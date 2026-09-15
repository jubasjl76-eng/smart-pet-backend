/**
 * pg-boss job queue (Phase 20, A12 #3). Exercised against an in-process
 * PGlite instance via pg-boss's `pglite` backend profile — real queue/worker
 * mechanics (SKIP LOCKED dequeue, retry/backoff, dead-letter), no external
 * Postgres needed. Executes multi-statement migration SQL via `db.exec()`
 * (pglite's extended/prepared-statement `query()` rejects multiple
 * commands in one string — the same reason this repo's other tests use
 * `db.exec(BREEDER_DDL)` rather than `db.query(BREEDER_DDL)`) and falls
 * back to `query()` for everything else so params still bind correctly.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PgBoss, type Db } from 'pg-boss';

function pgliteAdapter(db: PGlite): Db {
  return {
    async executeSql(text: string, values?: unknown[]) {
      if (values && values.length) {
        const r = await db.query(text, values);
        return { rows: r.rows };
      }
      try {
        const r = await db.query(text);
        return { rows: r.rows };
      } catch (e) {
        if (!String((e as Error).message).includes('cannot insert multiple commands')) throw e;
        const results = await db.exec(text);
        const last = results.at(-1) as { rows?: unknown[] } | undefined;
        return { rows: last?.rows ?? [] };
      }
    },
  };
}

let boss: PgBoss | undefined;
afterEach(async () => {
  await boss?.stop({ graceful: false }).catch(() => {});
  boss = undefined;
});

describe('pg-boss queue', () => {
  it('delivers a sent job to a worker exactly once', async () => {
    boss = new PgBoss({ db: pgliteAdapter(new PGlite()), backend: 'pglite' });
    await boss.start();
    await boss.createQueue('q1');

    const received: unknown[] = [];
    await boss.work('q1', async ([job]) => {
      received.push(job.data);
    });
    await boss.send('q1', { hello: 'world' });

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 20_000 });
    expect(received[0]).toEqual({ hello: 'world' });
  }, 25_000);

  it('retries a failing job up to retryLimit, then dead-letters it', async () => {
    boss = new PgBoss({ db: pgliteAdapter(new PGlite()), backend: 'pglite' });
    await boss.start();
    await boss.createQueue('dlq');
    await boss.createQueue('q2');

    let attempts = 0;
    const dead: unknown[] = [];
    await boss.work('q2', async () => {
      attempts++;
      throw new Error('boom');
    });
    await boss.work('dlq', async ([job]) => {
      dead.push(job.data);
    });
    await boss.send('q2', { x: 1 }, { retryLimit: 1, retryDelay: 0, deadLetter: 'dlq' });

    await vi.waitFor(() => expect(dead).toHaveLength(1), { timeout: 20_000 });
    expect(attempts).toBeGreaterThanOrEqual(2); // the first try + at least one retry
  }, 25_000);
});
