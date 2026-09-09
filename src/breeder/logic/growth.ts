/**
 * Puppy growth curves + adult weight-trend flags.
 *
 * The expected-weight model is a Gompertz curve W(t) = A · exp(-b · exp(-k·t))
 * scaled so that, for a given expected adult weight A:
 *   - W(0)   ≈ 1.5% of A     (newborn)
 *   - W(56)  ≈ 45% of A      (~8 weeks, typical go-home)
 *   - W(365) ≈ 98% of A      (~1 year)
 *
 * It is a planning estimate, not a veterinary reference. Breeds and lines vary
 * widely; the value of the curve here is the *deviation flag*, not the grams.
 */

const GOMPERTZ_B = 4.2;      // shifts the inflection; tuned to the anchors above
const GOMPERTZ_K = 0.0165;   // growth rate per day

export function expectedPuppyWeightG(adultWeightKg: number, ageDays: number): number {
  const A = Math.max(0, adultWeightKg) * 1000;
  if (A === 0) return 0;
  const t = Math.max(0, ageDays);
  return A * Math.exp(-GOMPERTZ_B * Math.exp(-GOMPERTZ_K * t));
}

export type WeightFlag = 'ok' | 'under' | 'over' | 'concern';

export interface WeightAssessment {
  expectedG: number;
  actualG: number;
  ratio: number;          // actual / expected
  deviationPct: number;   // (actual - expected) / expected * 100
  flag: WeightFlag;
}

/**
 * Compare a single reading to the expected curve.
 * `concern` is reserved for large shortfalls (possible fading pup / illness).
 */
export function assessPuppyWeight(
  adultWeightKg: number,
  ageDays: number,
  actualG: number
): WeightAssessment {
  const expectedG = expectedPuppyWeightG(adultWeightKg, ageDays);
  const ratio = expectedG > 0 ? actualG / expectedG : 1;
  const deviationPct = expectedG > 0 ? ((actualG - expectedG) / expectedG) * 100 : 0;
  let flag: WeightFlag = 'ok';
  if (ratio <= 0.7) flag = 'concern';
  else if (ratio < 0.85) flag = 'under';
  else if (ratio > 1.25) flag = 'over';
  return { expectedG, actualG, ratio, deviationPct, flag };
}

export interface Reading {
  grams: number;
  takenAt: Date | string | number;
}

function toMs(v: Date | string | number): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return Date.parse(v);
}

/** Average grams/day gain between the first and last reading in the window. */
export function dailyGainG(readings: Reading[]): number | null {
  if (readings.length < 2) return null;
  const sorted = [...readings].sort((a, b) => toMs(a.takenAt) - toMs(b.takenAt));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const days = (toMs(last.takenAt) - toMs(first.takenAt)) / 86_400_000;
  if (days <= 0) return null;
  return (last.grams - first.grams) / days;
}

/**
 * Flags a drop between consecutive readings larger than `dropPct` of body weight.
 * For neonates any sustained loss is a red flag; default 3%.
 */
export function hasWeightLoss(readings: Reading[], dropPct = 3): { lost: boolean; worstPct: number } {
  const sorted = [...readings].sort((a, b) => toMs(a.takenAt) - toMs(b.takenAt));
  let worstPct = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].grams;
    const cur = sorted[i].grams;
    if (prev > 0 && cur < prev) {
      const pct = ((prev - cur) / prev) * 100;
      if (pct > worstPct) worstPct = pct;
    }
  }
  return { lost: worstPct >= dropPct, worstPct: Number(worstPct.toFixed(2)) };
}

/**
 * Adult body-condition trend vs a baseline weight (e.g. plan target or a
 * check-in reading). > `concernPct` loss is worth a vet note.
 */
export function adultWeightTrend(
  currentG: number,
  baselineG: number,
  concernPct = 8
): { changePct: number; flag: 'ok' | 'gaining' | 'losing' | 'concern' } {
  if (baselineG <= 0) return { changePct: 0, flag: 'ok' };
  const changePct = ((currentG - baselineG) / baselineG) * 100;
  let flag: 'ok' | 'gaining' | 'losing' | 'concern' = 'ok';
  if (changePct <= -concernPct) flag = 'concern';
  else if (changePct < -2) flag = 'losing';
  else if (changePct > 5) flag = 'gaining';
  return { changePct: Number(changePct.toFixed(2)), flag };
}
