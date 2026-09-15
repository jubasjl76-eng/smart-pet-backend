/**
 * API conformance (hardening Phase 17).
 *
 * Every operation in the committed OpenAPI doc must be reachable on the real
 * router tree — this catches "documented a path that was never mounted",
 * "renamed a route but not the spec", and "wrong mount prefix". The DB + MQTT
 * are stubbed; we only assert the request did NOT fall through to the app's
 * catch-all 404, and that `secure` operations reject an unauthenticated call.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

vi.mock('../database/index.js', () => ({
  query: async () => [],
  queryOne: async () => null,
  execute: async () => {},
  initializeDatabase: async () => {},
  pool: {},
}));
vi.mock('../services/feederMqtt.js', () => ({
  isFeederMqttConnected: () => true,
  startFeederMqtt: async () => {},
  stopFeederMqtt: () => {},
  publishCommand: async () => {},
}));
vi.mock('../services/flags.js', () => ({ getFlags: async () => ({}) }));

const { buildApp } = await import('../app.js');
const { buildOpenApiDoc } = await import('../openapi/index.js');

let base: string;
beforeAll(async () => {
  const app = buildApp();
  const srv = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

interface Op {
  method: string;
  path: string;
  secure: boolean;
}

function operations(): Op[] {
  const doc = buildOpenApiDoc() as {
    paths: Record<string, Record<string, { security?: unknown[] }>>;
  };
  const ops: Op[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      ops.push({
        method: method.toUpperCase(),
        path,
        secure: Array.isArray(op.security) && op.security.length > 0,
      });
    }
  }
  return ops;
}

/** `/api/breeder/animals/{id}` → `/api/breeder/animals/x` */
const fill = (p: string) => p.replace(/\{[^}]+\}/g, 'x');

describe('OpenAPI conformance', () => {
  it('documents at least the full breeder + owner surface', () => {
    expect(operations().length).toBeGreaterThan(120);
  });

  it.each(operations())('$method $path is mounted', async ({ method, path, secure }) => {
    const res = await fetch(`${base}${fill(path)}`, {
      method,
      headers:
        method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
    });

    // Never the app-level catch-all.
    let body: unknown = null;
    try {
      body = await res.clone().json();
    } catch {
      /* non-JSON is fine */
    }
    const fellThrough = res.status === 404 && (body as { code?: string })?.code === 'no_route';
    expect(fellThrough, `${method} ${path} fell through to the catch-all — not mounted`).toBe(
      false,
    );

    // A documented-secure operation must reject an unauthenticated request.
    // 429 is also acceptable: this suite hits every /api/auth/* operation
    // back-to-back from one IP, which legitimately trips that route class's
    // rate limiter (Phase 20) partway through — still a rejection, just via
    // a different, earlier-in-the-chain gate than the route's own auth check.
    if (secure) {
      expect(
        [401, 403, 429],
        `${method} ${path} is documented secure but returned ${res.status} unauthenticated`,
      ).toContain(res.status);
    }
  });
});
