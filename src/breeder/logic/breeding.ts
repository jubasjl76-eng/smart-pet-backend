/** Breeding-calendar maths — pure. Heuristics; the vet's call always wins. */

export const GESTATION_DAYS = 63;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function plusDays(base: string | Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Average gap between recent heats; 180 days when we have fewer than two. */
export function heatIntervalDays(startDates: (string | Date)[]): number {
  const ms = startDates.map((d) => new Date(d).getTime()).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  if (ms.length < 2) return 180;
  const gaps: number[] = [];
  for (let i = 1; i < ms.length; i++) gaps.push((ms[i] - ms[i - 1]) / 86_400_000);
  const recent = gaps.slice(-3);
  return Math.round(recent.reduce((s, g) => s + g, 0) / recent.length);
}

export function predictNextHeat(
  startDates: (string | Date)[],
): { nextStart: string; intervalDays: number } | null {
  const valid = startDates.map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime()));
  if (valid.length === 0) return null;
  const last = valid.sort((a, b) => a.getTime() - b.getTime()).at(-1)!;
  const intervalDays = heatIntervalDays(startDates);
  return { nextStart: iso(plusDays(last, intervalDays)), intervalDays };
}

/** Rough fertile window: days 9 to 15 from heat onset. Progesterone refines it. */
export function fertileWindow(heatStart: string | Date): { from: string; to: string } {
  return { from: iso(plusDays(heatStart, 9)), to: iso(plusDays(heatStart, 15)) };
}

export function dueFromMating(matedOn: string | Date): string {
  return iso(plusDays(matedOn, GESTATION_DAYS));
}

/**
 * Progesterone guidance (ng/mL). LH surge ~2, ovulation ~5, fertile eggs ~2 days
 * after ovulation. Deliberately rough.
 */
export function progesteroneGuidance(
  readings: { on: string; ngml: number }[],
): { phase: string; note: string; breedOn?: string } {
  if (readings.length === 0) return { phase: 'none', note: 'No progesterone readings yet.' };
  const latest = [...readings].sort((a, b) => String(a.on).localeCompare(String(b.on))).at(-1)!;
  const v = latest.ngml;
  if (v < 2) return { phase: 'pre-surge', note: `${v} ng/mL, before the LH surge. Test again in 2 to 3 days.` };
  if (v < 5) {
    return {
      phase: 'surge',
      note: `${v} ng/mL, LH surge. Ovulation in about 2 days.`,
      breedOn: iso(plusDays(latest.on, 4)),
    };
  }
  if (v < 20) {
    return {
      phase: 'ovulation',
      note: `${v} ng/mL, ovulating. Optimal breeding around ${iso(plusDays(latest.on, 2))}.`,
      breedOn: iso(plusDays(latest.on, 2)),
    };
  }
  return { phase: 'post-ovulation', note: `${v} ng/mL, past ovulation. Breed now, the window is closing.` };
}
