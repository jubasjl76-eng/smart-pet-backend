import { describe, it, expect } from 'vitest';
import {
  deriveIsFoodLow,
  isDeviceOnline,
  parseStatusPayload,
} from '../mqtt/contract.js';
import { ingestStatusMessage, presentDevice } from '../services/statusIngest.js';
import type { DeviceRow } from '../types.js';

describe('status payload contract', () => {
  it('accepts deviceId, kennelId, timestamp, status, foodLevel, lastFeed', () => {
    const parsed = parseStatusPayload({
      deviceId: 'feeder-sim-001',
      kennelId: 'home',
      timestamp: 100,
      status: 'online',
      foodLevel: 15,
      lastFeed: 90,
      isFoodLow: true,
    });
    expect(parsed).toMatchObject({
      deviceId: 'feeder-sim-001',
      kennelId: 'home',
      timestamp: 100,
      status: 'online',
      foodLevel: 15,
      lastFeed: 90,
    });
    expect(parsed && 'isFoodLow' in parsed).toBe(false);
  });

  it('derives foodLevel < 20 in the app, not on the wire', () => {
    expect(deriveIsFoodLow(15)).toBe(true);
    expect(deriveIsFoodLow(20)).toBe(false);
    expect(deriveIsFoodLow(80)).toBe(false);
  });

  it('treats status !== online as offline', () => {
    expect(isDeviceOnline('online')).toBe(true);
    expect(isDeviceOnline('offline')).toBe(false);
    expect(isDeviceOnline('lost')).toBe(false);
    expect(isDeviceOnline(undefined)).toBe(false);
  });
});

describe('status ingest', () => {
  it('writes foodLevel when online and keeps it on LWT without presenting as current', async () => {
    const store: Record<string, any> = {
      feeder: {
        id: '1',
        user_id: 'u1',
        device_id: 'feeder-sim-001',
        device_type: 'feeder',
        name: 'Sim',
        kennel_id: 'home',
        mqtt_username: 'device:feeder-sim-001',
        mqtt_password_hash: 'x',
        is_online: false,
        last_seen: null,
        food_level: 10,
        last_feed: null,
        status: 'offline',
        claimed_at: null,
        last_status_at: null,
      } satisfies DeviceRow,
    };
    const db = {
      queryOne: async () => store.feeder,
      execute: async (text: string, params?: any[]) => {
        if (text.includes("status = 'online'")) {
          store.feeder.status = 'online';
          store.feeder.is_online = true;
          store.feeder.food_level = params?.[1] ?? store.feeder.food_level;
        }
        if (text.includes("status = 'offline'")) {
          store.feeder.status = 'offline';
          store.feeder.is_online = false;
        }
      },
    };

    await ingestStatusMessage(
      'kennel/home/feeder/feeder-sim-001/status',
      JSON.stringify({
        deviceId: 'feeder-sim-001',
        kennelId: 'home',
        timestamp: 1,
        status: 'online',
        foodLevel: 42,
        lastFeed: 1,
      }),
      db as any
    );
    expect(store.feeder.food_level).toBe(42);
    expect(presentDevice(store.feeder).foodLevel).toBe(42);
    expect(presentDevice(store.feeder).isFoodLow).toBe(false);

    await ingestStatusMessage(
      'kennel/home/feeder/feeder-sim-001/status',
      JSON.stringify({
        deviceId: 'feeder-sim-001',
        kennelId: 'home',
        timestamp: 0,
        status: 'offline',
      }),
      db as any
    );
    expect(store.feeder.food_level).toBe(42);
    expect(presentDevice(store.feeder).foodLevel).toBeNull();
    expect(presentDevice(store.feeder).isFoodLow).toBeNull();
    expect(presentDevice(store.feeder).status).toBe('offline');
  });

  it('ignores forbidden topics', async () => {
    const db = { queryOne: async () => { throw new Error('should not query'); }, execute: async () => {} };
    const result = await ingestStatusMessage(
      'devices/feeder-sim-001/telemetry',
      JSON.stringify({ deviceId: 'feeder-sim-001', kennelId: 'home', timestamp: 1, status: 'online' }),
      db as any
    );
    expect(result).toBeNull();
  });
});
