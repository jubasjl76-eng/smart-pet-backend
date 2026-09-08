/**
 * Notification delivery policy — quiet hours + channel selection + exception priority.
 */

export interface QuietHours {
  start: string;              // "HH:MM" local
  end: string;                // "HH:MM" local (may wrap past midnight)
  /** Severities that punch through quiet hours anyway. */
  overrideSeverity?: 'warning' | 'critical';
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h % 24) * 60 + (m % 60);
}

/** `now` is treated as already in the user's local timezone. */
export function isWithinQuietHours(q: QuietHours | null | undefined, now: Date): boolean {
  if (!q || !q.start || !q.end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = minutesOfDay(q.start);
  const end = minutesOfDay(q.end);
  if (start === end) return false;
  return start < end
    ? cur >= start && cur < end          // same-day window
    : cur >= start || cur < end;         // wraps past midnight
}

export type Severity = 'info' | 'warning' | 'critical';

/**
 * Decide which channels an exception should go out on right now.
 * Quiet hours suppress everything except `siren` and any severity in overrideSeverity.
 */
export function channelsForDelivery(opts: {
  configuredChannels: string[];
  severity: Severity;
  quietHours?: QuietHours | null;
  now: Date;
}): { channels: string[]; suppressed: boolean } {
  const { configuredChannels, severity, quietHours, now } = opts;
  const quiet = isWithinQuietHours(quietHours, now);
  if (!quiet) return { channels: configuredChannels, suppressed: false };

  const override = quietHours?.overrideSeverity;
  const punchesThrough =
    (override === 'warning' && (severity === 'warning' || severity === 'critical')) ||
    (override === 'critical' && severity === 'critical');

  if (punchesThrough) return { channels: configuredChannels, suppressed: false };

  const stillAllowed = configuredChannels.filter((c) => c === 'siren' || c === 'log');
  return { channels: stillAllowed, suppressed: stillAllowed.length < configuredChannels.length };
}

/**
 * Priority score (0..100, higher = surface sooner in the care inbox).
 * Combines severity, kind, and age so stale criticals float to the top.
 */
const KIND_BUMP: Record<string, number> = {
  'wrong-pen': 25,
  'missed-meal': 20,
  'temp-high': 18,
  'temp-low': 12,
  'feeder-jam': 15,
  'low-battery': 6,
  'device-offline': 8,
  'maintenance-due': 4,
  'med-missed': 22,
};

export function exceptionPriority(opts: {
  severity: Severity;
  kind: string;
  ageSeconds: number;
  escalationStep?: number;
}): number {
  const base = opts.severity === 'critical' ? 60 : opts.severity === 'warning' ? 35 : 15;
  const kind = KIND_BUMP[opts.kind] ?? 0;
  const age = Math.min(15, opts.ageSeconds / 3600); // +1/hour up to +15
  const esc = (opts.escalationStep ?? 0) * 5;
  return Math.max(0, Math.min(100, Math.round(base + kind + age + esc)));
}
