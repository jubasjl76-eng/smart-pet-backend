import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { registry, httpMetricsMiddleware } from '../metrics.js';
import '../breeder/engine/channels.js'; // registers the resend/twilio breakers

describe('metrics registry', () => {
  it('exposes default process + pg-pool + http + circuit-breaker metrics', async () => {
    const text = await registry.metrics();
    expect(text).toContain('process_cpu_user_seconds_total');
    expect(text).toContain('pg_pool_connections');
    expect(text).toContain('http_request_duration_seconds');
    expect(text).toContain('service="smart-pet-backend"');
    // resend/twilio/mqtt-publish/revalidate-webhook breakers self-register on
    // import (channels.ts, feederMqtt.ts, revalidate.ts) — closed (0) by default.
    expect(text).toMatch(/circuit_breaker_state\{[^}]*name="resend"[^}]*\} 0/);
  });

  it('records a request when the response finishes', async () => {
    let finish: () => void = () => {};
    const req = {
      method: 'GET',
      path: '/x',
      baseUrl: '/api/breeder/inbox',
      route: { path: '/:id' },
    } as unknown as Request;
    const res = {
      statusCode: 200,
      on: (ev: string, cb: () => void) => {
        if (ev === 'finish') finish = cb;
      },
    } as unknown as Response;

    httpMetricsMiddleware(req, res, () => {});
    finish();

    const text = await registry.metrics();
    expect(text).toMatch(
      /http_request_duration_seconds_count\{[^}]*route="\/api\/breeder\/inbox\/:id"[^}]*\}/,
    );
  });

  it('skips its own endpoint', () => {
    const req = { path: '/metrics' } as unknown as Request;
    let called = false;
    httpMetricsMiddleware(req, {} as Response, () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
