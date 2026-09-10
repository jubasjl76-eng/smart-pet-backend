import mqtt, { MqttClient } from 'mqtt';
import { EventEmitter } from 'events';
import { query } from '../database/index.js';
import { config, mqttUrl } from '../config/index.js';
import { injectTrace } from '../mqtt/trace.js';
import { log } from '../log.js';

const mlog = log.child({ mod: 'feeder-mqtt' });

const STATUS_WILDCARD = 'kennel/+/feeder/+/status';
const ACK_TIMEOUT_MS = 15000;

export type StatusPayload = {
  deviceId: string;
  kennelId: string;
  timestamp: number;
  status: string;
  foodLevel?: number;
  lastFeed?: number;
  fwVersion?: string;
};

const bus = new EventEmitter();
bus.setMaxListeners(50);

let client: MqttClient | null = null;

/** True once the backend's feeder MQTT client has an open broker connection. */
export function isFeederMqttConnected(): boolean {
  return !!client?.connected;
}

/** Close the feeder MQTT client (graceful shutdown). */
export function stopFeederMqtt(): void {
  client?.end();
  client = null;
}

export function commandTopic(kennelId: string, deviceId: string, deviceType = 'feeder'): string {
  return `kennel/${kennelId}/${deviceType}/${deviceId}/command`;
}

export function statusTopic(kennelId: string, deviceId: string): string {
  return `kennel/${kennelId}/feeder/${deviceId}/status`;
}

// Fleet kill switch (Phase 19, A12 #17). Retained, kennel-wide.
export function fleetControlTopic(kennelId: string): string {
  return `kennel/${kennelId}/_control`;
}

