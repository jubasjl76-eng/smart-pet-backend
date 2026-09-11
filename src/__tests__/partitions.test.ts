/**
 * Monthly range-partition maintenance (Phase 20, A12 #23).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { BREEDER_DDL } from '../breeder/schema.js';

const db = new PGlite();
vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => {
    await db.query(t, p as unknown[]);
  },
  pool: {},
}));

const {
  ensureMonthPartition,
  ensureUpcomingPartitions,
  listMonthlyPartitions,
  dropExpiredMonthPartitions,
} = await import('../db/partitions.js');

const M = dirname(fileURLToPath(import.meta.url)).replace(/__tests__$/, 'database/migrations');
const mig = (f: string) => readFileSync(join(M, f), 'utf8');

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email VARCHAR(255), role VARCHAR(20), kennel_id VARCHAR(255));
    CREATE TABLE devices (device_id VARCHAR(255) PRIMARY KEY, kennel_id VARCHAR(255));
  `);
  await db.exec(BREEDER_DDL);
  await db.exec(mig('009_access_log.sql'));
  await db.exec(mig('015_partition_access_log.sql'));
  await db.exec(mig('016_partition_exceptions.sql'));
});

describe('ensureMonthPartition / ensureUpcomingPartitions', () => {
  it('creates a partition for a named month, and is idempotent', async () => {
    const jan = new Date(Date.UTC(2027, 0, 15));
    const name = await ensureMonthPartition('access_log', jan);
    expect(name).toBe('access_log_2027_01');
    await expect(ensureMonthPartition('access_log', jan)).resolves.toBe(name); // no error on re-run

    const partitions = await listMonthlyPartitions('access_log');
    expect(partitions).toContain('access_log_2027_01');
  });

  it('creates the current month plus N ahead', async () => {
    await ensureUpcomingPartitions('exceptions', 2);
    const now = new Date();
    const partitions = await listMonthlyPartitions('exceptions');
    for (let i = 0; i <= 2; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const name = `exceptions_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      expect(partitions).toContain(name);
    }
  });
});

describe('dropExpiredMonthPartitions', () => {
  it('drops a whole expired month, leaves a non-expired one alone', async () => {
    const oldMonth = new Date(Date.UTC(2020, 5, 1)); // 2020-06 — long expired
    const recentMonth = new Date(); // this month — not expired
    await ensureMonthPartition('access_log', oldMonth);
    await ensureMonthPartition('access_log', recentMonth);

    await db.query(
      `INSERT INTO access_log (kennel_id, action, at) VALUES
       ('home','x','2020-06-10T00:00:00Z'), ('home','x','2020-06-15T00:00:00Z')`,
    );
    await db.query(`INSERT INTO access_log (kennel_id, action, at) VALUES ('home','x',NOW())`);

    const cutoff = new Date(Date.UTC(2021, 0, 1)); // well past the old month, before the recent one
    const dropped = await dropExpiredMonthPartitions('access_log', cutoff, 'home');
    expect(dropped).toBe(2);

    const remaining = await listMonthlyPartitions('access_log');
    expect(remaining).not.toContain('access_log_2020_06');
    const recentName = `access_log_${recentMonth.getUTCFullYear()}_${String(recentMonth.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(remaining).toContain(recentName);
    expect(
      (await db.query(`SELECT id FROM access_log WHERE kennel_id = 'home'`)).rows,
    ).toHaveLength(1);
  });

  it("won't drop a month another kennel still has data in", async () => {
    const month = new Date(Date.UTC(2019, 2, 1)); // 2019-03
    await ensureMonthPartition('access_log', month);
    await db.query(
      `INSERT INTO access_log (kennel_id, action, at) VALUES
       ('home','x','2019-03-05T00:00:00Z'), ('other-kennel','x','2019-03-06T00:00:00Z')`,
    );

    const dropped = await dropExpiredMonthPartitions(
      'access_log',
      new Date(Date.UTC(2020, 0, 1)),
      'home',
    );
    expect(dropped).toBe(0);
    expect(await listMonthlyPartitions('access_log')).toContain('access_log_2019_03');
  });

  it("honors a notSafeWhere guard — won't drop a month with a row matching it", async () => {
    const month = new Date(Date.UTC(2018, 4, 1)); // 2018-05
    await ensureMonthPartition('exceptions', month);
    await db.query(
      `INSERT INTO exceptions (kennel_id, kind, title, status, created_at) VALUES
       ('home','jam','Stuck','open','2018-05-05T00:00:00Z')`,
    );

    const dropped = await dropExpiredMonthPartitions(
      'exceptions',
      new Date(Date.UTC(2019, 0, 1)),
      'home',
      `status <> 'resolved'`,
    );
    expect(dropped).toBe(0);
    expect(await listMonthlyPartitions('exceptions')).toContain('exceptions_2018_05');

    await db.query(`UPDATE exceptions SET status = 'resolved' WHERE kennel_id = 'home'`);
    const droppedNow = await dropExpiredMonthPartitions(
      'exceptions',
      new Date(Date.UTC(2019, 0, 1)),
      'home',
      `status <> 'resolved'`,
    );
    expect(droppedNow).toBe(1);
  });
});
