/**
 * Idempotency-Key support (Phase 20). REDIS_URL unset in tests → the
 * in-memory store path. No header → pass-through. Same key on the same
 * route → the second call replays the first response instead of re-running
 * the handler; a different key → runs again.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

let base: string;
let calls = 0;

beforeAll(async () => {
  const { idempotent } = await import('../middleware/idempotency.js');
  const app = express();
  app.post('/create', idempotent(), (_req, res) => {
    calls += 1;
    res.status(201).json({ n: calls });
  });
  const srv = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

describe('idempotency', () => {
  it('runs the handler on every call when no Idempotency-Key is sent', async () => {
    const before = calls;
    await fetch(`${base}/create`, { method: 'POST' });
    await fetch(`${base}/create`, { method: 'POST' });
    expect(calls).toBe(before + 2);
  });

  it('replays the first response for a repeated key, and runs fresh for a new one', async () => {
    const first = await fetch(`${base}/create`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'abc-123' },
    });
    const firstBody = await first.json();
    expect(first.status).toBe(201);
    expect(first.headers.get('idempotent-replayed')).toBeNull();

    const replay = await fetch(`${base}/create`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'abc-123' },
    });
    const replayBody = await replay.json();
    expect(replay.status).toBe(201);
    expect(replayBody).toEqual(firstBody); // same `n` — handler did not re-run
    expect(replay.headers.get('idempotent-replayed')).toBe('true');

    const fresh = await fetch(`${base}/create`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'xyz-999' },
    });
    const freshBody = await fresh.json();
    expect(freshBody).not.toEqual(firstBody); // different key → the handler ran again
  });
});
