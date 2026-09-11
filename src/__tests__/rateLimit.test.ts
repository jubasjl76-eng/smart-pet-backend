/**
 * Application rate-limit stack (Phase 20). Exercises the real exported
 * `authLimiter` (limit 5/min) end-to-end — headers + body shape must match
 * the OpenAPI `RateLimited` component (src/openapi/index.ts) that
 * @jubasjl76-eng/api-client's RateLimitedError is generated from.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

let base: string;
beforeAll(async () => {
  const { authLimiter } = await import('../middleware/rateLimit.js');
  const app = express();
  app.get('/ping', authLimiter, (_req, res) => res.json({ ok: true }));
  const srv = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

describe('rate limit', () => {
  it('allows up to the limit, then 429s with the documented contract', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/ping`);
      expect(res.status).toBe(200);
    }

    const res = await fetch(`${base}/ping`);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(res.headers.get('ratelimit-limit')).toBe('5');
    expect(res.headers.get('ratelimit-remaining')).toBe('0');
    expect(res.headers.get('ratelimit-reset')).toMatch(/^\d+$/);
    await expect(res.json()).resolves.toEqual({ error: 'Too many requests' });
  });
});
