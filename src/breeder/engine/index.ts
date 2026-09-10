/**
 * Breeder engine bootstrap.
 *
 * - Subscribes to `kennel/+/#`, normalises each message into a RuleEvent and
 *   feeds it to the rules + maintenance evaluator.
 * - Runs a periodic tick: notification drain + escalations, consumable sweep,
 *   missed-medication sweep, and offline detection.
 *
 * Safe to start even with no broker: mqtt.connect retries in the background and
 * the periodic tick is broker-independent.
 */
import mqtt, { type MqttClient } from 'mqtt';
import { query, execute } from '../../database/index.js';
import { config, mqttUrl } from '../../config/index.js';
import type { RuleEvent } from '../logic/rules.js';
import { ingestEvent } from './rulesEngine.js';
import { notifierTick } from './notifier.js';
import { consumableStatus } from '../logic/consumables.js';
import { missedDoses, type MedSchedule, type MedLog } from '../logic/medications.js';
import { vaccinationSweep } from '../routes/vaccinations.js';
import { updatePackSweep } from '../routes/buyerComms.js';
import { breedingSweep } from '../routes/breeding.js';
import { retentionSweep } from '../routes/privacy.js';
import { fleetSweep } from '../routes/fleet.js';
import { raiseException } from '../exceptions.js';
import { emitStream } from '../stream.js';
import { handleCrashEvent } from './crashReport.js';
import { withExtractedTrace } from '../../mqtt/trace.js';
import { log } from '../../log.js';

const elog = log.child({ mod: 'engine' });

let client: MqttClient | null = null;
let tickTimer: NodeJS.Timeout | null = null;

const TOPIC = /^kennel\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/;

export function normaliseMessage(topic: string, payloadRaw: Buffer | string): RuleEvent[] {
  const m = TOPIC.exec(topic);
  if (!m) return [];
  const [, kennelId, deviceType, deviceId, leaf] = m;
  let p: any = {};
  try { p = JSON.parse(payloadRaw.toString()); } catch { /* non-JSON payload */ }
  const at = new Date();
  const base = { kennelId, deviceId, deviceType, meta: p?.penId ? { penId: p.penId } : {}, at };
  const events: RuleEvent[] = [];

  if (leaf === 'status') {
    events.push({ ...base, type: 'device_status', status: String(p.status ?? 'unknown') });
    if (typeof p.rssi === 'number') events.push({ ...base, type: 'telemetry', metric: 'rssi', value: p.rssi });
    if (p.event === 'jam' || p.jam === true) events.push({ ...base, type: 'jam' });
  } else if (leaf === 'event') {
    const kind = String(p.event ?? p.type ?? '');
    if (kind === 'feed' || kind === 'feed_acked') events.push({ ...base, type: 'feed_acked' });
    if (kind === 'dispense' || kind === 'dispense_acked') events.push({ ...base, type: 'dispense_acked', value: Number(p.seconds ?? p.durationSec ?? 0) });
    if (kind === 'door_open' || kind === 'door_opened') events.push({ ...base, type: 'door_opened' });
    if (kind === 'jam') events.push({ ...base, type: 'jam' });
    if (kind === 'crash') {
      // spd_mqtt publishEvent() nests the fill() fields under `data`.
      const cd = (p.data && typeof p.data === 'object') ? p.data : p;
      events.push({
        ...base,
        type: 'device_crash',
        meta: {
          ...base.meta,
          reason: cd.reason, rawReason: cd.rawReason, fw: cd.fw,
          heapFree: cd.heapFree, minHeapFree: cd.minHeapFree,
        },
      });
    }
  } else if (leaf === 'location') {
    if (typeof p.battery === 'number') events.push({ ...base, type: 'low_battery', value: p.battery, metric: 'battery' });
  } else if (['temperature', 'humidity', 'airquality'].includes(leaf)) {
    events.push({ ...base, type: 'telemetry', metric: leaf, value: Number(p.value ?? p[leaf]) });
  }
  return events;
}

async function onMessage(topic: string, payload: Buffer): Promise<void> {
  // Continue the device's trace if the payload carries a traceparent (Phase 16).
  let carrier: Record<string, unknown> = {};
  try { carrier = JSON.parse(payload.toString()); } catch { /* non-JSON */ }

  await withExtractedTrace(carrier, async () => {
    for (const event of normaliseMessage(topic, payload)) {
      if (event.type === 'device_status' && event.deviceId) {
        emitStream(event.kennelId, { type: 'device', deviceId: event.deviceId, status: event.status ?? 'unknown' });
      }
      if (event.type === 'device_crash') {
        await handleCrashEvent(event).catch((e) => elog.error({ err: e }, 'crash report failed'));
        continue;
      }
      try {
        await ingestEvent(event);
      } catch (e) {
        elog.error({ err: e }, 'ingest failed');
      }
    }
  });
}

// ── Periodic sweeps ───────────────────────────────────────────────────────

