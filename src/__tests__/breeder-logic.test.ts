import { describe, it, expect } from 'vitest';
import {
  expectedPuppyWeightG,
  assessPuppyWeight,
  dailyGainG,
  hasWeightLoss,
  adultWeightTrend,
} from '../breeder/logic/growth.js';
import {
  evaluateRule,
  evalCondition,
  triggerMatches,
  cooldownElapsed,
  presetRules,
  type Rule,
  type RuleEvent,
} from '../breeder/logic/rules.js';
import { dueEscalationSteps, nextStepIndex } from '../breeder/logic/escalation.js';
import { projectRunOut, consumableStatus, estimateDailyUse } from '../breeder/logic/consumables.js';
import { predictMaintenance, ewma } from '../breeder/logic/maintenance.js';
import { isWithinQuietHours, channelsForDelivery, exceptionPriority } from '../breeder/logic/delivery.js';
import { scheduledDoses, missedDoses, complianceReport } from '../breeder/logic/medications.js';
import { wellnessInsights } from '../breeder/logic/wellness.js';
import { generateRotation, activityMinutesInWindow } from '../breeder/logic/enrichment.js';

describe('growth', () => {
  it('expected puppy weight is monotonic and bounded by adult weight', () => {
    const A = 30; // kg adult
    const w0 = expectedPuppyWeightG(A, 0);
    const w56 = expectedPuppyWeightG(A, 56);
    const w365 = expectedPuppyWeightG(A, 365);
    expect(w0).toBeGreaterThan(0);
    expect(w0).toBeLessThan(w56);
    expect(w56).toBeLessThan(w365);
    expect(w365).toBeLessThanOrEqual(A * 1000);
    expect(w365 / (A * 1000)).toBeGreaterThan(0.9); // near adult by a year
  });

  it('flags an underweight puppy', () => {
    const age = 56;
    const expected = expectedPuppyWeightG(25, age);
    expect(assessPuppyWeight(25, age, expected).flag).toBe('ok');
    expect(assessPuppyWeight(25, age, expected * 0.8).flag).toBe('under');
    expect(assessPuppyWeight(25, age, expected * 0.6).flag).toBe('concern');
    expect(assessPuppyWeight(25, age, expected * 1.4).flag).toBe('over');
  });

  it('computes daily gain and detects weight loss', () => {
    const readings = [
      { grams: 400, takenAt: '2026-01-01' },
      { grams: 520, takenAt: '2026-01-03' },
    ];
    expect(dailyGainG(readings)).toBeCloseTo(60, 5);
    expect(hasWeightLoss(readings).lost).toBe(false);
    const losing = [
      { grams: 500, takenAt: '2026-01-01' },
      { grams: 470, takenAt: '2026-01-02' },
    ];
    expect(hasWeightLoss(losing, 3).lost).toBe(true);
    expect(hasWeightLoss(losing, 3).worstPct).toBeCloseTo(6, 1);
  });

  it('adult weight trend concern on >8% loss', () => {
    expect(adultWeightTrend(27600, 30000).flag).toBe('concern');
    expect(adultWeightTrend(29000, 30000).flag).toBe('losing');
    expect(adultWeightTrend(30200, 30000).flag).toBe('ok');
    expect(adultWeightTrend(32000, 30000).flag).toBe('gaining');
  });
});

