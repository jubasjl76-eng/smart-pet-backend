/**
 * Phase 4 — channel adapters + retry/backoff.
 * Pure helpers unit-tested; drainNotifications exercised against pglite.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { BREEDER_DDL } from '../breeder/schema.js';
import { backoffSeconds, channelConfigured, planNextAttempt } from '../breeder/engine/channels.js';

const db = new PGlite();
vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => {
    await db.query(t, p as unknown[]);
  },
  pool: {},
}));
const { drainNotifications } = await import('../breeder/engine/notifier.js');

describe('backoffSeconds', () => {
  it('grows geometrically and caps at 6h', () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(300);
    expect(backoffSeconds(3)).toBe(1500);
    expect(backoffSeconds(99)).toBe(6 * 3600);
    expect(backoffSeconds(0)).toBe(60);
  });
});

describe('channelConfigured', () => {
  it('log / webhook / siren always available; email / sms need env', () => {
    expect(channelConfigured('log')).toBe(true);
    expect(channelConfigured('webhook')).toBe(true);
    expect(channelConfigured('siren')).toBe(true);
    expect(channelConfigured('push')).toBe(false);
    expect(channelConfigured('email')).toBe(false);
    expect(channelConfigured('sms')).toBe(false);
  });
});

describe('planNextAttempt', () => {
  it('sent / suppressed are terminal', () => {
    expect(planNextAttempt({ status: 'sent' }, 1, 5).nextAttemptAt).toBeNull();
    expect(planNextAttempt({ status: 'suppressed' }, 1, 5).status).toBe('suppressed');
  });
  it('failed re-queues with a future retry until max attempts', () => {
    const a = planNextAttempt({ status: 'failed' }, 1, 3, 1_000_000);
    expect(a.status).toBe('queued');
    expect(a.nextAttemptAt?.getTime()).toBe(1_060_000);
    const b = planNextAttempt({ status: 'failed' }, 3, 3);
    expect(b.status).toBe('failed');
    expect(b.nextAttemptAt).toBeNull();
  });
});

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email VARCHAR(255), role VARCHAR(20));
    CREATE TABLE devices (device_id VARCHAR(255) PRIMARY KEY, kennel_id VARCHAR(255));
  `);
  await db.exec(BREEDER_DDL);
  await db.exec(`
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 5;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS provider_ref VARCHAR(255);
  `);
});

async function insert(channel: string, target: string | null, maxAttempts = 5): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notifications (kennel_id, channel, target, subject, body, max_attempts)
     VALUES ('home', $1, $2, 'test', 'body', $3) RETURNING id`,
    [channel, target, maxAttempts],
  );
  return rows[0].id;
}
async function statusOf(id: string) {
  const { rows } = await db.query<{ status: string; attempts: number; next_attempt_at: string | null }>(
    `SELECT status, attempts, next_attempt_at FROM notifications WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe('drainNotifications', () => {
  it('delivers a log notification', async () => {
    const id = await insert('log', null);
    const r = await drainNotifications();
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const row = await statusOf(id);
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(1);
  });

  it('suppresses email when the provider is not configured', async () => {
    const id = await insert('email', 'someone@example.com');
    await drainNotifications();
    expect((await statusOf(id)).status).toBe('suppressed');
  });

  it('retries a failing webhook, then gives up at max_attempts', async () => {
    const id = await insert('webhook', 'http://127.0.0.1:0/never', 2);
    await drainNotifications();
    let row = await statusOf(id);
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).not.toBeNull();

    await db.query(`UPDATE notifications SET next_attempt_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id]);
    await drainNotifications();
    row = await statusOf(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(2);
    expect(row.next_attempt_at).toBeNull();
  });
});
