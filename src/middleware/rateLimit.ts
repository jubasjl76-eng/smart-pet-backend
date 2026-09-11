/**
 * Application rate-limit stack (hardening Phase 20, A10).
 *
 * Token-bucket per route class, Redis-backed (src/redis.ts) so every backend
 * instance shares one counter — an in-memory store would let each of prod's
 * ×2+ instances grant the full quota. Falls back to express-rate-limit's
 * built-in in-memory store when Redis is unset (dev/local, single instance).
 *
 * Response contract — documented in src/openapi/index.ts's `RateLimited`
 * component and consumed by @jubasjl76-eng/api-client's RateLimitedError:
 * 429 + Retry-After + RateLimit-Limit/-Remaining/-Reset (IETF draft-7) +
 * a `{ error }` JSON body.
 */
import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import type { Request } from 'express';
import { redis } from '../redis.js';
import type { AuthRequest } from './auth.js';

function store(prefix: string): Options['store'] | undefined {
  const client = redis;
  if (!client) return undefined; // express-rate-limit's default MemoryStore
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) =>
      client.call(command, ...args) as Promise<RedisReply>,
  });
}

function limiter(opts: {
  windowMs: number;
  limit: number;
  keyPrefix: string;
  keyGenerator?: Options['keyGenerator'];
}) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    // 'draft-6' → separate RateLimit-Limit/-Remaining/-Reset headers, which
    // is what src/openapi/index.ts's RateLimited component documents.
    // ('draft-7'+ in this library version combine them into one `RateLimit`
    // header per a newer IETF revision — not what the contract declares.)
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    message: { error: 'Too many requests' },
    store: store(opts.keyPrefix),
    ...(opts.keyGenerator ? { keyGenerator: opts.keyGenerator } : {}),
  });
}

/** ~5/min/IP — /api/auth/* (credential stuffing). */
export const authLimiter = limiter({ windowMs: 60_000, limit: 5, keyPrefix: 'auth' });

/** ~30/min/IP — /api/public/* (marketing-site browsing). */
export const publicLimiter = limiter({ windowMs: 60_000, limit: 30, keyPrefix: 'public' });

/** ~100/hr/IP — layered on top of publicLimiter for POST /api/public/inquiries. */
export const inquiryLimiter = limiter({ windowMs: 3_600_000, limit: 100, keyPrefix: 'inquiry' });

/** ~600/min per authenticated user — /api/breeder/* (mount after `auth`). */
export const breederLimiter = limiter({
  windowMs: 60_000,
  limit: 600,
  keyPrefix: 'breeder',
  keyGenerator: (req: Request) => (req as AuthRequest).user?.id ?? ipKeyGenerator(req.ip ?? ''),
});
