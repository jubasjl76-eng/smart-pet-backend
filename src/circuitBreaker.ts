/**
 * Circuit breakers around outbound calls (hardening Phase 20, A12 #5) —
 * Resend, Twilio, MQTT publish, the revalidate webhook. A provider outage
 * shouldn't block or retry forever against a dead host: after enough
 * failures the breaker opens and every call fails fast (no network attempt)
 * until `resetTimeout` elapses and it tries a single probe call.
 *
 * No `.fallback()` is registered on any breaker here — an open-circuit
 * rejection looks exactly like a real call failure to the caller, which
 * already has its own degrade path (return a `failed`/`suppressed` result,
 * swallow-and-log, queue for retry). `/metrics` exposes each breaker's state
 * (src/metrics.ts).
 */
import CircuitBreaker from 'opossum';

const breakers: CircuitBreaker[] = [];

export function circuitBreaker<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R>,
  opts: CircuitBreaker.Options = {},
): CircuitBreaker<A, R> {
  const cb = new CircuitBreaker(fn, {
    timeout: 10_000,
    errorThresholdPercentage: 50,
    resetTimeout: 30_000,
    rollingCountTimeout: 60_000,
    ...opts,
    name,
  });
  breakers.push(cb);
  return cb;
}

export function listBreakers(): readonly CircuitBreaker[] {
  return breakers;
}
