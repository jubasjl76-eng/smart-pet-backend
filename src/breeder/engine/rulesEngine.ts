/**
 * Rules + maintenance evaluation over a normalised device-event stream.
 *
 * `ingestEvent` is the single entry point; the MQTT subscriber and any internal
 * producers (schedule checker, offline detector) call it. It:
 *   1. updates predictive-maintenance counters
 *   2. evaluates enabled rules for the kennel
 *   3. executes matched actions (raise_exception / notify / device_command / set_pen_relay)
 */
import { query, queryOne, execute } from '../../database/index.js';
import { evaluateRule, type Rule, type RuleEvent, type RuleAction } from '../logic/rules.js';
import { predictMaintenance, ewma } from '../logic/maintenance.js';
import { raiseException } from '../exceptions.js';
import { publishCommand } from '../../services/feederMqtt.js';

function toRule(row: any): Rule {
  return {
    id: row.id, kennelId: row.kennel_id, name: row.name, enabled: row.enabled,
    trigger: row.trigger, conditions: row.conditions ?? [], actions: row.actions ?? [],
    cooldownSeconds: row.cooldown_seconds ?? 300, lastFiredAt: row.last_fired_at,
  };
}

async function bumpCounter(kennelId: string, deviceId: string, metric: string, delta: number): Promise<number> {
  const row = await queryOne<{ value: number; service_limit: number | null }>(
    `INSERT INTO device_health_counters (kennel_id, device_id, metric, value)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (device_id, metric) DO UPDATE SET value = device_health_counters.value + $4, updated_at=NOW()
     RETURNING value, service_limit`,
    [kennelId, deviceId, metric, delta]
  );
  return row?.value ?? 0;
}

async function setCounter(kennelId: string, deviceId: string, metric: string, value: number): Promise<void> {
  await execute(
    `INSERT INTO device_health_counters (kennel_id, device_id, metric, value)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (device_id, metric) DO UPDATE SET value=$4, updated_at=NOW()`,
    [kennelId, deviceId, metric, value]
  );
}

async function updateMaintenance(event: RuleEvent): Promise<void> {
  if (!event.deviceId) return;
  const k = event.kennelId;

  if (event.type === 'feed_acked') {
    const v = await bumpCounter(k, event.deviceId, 'servo_cycles', 1);
    await maybeRaiseMaintenance(k, event.deviceId, 'servo_cycles', v);
  }
  if (event.type === 'door_opened') {
    const v = await bumpCounter(k, event.deviceId, 'door_cycles', 1);
    await maybeRaiseMaintenance(k, event.deviceId, 'door_cycles', v);
  }
  if (event.type === 'dispense_acked' && typeof event.value === 'number') {
    const v = await bumpCounter(k, event.deviceId, 'pump_seconds', event.value);
    await maybeRaiseMaintenance(k, event.deviceId, 'pump_seconds', v);
  }
  if (event.type === 'jam') {
    const v = await bumpCounter(k, event.deviceId, 'jam_count', 1);
    await maybeRaiseMaintenance(k, event.deviceId, 'jam_count', v);
  }
  if (event.metric === 'rssi' && typeof event.value === 'number') {
    const prev = await queryOne<{ value: number }>(
      `SELECT value FROM device_health_counters WHERE device_id=$1 AND metric='rssi_ewma'`, [event.deviceId]
    );
    const next = ewma(prev?.value ?? null, event.value);
    await setCounter(k, event.deviceId, 'rssi_ewma', next);
    await maybeRaiseMaintenance(k, event.deviceId, 'rssi_ewma', next);
  }
}

async function maybeRaiseMaintenance(kennelId: string, deviceId: string, metric: string, value: number): Promise<void> {
  const counter = await queryOne<{ service_limit: number | null }>(
    `SELECT service_limit FROM device_health_counters WHERE device_id=$1 AND metric=$2`, [deviceId, metric]
  );
  const pred = predictMaintenance({ metric, value, serviceLimit: counter?.service_limit ?? null });
  if (pred.level === 'due' || pred.level === 'overdue') {
    await raiseException({
      kennelId, kind: 'maintenance-due',
      severity: pred.level === 'overdue' ? 'critical' : 'warning',
      deviceId, title: `Service due: ${deviceId} (${metric})`, detail: pred.message,
      suggestedAction: 'Schedule maintenance before failure', dedupKey: `maintenance-due:${deviceId}:${metric}`,
      notifyAudience: 'manager',
    });
  }
}

async function runAction(action: RuleAction, rule: Rule, event: RuleEvent): Promise<void> {
  switch (action.type) {
    case 'raise_exception':
      await raiseException({
        kennelId: rule.kennelId,
        kind: String(action.kind ?? 'rule'),
        severity: (action.severity as any) ?? 'warning',
        title: String(action.title ?? rule.name),
        detail: action.detail as string | undefined,
        deviceId: event.deviceId ?? null,
        animalId: event.animalId ?? null,
        penId: (event.meta?.penId as string) ?? null,
        ruleId: rule.id,
        priority: action.priority as number | undefined,
        suggestedAction: action.suggestedAction as string | undefined,
        notifyAudience: (action.audience as any) ?? null,
      });
      break;
    case 'device_command':
      if (event.deviceId && action.command) {
        await publishCommand(rule.kennelId, String(action.targetDeviceId ?? event.deviceId), {
          command: action.command, params: action.params ?? {},
          deviceId: action.targetDeviceId ?? event.deviceId, kennelId: rule.kennelId, timestamp: Date.now(),
        }).catch((e) => console.warn('[engine] device_command failed', e.message));
      }
      break;
    case 'set_pen_relay':
      // Relay lives on the pen's door/controller device; publish a relay command.
      if (event.meta?.penId || event.deviceId) {
        const target = (event.meta?.relayDeviceId as string) ?? event.deviceId!;
        await publishCommand(rule.kennelId, target, {
          command: 'relay', params: { relay: action.relay, state: action.state },
          deviceId: target, kennelId: rule.kennelId, timestamp: Date.now(),
        }).catch((e) => console.warn('[engine] set_pen_relay failed', e.message));
      }
      break;
    case 'notify':
      // Handled by raise_exception's fan-out; a bare notify just logs intent.
      console.log(`[engine] rule "${rule.name}" notify audience=${action.audience ?? 'default'}`);
      break;
  }
}

export async function ingestEvent(event: RuleEvent): Promise<{ fired: string[] }> {
  await updateMaintenance(event).catch((e) => console.warn('[engine] maintenance update failed', e.message));

  const ruleRows = await query<any>(
    `SELECT * FROM rules WHERE kennel_id=$1 AND enabled=true`, [event.kennelId]
  );
  const now = new Date();
  const fired: string[] = [];

  for (const row of ruleRows) {
    const rule = toRule(row);
    const evalResult = evaluateRule(rule, event, now);
    if (!evalResult.fired) continue;

    for (const action of evalResult.actions) {
      await runAction(action, rule, event).catch((e) => console.warn('[engine] action failed', e.message));
    }
    await execute(`UPDATE rules SET last_fired_at=NOW() WHERE id=$1`, [rule.id]);
    await execute(
      `INSERT INTO rule_firings (rule_id, kennel_id, context) VALUES ($1,$2,$3)`,
      [rule.id, rule.kennelId, JSON.stringify({ event })]
    );
    fired.push(rule.name);
  }
  return { fired };
}
