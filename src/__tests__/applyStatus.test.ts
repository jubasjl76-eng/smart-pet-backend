/**
 * Status-ordering guard (Phase 21, A11 — EMQX cluster depth / MQTT HA). A
 * device journals status locally while disconnected and replays it on
 * reconnect; with no shared state between broker replicas, a replay can
 * arrive after a newer status already applied. `applyStatus()` must drop it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

const { applyStatus } = await import('../services/feederMqtt.js');

beforeEach(async () => {
  await db.exec(`DROP TABLE IF EXISTS devices;`);
  await db.exec(`
    CREATE TABLE devices (
      device_id VARCHAR(255) PRIMARY KEY,
      kennel_id VARCHAR(255),
      is_online BOOLEAN DEFAULT false,
      status VARCHAR(20) DEFAULT 'offline',
      last_seen TIMESTAMP,
      food_level FLOAT,
      latest_value FLOAT,
      last_feed BIGINT,
      fw_version VARCHAR(50),
      fw_updated_at TIMESTAMP,
      last_status_ts BIGINT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    INSERT INTO devices (device_id, kennel_id) VALUES ('feeder-01', 'k1');
  `);
});

async function device() {
  const rows = (await db.query('SELECT * FROM devices WHERE device_id = $1', ['feeder-01']))
    .rows as any[];
  return rows[0];
}

describe('applyStatus ordering guard', () => {
  it('applies an in-order status and records the watermark', async () => {
    await applyStatus({
      deviceId: 'feeder-01',
      kennelId: 'k1',
      timestamp: 1000,
      status: 'online',
      foodLevel: 80,
    });
    const d = await device();
    expect(d.status).toBe('online');
    expect(d.food_level).toBe(80);
    expect(Number(d.last_status_ts)).toBe(1000);
  });

  it('drops a replayed status older than the last one applied', async () => {
    await applyStatus({
      deviceId: 'feeder-01',
      kennelId: 'k1',
      timestamp: 2000,
      status: 'online',
      foodLevel: 80,
    });
    await applyStatus({
      deviceId: 'feeder-01',
      kennelId: 'k1',
      timestamp: 1000,
      status: 'offline',
      foodLevel: 60,
    });
    const d = await device();
    expect(d.status).toBe('online'); // the stale offline replay never applied
    expect(d.food_level).toBe(80);
    expect(Number(d.last_status_ts)).toBe(2000);
  });

  it('drops a duplicate at the same timestamp', async () => {
    await applyStatus({
      deviceId: 'feeder-01',
      kennelId: 'k1',
      timestamp: 1000,
      status: 'online',
      foodLevel: 80,
    });
    await applyStatus({
      deviceId: 'feeder-01',
      kennelId: 'k1',
      timestamp: 1000,
      status: 'offline',
      foodLevel: 10,
    });
    const d = await device();
    expect(d.status).toBe('online');
  });

  it('always applies an LWT (timestamp 0) without moving the watermark backwards', async () => {
    await applyStatus({
      deviceId: 'feeder-01',
      kennelId: 'k1',
      timestamp: 2000,
      status: 'online',
      foodLevel: 80,
    });
    await applyStatus({ deviceId: 'feeder-01', kennelId: 'k1', timestamp: 0, status: 'offline' });
    const d = await device();
    expect(d.status).toBe('offline');
    expect(d.is_online).toBe(false);
    expect(Number(d.last_status_ts)).toBe(2000); // watermark unchanged by the LWT

    // a genuine reconnect right after still applies normally
    await applyStatus({
      deviceId: 'feeder-01',
      kennelId: 'k1',
      timestamp: 2500,
      status: 'online',
      foodLevel: 90,
    });
    const d2 = await device();
    expect(d2.status).toBe('online');
    expect(Number(d2.last_status_ts)).toBe(2500);
  });
});
