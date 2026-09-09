/**
 * Staged-rollout maths — pure. A device belongs to a stable bucket 0..99 from a
 * hash of its id; a 'rolling' rollout at percent P moves every device whose
 * bucket is < P. Bumping P is monotonic, so a device that started updating never
 * falls back out of the wave.
 */
import { createHash } from 'node:crypto';

export function deviceBucket(deviceId: string): number {
  const hex = createHash('sha1').update(deviceId).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % 100;
}

export interface Rollout {
  state: 'rolling' | 'paused' | 'done';
  percent: number;
}

/**
 * The version this device should be running, or null to leave it alone.
 * `paused` / `done` and out-of-bucket devices get null.
 */
export function deviceTarget(
  rollout: Rollout | null | undefined,
  firmwareVersion: string,
  deviceId: string,
): string | null {
  if (!rollout || rollout.state !== 'rolling') return null;
  return deviceBucket(deviceId) < rollout.percent ? firmwareVersion : null;
}

export type DeviceFwStatus = 'up-to-date' | 'pending' | 'unknown';

/** Where one device sits relative to the rollout, for the fleet view. */
export function deviceFwStatus(
  reported: string | null | undefined,
  target: string | null,
): DeviceFwStatus {
  if (!reported) return 'unknown';
  if (!target) return 'up-to-date';        // nothing wants to move it
  return reported === target ? 'up-to-date' : 'pending';
}