describe('rules engine core', () => {
  const baseRule: Rule = {
    id: 'r1', kennelId: 'home', name: 'temp high', enabled: true,
    trigger: { type: 'telemetry', metric: 'temperature' },
    conditions: [{ field: 'value', op: 'gt', value: 28 }],
    actions: [{ type: 'raise_exception', kind: 'temp-high', severity: 'critical', title: 'hot' }],
    cooldownSeconds: 600, lastFiredAt: null,
  };
  const hotEvent: RuleEvent = {
    type: 'telemetry', kennelId: 'home', deviceId: 's1', deviceType: 'sensor',
    metric: 'temperature', value: 31, at: new Date('2026-01-01T12:00:00Z'),
  };

  it('fires when trigger + condition match', () => {
    const r = evaluateRule(baseRule, hotEvent, new Date('2026-01-01T12:00:00Z'));
    expect(r.fired).toBe(true);
    expect(r.actions[0]).toMatchObject({ type: 'raise_exception', kind: 'temp-high' });
  });

  it('does not fire when condition fails', () => {
    const cool = { ...hotEvent, value: 22 };
    expect(evaluateRule(baseRule, cool).fired).toBe(false);
    expect(evaluateRule(baseRule, cool).reason).toBe('condition-failed');
  });

  it('does not fire for another kennel or wrong metric', () => {
    expect(evaluateRule(baseRule, { ...hotEvent, kennelId: 'other' }).fired).toBe(false);
    expect(evaluateRule(baseRule, { ...hotEvent, metric: 'humidity' }).reason).toBe('no-trigger-match');
  });

  it('respects cooldown', () => {
    const justFired: Rule = { ...baseRule, lastFiredAt: new Date('2026-01-01T11:59:00Z') };
    const r = evaluateRule(justFired, hotEvent, new Date('2026-01-01T12:00:00Z'));
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('cooldown');
    expect(cooldownElapsed(justFired, new Date('2026-01-01T12:10:01Z'))).toBe(true);
  });

  it('disabled rule never fires', () => {
    expect(evaluateRule({ ...baseRule, enabled: false }, hotEvent).reason).toBe('disabled');
  });

  it('condition operators', () => {
    const ev: RuleEvent = { type: 't', kennelId: 'home', value: 5, at: new Date(), meta: { pen: 'A' } };
    expect(evalCondition({ field: 'value', op: 'between', value: [1, 10] }, ev)).toBe(true);
    expect(evalCondition({ field: 'value', op: 'lte', value: 5 }, ev)).toBe(true);
    expect(evalCondition({ field: 'meta.pen', op: 'in', value: ['A', 'B'] }, ev)).toBe(true);
    expect(evalCondition({ field: 'meta.pen', op: 'eq', value: 'C' }, ev)).toBe(false);
  });

  it('low_battery trigger uses belowPct', () => {
    const t = { type: 'low_battery', belowPct: 15 };
    expect(triggerMatches(t, { type: 'low_battery', kennelId: 'home', value: 12, at: new Date() })).toBe(true);
    expect(triggerMatches(t, { type: 'low_battery', kennelId: 'home', value: 40, at: new Date() })).toBe(false);
  });

  it('ships a usable set of preset rules', () => {
    const presets = presetRules('home');
    expect(presets.length).toBeGreaterThanOrEqual(6);
    expect(presets.every((p) => p.kennelId === 'home' && p.actions.length > 0)).toBe(true);
    expect(presets.some((p) => p.name.toLowerCase().includes('wrong dog'))).toBe(true);
  });
});

describe('escalation', () => {
  const chain = [
    { afterSeconds: 600, channel: 'sms' as const, label: 'on-call' },
    { afterSeconds: 1200, channel: 'email' as const, label: 'manager' },
  ];
  const first = new Date('2026-01-01T00:00:00Z');

  it('returns no steps before the first threshold', () => {
    const due = dueEscalationSteps({
      chain, firstNotifiedAt: first, now: new Date('2026-01-01T00:05:00Z'),
      status: 'open', lastDeliveredStep: 0,
    });
    expect(due).toHaveLength(0);
  });

  it('returns step 1 after 10 minutes, still open', () => {
    const due = dueEscalationSteps({
      chain, firstNotifiedAt: first, now: new Date('2026-01-01T00:10:30Z'),
      status: 'open', lastDeliveredStep: 0,
    });
    expect(due.map((d) => d.index)).toEqual([1]);
  });

  it('catches up multiple steps if the worker was down', () => {
    const due = dueEscalationSteps({
      chain, firstNotifiedAt: first, now: new Date('2026-01-01T00:30:00Z'),
      status: 'escalated', lastDeliveredStep: 0,
    });
    expect(due.map((d) => d.index)).toEqual([1, 2]);
  });

  it('stops when acknowledged or snoozed', () => {
    expect(dueEscalationSteps({
      chain, firstNotifiedAt: first, now: new Date('2026-01-01T00:30:00Z'),
      status: 'acknowledged', lastDeliveredStep: 0,
    })).toHaveLength(0);
    expect(dueEscalationSteps({
      chain, firstNotifiedAt: first, now: new Date('2026-01-01T00:30:00Z'),
      status: 'open', lastDeliveredStep: 0, snoozedUntil: new Date('2026-01-01T02:00:00Z'),
    })).toHaveLength(0);
  });

  it('nextStepIndex bounds', () => {
    expect(nextStepIndex(chain, 0)).toBe(1);
    expect(nextStepIndex(chain, 2)).toBeNull();
  });
});

