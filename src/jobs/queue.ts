/**
 * pg-boss job queue (hardening Phase 20, A12 #3) — a durable worker with
 * retry/backoff and dead-letter queues, Postgres-backed (the same database
 * the app already requires — zero new infra, fits the stdlib-first ethos
 * over adding Redis-backed BullMQ or a message broker). Lives in its own
 * `pgboss` schema, migrated automatically on start().
 *
 * Boot order (src/index.ts): the DB comes up, then startQueue(), then each
 * job module's registerWorker(), then the app starts accepting traffic.
 * Shutdown stops the queue (draining in-flight jobs) before the pool closes.
 */
import { PgBoss, type ConstructorOptions } from 'pg-boss';
import { config, pgDatabase } from '../config/index.js';
import { log } from '../log.js';

const qlog = log.child({ mod: 'queue' });

export function createPgBoss(overrides: Partial<ConstructorOptions> = {}): PgBoss {
  const boss = new PgBoss({
    host: config.PG_HOST,
    port: config.PG_PORT,
    database: pgDatabase(),
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    schema: 'pgboss',
    // pg-boss builds its own pg.Pool from these options — without an
    // explicit max it falls back to pg's own default (10), a previously
    // invisible connection consumer alongside the app's main pool
    // (Phase 20, A12 #1).
    max: config.PG_BOSS_POOL_MAX,
    ...overrides,
  });
  boss.on('error', (err) => qlog.error({ err }, 'pg-boss error'));
  return boss;
}

let boss: PgBoss | null = null;

/** The app-wide queue instance (lazily created on first use). */
export function getQueue(): PgBoss {
  if (!boss) boss = createPgBoss();
  return boss;
}

export async function startQueue(): Promise<void> {
  await getQueue().start();
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 10_000 }).catch((err) => {
      qlog.error({ err }, 'queue stop failed');
    });
  }
}
