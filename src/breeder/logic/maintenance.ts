/**
 * Predictive maintenance — turn running device counters into "service soon" flags.
 *
 * Counters are incremented by the engine:
 *   servo_cycles  += 1 per feed command acked
 *   door_cycles   += 1 per pen-door open
 *   pump_seconds  += dispense duration
 *   jam_count     += 1 per reported jam / no-flow
 *   rssi_ewma      = exponentially weighted mean of Wi-Fi RSSI (dBm, negative)
 */

export interface HealthCounter {
  metric: string;
  value: number;
  serviceLimit: number | null;
  servicedAt?: Date | string | null;
}

export type MaintenanceLevel = 'ok' | 'monitor' | 'due' | 'overdue';

export interface MaintenancePrediction {
  metric: string;
  level: MaintenanceLevel;
  usedFraction: number | null;   // value / serviceLimit
  remaining: number | null;      // serviceLimit - value
  message: string;
}

export function predictMaintenance(counter: HealthCounter): MaintenancePrediction {
  const { metric, value, serviceLimit } = counter;

  // RSSI is a signal-quality metric, not a wear counter: worse (more negative) is bad.
  if (metric === 'rssi_ewma') {
    let level: MaintenanceLevel = 'ok';
    if (value <= -85) level = 'due';
    else if (value <= -78) level = 'monitor';
    return {
      metric, level, usedFraction: null, remaining: null,
      message: level === 'ok' ? 'Wi-Fi signal OK'
        : level === 'monitor' ? `Wi-Fi weak (${value} dBm) — watch for dropouts`
        : `Wi-Fi poor (${value} dBm) — add an AP / move the device`,
    };
  }

  if (metric === 'jam_count') {
    let level: MaintenanceLevel = 'ok';
    if (value >= 5) level = 'due';
    else if (value >= 2) level = 'monitor';
    return {
      metric, level, usedFraction: null, remaining: null,
      message: level === 'ok' ? 'No jams'
        : `${value} jam(s) since last service — inspect the mechanism`,
    };
  }

  if (serviceLimit == null || serviceLimit <= 0) {
    return { metric, level: 'ok', usedFraction: null, remaining: null, message: 'No service limit set' };
  }
  const usedFraction = value / serviceLimit;
  const remaining = serviceLimit - value;
  let level: MaintenanceLevel = 'ok';
  if (usedFraction >= 1) level = 'overdue';
  else if (usedFraction >= 0.9) level = 'due';
  else if (usedFraction >= 0.75) level = 'monitor';

  const message =
    level === 'overdue' ? `${metric} past service limit (${value}/${serviceLimit}) — service now`
    : level === 'due' ? `${metric} at ${Math.round(usedFraction * 100)}% of service life — schedule service`
    : level === 'monitor' ? `${metric} at ${Math.round(usedFraction * 100)}% of service life`
    : `${metric} healthy`;

  return { metric, level, usedFraction: Number(usedFraction.toFixed(3)), remaining, message };
}

/** EWMA update for RSSI-style rolling metrics. alpha in (0,1], higher = more reactive. */
export function ewma(prev: number | null, sample: number, alpha = 0.2): number {
  if (prev == null || !Number.isFinite(prev)) return sample;
  return Number((alpha * sample + (1 - alpha) * prev).toFixed(2));
}