async function sweepConsumables(): Promise<void> {
  const rows = await query<any>(`SELECT * FROM consumables`);
  for (const c of rows) {
    const status = consumableStatus({ onHand: c.on_hand, lowThreshold: c.low_threshold, dailyUse: c.daily_use ?? null });
    if (status.level === 'ok') continue;
    await raiseException({
      kennelId: c.kennel_id, kind: 'consumable-low',
      severity: status.level === 'low' ? 'warning' : 'critical',
      title: `${c.name} ${status.level === 'out' ? 'out of stock' : 'low'}`,
      detail: status.message, dedupKey: `consumable-low:${c.id}`,
      suggestedAction: 'Restock and update the on-hand count', notifyAudience: 'manager',
    }).catch(() => {});
  }
}

function medRow(m: any): MedSchedule {
  return { id: m.id, timesOfDay: m.times_of_day ?? [], daysOfWeek: m.days_of_week ?? [], startsOn: m.starts_on, endsOn: m.ends_on, active: m.active };
}

async function sweepMissedMeds(): Promise<void> {
  const meds = await query<any>(`SELECT * FROM medications WHERE active=true`);
  const now = new Date();
  for (const m of meds) {
    const logs = await query<any>(
      `SELECT medication_id, scheduled_for, administered_at, outcome FROM medication_logs
        WHERE medication_id=$1 AND administered_at > NOW() - INTERVAL '3 days'`, [m.id]
    );
    const medLogs: MedLog[] = logs.map((l) => ({ medicationId: l.medication_id, scheduledFor: l.scheduled_for ?? l.administered_at, outcome: l.outcome }));
    const missed = missedDoses(medRow(m), medLogs, now);
    if (!missed.length) continue;
    await raiseException({
      kennelId: m.kennel_id, kind: 'med-missed', severity: 'critical', animalId: m.animal_id,
      title: `Missed dose: ${m.name}`,
      detail: `${missed.length} overdue, oldest ${missed[0].toISOString()}`,
      suggestedAction: 'Give and log the dose, or mark skipped with a reason',
      dedupKey: `med-missed:${m.id}`, notifyAudience: 'on-call',
    }).catch(() => {});
  }
}

async function detectOffline(): Promise<void> {
  // Devices last seen > 10 min ago that we have not already flagged.
  const stale = await query<{ device_id: string; kennel_id: string; name: string | null; last_seen: string }>(
    `SELECT device_id, kennel_id, name, last_seen FROM devices
      WHERE last_seen IS NOT NULL AND last_seen < NOW() - INTERVAL '10 minutes'
        AND (status IS DISTINCT FROM 'offline')`
  );
  for (const d of stale) {
    await execute(`UPDATE devices SET status='offline', is_online=false WHERE device_id=$1`, [d.device_id]);
    emitStream(d.kennel_id, { type: 'device', deviceId: d.device_id, status: 'offline' });
    await ingestEvent({
      type: 'device_offline', kennelId: d.kennel_id, deviceId: d.device_id, at: new Date(),
    }).catch(() => {});
    await raiseException({
      kennelId: d.kennel_id, kind: 'device-offline', severity: 'warning', deviceId: d.device_id,
      title: `${d.name ?? d.device_id} offline`, detail: `Last seen ${d.last_seen}`,
      suggestedAction: 'Check power and Wi-Fi at the pen', dedupKey: `device-offline:${d.device_id}`,
    }).catch(() => {});
  }
}

export async function engineTick(): Promise<void> {
  const step = (name: string, p: Promise<unknown>) =>
    p.catch((e) => elog.warn({ step: name, err: e }, 'tick step failed'));
  await step('notifier', notifierTick());
  await step('consumables', sweepConsumables());
  await step('meds', sweepMissedMeds());
  await step('vaccinations', vaccinationSweep());
  await step('update-pack', updatePackSweep());
  await step('breeding', breedingSweep());
  await step('retention', retentionSweep());
  await step('fleet', fleetSweep());
  await step('offline-detect', detectOffline());
}

export function startBreederEngine(): void {
  client = mqtt.connect(mqttUrl(), {
    clientId: config.MQTT_CLIENT_ID + '-breeder',
    username: config.MQTT_USERNAME || config.MQTT_USER || undefined,
    password: config.MQTT_PASSWORD || undefined,
    reconnectPeriod: 5000,
    clean: true,
  });
  client.on('connect', () => {
    client!.subscribe('kennel/+/+/+/+', { qos: 1 }, (err) => {
      if (err) elog.error({ err }, 'subscribe failed');
      else elog.info('subscribed kennel/+/+/+/+');
    });
  });
  client.on('message', (t, p) => { void onMessage(t, p); });
  client.on('error', (e) => elog.error({ err: e }, 'mqtt error'));

  const intervalMs = Number(process.env.BREEDER_TICK_MS || 60_000);
  tickTimer = setInterval(() => { void engineTick(); }, intervalMs);
  if (tickTimer.unref) tickTimer.unref();
  elog.info({ tickMs: intervalMs }, 'breeder engine started');
}

export function stopBreederEngine(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  client?.end(true);
  client = null;
}
