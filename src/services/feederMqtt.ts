import mqtt, { MqttClient } from 'mqtt';
import {
  COMMAND_QOS,
  STATUS_QOS,
  commandTopic,
  statusWildcard,
} from '../mqtt/contract.js';
import { ingestStatusMessage } from './statusIngest.js';
import type { FeederStatusPayload } from '../types.js';

export type StatusPredicate = (status: FeederStatusPayload) => boolean;

export interface FeederBus {
  publishCommand(topic: string, payload: object): Promise<void>;
  waitForStatus(deviceId: string, pred: StatusPredicate, timeoutMs: number): Promise<FeederStatusPayload>;
  connected(): boolean;
}

type Waiter = { pred: StatusPredicate; resolve: (s: FeederStatusPayload) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const waiters = new Map<string, Waiter[]>();
let bus: FeederBus | null = null;
let client: MqttClient | null = null;

export function getFeederBus(): FeederBus | null {
  return bus;
}

export function setFeederBus(next: FeederBus | null): void {
  bus = next;
}

export function notifyStatus(payload: FeederStatusPayload): void {
  const list = waiters.get(payload.deviceId);
  if (!list?.length) return;
  const remaining: Waiter[] = [];
  for (const w of list) {
    if (w.pred(payload)) {
      clearTimeout(w.timer);
      w.resolve(payload);
    } else {
      remaining.push(w);
    }
  }
  if (remaining.length) waiters.set(payload.deviceId, remaining);
  else waiters.delete(payload.deviceId);
}

function addWaiter(deviceId: string, pred: StatusPredicate, timeoutMs: number): Promise<FeederStatusPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const list = (waiters.get(deviceId) || []).filter((w) => w.timer !== timer);
      if (list.length) waiters.set(deviceId, list);
      else waiters.delete(deviceId);
      reject(new Error('Device did not ack feed via status'));
    }, timeoutMs);
    const entry: Waiter = { pred, resolve, reject, timer };
    const list = waiters.get(deviceId) || [];
    list.push(entry);
    waiters.set(deviceId, list);
  });
}

export function createMemoryBus(): FeederBus {
  const published: Array<{ topic: string; payload: object; qos: number }> = [];
  const mem: FeederBus & { published: typeof published } = {
    published,
    connected: () => true,
    async publishCommand(topic: string, payload: object) {
      published.push({ topic, payload, qos: COMMAND_QOS });
    },
    waitForStatus(deviceId, pred, timeoutMs) {
      return addWaiter(deviceId, pred, timeoutMs);
    },
  };
  return mem;
}

export async function handleIncomingStatus(topic: string, body: string): Promise<void> {
  const payload = await ingestStatusMessage(topic, body);
  if (payload) notifyStatus(payload);
}

export function startFeederMqttFromEnv(): void {
  const broker = process.env.MQTT_BROKER;
  if (!broker) {
    console.warn('[mqtt] MQTT_BROKER unset; feeder command path will return 503 until configured');
    return;
  }

  const mqttClient = mqtt.connect(broker, {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASSWORD,
    clientId: 'smart-pet-backend-feeder-' + Math.random().toString(16).slice(2, 10),
    reconnectPeriod: 5000,
  });
  client = mqttClient;

  mqttClient.on('connect', () => {
    console.log('[mqtt] feeder bus connected');
    mqttClient.subscribe(statusWildcard(), { qos: STATUS_QOS }, (err) => {
      if (err) console.error('[mqtt] status subscribe failed', err);
      else console.log(`[mqtt] subscribed ${statusWildcard()} qos ${STATUS_QOS}`);
    });
  });

  mqttClient.on('message', (topic, message) => {
    handleIncomingStatus(topic, message.toString()).catch((err) => {
      console.error('[mqtt] status ingest error', err);
    });
  });

  mqttClient.on('error', (err) => {
    console.error('[mqtt] error', err.message);
  });

  bus = {
    connected: () => mqttClient.connected,
    async publishCommand(topic: string, payload: object) {
      await new Promise<void>((resolve, reject) => {
        mqttClient.publish(topic, JSON.stringify(payload), { qos: COMMAND_QOS }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    waitForStatus(deviceId, pred, timeoutMs) {
      return addWaiter(deviceId, pred, timeoutMs);
    },
  };
}

export function stopFeederMqtt(): void {
  client?.end();
  client = null;
  bus = null;
}

export { commandTopic };
