/**
 * Feature flags — admin CRUD (Phase 20) + the cached read-side service
 * (Phase 12).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => {
    await db.query(t, p as unknown[]);
  },
  pool: {},
}));

const { default: flagsRouter } = await import('../breeder/routes/flags.js');
const { getFlags, isFlagEnabled, invalidateFlags } = await import('../services/flags.js');

let base: string;

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE access_log (
      id BIGSERIAL PRIMARY KEY, kennel_id VARCHAR(255) NOT NULL, user_id UUID, action VARCHAR(40) NOT NULL,
      subject_type VARCHAR(20), subject_id VARCHAR(255), ip VARCHAR(64), detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE feature_flags (
      key TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT FALSE, description TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { kennelId: string }).kennelId = 'home';
    (req as unknown as { user: { id: string } }).user = {
      id: '00000000-0000-0000-0000-0000000000aa',
    };
    next();
  });
  app.use(flagsRouter);
  const srv = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

const put = (key: string, body: unknown) =>
  fetch(`${base}/${key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('feature flags', () => {
  it('rejects a bad key', async () => {
    const res = await put('Not_Valid!', { enabled: true });
    expect(res.status).toBe(400);
  });

  it('creates a flag, and GET /api/config-style read sees it once the cache is invalidated', async () => {
    invalidateFlags();
    expect(await isFlagEnabled('new-console')).toBe(false); // unknown key — never throws

    const res = await put('new-console', { enabled: true, description: 'staged rollout' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flag).toMatchObject({
      key: 'new-console',
      enabled: true,
      description: 'staged rollout',
    });

    // PUT invalidates the cache itself, so a fresh read sees it immediately.
    expect(await isFlagEnabled('new-console')).toBe(true);
    expect(await getFlags()).toMatchObject({ 'new-console': true });
  });

  it('toggles an existing flag off, keeping its description when none is sent', async () => {
    const res = await put('new-console', { enabled: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flag).toMatchObject({
      key: 'new-console',
      enabled: false,
      description: 'staged rollout',
    });
    expect(await isFlagEnabled('new-console')).toBe(false);
  });

  it('lists every flag', async () => {
    await put('another-flag', { enabled: true });
    const res = await fetch(base);
    const body = await res.json();
    expect(body.flags.map((f: { key: string }) => f.key).sort()).toEqual([
      'another-flag',
      'new-console',
    ]);
  });

  it('deletes a flag — back to off, absent from the list', async () => {
    const res = await fetch(`${base}/another-flag`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await isFlagEnabled('another-flag')).toBe(false);
    const list = await (await fetch(base)).json();
    expect(list.flags.map((f: { key: string }) => f.key)).not.toContain('another-flag');
  });
});
