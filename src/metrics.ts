/**
 * Prometheus metrics (hardening Phase 16).
 *
 *   GET /metrics   — default process metrics (CPU / mem / event-loop / GC),
 *                    an HTTP request-duration histogram, and pg-pool gauges.
 *
 * Scraped by the Grafana Cloud agent. If METRICS_TOKEN is set the endpoint
 * requires `Authorization: Bearer <token>`; otherwise it is open (dev / behind
 * a private ALB — Phase 18 adds the edge restriction).
 */
import { collectDefaultMetrics, Registry, Histogram, Gauge } from 'prom-client';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config/index.js';
import { pool } from './database/index.js';
import { listBreakers } from './circuitBreaker.js';
import { VERSION } from './version.js';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'smart-pet-backend', version: VERSION });
collectDefaultMetrics({ register: registry });

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// pg pool depth — read on each scrape.
new Gauge({
  name: 'pg_pool_connections',
  help: 'node-postgres pool connections by state',
  labelNames: ['state'],
  registers: [registry],
  collect() {
    this.set({ state: 'total' }, pool.totalCount);
    this.set({ state: 'idle' }, pool.idleCount);
    this.set({ state: 'waiting' }, pool.waitingCount);
  },
});

// Circuit breaker state (Phase 20, A12 #5) — 0 closed, 0.5 half-open, 1 open.
// Read on each scrape; opossum breakers created in channels.ts (Resend,
// Twilio), feederMqtt.ts (MQTT publish), and revalidate.ts self-register via
// circuitBreaker() (src/circuitBreaker.ts).
new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state by name: 0 closed, 0.5 half-open, 1 open',
  labelNames: ['name'],
  registers: [registry],
  collect() {
    for (const cb of listBreakers()) {
      this.set({ name: cb.name }, cb.opened ? 1 : cb.halfOpen ? 0.5 : 0);
    }
  },
});

/** Low-cardinality route label: the mounted path + the matched sub-route, or "other". */
function routeLabel(req: Request): string {
  const sub = req.route?.path;
  if (typeof sub === 'string') return (req.baseUrl || '') + sub || sub;
  return req.baseUrl || 'other';
}

export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/metrics') return next();
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: routeLabel(req), status: String(res.statusCode) });
  });
  next();
}

export async function metricsHandler(req: Request, res: Response): Promise<void> {
  const token = config.METRICS_TOKEN;
  if (token && req.get('authorization') !== `Bearer ${token}`) {
    res.status(401).end();
    return;
  }
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
}