export function publishFleetControl(
  kennelId: string,
  body: { safeMode: boolean; reason?: string; at?: string; by?: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!client || !client.connected) {
      reject(new Error('MQTT broker not connected'));
      return;
    }
    client.publish(fleetControlTopic(kennelId), JSON.stringify(body), { qos: 1, retain: true }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

async function resyncFleetControl(): Promise<void> {
  try {
    const { query } = await import('../database/index.js');
    const rows = await query<{ kennel_id: string; reason: string | null; updated_at: string }>(
      `SELECT kennel_id, reason, updated_at FROM fleet_control WHERE safe_mode = true`,
    );
    for (const r of rows) {
      await publishFleetControl(r.kennel_id, {
        safeMode: true,
        reason: r.reason ?? undefined,
        at: new Date(r.updated_at).toISOString(),
      }).catch(() => {});
    }
    if (rows.length) mlog.warn({ kennels: rows.length }, 're-asserted fleet safe-mode');
  } catch (e) {
    mlog.error({ err: e }, 'fleet-control resync failed');
  }
}

function parseStatus(raw: Buffer): StatusPayload | null {
  try {
    const p = JSON.parse(raw.toString());
    if (!p || !p.deviceId || !p.kennelId) return null;
    return {
      deviceId: String(p.deviceId),
      kennelId: String(p.kennelId),
      timestamp: Number(p.timestamp || 0),
      status: String(p.status || 'offline'),
      foodLevel: p.foodLevel !== undefined ? Number(p.foodLevel) : undefined,
      lastFeed: p.lastFeed !== undefined ? Number(p.lastFeed) : undefined,
      fwVersion: p.fw ?? p.fwVersion ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function applyStatus(p: StatusPayload): Promise<void> {
  const online = p.status === 'online';
  const food = p.status === 'offline' || p.foodLevel === undefined ? null : p.foodLevel;
  await query(
    `UPDATE devices SET
       is_online = $1,
       status = $2,
       last_seen = CASE WHEN $1 THEN NOW() ELSE last_seen END,
       food_level = COALESCE($3, food_level),
       latest_value = COALESCE($3, latest_value),
       last_feed = COALESCE($4, last_feed),
       kennel_id = COALESCE(kennel_id, $5),
       fw_version = COALESCE($7, fw_version),
       fw_updated_at = CASE WHEN $7 IS NOT NULL AND $7 IS DISTINCT FROM fw_version THEN NOW() ELSE fw_updated_at END,
       updated_at = NOW()
     WHERE device_id = $6`,
    [online, online ? 'online' : 'offline', food, p.lastFeed ?? null, p.kennelId, p.deviceId, p.fwVersion ?? null]
  );
  bus.emit(`status:${p.deviceId}`, p);
}

export function startFeederMqtt(): void {
  const opts: mqtt.IClientOptions = {
    clientId: config.MQTT_CLIENT_ID,
    username: config.MQTT_USERNAME || config.MQTT_USER || undefined,
    password: config.MQTT_PASSWORD || undefined,
    reconnectPeriod: 5000,
    clean: false,
  };
  client = mqtt.connect(mqttUrl(), opts);
  client.on('connect', () => {
    client!.subscribe(STATUS_WILDCARD, { qos: 1 }, (err) => {
      if (err) mlog.error({ err }, 'status subscribe failed');
    });
    // Re-assert the retained kill-switch state for any halted kennel — the
    // broker may have lost retained messages across a restart.
    void resyncFleetControl();
  });
  client.on('message', async (topic, payload) => {
    if (!topic.endsWith('/status')) return;
    const p = parseStatus(payload);
    if (!p) return;
    try {
      await applyStatus(p);
    } catch (e) {
      mlog.error({ err: e }, 'status ingest failed');
    }
  });
  client.on('error', (e) => mlog.error({ err: e }, 'mqtt error'));
}

export function publishCommand(
  kennelId: string, deviceId: string, body: object, deviceType = 'feeder',
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!client || !client.connected) {
      reject(new Error('MQTT broker not connected'));
      return;
    }
    const topic = commandTopic(kennelId, deviceId, deviceType);
    // W3C Trace Context so the device ack links to this command (Phase 16).
    injectTrace(body as Record<string, unknown>);
    client.publish(topic, JSON.stringify(body), { qos: 2 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function waitForStatusAck(deviceId: string, sinceMs: number, timeoutMs = ACK_TIMEOUT_MS): Promise<StatusPayload> {
  return new Promise((resolve, reject) => {
    const key = `status:${deviceId}`;
    const timer = setTimeout(() => {
      bus.off(key, onStatus);
      reject(new Error('Device ack timeout'));
    }, timeoutMs);
    function onStatus(p: StatusPayload) {
      if (p.status !== 'online') return;
      const lastFeed = p.lastFeed != null ? Number(p.lastFeed) : NaN;
      if (Number.isFinite(lastFeed)) {
        if (lastFeed < sinceMs) return;
      } else if (p.timestamp && p.timestamp < sinceMs) {
        return;
      }
      clearTimeout(timer);
      bus.off(key, onStatus);
      resolve(p);
    }
    bus.on(key, onStatus);
  });
}

export async function publishFeedAndWait(kennelId: string, deviceId: string, amount: number): Promise<StatusPayload> {
  const timestamp = Date.now();
  await publishCommand(kennelId, deviceId, {
    command: 'feed',
    deviceId,
    kennelId,
    timestamp,
    params: { amount },
  });
  return waitForStatusAck(deviceId, timestamp);
}

export async function publishScheduleSet(
  kennelId: string,
  deviceId: string,
  schedules: { id: string; time: string; amount: number; enabled: boolean }[]
): Promise<void> {
  await publishCommand(kennelId, deviceId, {
    command: 'schedule_set',
    deviceId,
    kennelId,
    timestamp: Date.now(),
    params: { schedules },
  });
}

export function isFoodLow(foodLevel: number | null | undefined): boolean {
  return typeof foodLevel === 'number' && foodLevel < 20;
}

// ── FeederBus: testable seam over publish + status-ack ──────────────────────
import type { FeederStatusPayload } from '../types.js';

const COMMAND_QOS = 2 as const;

export interface FeederBus {
  waitForStatus(
    deviceId: string,
    predicate: (status: FeederStatusPayload) => boolean,
    timeoutMs: number
  ): Promise<FeederStatusPayload>;
  publishCommand(topic: string, payload: object): Promise<void>;
}

export type MemoryBus = FeederBus & {
  published: Array<{ topic: string; payload: any; qos: number }>;
};

type Waiter = {
  deviceId: string;
  predicate: (s: FeederStatusPayload) => boolean;
  settle: (s: FeederStatusPayload) => void;
};

const memoryWaiters = new Set<Waiter>();
let activeBus: FeederBus | null = null;

export function setFeederBus(bus: FeederBus): void {
  activeBus = bus;
}

export function getFeederBus(): FeederBus {
  return activeBus ?? liveBus;
}

/** Deliver a status message to any in-memory waiter whose predicate matches. */
export function notifyStatus(status: FeederStatusPayload): void {
  for (const w of Array.from(memoryWaiters)) {
    if (w.deviceId === status.deviceId && w.predicate(status)) {
      memoryWaiters.delete(w);
      w.settle(status);
    }
  }
}

/** In-memory bus for tests: records published commands, resolved via notifyStatus(). */
export function createMemoryBus(): MemoryBus {
  const bus: MemoryBus = {
    published: [],
    publishCommand(topic: string, payload: object): Promise<void> {
      bus.published.push({ topic, payload, qos: COMMAND_QOS });
      return Promise.resolve();
    },
    waitForStatus(deviceId, predicate, timeoutMs) {
      return new Promise<FeederStatusPayload>((resolve, reject) => {
        const waiter: Waiter = {
          deviceId,
          predicate,
          settle: (s) => {
            clearTimeout(timer);
            resolve(s);
          },
        };
        const timer = setTimeout(() => {
          memoryWaiters.delete(waiter);
          reject(new Error(`Device ${deviceId} did not ack in ${timeoutMs}ms`));
        }, timeoutMs);
        memoryWaiters.add(waiter);
      });
    },
  };
  return bus;
}

/** Live bus backed by the real MQTT client + status EventEmitter. */
const liveBus: FeederBus = {
  waitForStatus(deviceId, predicate, timeoutMs) {
    return new Promise<FeederStatusPayload>((resolve, reject) => {
      const key = `status:${deviceId}`;
      const timer = setTimeout(() => {
        bus.off(key, onStatus);
        reject(new Error(`Device ${deviceId} did not ack in ${timeoutMs}ms`));
      }, timeoutMs);
      function onStatus(p: StatusPayload) {
        if (!predicate(p as unknown as FeederStatusPayload)) return;
        clearTimeout(timer);
        bus.off(key, onStatus);
        resolve(p as unknown as FeederStatusPayload);
      }
      bus.on(key, onStatus);
    });
  },
  publishCommand(topic: string, payload: object): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!client || !client.connected) {
        reject(new Error('MQTT broker not connected'));
        return;
      }
      client.publish(topic, JSON.stringify(payload), { qos: COMMAND_QOS }, (err) =>
        err ? reject(err) : resolve()
      );
    });
  },
};
