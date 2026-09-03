/**
 * Locked MQTT contract (24 Sep feeder command path).
 * Do NOT fork to devices/<id>/telemetry or devices/<id>/commands.
 */
import { FOOD_LOW_THRESHOLD } from '../config.js';
import type {
  FeedCommandPayload,
  FeederStatusPayload,
  ScheduleSetEntry,
  ScheduleSetPayload,
} from '../types.js';

export const COMMAND_QOS = 2 as const;
export const STATUS_QOS = 1 as const;
export const STATUS_RETAINED = true;

export function commandTopic(kennelId: string, deviceId: string): string {
  return `kennel/${kennelId}/feeder/${deviceId}/command`;
}

export function statusTopic(kennelId: string, deviceId: string): string {
  return `kennel/${kennelId}/feeder/${deviceId}/status`;
}

export function statusWildcard(): string {
  return 'kennel/+/feeder/+/status';
}

export function mqttUsername(deviceId: string): string {
  return `device:${deviceId}`;
}

export function buildFeedCommand(opts: {
  deviceId: string;
  kennelId: string;
  timestamp: number;
  amount: number;
}): FeedCommandPayload {
  return {
    command: 'feed',
    deviceId: opts.deviceId,
    kennelId: opts.kennelId,
    timestamp: opts.timestamp,
    params: { amount: opts.amount },
  };
}

export function buildScheduleSet(opts: {
  deviceId: string;
  kennelId: string;
  timestamp: number;
  schedules: ScheduleSetEntry[];
}): ScheduleSetPayload {
  return {
    command: 'schedule_set',
    deviceId: opts.deviceId,
    kennelId: opts.kennelId,
    timestamp: opts.timestamp,
    params: { schedules: opts.schedules },
  };
}

export function buildLwtPayload(deviceId: string, kennelId: string): Record<string, unknown> {
  return {
    deviceId,
    kennelId,
    timestamp: 0,
    status: 'offline',
  };
}

export function parseStatusTopic(topic: string): { kennelId: string; deviceId: string } | null {
  const m = /^kennel\/([^/]+)\/feeder\/([^/]+)\/status$/.exec(topic);
  if (!m) return null;
  return { kennelId: m[1], deviceId: m[2] };
}

export function isForbiddenTopic(topic: string): boolean {
  return (
    /^devices\/[^/]+\/(telemetry|commands)$/.test(topic) ||
    topic.includes('/#') ||
    /^kennel\/\+$/.test(topic)
  );
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function parseStatusPayload(raw: unknown): FeederStatusPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.deviceId !== 'string' || typeof o.kennelId !== 'string') return null;
  const timestamp = toNumber(o.timestamp);
  if (timestamp === undefined) return null;
  if (typeof o.status !== 'string') return null;

  const parsed: FeederStatusPayload = {
    deviceId: o.deviceId,
    kennelId: o.kennelId,
    timestamp,
    status: o.status,
  };

  // isFoodLow is NOT on the wire. Ignore if a device sends it.
  const foodLevel = toNumber(o.foodLevel);
  if (foodLevel !== undefined) parsed.foodLevel = foodLevel;
  if (o.lastFeed !== undefined && o.lastFeed !== null) {
    parsed.lastFeed = o.lastFeed as number | string;
  }
  return parsed;
}

export function isDeviceOnline(status: string | undefined | null): boolean {
  return status === 'online';
}

export function deriveIsFoodLow(foodLevel: number | null | undefined): boolean {
  return foodLevel != null && foodLevel < FOOD_LOW_THRESHOLD;
}

export function lastFeedToMs(lastFeed: number | string | Date | null | undefined): number | null {
  if (lastFeed == null) return null;
  if (typeof lastFeed === 'number') {
    return lastFeed < 1e12 ? lastFeed * 1000 : lastFeed;
  }
  const t = new Date(lastFeed).getTime();
  return Number.isFinite(t) ? t : null;
}
