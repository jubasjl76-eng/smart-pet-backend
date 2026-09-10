/**
 * Feeder command path (24 Sep locked wire format), now built on the shared
 * contract package.
 *
 * The topic scheme + QoS/retain policy come from `@jubasjl76-eng/mqtt-contract`
 * (hardening Phase 14, ADR-0001) — the strings are byte-identical to what this
 * module used to hand-roll, and `command-path`/`status-ingest` tests pin them.
 *
 * The PAYLOAD layer below stays local on purpose: the deployed feeder firmware
 * speaks a v1 dialect (no `command.id`, permissive `status` string) that the
 * package's v2 `buildFeed` / `parseStatus` would break. Converging those needs
 * a firmware rev + staged rollout, tracked separately.
 *
 * Device ACL (broker): username device:<deviceId>
 *   SUB kennel/{kennelId}/feeder/{deviceId}/command  only
 *   PUB kennel/{kennelId}/feeder/{deviceId}/status   only
 */
import {
  commandTopic as pkgCommandTopic,
  statusTopic as pkgStatusTopic,
  allOf,
  parseTopic,
  deliveryFor,
} from '@jubasjl76-eng/mqtt-contract';

export const COMMAND_QOS = deliveryFor('command').qos; // 2
export const STATUS_QOS = deliveryFor('status').qos; // 1
export const STATUS_RETAINED = deliveryFor('status').retain; // true

export function commandTopic(kennelId: string, deviceId: string): string {
  return pkgCommandTopic(kennelId, 'feeder', deviceId);
}

export function statusTopic(kennelId: string, deviceId: string): string {
  return pkgStatusTopic(kennelId, 'feeder', deviceId);
}

export function statusSubscribeFilter(): string {
  return allOf('feeder', 'status'); // kennel/+/feeder/+/status
}

export function parseStatusTopic(topic: string): { kennelId: string; deviceId: string } | null {
  const parts = parseTopic(topic);
  if (!parts || parts.deviceType !== 'feeder' || parts.leaf !== 'status') return null;
  return { kennelId: parts.kennelId, deviceId: parts.deviceId };
}

export type FeedCommand = {
  command: 'feed';
  deviceId: string;
  kennelId: string;
  timestamp: number;
  params: { amount: number };
};

export type ScheduleEntry = {
  id: string;
  time: string; // HH:mm
  amount: number;
  enabled: boolean;
};

export type ScheduleSetCommand = {
  command: 'schedule_set';
  deviceId: string;
  kennelId: string;
  timestamp: number;
  params: { schedules: ScheduleEntry[] };
};

export type FeederCommand = FeedCommand | ScheduleSetCommand;

export type FeederStatus = {
  deviceId: string;
  kennelId: string;
  timestamp: number;
  status: string;
  foodLevel?: number;
  lastFeed?: number | string;
};

export type LwtStatus = {
  deviceId: string;
  kennelId: string;
  timestamp: 0;
  status: 'offline';
};

export function buildFeedCommand(args: {
  deviceId: string;
  kennelId: string;
  timestamp: number;
  amount: number;
}): FeedCommand {
  return {
    command: 'feed',
    deviceId: args.deviceId,
    kennelId: args.kennelId,
    timestamp: args.timestamp,
    params: { amount: args.amount },
  };
}

export function buildScheduleSetCommand(args: {
  deviceId: string;
  kennelId: string;
  timestamp: number;
  schedules: ScheduleEntry[];
}): ScheduleSetCommand {
  return {
    command: 'schedule_set',
    deviceId: args.deviceId,
    kennelId: args.kennelId,
    timestamp: args.timestamp,
    params: { schedules: args.schedules },
  };
}

export function mqttUsername(deviceId: string): string {
  return `device:${deviceId}`;
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isHhMm(value: string): boolean {
  return HH_MM.test(value);
}

export function formatHhMm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// ── Status / topic helpers (shared by statusIngest + feedNow) ────────────────

/** Topics outside the locked kennel/{kennelId}/{deviceType}/{deviceId}/... scheme. */
export function isForbiddenTopic(topic: string): boolean {
  if (topic.startsWith('devices/')) return true;
  if (topic.includes('/telemetry')) return true;
  if (topic.endsWith('/commands')) return true;
  return false;
}

export function isDeviceOnline(status: string | null | undefined): boolean {
  return status === 'online';
}

/** foodLevel < 20 is "low". Derived in the app, never trusted from the wire. */
export function deriveIsFoodLow(foodLevel: number | null | undefined): boolean {
  return typeof foodLevel === 'number' && Number.isFinite(foodLevel) && foodLevel < 20;
}

/** Normalise a lastFeed value (epoch seconds, epoch ms, or ISO string) to ms. */
export function lastFeedToMs(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1e12 ? Math.round(value * 1000) : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Parse an inbound status payload, dropping any key not in the locked contract. */
export function parseStatusPayload(raw: unknown): FeederStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.deviceId !== 'string' || typeof p.kennelId !== 'string') return null;
  const out: FeederStatus = {
    deviceId: p.deviceId,
    kennelId: p.kennelId,
    timestamp: typeof p.timestamp === 'number' ? p.timestamp : 0,
    status: typeof p.status === 'string' ? p.status : 'offline',
  };
  if (typeof p.foodLevel === 'number') out.foodLevel = p.foodLevel;
  if (typeof p.lastFeed === 'number' || typeof p.lastFeed === 'string') {
    out.lastFeed = p.lastFeed as number | string;
  }
  return out;
}

/** Last-will payload: same status topic, retained, never carries a foodLevel. */
export function buildLwtPayload(deviceId: string, kennelId: string): LwtStatus {
  return { deviceId, kennelId, timestamp: 0, status: 'offline' };
}

/** Alias kept for callers that import the shorter name. */
export const buildScheduleSet = buildScheduleSetCommand;
