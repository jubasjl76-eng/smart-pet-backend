/**
 * Security headers (Phase 18, A12 #11). helmet on every response; a strict
 * `default-src 'none'` CSP on the API, a looser one on `/docs` for Scalar.
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

let base: string;
beforeAll(async () => {
  const app = buildApp();
  const srv = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

describe('security headers', () => {
  it('sets helmet defaults + a locked-down CSP on API responses', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('loosens only script/style/font on /docs so Scalar can load', async () => {
    const csp = (await fetch(`${base}/docs`)).headers.get('content-security-policy') ?? '';
    expect(csp).toContain('https://cdn.jsdelivr.net');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("default-src 'none'");
  });
});
