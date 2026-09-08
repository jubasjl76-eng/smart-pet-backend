/**
 * Medication scheduling helpers. Administration is manual (staff) — these
 * functions compute what is due, what was missed, and the compliance rate for
 * the dashboard. No hardware dispensing.
 */

export interface MedSchedule {
  id: string;
  timesOfDay: string[];       // ["08:00","20:00"]
  daysOfWeek: number[];       // 0..6 (Sun..Sat); empty = every day
  startsOn?: string | Date | null;
  endsOn?: string | Date | null;
  active: boolean;
}

export interface MedLog {
  medicationId: string;
  scheduledFor: string | Date;
  outcome: 'given' | 'skipped' | 'refused' | 'vomited';
}

function atLocal(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

function inDateRange(d: Date, startsOn?: string | Date | null, endsOn?: string | Date | null): boolean {
  if (startsOn && d < new Date(startsOn)) return false;
  if (endsOn) {
    const end = new Date(endsOn);
    end.setHours(23, 59, 59, 999);
    if (d > end) return false;
  }
  return true;
}

/** All scheduled dose times in [from, from+horizonHours]. */
export function scheduledDoses(med: MedSchedule, from: Date, horizonHours = 24): Date[] {
  if (!med.active) return [];
  const out: Date[] = [];
  const end = new Date(from.getTime() + horizonHours * 3_600_000);
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    const dow = cursor.getDay();
    const dayOk = med.daysOfWeek.length === 0 || med.daysOfWeek.includes(dow);
    if (dayOk) {
      for (const t of med.timesOfDay) {
        const dose = atLocal(cursor, t);
        if (dose >= from && dose <= end && inDateRange(dose, med.startsOn, med.endsOn)) {
          out.push(dose);
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** Doses whose time has passed with no log (grace period in minutes). */
export function missedDoses(med: MedSchedule, logs: MedLog[], now: Date, graceMinutes = 60, lookbackHours = 48): Date[] {
  const from = new Date(now.getTime() - lookbackHours * 3_600_000);
  const due = scheduledDoses(med, from, lookbackHours).filter(
    (d) => d.getTime() + graceMinutes * 60_000 < now.getTime()
  );
  const logged = new Set(
    logs
      .filter((l) => l.medicationId === med.id)
      .map((l) => new Date(l.scheduledFor).getTime())
  );
  return due.filter((d) => {
    for (const t of logged) if (Math.abs(t - d.getTime()) <= graceMinutes * 60_000) return false;
    return true;
  });
}

export interface ComplianceReport {
  scheduled: number;
  given: number;
  skipped: number;
  missed: number;
  rate: number; // given / scheduled, 0..1
}

export function complianceReport(med: MedSchedule, logs: MedLog[], now: Date, windowDays = 30): ComplianceReport {
  const from = new Date(now.getTime() - windowDays * 86_400_000);
  const scheduledTimes = scheduledDoses(med, from, windowDays * 24).filter((d) => d <= now);
  const relevant = logs.filter((l) => l.medicationId === med.id && new Date(l.scheduledFor) >= from);
  const given = relevant.filter((l) => l.outcome === 'given').length;
  const skipped = relevant.filter((l) => l.outcome === 'skipped' || l.outcome === 'refused').length;
  const scheduled = scheduledTimes.length;
  const missed = Math.max(0, scheduled - given - skipped);
  return {
    scheduled, given, skipped, missed,
    rate: scheduled === 0 ? 1 : Number((given / scheduled).toFixed(3)),
  };
}
