/**
 * Phase 9 slice 2 — geofencing maths + position ingest / escape detection.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { haversineMeters, insideZone, isEscape, evaluate, type Zone } from '../breeder/logic/geofence.js';

describe('geofence maths', () => {
  const z: Zone = { id: 'z1', kind: 'boundary', center_lat: 53.5, center_lng: -6.5, radius_m: 100 };

  it('haversine ~ known distance', () => {
    // 0.001 deg latitude ~ 111 m
    const d = haversineMeters({ lat: 53.5, lng: -6.5 }, { lat: 53.501, lng: -6.5 });
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(117);
  });

  it('insideZone respects the radius', () => {
    expect(insideZone({ lat: 53.5, lng: -6.5 }, z)).toBe(true);
    expect(insideZone({ lat: 53.51, lng: -6.5 }, z)).toBe(false);
  });

  it('isEscape: boundary-exit and exclusion-enter', () => {
    expect(isEscape(z, 'exit')).toBe(true);
    expect(isEscape(z, 'enter')).toBe(false);
    expect(isEscape({ ...z, kind: 'exclusion' }, 'enter')).toBe(true);
  });

  it('evaluate diffs membership against the previous fix', () => {
    const zones = [z, { ...z, id: 'z2', radius_m: 5 }];
    const r = evaluate({ lat: 53.5, lng: -6.5 }, zones, new Set(['z2']));
    expect(r.insideIds).toEqual(['z1', 'z2']);
    expect(r.entered.map((x) => x.id)).toEqual(['z1']);
    expect(r.exited).toEqual([]);

    const out = evaluate({ lat: 53.6, lng: -6.5 }, zones, new Set(['z1', 'z2']));
    expect(out.exited.map((x) => x.id)).toEqual(['z1', 'z2']);
  });
});

const db = new PGlite();
vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as unknown[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => { await db.query(t, p as unknown[]); },
  pool: {},
}));
const raiseException = vi.fn(async () => ({ exception: { id: 'x' }, created: true }));
vi.mock('../breeder/exceptions.js', () => ({ raiseException }));

const { default: geoRouter } = await import('../breeder/routes/geo.js');

const M = dirname(fileURLToPath(import.meta.url)).replace(/__tests__$/, 'database/migrations');
let base: string;
const ANIMAL = 'a1111111-1111-1111-1111-111111111111';

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
    INSERT INTO users (id) VALUES ('00000000-0000-0000-0000-0000000000aa');
    CREATE TABLE animals (
      id UUID PRIMARY KEY, kennel_id VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL,
      collar_device_id VARCHAR(255), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE exceptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kennel_id VARCHAR(255) NOT NULL,
      dedup_key VARCHAR(255), status VARCHAR(20) DEFAULT 'open',
      resolved_at TIMESTAMPTZ, resolution_note TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    INSERT INTO animals (id, kennel_id, name, collar_device_id) VALUES
      ('${ANIMAL}','home','Willow','collar-01');
  `);
  await db.exec(readFileSync(join(M, '012_geofencing.sql'), 'utf8'));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { kennelId: string }).kennelId = 'home';
    (req as unknown as { user: { id: string } }).user = { id: '00000000-0000-0000-0000-0000000000aa' };
    next();
  });
  app.use(geoRouter);
  const srv = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

const post = (p: string, body: unknown) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('geo routes', () => {
  let zoneId = '';

  it('creates a boundary zone', async () => {
    const r = await post('/zones', { name: 'Paddock', centerLat: 53.5, centerLng: -6.5, radiusM: 100 });
    expect(r.status).toBe(201);
    zoneId = (await r.json()).zone.id;
  });

  it('a fix inside raises nothing and records membership', async () => {
    raiseException.mockClear();
    const r = await post('/positions', { animalId: ANIMAL, lat: 53.5, lng: -6.5 });
    const j = await r.json();
    expect(j.insideZoneIds).toEqual([zoneId]);
    expect(j.entered).toEqual([zoneId]);
    expect(j.alerts).toBe(0);
    expect(raiseException).not.toHaveBeenCalled();
    const st = (await db.query(`SELECT inside FROM geofence_state WHERE animal_id = '${ANIMAL}'`)).rows;
    expect(st).toEqual([{ inside: true }]);
  });

  it('a fix outside the boundary fires an escape alert', async () => {
    raiseException.mockClear();
    const r = await post('/positions', { deviceId: 'collar-01', lat: 53.7, lng: -6.5 });
    const j = await r.json();
    expect(j.exited).toEqual([zoneId]);
    expect(j.alerts).toBe(1);
    expect(raiseException).toHaveBeenCalledTimes(1);
    expect(raiseException.mock.calls[0][0]).toMatchObject({ kind: 'geofence-escape', severity: 'critical', animalId: ANIMAL });
  });

  it('coming back inside resolves the standing escape', async () => {
    await db.query(
      `INSERT INTO exceptions (kennel_id, dedup_key, status) VALUES ('home', $1, 'open')`,
      [`geofence-escape:${ANIMAL}`],
    );
    await post('/positions', { animalId: ANIMAL, lat: 53.5, lng: -6.5 });
    const ex = (await db.query<{ status: string }>(`SELECT status FROM exceptions WHERE dedup_key = $1`,
      [`geofence-escape:${ANIMAL}`])).rows;
    expect(ex.every((e) => e.status === 'resolved')).toBe(true);
  });

  it('rejects a fix with no animalId or deviceId', async () => {
    expect((await post('/positions', { lat: 1, lng: 2 })).status).toBe(400);
  });
});
