import mqtt, { MqttClient } from 'mqtt';
import { EventEmitter } from 'events';
import { query } from '../database/index.js';

const STATUS_WILDCARD = 'kennel/+/feeder/+/status';
const ACK_TIMEOUT_MS = 15000;

export type StatusPayload = {
  deviceId: string;
  kennelId: string;
  timestamp: number;
  status: string;
  foodLevel?: number;
  lastFeed?: number;
};

const bus = new EventEmitter();
bus.setMaxListeners(50);

let client: MqttClient | null = null;

export function commandTopic(kennelId: string, deviceId: string): string {
  return `kennel/${kennelId}/feeder/${deviceId}/command`;
}

export function statusTopic(kennelId: string, deviceId: string): string {
  return `kennel/${kennelId}/feeder/${deviceId}/status`;
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
       updated_at = NOW()
     WHERE device_id = $6`,
    [online, online ? 'online' : 'offline', food, p.lastFeed ?? null, p.kennelId, p.deviceId]
  );
  bus.emit(`status:${p.deviceId}`, p);
}

export function startFeederMqtt(): void {
  const url = process.env.MQTT_URL || 'mqtt://localhost:1883';
  const opts: mqtt.IClientOptions = {
    clientId: process.env.MQTT_CLIENT_ID || 'smart-pet-backend',
    username: process.env.MQTT_USERNAME || process.env.MQTT_USER || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 5000,
    clean: false,
  };
  client = mqtt.connect(url, opts);
  client.on('connect', () => {
    client!.subscribe(STATUS_WILDCARD, { qos: 1 }, (err) => {
      if (err) console.error('[mqtt] status subscribe failed', err);
    });
  });
  client.on('message', async (topic, payload) => {
    if (!topic.endsWith('/status')) return;
    const p = parseStatus(payload);
    if (!p) return;
    try {
      await applyStatus(p);
    } catch (e) {
      console.error('[mqtt] status ingest failed', e);
    }
  });
  client.on('error', (e) => console.error('[mqtt]', e.message));
}

export function publishCommand(kennelId: string, deviceId: string, body: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!client || !client.connected) {
      reject(new Error('MQTT broker not connected'));
      return;
    }
    const topic = commandTopic(kennelId, deviceId);
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
