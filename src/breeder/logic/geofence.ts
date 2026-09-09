/**
 * Geofencing maths — pure. Circular zones only (a polygon fit is a later
 * refinement; a circle covers "keep the dog in the paddock").
 */

export interface Point { lat: number; lng: number }

export interface Zone {
  id: string;
  kind: 'boundary' | 'exclusion';
  center_lat: number;
  center_lng: number;
  radius_m: number;
}

const R = 6_371_000; // earth radius, metres

export function haversineMeters(a: Point, b: Point): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function insideZone(p: Point, z: Zone): boolean {
  return haversineMeters(p, { lat: z.center_lat, lng: z.center_lng }) <= z.radius_m;
}

/** True when this crossing is one the breeder needs to hear about right now. */
export function isEscape(z: Zone, transition: 'enter' | 'exit'): boolean {
  return (z.kind === 'boundary' && transition === 'exit') ||
         (z.kind === 'exclusion' && transition === 'enter');
}

export interface Evaluation {
  insideIds: string[];
  entered: Zone[];
  exited: Zone[];
}

/**
 * Given a fix, the active zones, and the set of zone ids the animal was inside
 * at the last fix, work out the new membership and the crossings.
 */
export function evaluate(p: Point, zones: Zone[], prevInside: Set<string>): Evaluation {
  const insideIds: string[] = [];
  const entered: Zone[] = [];
  const exited: Zone[] = [];
  const nowInside = new Set<string>();

  for (const z of zones) {
    if (insideZone(p, z)) {
      nowInside.add(z.id);
      insideIds.push(z.id);
      if (!prevInside.has(z.id)) entered.push(z);
    } else if (prevInside.has(z.id)) {
      exited.push(z);
    }
  }
  return { insideIds, entered, exited };
}
