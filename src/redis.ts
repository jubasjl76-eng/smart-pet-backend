/**
 * Redis connection (hardening Phase 20 — `modules/cache` from Phase 12,
 * dormant until now).
 *
 * `REDIS_URL` unset (dev/local, `modules/cache`'s `enabled = false`) → `redis`
 * is `null` and every future consumer (rate limiter, SSE fan-out, leader
 * lock, idempotency store) falls back to its in-process/single-instance
 * behavior. Set (staging/prod) → a real `ioredis` client.
 */
import Redis from 'ioredis';
import { config } from './config/index.js';
import { log } from './log.js';

export const redis: Redis | null = config.REDIS_URL
  ? new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    })
  : null;

if (redis) {
  redis.on('error', (err) => log.error({ err }, 'redis error'));
  redis.connect().catch((err) => log.error({ err }, 'redis connect failed'));
}

/** True when Redis isn't configured (nothing to check) or PINGs successfully. */
export async function redisHealthy(): Promise<boolean> {
  if (!redis) return true;
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redis) await redis.quit().catch(() => {});
}
