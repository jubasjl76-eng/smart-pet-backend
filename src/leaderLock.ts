/**
 * Leader-election lock (hardening Phase 20, A12 #2) — `SET key val PX ttl NX`,
 * so exactly one backend instance runs a periodic sweep (engineTick, which
 * runs fleetSweep/retentionSweep/vaccinationSweep/etc. internally) per tick
 * window, once prod scales past one instance.
 *
 * REDIS_URL unset (dev/local, single instance) → every call is the leader —
 * nothing to coordinate with. A Redis error also runs the work rather than
 * skipping it: a rare double-run (the sweeps are dedupKey'd/idempotent-ish)
 * is a smaller failure than silently stopping every sweep fleet-wide.
 *
 * No renewal, no explicit release: the TTL alone bounds exclusivity to one
 * tick window and then expires, so the next tick's `SET ... NX` — from
 * whichever instance's timer fires first — naturally re-elects a leader.
 */
import { randomUUID } from 'node:crypto';
import { redis } from './redis.js';
import { log } from './log.js';

const TOKEN = randomUUID(); // unused today (no compare-and-release), kept as the lock value for debugging (`redis-cli GET <key>` names the holder)

/** Runs `fn` only if this call acquires `key` for `ttlMs`; otherwise a no-op. */
export async function withLeaderLock(
  key: string,
  ttlMs: number,
  fn: () => Promise<void>,
): Promise<void> {
  if (redis) {
    try {
      const ok = await redis.set(key, TOKEN, 'PX', ttlMs, 'NX');
      if (ok !== 'OK') return; // another instance holds it this window
    } catch (err) {
      log.warn({ err, key }, 'leader lock unavailable — running unlocked this tick');
    }
  }
  await fn();
}
