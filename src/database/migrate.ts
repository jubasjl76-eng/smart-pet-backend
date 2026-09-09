/**
 * Minimal forward-only SQL migration runner. No dependency.
 *
 *   npm run migrate            # apply pending migrations
 *   npm run migrate -- --status
 *
 * Migrations are `src/database/migrations/NNN_name.sql`, applied in filename
 * order, each in its own transaction, recorded in `_migrations`. Files are
 * expected to be idempotent (they run alongside the legacy boot DDL).
 *
 * `runMigrations(pool)` is also called from initializeDatabase() so a plain
 * `npm run dev` / `docker compose up` is migrated automatically; the standalone
 * CLI is what the deploy pipeline uses as a one-off task.
 */
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';
import { config, pgDatabase } from '../config/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'migrations');

export interface MigrationClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}
/** A `pg.Pool` also has `connect()` — used to keep BEGIN…COMMIT on one connection. */
export interface MigrationPool extends MigrationClient {
  connect?(): Promise<MigrationClient & { release: () => void }>;
}

export function listMigrations(): { name: string; sql: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8') }));
}

export async function runMigrations(
  db: MigrationPool,
  log: (m: string) => void = () => {}
): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const done = new Set(
    (await db.query('SELECT name FROM _migrations')).rows.map((r) => r.name)
  );
  const applied: string[] = [];
  for (const { name, sql } of listMigrations()) {
    if (done.has(name)) continue;
    log(`[migrate] applying ${name}`);

    // A Pool hands out a connection per query() call, which would split
    // BEGIN/COMMIT across connections — grab a dedicated client when we can.
    const client = typeof db.connect === 'function' ? await db.connect() : db;
    const dedicated = client !== db;
    try {
      if (dedicated) await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
      if (dedicated) await client.query('COMMIT');
      applied.push(name);
    } catch (err) {
      if (dedicated) await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${name} failed: ${(err as Error).message}`);
    } finally {
      if (dedicated) (client as any).release();
    }
  }
  return applied;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// `npm run migrate` is self-sufficient: it ensures the full schema exists
// (base + breeder DDL) before applying migration files, so it works on a
// fresh database. `--status` just lists applied/pending.
async function cli(): Promise<void> {
  if (process.argv.includes('--status')) {
    const { Pool } = pg;
    const pool = new Pool({
      host: config.PG_HOST,
      port: config.PG_PORT,
      database: pgDatabase(),
      user: config.PG_USER,
      password: config.PG_PASSWORD,
    });
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
      const done = new Set((await pool.query('SELECT name FROM _migrations')).rows.map((r) => r.name));
      for (const { name } of listMigrations()) {
        console.log(`${done.has(name) ? '✓ applied ' : '· pending '} ${name}`);
      }
    } finally {
      await pool.end();
    }
    return;
  }

  const { initializeDatabase, pool } = await import('./index.js');
  const { initBreederSchema } = await import('../breeder/schema.js');
  await initializeDatabase();
  await initBreederSchema();
  const applied = await runMigrations(pool, console.log);
  console.log(applied.length ? `[migrate] ${applied.length} applied` : '[migrate] up to date');
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
