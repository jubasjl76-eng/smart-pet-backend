/**
 * Circuit breaker factory (Phase 20). A breaker opens after enough failures,
 * fails fast (no call to the wrapped function) while open, and — after
 * resetTimeout — allows one probe call through that can close it again.
 * `listBreakers()` reflects state for /metrics.
 */
import { describe, it, expect, vi } from 'vitest';
import { circuitBreaker, listBreakers } from '../circuitBreaker.js';

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('circuitBreaker', () => {
  it('opens after a failure, fails fast without calling the function, then recovers', async () => {
    const fn = vi.fn(async (ok: boolean) => {
      if (!ok) throw new Error('boom');
      return 'ok';
    });
    const name = `test-${Math.random()}`;
    const cb = circuitBreaker(name, fn, {
      errorThresholdPercentage: 1,
      resetTimeout: 50,
      rollingCountTimeout: 1000,
      volumeThreshold: 1,
    });

    await expect(cb.fire(false)).rejects.toThrow('boom');
    expect(cb.opened).toBe(true);
    expect(listBreakers().some((b) => b.name === name && b.opened)).toBe(true);

    const callsBeforeOpen = fn.mock.calls.length;
    await expect(cb.fire(true)).rejects.toThrow(); // breaker open — rejects without calling fn
    expect(fn.mock.calls.length).toBe(callsBeforeOpen);

    await wait(60); // past resetTimeout — breaker allows a probe call through
    await expect(cb.fire(true)).resolves.toBe('ok');
    expect(cb.closed).toBe(true);
  });
});
