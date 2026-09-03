/**
 * LOCKED MQTT contract (24 Sep feeder command path).
 * kennelId = household string. No topic fork (no devices/<id>/telemetry).
 *
 * Device ACL (broker): username device:<deviceId>
 *   SUB kennel/{kennelId}/feeder/{deviceId}/command  only
 *   PUB kennel/{kennelId}/feeder/{deviceId}/status   only
 * Backend (this process) publishes command QoS 2 and subscribes status QoS 1.
 */

export const COMMAND_QOS = 2 as const;
export const STATUS_QOS = 1 as const;
export const STATUS_RETAINED = true;

export function commandTopic(kennelId: string, deviceId: string): string {
  return `kennel/${kennelId}/feeder/${deviceId}/command`;
}

export function statusTopic(kennelId: string, deviceId: string): string {
  return `kennel/${kennelId}/feeder/${deviceId}/status`;
}

export function statusSubscribeFilter(): string {
  return 'kennel/+/feeder/+/status';
}

export function parseStatusTopic(topic: string): { kennelId: string; deviceId: string } | null {
  const parts = topic.split('/');
  if (parts.length !== 5) return null;
  const [kennel, kennelId, feeder, deviceId, leaf] = parts;
  if (kennel !== 'kennel' || feeder !== 'feeder' || leaf !== 'status') return null;
  if (!kennelId || !deviceId) return null;
  return { kennelId, deviceId };
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
