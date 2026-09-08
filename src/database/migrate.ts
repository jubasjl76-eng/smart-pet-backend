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

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'migrations');

export interface MigrationClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export function listMigrations(): { name: string; sql: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8') }));
}

export async function runMigrations(
  client: MigrationClient,
  log: (m: string) => void = () => {}
): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const done = new Set(
    (await client.query('SELECT name FROM _migrations')).rows.map((r) => r.name)
  );
  const applied: string[] = [];
  for (const { name, sql } of listMigrations()) {
    if (done.has(name)) continue;
    log(`[migrate] applying ${name}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      applied.push(name);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${name} failed: ${(err as Error).message}`);
    }
  }
  return applied;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function cli(): Promise<void> {
  const { Pool } = pg;
  const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DATABASE || 'smartpet',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
  });
  try {
    if (process.argv.includes('--status')) {
      await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
      const done = new Set((await pool.query('SELECT name FROM _migrations')).rows.map((r) => r.name));
      for (const { name } of listMigrations()) {
        console.log(`${done.has(name) ? '✓ applied ' : '· pending '} ${name}`);
      }
    } else {
      const applied = await runMigrations(pool, console.log);
      console.log(applied.length ? `[migrate] ${applied.length} applied` : '[migrate] up to date');
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
