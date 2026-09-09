/**
 * Automated play / enrichment rotation.
 *
 * Given the animals to rotate, the available stations (play yards / enrichment
 * spots) and a working window, produce non-overlapping sessions that spread the
 * animals across stations round-robin. One session per animal per generated day.
 */

export interface RotationRequest {
  animalIds: string[];
  stations: string[];
  date: Date;              // day to schedule
  dayStart: string;        // "09:00"
  dayEnd: string;          // "17:00"
  slotMinutes: number;     // e.g. 30
}

export interface PlannedSession {
  animalId: string;
  station: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

function at(date: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

export function generateRotation(req: RotationRequest): PlannedSession[] {
  const { animalIds, stations, date, dayStart, dayEnd, slotMinutes } = req;
  if (animalIds.length === 0 || stations.length === 0 || slotMinutes <= 0) return [];

  const windowStart = at(date, dayStart).getTime();
  const windowEnd = at(date, dayEnd).getTime();
  const slotMs = slotMinutes * 60_000;
  const slots = Math.floor((windowEnd - windowStart) / slotMs);
  if (slots <= 0) return [];

  const capacity = slots * stations.length;
  const sessions: PlannedSession[] = [];

  animalIds.forEach((animalId, i) => {
    if (i >= capacity) return; // no room today; caller can roll to tomorrow
    const slotIndex = Math.floor(i / stations.length);
    const station = stations[i % stations.length];
    const start = new Date(windowStart + slotIndex * slotMs);
    const end = new Date(start.getTime() + slotMs);
    sessions.push({ animalId, station, scheduledStart: start, scheduledEnd: end });
  });

  return sessions;
}

/** Split activity minutes from a collar accelerometer series into a per-session total. */
export function activityMinutesInWindow(
  samples: Array<{ at: string | Date; moving: boolean }>,
  start: Date,
  end: Date,
  sampleSpacingSeconds = 60
): number {
  const s = start.getTime();
  const e = end.getTime();
  const moving = samples.filter((x) => {
    const t = new Date(x.at).getTime();
    return t >= s && t < e && x.moving;
  }).length;
  return Number(((moving * sampleSpacingSeconds) / 60).toFixed(1));
}