describe('consumables', () => {
  it('projects run-out date', () => {
    const p = projectRunOut(10, 2, new Date('2026-01-01T00:00:00Z'));
    expect(p.daysLeft).toBe(5);
    expect(p.runOutOn).toBe('2026-01-06');
  });

  it('null daily use → unknown', () => {
    expect(projectRunOut(10, null).daysLeft).toBeNull();
  });

  it('status levels', () => {
    expect(consumableStatus({ onHand: 20, lowThreshold: 5, dailyUse: 1 }).level).toBe('ok');
    expect(consumableStatus({ onHand: 6, lowThreshold: 5, dailyUse: 1 }).level).toBe('low');   // 6 days left
    expect(consumableStatus({ onHand: 1.5, lowThreshold: 5, dailyUse: 1 }).level).toBe('critical');
    expect(consumableStatus({ onHand: 0, lowThreshold: 5, dailyUse: 1 }).level).toBe('out');
  });

  it('estimates daily use from recent dispensed grams', () => {
    const now = Date.now();
    const events = [
      { grams: 1000, at: new Date(now - 4 * 86400000) },
      { grams: 1000, at: new Date(now - 3 * 86400000) },
      { grams: 1000, at: new Date(now - 2 * 86400000) },
      { grams: 1000, at: new Date(now - 1 * 86400000) },
    ];
    const est = estimateDailyUse(events, 0.5);
    expect(est).not.toBeNull();
    expect(est!).toBeGreaterThan(0.8);
    expect(est!).toBeLessThan(1.4);
  });
});

describe('maintenance', () => {
  it('wear counter fractions', () => {
    expect(predictMaintenance({ metric: 'servo_cycles', value: 100, serviceLimit: 1000 }).level).toBe('ok');
    expect(predictMaintenance({ metric: 'servo_cycles', value: 800, serviceLimit: 1000 }).level).toBe('monitor');
    expect(predictMaintenance({ metric: 'servo_cycles', value: 950, serviceLimit: 1000 }).level).toBe('due');
    expect(predictMaintenance({ metric: 'servo_cycles', value: 1100, serviceLimit: 1000 }).level).toBe('overdue');
  });

  it('rssi and jam metrics use their own scales', () => {
    expect(predictMaintenance({ metric: 'rssi_ewma', value: -60, serviceLimit: null }).level).toBe('ok');
    expect(predictMaintenance({ metric: 'rssi_ewma', value: -88, serviceLimit: null }).level).toBe('due');
    expect(predictMaintenance({ metric: 'jam_count', value: 6, serviceLimit: null }).level).toBe('due');
  });

  it('ewma smooths', () => {
    expect(ewma(null, -60)).toBe(-60);
    expect(ewma(-60, -80, 0.5)).toBe(-70);
  });
});

describe('delivery policy', () => {
  it('quiet hours wrap past midnight', () => {
    const q = { start: '22:00', end: '07:00' };
    expect(isWithinQuietHours(q, new Date('2026-01-01T23:30:00'))).toBe(true);
    expect(isWithinQuietHours(q, new Date('2026-01-01T06:00:00'))).toBe(true);
    expect(isWithinQuietHours(q, new Date('2026-01-01T12:00:00'))).toBe(false);
  });

  it('critical punches through quiet hours when configured', () => {
    const now = new Date('2026-01-01T23:30:00');
    const q = { start: '22:00', end: '07:00', overrideSeverity: 'critical' as const };
    expect(channelsForDelivery({ configuredChannels: ['sms', 'push'], severity: 'critical', quietHours: q, now }).suppressed).toBe(false);
    const warn = channelsForDelivery({ configuredChannels: ['sms', 'push'], severity: 'warning', quietHours: q, now });
    expect(warn.suppressed).toBe(true);
    expect(warn.channels).not.toContain('sms');
  });

  it('priority rises with severity, kind and age', () => {
    const fresh = exceptionPriority({ severity: 'warning', kind: 'low-battery', ageSeconds: 0 });
    const staleCrit = exceptionPriority({ severity: 'critical', kind: 'wrong-pen', ageSeconds: 4 * 3600, escalationStep: 1 });
    expect(staleCrit).toBeGreaterThan(fresh);
    expect(staleCrit).toBeLessThanOrEqual(100);
  });
});

