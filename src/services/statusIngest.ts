import { execute, queryOne } from '../database/index.js';
import {
  deriveIsFoodLow,
  isDeviceOnline,
  parseStatusPayload,
  parseStatusTopic,
} from '../mqtt/contract.js';
import type { DeviceRow, FeederStatusPayload } from '../types.js';

export type DbExec = typeof execute;
export type DbOne = typeof queryOne;

export async function ingestStatusMessage(
  topic: string,
  body: string,
  db: { execute: DbExec; queryOne: DbOne } = { execute, queryOne }
): Promise<FeederStatusPayload | null> {
  const topicParts = parseStatusTopic(topic);
  if (!topicParts) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }

  const payload = parseStatusPayload(raw);
  if (!payload) return null;
  if (payload.deviceId !== topicParts.deviceId || payload.kennelId !== topicParts.kennelId) {
    return null;
  }

  const existing = await db.queryOne<DeviceRow>(
    'SELECT * FROM devices WHERE device_id = $1',
    [payload.deviceId]
  );
  if (!existing) return null;

  const online = isDeviceOnline(payload.status);
  const lastFeed =
    payload.lastFeed != null ? new Date(typeof payload.lastFeed === 'number'
      ? (payload.lastFeed < 1e12 ? payload.lastFeed * 1000 : payload.lastFeed)
      : payload.lastFeed) : null;

  if (online) {
    await db.execute(
      `UPDATE devices
       SET status = 'online',
           is_online = true,
           last_seen = NOW(),
           last_status_at = NOW(),
           food_level = COALESCE($2, food_level),
           last_feed = COALESCE($3, last_feed),
           kennel_id = COALESCE(kennel_id, $4),
           updated_at = NOW()
       WHERE device_id = $1`,
      [payload.deviceId, payload.foodLevel ?? null, lastFeed, payload.kennelId]
    );
  } else {
    await db.execute(
      `UPDATE devices
       SET status = 'offline',
           is_online = false,
           last_status_at = NOW(),
           updated_at = NOW()
       WHERE device_id = $1`,
      [payload.deviceId]
    );
  }

  return payload;
}

export function presentDevice(row: DeviceRow): Record<string, unknown> {
  const online = isDeviceOnline(row.status);
  const presented: Record<string, unknown> = {
    id: row.id,
    deviceId: row.device_id,
    kennelId: row.kennel_id,
    name: row.name,
    deviceType: row.device_type,
    status: online ? 'online' : 'offline',
    isOnline: online,
    lastFeed: row.last_feed,
    lastSeen: row.last_seen,
  };
  if (online) {
    presented.foodLevel = row.food_level;
    presented.isFoodLow = deriveIsFoodLow(row.food_level);
  } else {
    presented.foodLevel = null;
    presented.isFoodLow = null;
  }
  return presented;
}
