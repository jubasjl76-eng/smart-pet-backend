/**
 * Redis connection (Phase 20). REDIS_URL unset → `redis` is null and
 * `redisHealthy()` reports true (nothing to check, not a failure).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

describe('redis', () => {
  it('is null and reports healthy when REDIS_URL is unset', async () => {
    const { redis, redisHealthy, closeRedis } = await import('../redis.js');
    expect(redis).toBeNull();
    await expect(redisHealthy()).resolves.toBe(true);
    await expect(closeRedis()).resolves.toBeUndefined();
  });
});

vi.mock('../database/index.js', () => ({
  query: async () => [],
  queryOne: async () => null,
  execute: async () => {},
  initializeDatabase: async () => {},
  pool: {},
}));
vi.mock('../services/feederMqtt.js', () => ({
  isFeederMqttConnected: () => true,
  startFeederMqtt: async () => {},
  stopFeederMqtt: () => {},
  publishCommand: async () => {},
}));
vi.mock('../services/flags.js', () => ({ getFlags: async () => ({}) }));

const { buildApp } = await import('../app.js');

let base: string;
beforeAll(async () => {
  const app = buildApp();
  const srv = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

describe('/ready', () => {
  it('reports redis: null when unconfigured, and stays ready', async () => {
    const res = await fetch(`${base}/ready`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.redis).toBeNull();
    expect(body.db).toBe(true);
    expect(body.mqtt).toBe(true);
  });
});
