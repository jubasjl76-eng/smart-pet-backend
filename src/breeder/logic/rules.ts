/**
 * Rules / automation engine — pure evaluation core.
 *
 * A rule = trigger + optional conditions + actions. The engine (engine/rules.ts)
 * feeds a normalised event into `evaluateRule` and acts on the returned actions.
 *
 * Preset trigger types (v1):
 *   - device_status      params: { deviceType?, statusEquals? }
 *   - telemetry          params: { metric }                      → event.value
 *   - missed_meal        params: { withinHours }
 *   - low_battery        params: { belowPct }
 *   - wrong_pen          params: {}
 *   - device_offline     params: { forMinutes }
 *   - maintenance_due    params: { metric }
 *
 * Condition op: eq ne gt gte lt lte in between
 * Action types: raise_exception | notify | device_command | set_pen_relay
 */

export type ConditionOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'between';

export interface RuleCondition {
  field: string;               // dotted path into the event, e.g. "value" or "meta.penId"
  op: ConditionOp;
  value: unknown;
}

export interface RuleTrigger {
  type: string;
  [param: string]: unknown;
}

export interface RuleAction {
  type: 'raise_exception' | 'notify' | 'device_command' | 'set_pen_relay';
  [param: string]: unknown;
}

export interface Rule {
  id: string;
  kennelId: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  actions: RuleAction[];
  cooldownSeconds: number;
  lastFiredAt: Date | string | null;
}

export interface RuleEvent {
  type: string;                // matches trigger.type family
  kennelId: string;
  deviceId?: string;
  deviceType?: string;
  metric?: string;
  value?: number;
  status?: string;
  animalId?: string;
  meta?: Record<string, unknown>;
  at: Date;
}

export function getField(event: RuleEvent, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = event;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function evalCondition(cond: RuleCondition, event: RuleEvent): boolean {
  const actual = getField(event, cond.field);
  const expected = cond.value;
  switch (cond.op) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'gt': return typeof actual === 'number' && actual > Number(expected);
    case 'gte': return typeof actual === 'number' && actual >= Number(expected);
    case 'lt': return typeof actual === 'number' && actual < Number(expected);
    case 'lte': return typeof actual === 'number' && actual <= Number(expected);
    case 'in': return Array.isArray(expected) && expected.includes(actual);
    case 'between': {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const n = Number(actual);
      return n >= Number(expected[0]) && n <= Number(expected[1]);
    }
    default: return false;
  }
}

export function triggerMatches(trigger: RuleTrigger, event: RuleEvent): boolean {
  if (trigger.type !== event.type) return false;
  switch (trigger.type) {
    case 'device_status':
      if (trigger.deviceType && trigger.deviceType !== event.deviceType) return false;
      if (trigger.statusEquals && trigger.statusEquals !== event.status) return false;
      return true;
    case 'telemetry':
      return !trigger.metric || trigger.metric === event.metric;
    case 'maintenance_due':
      return !trigger.metric || trigger.metric === event.metric;
    case 'low_battery':
      return typeof event.value === 'number' && event.value < Number(trigger.belowPct ?? 20);
    case 'device_offline':
    case 'missed_meal':
    case 'wrong_pen':
      return true;
    default:
      return true;
  }
}

/** Cooldown check — true if the rule is allowed to fire again at `now`. */
export function cooldownElapsed(rule: Rule, now: Date): boolean {
  if (!rule.lastFiredAt) return true;
  const last = rule.lastFiredAt instanceof Date ? rule.lastFiredAt.getTime() : Date.parse(String(rule.lastFiredAt));
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= rule.cooldownSeconds * 1000;
}

export interface RuleEvaluation {
  fired: boolean;
  reason: 'disabled' | 'no-trigger-match' | 'condition-failed' | 'cooldown' | 'fired';
  actions: RuleAction[];
}

