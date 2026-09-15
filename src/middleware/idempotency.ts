/**
 * Idempotency-Key support (hardening Phase 20, A12 #4) — a retried request
 * carrying the same key returns the first result instead of re-running the
 * handler, per the `IdempotencyKey` parameter `src/openapi/index.ts` has
 * documented on `idempotent: true` routes since Phase 14.
 *
 * Redis-backed (24h TTL) so every backend instance shares the cache; an
 * in-memory Map when REDIS_URL is unset (dev/local, single instance).
 *
 * ponytail: no reservation/lock phase — two requests carrying the SAME key
 * that arrive concurrently, before either has finished, can both reach the
 * handler. That's a narrow race, not the common case this exists for (a
 * client that timed out and retried after the first attempt completed).
 * Upgrade path: SET NX a placeholder before running the handler, replace it
 * with the real response on completion.
 */
import type { Request, Response, NextFunction } from 'express';
import { redis } from '../redis.js';
import type { AuthRequest } from './auth.js';
import { log } from '../log.js';

const TTL_S = 24 * 60 * 60; // 24h — comfortably covers a client's retry window
const HEADER = 'Idempotency-Key';

interface Cached {
  status: number;
  body: string;
}

const memStore = new Map<string, Cached & { expiresAt: number }>();

function keyFor(req: Request, idemKey: string): string {
  const scope = (req as AuthRequest).user?.id ?? req.ip ?? 'anon';
  return `idem:${scope}:${req.method}:${req.originalUrl}:${idemKey}`;
}

async function readCached(key: string): Promise<Cached | null> {
  if (redis) {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as Cached) : null;
  }
  const e = memStore.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    memStore.delete(key);
    return null;
  }
  return { status: e.status, body: e.body };
}

async function writeCached(key: string, value: Cached): Promise<void> {
  if (redis) {
    await redis.set(key, JSON.stringify(value), 'EX', TTL_S);
    return;
  }
  memStore.set(key, { ...value, expiresAt: Date.now() + TTL_S * 1000 });
}

/**
 * Mount on a mutating route already registered `idempotent: true` in its
 * `apiRoute()` spec. A no-op when the client doesn't send the header.
 */
export function idempotent() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header(HEADER);
    if (!header) {
      next();
      return;
    }
    const key = keyFor(req, header);

    try {
      const cached = await readCached(key);
      if (cached) {
        res
          .status(cached.status)
          .set('Idempotent-Replayed', 'true')
          .type('application/json')
          .send(cached.body);
        return;
      }
    } catch (err) {
      log.warn({ err, key }, 'idempotency store unavailable — running the handler unprotected');
      next();
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = ((body?: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const payload = JSON.stringify(body);
        writeCached(key, { status: res.statusCode, body: payload }).catch((err) =>
          log.warn({ err, key }, 'failed to cache idempotent response'),
        );
      }
      return originalJson(body);
    }) as Response['json'];

    next();
  };
}
