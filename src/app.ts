/**
 * Express app assembly — every middleware + route, no server, no DB init.
 *
 * `src/index.ts` calls `buildApp()`, then owns `app.listen`, the boot chain and
 * graceful shutdown. Tests call `buildApp()` directly (see
 * `__tests__/openapi-conformance.test.ts`).
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import * as Sentry from '@sentry/node';
import cors from 'cors';
import helmet from 'helmet';

import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import scheduleRoutes from './routes/schedules.js';
import eventRoutes from './routes/events.js';
import setupRoutes from './routes/setup.js';
import userRoutes from './routes/users.js';
import { auth, ownerOnly, adminOnly } from './middleware/auth.js';
import { query, queryOne } from './database/index.js';
import { isFeederMqttConnected } from './services/feederMqtt.js';
import { redis, redisHealthy } from './redis.js';
import { mountBreeder } from './breeder/index.js';
import { getFlags } from './services/flags.js';
import { buildOpenApiDoc, docsHtml } from './openapi/index.js';
import { config, safeConfig } from './config/index.js';
import { VERSION } from './version.js';
import { httpMetricsMiddleware, metricsHandler } from './metrics.js';
import { log } from './log.js';

const API_SUNSET = 'Fri, 01 Jan 2027 00:00:00 GMT';

export interface BuildAppOptions {
  /** `/ready` reports 503 while this is true. Defaults to never. */
  isShuttingDown?: () => boolean;
}