export function evaluateRule(rule: Rule, event: RuleEvent, now: Date = new Date()): RuleEvaluation {
  if (!rule.enabled) return { fired: false, reason: 'disabled', actions: [] };
  if (rule.kennelId !== event.kennelId) return { fired: false, reason: 'no-trigger-match', actions: [] };
  if (!triggerMatches(rule.trigger, event)) return { fired: false, reason: 'no-trigger-match', actions: [] };
  for (const cond of rule.conditions ?? []) {
    if (!evalCondition(cond, event)) return { fired: false, reason: 'condition-failed', actions: [] };
  }
  if (!cooldownElapsed(rule, now)) return { fired: false, reason: 'cooldown', actions: [] };
  return { fired: true, reason: 'fired', actions: rule.actions ?? [] };
}

/** Ready-to-use starter rules for a new kennel (parameterised presets). */
export function presetRules(kennelId: string): Array<Omit<Rule, 'id' | 'lastFiredAt'>> {
  return [
    {
      kennelId, name: 'Whelping-room temperature high', enabled: true,
      trigger: { type: 'telemetry', metric: 'temperature' },
      conditions: [{ field: 'value', op: 'gt', value: 28 }],
      actions: [
        { type: 'raise_exception', kind: 'temp-high', severity: 'critical',
          title: 'Whelping room over 28 °C', suggestedAction: 'Turn on fan / check HVAC' },
        { type: 'set_pen_relay', relay: 'fan', state: 'on' },
        { type: 'notify', audience: 'on-call' },
      ],
      cooldownSeconds: 600,
    },
    {
      kennelId, name: 'Whelping-room temperature low', enabled: true,
      trigger: { type: 'telemetry', metric: 'temperature' },
      conditions: [{ field: 'value', op: 'lt', value: 20 }],
      actions: [
        { type: 'raise_exception', kind: 'temp-low', severity: 'warning',
          title: 'Whelping room under 20 °C', suggestedAction: 'Add heat lamp for the litter' },
        { type: 'notify', audience: 'on-call' },
      ],
      cooldownSeconds: 600,
    },
    {
      kennelId, name: 'Collar battery low', enabled: true,
      trigger: { type: 'low_battery', belowPct: 15 },
      conditions: [],
      actions: [
        { type: 'raise_exception', kind: 'low-battery', severity: 'warning',
          title: 'Collar battery low', suggestedAction: 'Swap / charge the collar' },
      ],
      cooldownSeconds: 3600,
    },
    {
      kennelId, name: 'Missed two consecutive meals', enabled: true,
      trigger: { type: 'missed_meal', withinHours: 14 },
      conditions: [],
      actions: [
        { type: 'raise_exception', kind: 'missed-meal', severity: 'critical', priority: 85,
          title: 'Dog skipped 2 meals', suggestedAction: 'Check the dog and the feeder in person' },
        { type: 'notify', audience: 'manager' },
      ],
      cooldownSeconds: 3600,
    },
    {
      kennelId, name: 'Wrong dog at feeder / in pen', enabled: true,
      trigger: { type: 'wrong_pen' },
      conditions: [],
      actions: [
        { type: 'raise_exception', kind: 'wrong-pen', severity: 'critical', priority: 90,
          title: 'Wrong dog detected at a device/pen',
          suggestedAction: 'Verify collar/BLE tag and move the dog to its pen' },
        { type: 'notify', audience: 'on-call' },
      ],
      cooldownSeconds: 300,
    },
    {
      kennelId, name: 'Device offline 10 min', enabled: true,
      trigger: { type: 'device_offline', forMinutes: 10 },
      conditions: [],
      actions: [
        { type: 'raise_exception', kind: 'device-offline', severity: 'warning',
          title: 'Device offline', suggestedAction: 'Check power and Wi-Fi at the pen' },
      ],
      cooldownSeconds: 1800,
    },
    {
      kennelId, name: 'Feeder servo near service limit', enabled: true,
      trigger: { type: 'maintenance_due', metric: 'servo_cycles' },
      conditions: [],
      actions: [
        { type: 'raise_exception', kind: 'maintenance-due', severity: 'warning',
          title: 'Feeder motor near its service limit',
          suggestedAction: 'Schedule servo replacement before it jams during a stay' },
        { type: 'notify', audience: 'manager' },
      ],
      cooldownSeconds: 86400,
    },
  ];
}
