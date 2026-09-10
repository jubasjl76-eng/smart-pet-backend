/**
 * Fleet kill switch (Phase 19, A12 #17) — halt / resume drives the
 * `fleet_control` row and (best-effort) the retained MQTT control message.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { PGlite } from '@electric-sql/pglite';
import { BREEDER_DDL } from '../breeder/schema.js';

const db = new PGlite();
vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => { await db.query(t, p as unknown[]); },
  pool: {},
}));

const publishFleetControl = vi.fn(async () => {});
vi.mock('../services/feederMqtt.js', () => ({
  isFeederMqttConnected: () => true,
  publishCommand: async () => {},
  publishFleetControl,
}));
vi.mock('../services/flags.js', () => ({ getFlags: async () => ({}) }));

const { mountBreeder } = await import('../breeder/index.js');

const KENNEL = 'kennel-kill';
const USER = '00000000-0000-0000-0000-0000000000c1';
const SECRET = process.env.JWT_SECRET ?? 'test-secret-not-for-production';
const token = jwt.sign({ userId: USER, role: 'owner' }, SECRET);
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

let base: string;
beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY, email VARCHAR(255), name VARCHAR(255),
      role VARCHAR(20) DEFAULT 'owner', active BOOLEAN DEFAULT true, kennel_id VARCHAR(255));
    CREATE TABLE devices (device_id VARCHAR(255) PRIMARY KEY, kennel_id VARCHAR(255));
  `);
  await db.exec(BREEDER_DDL);
  await db.query(`INSERT INTO users (id, email, name, kennel_id) VALUES ($1,$2,$3,$4)`,
    [USER, 'c@test', 'C', KENNEL]);

  const app = express();
  app.use(express.json());
  mountBreeder(app);
  const srv = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

const get = (p: string) => fetch(`${base}${p}`, { headers: H });
const post = (p: string, body?: unknown) =>
  fetch(`${base}${p}`, { method: 'POST', headers: H, body: body ? JSON.stringify(body) : undefined });

describe('fleet kill switch', () => {
  it('starts un-halted', async () => {
    const r = await get('/api/breeder/fleet/control');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ safeMode: false, reason: null });
  });

  it('halt sets safe mode + reason and publishes retained control', async () => {
    publishFleetControl.mockClear();
    const r = await post('/api/breeder/fleet/halt', { reason: 'over-feeding on rule r7' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ safeMode: true, brokerPublished: true });

    expect(publishFleetControl).toHaveBeenCalledWith(
      KENNEL,
      expect.objectContaining({ safeMode: true, reason: 'over-feeding on rule r7' }),
    );
    const c = await (await get('/api/breeder/fleet/control')).json();
    expect(c).toMatchObject({ safeMode: true, reason: 'over-feeding on rule r7' });
  });

  it('resume clears it', async () => {
    publishFleetControl.mockClear();
    const r = await post('/api/breeder/fleet/resume');
    expect(await r.json()).toEqual({ safeMode: false, brokerPublished: true });
    expect(publishFleetControl).toHaveBeenCalledWith(KENNEL, expect.objectContaining({ safeMode: false }));
    expect((await (await get('/api/breeder/fleet/control')).json()).safeMode).toBe(false);
  });

  it('still 200 with brokerPublished:false when the broker throws', async () => {
    publishFleetControl.mockRejectedValueOnce(new Error('broker down'));
    const r = await post('/api/breeder/fleet/halt', { reason: 'x' });
    expect(await r.json()).toEqual({ safeMode: true, brokerPublished: false });
    // DB is still the source of truth
    expect((await (await get('/api/breeder/fleet/control')).json()).safeMode).toBe(true);
  });
});
