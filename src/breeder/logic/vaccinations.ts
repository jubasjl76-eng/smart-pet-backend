/**
 * Vaccination / worming scheduling — pure helpers. The route + engine sweep
 * turn these into `vaccination_records` and care-inbox exceptions.
 */

export interface ProtocolDose {
  name: string;
  atAgeDays: number;
  kind?: 'vaccine' | 'worming';
}

export type VaccStatus = 'done' | 'due' | 'overdue' | 'upcoming';

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Expand a protocol against a birth date into due-dated rows. */
export function scheduleFromProtocol(
  dob: string | Date,
  doses: ProtocolDose[],
): { name: string; kind: 'vaccine' | 'worming'; dueOn: string }[] {
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return [];
  return doses
    .filter((d) => typeof d.atAgeDays === 'number' && d.name)
    .map((d) => ({
      name: d.name,
      kind: d.kind === 'worming' ? 'worming' : 'vaccine',
      dueOn: addDays(birth, d.atAgeDays).toISOString().slice(0, 10),
    }));
}

export function recordStatus(
  r: { given_on: string | Date | null; due_on: string | Date | null },
  now: Date = new Date(),
): VaccStatus {
  if (r.given_on) return 'done';
  if (!r.due_on) return 'upcoming';
  const due = new Date(r.due_on);
  const days = (due.getTime() - now.getTime()) / 86_400_000;
  if (days < 0) return 'overdue';
  if (days <= 7) return 'due';
  return 'upcoming';
}

/**
 * Sensible core puppy schedule + rabies + routine worming, tuned to an 8-week
 * go-home. The breeder edits this — it's a starting point, not medical advice.
 */
export const DEFAULT_PROTOCOL: ProtocolDose[] = [
  { name: 'Worming (2 weeks)', atAgeDays: 14, kind: 'worming' },
  { name: 'Worming (4 weeks)', atAgeDays: 28, kind: 'worming' },
  { name: 'Worming (6 weeks)', atAgeDays: 42, kind: 'worming' },
  { name: 'DHP/L primary', atAgeDays: 42, kind: 'vaccine' },
  { name: 'Worming (8 weeks)', atAgeDays: 56, kind: 'worming' },
  { name: 'DHP/L second', atAgeDays: 63, kind: 'vaccine' },
  { name: 'Rabies', atAgeDays: 84, kind: 'vaccine' },
  { name: 'DHP/L 1-year booster', atAgeDays: 365, kind: 'vaccine' },
];
