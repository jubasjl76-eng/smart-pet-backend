/**
 * Wellness insights — turn raw intake / weight / activity series into a short
 * list of plain-language observations. Deliberately conservative: it points at
 * things worth a human/vet look, it does not diagnose.
 */

export interface DailyPoint {
  day: string;   // ISO date
  value: number;
}

export interface WellnessInput {
  foodGramsPerDay: DailyPoint[];
  waterMlPerDay: DailyPoint[];
  activityMinutesPerDay: DailyPoint[];
  weightSeriesG: Array<{ takenAt: string | Date; grams: number }>;
}

export type InsightLevel = 'info' | 'watch' | 'concern';

export interface Insight {
  metric: 'food' | 'water' | 'activity' | 'weight';
  level: InsightLevel;
  message: string;
  changePct?: number;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Compare the last `recentDays` to the preceding `baseDays`. */
function trend(points: DailyPoint[], recentDays: number, baseDays: number): { changePct: number; recent: number; base: number } | null {
  if (points.length < recentDays + 2) return null;
  const sorted = [...points].sort((a, b) => a.day.localeCompare(b.day));
  const recent = sorted.slice(-recentDays).map((p) => p.value);
  const base = sorted.slice(-(recentDays + baseDays), -recentDays).map((p) => p.value);
  if (base.length === 0) return null;
  const r = mean(recent);
  const b = mean(base);
  if (b === 0) return null;
  return { changePct: Number((((r - b) / b) * 100).toFixed(1)), recent: r, base: b };
}

export function wellnessInsights(input: WellnessInput, now: Date = new Date()): Insight[] {
  const out: Insight[] = [];

  const water = trend(input.waterMlPerDay, 3, 7);
  if (water) {
    if (water.changePct >= 30)
      out.push({ metric: 'water', level: 'concern', changePct: water.changePct,
        message: `Drinking ${water.changePct}% more than usual — worth a vet check` });
    else if (water.changePct <= -30)
      out.push({ metric: 'water', level: 'concern', changePct: water.changePct,
        message: `Drinking ${Math.abs(water.changePct)}% less than usual — monitor closely` });
    else if (Math.abs(water.changePct) >= 15)
      out.push({ metric: 'water', level: 'watch', changePct: water.changePct,
        message: `Water intake changed ${water.changePct}% vs last week` });
  }

  const food = trend(input.foodGramsPerDay, 2, 7);
  if (food) {
    if (food.changePct <= -25)
      out.push({ metric: 'food', level: 'concern', changePct: food.changePct,
        message: `Eating ${Math.abs(food.changePct)}% less over the last 2 days — appetite drop` });
    else if (food.changePct <= -12)
      out.push({ metric: 'food', level: 'watch', changePct: food.changePct,
        message: `Appetite down ${Math.abs(food.changePct)}% vs last week` });
  }

  const activity = trend(input.activityMinutesPerDay, 3, 7);
  if (activity && activity.changePct <= -40)
    out.push({ metric: 'activity', level: 'watch', changePct: activity.changePct,
      message: `Much less active (${activity.changePct}%) than last week` });

  const w = [...input.weightSeriesG].sort(
    (a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime()
  );
  if (w.length >= 2) {
    const first = w[0].grams;
    const last = w[w.length - 1].grams;
    if (first > 0) {
      const changePct = Number((((last - first) / first) * 100).toFixed(1));
      if (changePct <= -8)
        out.push({ metric: 'weight', level: 'concern', changePct,
          message: `Weight down ${Math.abs(changePct)}% over the series — vet check advised` });
      else if (changePct >= 12)
        out.push({ metric: 'weight', level: 'watch', changePct,
          message: `Weight up ${changePct}% — review portions` });
    }
  }

  if (out.length === 0) out.push({ metric: 'weight', level: 'info', message: 'No notable changes this week' });
  return out;
}