describe('medications', () => {
  const med = {
    id: 'm1', timesOfDay: ['08:00', '20:00'], daysOfWeek: [], active: true,
    startsOn: '2026-01-01', endsOn: '2026-01-31',
  };

  it('lists scheduled doses in a horizon', () => {
    const from = new Date('2026-01-10T00:00:00');
    const doses = scheduledDoses(med, from, 24);
    expect(doses).toHaveLength(2);
    expect(doses[0].getHours()).toBe(8);
    expect(doses[1].getHours()).toBe(20);
  });

  it('flags missed doses with no log', () => {
    const now = new Date('2026-01-10T21:30:00');
    const missed = missedDoses(med, [
      { medicationId: 'm1', scheduledFor: new Date('2026-01-10T08:00:00'), outcome: 'given' },
    ], now);
    // 20:00 dose today is > 1h past with no log
    expect(missed.some((d) => d.getHours() === 20 && d.getDate() === 10)).toBe(true);
    expect(missed.some((d) => d.getHours() === 8 && d.getDate() === 10)).toBe(false);
  });

  it('compliance rate', () => {
    const now = new Date('2026-01-04T09:00:00');
    const logs = [
      { medicationId: 'm1', scheduledFor: new Date('2026-01-01T08:00:00'), outcome: 'given' as const },
      { medicationId: 'm1', scheduledFor: new Date('2026-01-01T20:00:00'), outcome: 'given' as const },
      { medicationId: 'm1', scheduledFor: new Date('2026-01-02T08:00:00'), outcome: 'skipped' as const },
    ];
    const rep = complianceReport(med, logs, now, 30);
    expect(rep.given).toBe(2);
    expect(rep.skipped).toBe(1);
    expect(rep.scheduled).toBeGreaterThanOrEqual(5);
    expect(rep.rate).toBeLessThan(1);
  });
});

describe('wellness insights', () => {
  it('flags a big jump in water intake', () => {
    const days = (n: number, base: number, spike?: number) =>
      Array.from({ length: n }, (_, i) => ({
        day: `2026-01-${String(i + 1).padStart(2, '0')}`,
        value: spike && i >= n - 3 ? spike : base,
      }));
    const insights = wellnessInsights({
      foodGramsPerDay: days(10, 300),
      waterMlPerDay: days(10, 500, 800),
      activityMinutesPerDay: days(10, 60),
      weightSeriesG: [{ takenAt: '2026-01-01', grams: 30000 }, { takenAt: '2026-01-10', grams: 30100 }],
    });
    expect(insights.some((i) => i.metric === 'water' && i.level === 'concern')).toBe(true);
  });

  it('returns an info line when nothing notable', () => {
    const flat = (n: number, v: number) =>
      Array.from({ length: n }, (_, i) => ({ day: `2026-01-${String(i + 1).padStart(2, '0')}`, value: v }));
    const insights = wellnessInsights({
      foodGramsPerDay: flat(10, 300),
      waterMlPerDay: flat(10, 500),
      activityMinutesPerDay: flat(10, 60),
      weightSeriesG: [{ takenAt: '2026-01-01', grams: 30000 }, { takenAt: '2026-01-10', grams: 30050 }],
    });
    expect(insights).toHaveLength(1);
    expect(insights[0].level).toBe('info');
  });
});

describe('enrichment rotation', () => {
  it('spreads animals across stations and slots without per-animal overlap', () => {
    const sessions = generateRotation({
      animalIds: ['a', 'b', 'c', 'd', 'e'],
      stations: ['yard-1', 'yard-2'],
      date: new Date('2026-01-01T00:00:00'),
      dayStart: '09:00', dayEnd: '12:00', slotMinutes: 30,
    });
    expect(sessions).toHaveLength(5);
    // first two share a slot on different stations
    expect(sessions[0].scheduledStart.getTime()).toBe(sessions[1].scheduledStart.getTime());
    expect(sessions[0].station).not.toBe(sessions[1].station);
    // third rolls to the next slot
    expect(sessions[2].scheduledStart.getTime()).toBeGreaterThan(sessions[1].scheduledStart.getTime());
    const perAnimal = new Set(sessions.map((s) => s.animalId));
    expect(perAnimal.size).toBe(5);
  });

  it('caps at available capacity', () => {
    const sessions = generateRotation({
      animalIds: Array.from({ length: 20 }, (_, i) => `a${i}`),
      stations: ['y1'],
      date: new Date('2026-01-01T00:00:00'),
      dayStart: '09:00', dayEnd: '10:00', slotMinutes: 30,
    });
    expect(sessions).toHaveLength(2); // 2 slots × 1 station
  });

  it('sums activity minutes in a window', () => {
    const start = new Date('2026-01-01T09:00:00');
    const end = new Date('2026-01-01T09:30:00');
    const samples = [
      { at: '2026-01-01T09:05:00', moving: true },
      { at: '2026-01-01T09:06:00', moving: true },
      { at: '2026-01-01T09:07:00', moving: false },
      { at: '2026-01-01T10:00:00', moving: true },
    ];
    expect(activityMinutesInWindow(samples, start, end, 60)).toBe(2);
  });
});
