/**
 * W3C Trace Context over MQTT (hardening Phase 16).
 *
 * `injectTrace` stamps the active span's `traceparent` (+ `tracestate`) onto an
 * outbound command payload; `withExtractedTrace` runs a handler under the
 * context carried by an inbound status/ack/event. Both no-op when there is no
 * active trace (Sentry tracing off), so they're always safe to call.
 */
import { propagation, context } from '@opentelemetry/api';

type Carrier = Record<string, unknown>;

export function injectTrace<T extends Carrier>(carrier: T): T {
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function withExtractedTrace<T>(carrier: Carrier | undefined, fn: () => T): T {
  const ctx = propagation.extract(context.active(), carrier ?? {});
  return context.with(ctx, fn);
}
