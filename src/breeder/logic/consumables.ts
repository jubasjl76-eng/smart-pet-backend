/**
 * Consumables — warn before a supply runs out. No auto-ordering.
 * Applies to both breeder (B2B) and owner (B2C): food, water filters, meds, bedding.
 */

export interface ConsumableInput {
  onHand: number;
  lowThreshold: number;
  /** Units consumed per day. Manual estimate, refined from intake_events by the engine. */
  dailyUse: number | null;
}

export type ConsumableLevel = 'ok' | 'low' | 'critical' | 'out';

export interface ConsumableStatus {
  level: ConsumableLevel;
  daysLeft: number | null;
  runOutOn: string | null; // ISO date
  message: string;
}

export function projectRunOut(onHand: number, dailyUse: number | null, from: Date = new Date()): {
  daysLeft: number | null;
  runOutOn: string | null;
} {
  if (dailyUse == null || dailyUse <= 0) return { daysLeft: null, runOutOn: null };
  const daysLeft = Math.max(0, onHand / dailyUse);
  const runOut = new Date(from.getTime() + daysLeft * 86_400_000);
  return { daysLeft: Number(daysLeft.toFixed(1)), runOutOn: runOut.toISOString().slice(0, 10) };
}

export function consumableStatus(input: ConsumableInput, from: Date = new Date()): ConsumableStatus {
  const { onHand, lowThreshold, dailyUse } = input;
  const { daysLeft, runOutOn } = projectRunOut(onHand, dailyUse, from);

  let level: ConsumableLevel = 'ok';
  if (onHand <= 0) level = 'out';
  else if (onHand <= lowThreshold) level = 'low';
  if (daysLeft != null) {
    if (daysLeft <= 2) level = daysLeft <= 0 ? 'out' : 'critical';
    else if (daysLeft <= 7 && level === 'ok') level = 'low';
  }

  const message =
    level === 'out' ? 'Out of stock — replace now'
    : level === 'critical' ? `Runs out in ~${daysLeft} day(s) — buy today`
    : level === 'low' ? (daysLeft != null ? `Low — ~${daysLeft} day(s) left` : 'Low — below threshold, restock soon')
    : 'Stock OK';

  return { level, daysLeft, runOutOn, message };
}

/**
 * Estimate daily use (kg or units) from recent dispensed intake for a linked device.
 * Falls back to the manual estimate when there is too little history.
 */
export function estimateDailyUse(
  events: Array<{ grams?: number | null; units?: number | null; at: Date | string | number }>,
  manualEstimate: number | null,
  windowDays = 7
): number | null {
  if (events.length < 2) return manualEstimate;
  const toMs = (v: Date | string | number) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));
  const now = Date.now();
  const cutoff = now - windowDays * 86_400_000;
  const recent = events.filter((e) => toMs(e.at) >= cutoff);
  if (recent.length < 2) return manualEstimate;
  const total = recent.reduce((s, e) => s + (e.grams != null ? e.grams / 1000 : e.units ?? 0), 0);
  const span = Math.max(1, (now - Math.min(...recent.map((e) => toMs(e.at)))) / 86_400_000);
  const est = total / span;
  return est > 0 ? Number(est.toFixed(3)) : manualEstimate;
}
