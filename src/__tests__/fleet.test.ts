/**
 * Phase 9 slice 1 — firmware registry + staged rollout.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { deviceBucket, deviceTarget, deviceFwStatus } from '../breeder/logic/rollout.js';

describe('rollout maths', () => {
  it('deviceBucket is stable and in 0..99', () => {
    const a = deviceBucket('feeder-abc');
    expect(a).toBe(deviceBucket('feeder-abc'));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });
  it('deviceTarget moves in-bucket devices only while rolling', () => {
    expect(deviceTarget({ state: 'rolling', percent: 100 }, '1.2.0', 'x')).toBe('1.2.0');
    expect(deviceTarget({ state: 'rolling', percent: 0 }, '1.2.0', 'x')).toBeNull();
    expect(deviceTarget({ state: 'paused', percent: 100 }, '1.2.0', 'x')).toBeNull();
    expect(deviceTarget(null, '1.2.0', 'x')).toBeNull();
  });
  it('deviceFwStatus reads reported vs target', () => {
    expect(deviceFwStatus(null, null)).toBe('unknown');
    expect(deviceFwStatus('1.0.0', null)).toBe('up-to-date');
    expect(deviceFwStatus('1.0.0', '1.0.0')).toBe('up-to-date');
    expect(deviceFwStatus('1.0.0', '1.1.0')).toBe('pending');
  });
});

const db = new PGlite();
vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => { await db.query(t, p as unknown[]); },
  pool: {},
}));
const publishCommand = vi.fn(async () => {});
vi.mock('../services/feederMqtt.js', () => ({ publishCommand }));

const { default: fleetRouter, fleetSweep } = await import('../breeder/routes/fleet.js');

const M = dirname(fileURLToPath(import.meta.url)).replace(/__tests__$/, 'database/migrations');
let base: string;

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
    INSERT INTO users (id) VALUES ('00000000-0000-0000-0000-0000000000aa');
    CREATE TABLE devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), device_id VARCHAR(255) UNIQUE NOT NULL,
      device_type VARCHAR(50) NOT NULL, name VARCHAR(255), kennel_id VARCHAR(255),
      is_online BOOLEAN DEFAULT false, last_seen TIMESTAMPTZ);
    CREATE TABLE access_log (
      id BIGSERIAL PRIMARY KEY, kennel_id VARCHAR(255) NOT NULL, user_id UUID, action VARCHAR(40) NOT NULL,
      subject_type VARCHAR(20), subject_id VARCHAR(255), ip VARCHAR(64), detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);
  await db.exec(readFileSync(join(M, '011_fleet_firmware.sql'), 'utf8'));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { kennelId: string }).kennelId = 'home';
    (req as unknown as { user: { id: string } }).user = { id: '00000000-0000-0000-0000-0000000000aa' };
    next();
  });
  app.use(fleetRouter);
  const srv = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

const post = (p: string, body: unknown) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (p: string, body: unknown) =>
  fetch(`${base}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('firmware + rollout routes', () => {
  let fwId = '';
  let rolloutId = '';

  it('publishes a build and rejects a duplicate version', async () => {
    const r = await post('/firmware', { deviceType: 'feeder', version: '1.4.0', url: 'https://x/f-1.4.0.bin', sha256: 'a'.repeat(64) });
    expect(r.status).toBe(201);
    fwId = (await r.json()).firmware.id;
    expect((await post('/firmware', { deviceType: 'feeder', version: '1.4.0', url: 'https://x/again.bin', sha256: 'b'.repeat(64) })).status).toBe(409);
  });

  it('starts a canary rollout at 5%', async () => {
    const r = await post('/rollouts', { firmwareId: fwId });
    expect(r.status).toBe(201);
    const j = await r.json();
    rolloutId = j.rollout.id;
    expect(j.rollout).toMatchObject({ state: 'rolling', percent: 5, device_type: 'feeder' });
  });

  it('rolls the percent forward but never back', async () => {
    expect((await patch(`/rollouts/${rolloutId}`, { percent: 50 })).status).toBe(200);
    const back = await patch(`/rollouts/${rolloutId}`, { percent: 20 });
    expect(back.status).toBe(400);
  });

  it('a second rollout for the same type closes the first', async () => {
    const r2 = await post('/firmware', { deviceType: 'feeder', version: '1.5.0', url: 'https://x/f-1.5.0.bin', sha256: 'c'.repeat(64) });
    const fw2 = (await r2.json()).firmware.id;
    await post('/rollouts', { firmwareId: fw2, percent: 10 });
    const live = (await db.query(`SELECT state FROM firmware_rollouts WHERE state <> 'done'`)).rows;
    expect(live).toHaveLength(1);
  });
});

describe('fleetSweep + GET /devices', () => {
  it('offers the OTA to in-bucket online devices, capped per tick', async () => {
    publishCommand.mockClear();
    // fresh rollout at 100% so every device is in-bucket
    await db.query(`UPDATE firmware_rollouts SET state = 'done'`);
    const fw = (await db.query<{ id: string }>(`INSERT INTO firmware (device_type, version, url, sha256)
      VALUES ('feeder','2.0.0','https://x/2.bin',$1) RETURNING id`, ['d'.repeat(64)])).rows[0];
    await db.query(`INSERT INTO firmware_rollouts (firmware_id, device_type, state, percent)
      VALUES ($1,'feeder','rolling',100)`, [fw.id]);
    for (let i = 0; i < 15; i++) {
      await db.query(`INSERT INTO devices (device_id, device_type, kennel_id, is_online) VALUES ($1,'feeder','home',true)`, [`f-${i}`]);
    }
    await db.query(`INSERT INTO devices (device_id, device_type, kennel_id, is_online) VALUES ('f-off','feeder','home',false)`);

    const r = await fleetSweep();
    expect(r.pushed).toBe(10);              // OTA_PER_TICK cap
    expect(publishCommand).toHaveBeenCalledTimes(10);
    expect(publishCommand.mock.calls[0][3]).toBe('feeder'); // deviceType routed on the topic

    const devs = await (await fetch(`${base}/devices`)).json();
    const one = devs.devices.find((d: { deviceId: string }) => d.deviceId === 'f-0');
    expect(one.target).toBe('2.0.0');
    expect(one.fwStatus).toBe('unknown'); // never reported a version
  });

  it('skips a device already reporting the target version', async () => {
    publishCommand.mockClear();
    await db.query(`UPDATE devices SET fw_version = '2.0.0' WHERE device_id LIKE 'f-%'`);
    const r = await fleetSweep();
    expect(r.pushed).toBe(0);
    expect(publishCommand).not.toHaveBeenCalled();
  });
});
