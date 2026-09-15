/**
 * Multi-tenant isolation (Phase 18, A12 #26).
 *
 * Companion to the `breeder-query-must-be-kennel-scoped` Semgrep rule: proves
 * end-to-end that a breeder request cannot read another kennel's row. Delete
 * the `AND kennel_id = $2` from `routes/animals.ts` GET /:id and the second
 * test goes red.
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
vi.mock('../services/feederMqtt.js', () => ({
  isFeederMqttConnected: () => true,
  publishCommand: async () => {},
}));
vi.mock('../services/flags.js', () => ({ getFlags: async () => ({}) }));

const { mountBreeder } = await import('../breeder/index.js');

const KENNEL_A = 'kennel-aaa';
const KENNEL_B = 'kennel-bbb';
const USER_A = '00000000-0000-0000-0000-00000000000a';
const USER_B = '00000000-0000-0000-0000-00000000000b';
const ANIMAL_B = '00000000-0000-0000-0000-0000000000b1';

const SECRET = process.env.JWT_SECRET ?? 'test-secret-not-for-production';
const tokenFor = (id: string) => jwt.sign({ userId: id, role: 'owner' }, SECRET);

let base: string;

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (
      id UUID PRIMARY KEY, email VARCHAR(255), name VARCHAR(255),
      role VARCHAR(20) DEFAULT 'owner', active BOOLEAN DEFAULT true, kennel_id VARCHAR(255));
    CREATE TABLE devices (device_id VARCHAR(255) PRIMARY KEY, kennel_id VARCHAR(255));
  `);
  await db.exec(BREEDER_DDL);
  await db.query(`INSERT INTO users (id, email, name, kennel_id) VALUES ($1,$2,$3,$4)`,
    [USER_A, 'a@test', 'A', KENNEL_A]);
  await db.query(`INSERT INTO users (id, email, name, kennel_id) VALUES ($1,$2,$3,$4)`,
    [USER_B, 'b@test', 'B', KENNEL_B]);
  await db.query(`INSERT INTO animals (id, kennel_id, name) VALUES ($1,$2,$3)`,
    [ANIMAL_B, KENNEL_B, 'Willow']);

  const app = express();
  app.use(express.json());
  mountBreeder(app);
  const srv = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

const getAnimal = (id: string, token: string) =>
  fetch(`${base}/api/breeder/animals/${id}`, { headers: { authorization: `Bearer ${token}` } });

describe('kennel isolation', () => {
  it("kennel B's owner can read kennel B's animal", async () => {
    const res = await getAnimal(ANIMAL_B, tokenFor(USER_B));
    expect(res.status).toBe(200);
    expect((await res.json()).animal.name).toBe('Willow');
  });

  it("kennel A's owner cannot read kennel B's animal", async () => {
    const res = await getAnimal(ANIMAL_B, tokenFor(USER_A));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('Willow');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await fetch(`${base}/api/breeder/animals/${ANIMAL_B}`);
    expect(res.status).toBe(401);
  });
});