export function buildApp(opts: BuildAppOptions = {}): Express {
  const isShuttingDown = opts.isShuttingDown ?? (() => false);
  const BACKEND_MODE = config.BACKEND_MODE;
  const app: Express = express();

  app.set('trust proxy', false);

  // Security headers (Phase 18, A12 #11). This is a JSON API — a response body
  // should never pull in resources — so the CSP is `default-src 'none'`. HSTS,
  // nosniff, frameguard, referrer-policy etc. come from helmet's defaults;
  // `X-Powered-By` is dropped. CORP is `cross-origin` so the dashboard / app
  // (separate origins) can read responses. `/docs` overrides the CSP below.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(cors());
  app.use(express.json());
  app.use(httpMetricsMiddleware);

  // API versioning (Phase 14, A1). `/api/v1/*` → `/api/*`; bare `/api/*` is a
  // deprecated alias that still works but carries Deprecation + Sunset headers.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const u = req.url;
    if (u === '/api/v1' || u.startsWith('/api/v1/') || u.startsWith('/api/v1?')) {
      req.url = '/api' + u.slice('/api/v1'.length);
    } else if (
      (u === '/api' || u.startsWith('/api/') || u.startsWith('/api?')) &&
      !u.startsWith('/api/config')
    ) {
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', API_SUNSET);
      res.setHeader('Link', '</docs>; rel="describedby"');
    }
    next();
  });

  // Liveness — the process is up. Always 200.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      mode: BACKEND_MODE,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: VERSION,
      port: 3000,
    });
  });

  // Readiness — 503 until the DB answers, MQTT is connected, and (when
  // REDIS_URL is set) Redis PINGs, and while draining. `redis` in the body is
  // `null` when unconfigured (dev/local, expected) rather than a failure.
  app.get('/ready', async (_req: Request, res: Response) => {
    let db = false;
    try {
      await query('SELECT 1');
      db = true;
    } catch {
      db = false;
    }
    const mqtt = isFeederMqttConnected();
    const redisOk = await redisHealthy();
    const draining = isShuttingDown();
    const ok = db && mqtt && redisOk && !draining;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ready' : 'not-ready',
      db,
      mqtt,
      redis: redis ? redisOk : null,
      shuttingDown: draining,
    });
  });

  // Prometheus metrics (Phase 16).
  app.get('/metrics', metricsHandler);

  // OpenAPI spec + a Scalar reference UI (Phase 14). The UI loads Scalar from
  // jsdelivr and runs inline, so `/docs` gets a looser CSP than the API default.
  // ponytail: self-host @scalar/api-reference to drop the CDN + 'unsafe-inline'.
  const docsCsp = helmet.contentSecurityPolicy({
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      'style-src': [
        "'self'",
        "'unsafe-inline'",
        'https://cdn.jsdelivr.net',
        'https://fonts.googleapis.com',
      ],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'https:'],
      'connect-src': ["'self'"],
      'worker-src': ["'self'", 'blob:'],
      'frame-ancestors': ["'none'"],
    },
  });
  app.get('/openapi.json', (_req: Request, res: Response) => res.json(buildOpenApiDoc()));
  app.get('/docs', docsCsp, (_req: Request, res: Response) => res.type('html').send(docsHtml));

  // Non-secret runtime config for the dashboard / app (no auth).
  app.get('/api/config', async (_req: Request, res: Response) => {
    res.json({
      env: config.NODE_ENV,
      mode: BACKEND_MODE,
      version: VERSION,
      flags: await getFlags(),
    });
  });

  function closed(_req: Request, res: Response) {
    res.status(403).json({
      error: 'closed',
      message:
        'Device path is MQTT status on kennel/{kennelId}/feeder/{deviceId}/status. Owner JWT is not a device credential. X-API-Key is not a product path.',
    });
  }
  app.post('/api/devices/ingest', closed);
  app.post('/api/sync/events', closed);
  app.get('/api/devices/state', closed);
  app.post('/api/iot/events', closed);
  app.use('/api/iot', closed);

  app.use('/api/auth', authRoutes);
  app.use('/api/setup', setupRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/devices', auth, ownerOnly, deviceRoutes);
  app.use('/api/schedules', auth, ownerOnly, scheduleRoutes);
  app.use('/api/events', auth, ownerOnly, eventRoutes);

  app.get('/api/admin/ping', auth, adminOnly, (req: Request, res: Response) => {
    res.json({ ok: true, role: (req as { user?: { role?: string } }).user?.role });
  });

  app.get('/api/pet', auth, async (req: Request, res: Response) => {
    const userId = (req as { user?: { id?: string } }).user?.id;
    try {
      const pet = await queryOne<{ id: string; name: string }>(
        'SELECT id, name FROM pets WHERE user_id = $1 LIMIT 1',
        [userId],
      );
      res.json({ pet: pet || { name: null } });
    } catch {
      res.status(404).json({ error: 'Not found' });
    }
  });

  app.put('/api/pet', auth, async (req: Request, res: Response) => {
    const userId = (req as { user?: { id?: string } }).user?.id;
    const name = String(req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    try {
      const existing = await queryOne<{ id: string }>(
        'SELECT id FROM pets WHERE user_id = $1 LIMIT 1',
        [userId],
      );
      if (existing) {
        const pet = await queryOne(
          'UPDATE pets SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name',
          [name, existing.id],
        );
        res.json({ pet });
      } else {
        const pet = (
          await query('INSERT INTO pets (user_id, name) VALUES ($1, $2) RETURNING id, name', [
            userId,
            name,
          ])
        )[0];
        res.json({ pet });
      }
    } catch {
      res.status(404).json({ error: 'Not found' });
    }
  });

  app.get('/api/stats', auth, ownerOnly, async (req: Request, res: Response) => {
    const userId = (req as { user?: { id?: string } }).user?.id;
    try {
      const devices = await query<{ device_type: string }>(
        `SELECT * FROM devices WHERE user_id = $1`,
        [userId],
      );
      const schedules = await query<{ enabled: boolean }>(
        `SELECT * FROM schedules WHERE user_id = $1`,
        [userId],
      );
      res.json({
        totalDevices: devices.length,
        feeders: devices.filter((d) => d.device_type === 'feeder').length,
        totalSchedules: schedules.length,
        activeSchedules: schedules.filter((s) => s.enabled).length,
      });
    } catch {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // Breeder platform: /api/breeder/*
  mountBreeder(app);

  // Unmatched path. The `code` lets the conformance test tell a fall-through
  // from a handler's own 404.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found', code: 'no_route' });
  });

  // Sentry error handler — after all routes, before ours. No-op without a DSN.
  Sentry.setupExpressErrorHandler(app);

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err }, 'unhandled request error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

/** Boot-time config line — kept here so index.ts stays thin. */
export function logBootConfig(): void {
  if (config.PORT !== 3000)
    log.warn({ port: config.PORT }, 'API is locked to port 3000; ignoring PORT');
  log.info({ config: safeConfig() }, 'boot');
}
