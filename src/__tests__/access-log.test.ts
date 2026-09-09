/**
 * Phase 8 slice 1 — access log helper.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => { await db.query(t, p as unknown[]); },
  pool: {},
}));
const { logAccess, clientIp } = await import('../breeder/accessLog.js');

// Minimal stand-in for KennelRequest.
const fakeReq = (over: Record<string, unknown> = {}) =>
  ({
    kennelId: 'home',
    user: { id: '00000000-0000-0000-0000-0000000000aa' },
    headers: {},
    socket: { remoteAddress: '10.0.0.9' },
    ...over,
  }) as never;

describe('clientIp', () => {
  it('takes the first hop of x-forwarded-for', () => {
    expect(clientIp(fakeReq({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }))).toBe('203.0.113.7');
  });
  it('falls back to the socket address', () => {
    expect(clientIp(fakeReq())).toBe('10.0.0.9');
  });
});

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE access_log (
      id BIGSERIAL PRIMARY KEY, kennel_id VARCHAR(255) NOT NULL, user_id UUID,
      action VARCHAR(40) NOT NULL, subject_type VARCHAR(20), subject_id VARCHAR(255),
      ip VARCHAR(64), detail JSONB NOT NULL DEFAULT '{}'::jsonb, at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);
});

describe('logAccess', () => {
  it('writes a row with the request identity and subject', async () => {
    await logAccess(fakeReq({ headers: { 'x-forwarded-for': '198.51.100.2' } }), 'document.download', {
      subjectType: 'buyer', subjectId: 'b-1', detail: { kind: 'contract' },
    });
    const rows = (await db.query<{
      kennel_id: string; action: string; subject_type: string; subject_id: string;
      ip: string; detail: { kind: string };
    }>(`SELECT kennel_id, action, subject_type, subject_id, ip, detail FROM access_log`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kennel_id: 'home', action: 'document.download',
      subject_type: 'buyer', subject_id: 'b-1', ip: '198.51.100.2',
    });
    expect(rows[0].detail.kind).toBe('contract');
  });

  it('never throws when the insert fails', async () => {
    await db.exec('ALTER TABLE access_log RENAME TO access_log_x');
    await expect(logAccess(fakeReq(), 'camera.view')).resolves.toBeUndefined();
    await db.exec('ALTER TABLE access_log_x RENAME TO access_log');
  });
});
