/**
 * Consumer for the firmware `crash` event (hardening Phase 15).
 *
 * A device that rebooted after a panic / watchdog / brown-out publishes one
 *   kennel/{k}/{type}/{id}/event  { event:"crash", reason, rawReason, fw, heapFree, minHeapFree }
 * on its next MQTT connect (smart-pet-device-sdk `spd_crash.h`).
 *
 * We forward it to Sentry (tagged as firmware, grouped by device-type + reason)
 * and raise a critical care-inbox exception so a human pulls a flapping device.
 */
import * as Sentry from '@sentry/node';
import type { RuleEvent } from '../logic/rules.js';
import { raiseException } from '../exceptions.js';

export async function handleCrashEvent(evt: RuleEvent): Promise<void> {
  const d = (evt.meta ?? {}) as Record<string, unknown>;
  const reason = String(d.reason ?? 'unknown');
  const fw = d.fw != null ? String(d.fw) : undefined;
  const deviceId = evt.deviceId ?? 'unknown';
  const deviceType = evt.deviceType ?? 'device';

  Sentry.captureEvent({
    message: `firmware crash (${deviceType}): ${reason}`,
    level: 'error',
    logger: 'firmware',
    tags: {
      source: 'firmware',
      kennelId: evt.kennelId,
      deviceId,
      deviceType,
      reason,
      ...(fw ? { fw } : {}),
    },
    fingerprint: ['firmware-crash', deviceType, reason],
    extra: { ...d, at: evt.at.toISOString() },
  });

  await raiseException({
    kennelId: evt.kennelId,
    kind: 'device-crash',
    severity: 'critical',
    deviceId,
    title: `${deviceType} ${deviceId} rebooted after a crash`,
    detail:
      `Reset reason: ${reason}` +
      (fw ? ` · fw ${fw}` : '') +
      (d.heapFree != null ? ` · heapFree ${d.heapFree}` : '') +
      (d.minHeapFree != null ? ` · minHeapFree ${d.minHeapFree}` : ''),
    suggestedAction: 'Check the device. If it repeats, pull it from service and RMA.',
    dedupKey: `device-crash:${deviceId}:${fw ?? 'unknown'}`,
    notifyAudience: 'on-call',
  }).catch((e) => {
    console.error('[engine] crash exception failed', (e as Error).message);
  });
}
