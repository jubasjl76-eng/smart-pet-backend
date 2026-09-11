/**
 * Typed config contract for the backend (hardening Phase 12, A8).
 *
 * ONE zod schema over `process.env`, split by where the value comes from.
 * Importing this module parses + validates once; a missing/invalid var prints
 * every problem and exits — the service never boots half-configured.
 *
 * Migration status: the boot path (server, DB pool, migrations, MQTT) reads
 * from `config`. Leaf reads (SEED_*, notification provider keys, TTLs, storage)
 * still read `process.env` directly for now; they are in the schema so boot
 * still validates them, and they move to `config.X` as those files are touched.
 */
import dotenv from 'dotenv';
import { loadConfig, redact, z, envBool, envInt, envPort } from '@jubasjl76-eng/shared';

dotenv.config();

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);

const schema = z.object({
  // ── public / build-time ──────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  /** The product API is locked to port 3000; PORT is read only to warn if overridden. */
  PORT: envPort().default(3000),
  BACKEND_MODE: z.preprocess(lower, z.enum(['cloud', 'local', 'edge']).default('cloud')),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  BREEDER_KENNEL_SLUG: z.string().default('home'),
  BREEDER_KENNEL_NAME: z.string().default('Home Kennel'),

  // ── runtime non-secret ───────────────────────────────────────────────
  BREEDER_TICK_MS: envInt().default(60_000),
  FEED_ACK_TIMEOUT_MS: envInt().default(8_000),

  PG_HOST: z.string().default('localhost'),
  PG_PORT: envPort().default(5432),
  PG_DATABASE: z.string().optional(),
  PG_USER: z.string().default('postgres'),
  // Pool sizing (Phase 20, A12 #1). Default 10 matches pg's own default
  // (dev/local, unmanaged); staging/prod set PG_POOL_MAX from Terraform —
  // floor(max_connections / instance count), with headroom.
  PG_POOL_MAX: envInt().default(10),
  PG_IDLE_TIMEOUT_MS: envInt().default(30_000),
  // 0 = pg's own default of "wait forever" for a connection attempt — a real
  // risk (a stuck attempt never frees the caller). 5s everywhere.
  PG_CONNECTION_TIMEOUT_MS: envInt().default(5_000),
  // Also set at the DB parameter-group level (defense in depth) once
  // Terraform's staging/prod max_connections + statement_timeout land.
  PG_STATEMENT_TIMEOUT_MS: envInt().default(30_000),
  // pg-boss (src/jobs/queue.ts) opens its own separate pg.Pool — small on
  // purpose, it's mostly idle between polls, not the app's main query load.
  PG_BOSS_POOL_MAX: envInt().default(5),

  MQTT_URL: z.string().optional(),
  MQTT_BROKER: z.string().optional(),
  MQTT_PUBLIC_URL: z.string().optional(),
  MQTT_CLIENT_ID: z.string().default('smart-pet-backend'),
  MQTT_USER: z.string().optional(),
  MQTT_USERNAME: z.string().optional(),
  MOSQUITTO_ACL_PATH: z.string().optional(),

  ACCESS_TTL: z.string().default('12h'),
  REFRESH_TTL_DAYS: envInt().default(30),
  INVITE_TTL_DAYS: envInt().default(7),
  PAIRING_TTL_MIN: envInt().default(60),

  STORAGE_DRIVER: z.preprocess(lower, z.enum(['local', 's3']).default('local')),
  STORAGE_DIR: z.string().default('./data/uploads'),

  WEBSITE_REVALIDATE_URL: z.string().optional(),

  // ── error tracking (Phase 15) — read raw in src/instrument.ts; in the schema
  //    so boot still validates them. A DSN is not a secret.
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),

  // observability (Phase 16) — /metrics is open unless this bearer token is set.
  METRICS_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).optional(),

  NOTIFY_EMAIL_FROM: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_FROM: z.string().optional(),

  SEED_OWNER_EMAIL: z.string().optional(),
  SEED_STAFF_EMAIL: z.string().optional(),
  SEED_DEMO: envBool().optional(),
  SEED_RULES: envBool().optional(),
  SEED_PENS: envBool().optional(),
  SEED_CONSOLE: envBool().optional(),
  SEED_VACC: envBool().optional(),

  // ── secret (AWS Secrets Manager at runtime; SOPS+age for git-committed non-prod) ──
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is unset — refusing to boot'),
  // Unset (dev/local) → src/redis.ts exports `redis: null`, every consumer
  // falls back to in-process/single-instance behavior (Phase 20).
  REDIS_URL: z.string().optional(),
  PG_PASSWORD: z.string().default('postgres'),
  MQTT_PASSWORD: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  WEBSITE_REVALIDATE_SECRET: z.string().optional(),
  SEED_OWNER_PASSWORD: z.string().optional(),
  SEED_STAFF_PASSWORD: z.string().optional(),
});

export const config = loadConfig(schema, { name: 'backend' });

export const SECRET_KEYS = [
  'JWT_SECRET',
  'REDIS_URL',
  'PG_PASSWORD',
  'MQTT_PASSWORD',
  'RESEND_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'WEBSITE_REVALIDATE_SECRET',
  'SEED_OWNER_PASSWORD',
  'SEED_STAFF_PASSWORD',
] as const;

/** The effective MQTT broker URL for the backend client (feeder + engine). */
export const mqttUrl = (): string =>
  config.MQTT_URL || config.MQTT_BROKER || 'mqtt://localhost:1883';

/** The MQTT broker URL to hand a device on claim (falls back to the client URL). */
export const mqttPublicUrl = (): string | null => config.MQTT_PUBLIC_URL || config.MQTT_URL || null;

/** The Postgres database name, honouring the legacy edge-mode default. */
export const pgDatabase = (): string =>
  config.PG_DATABASE || (config.BACKEND_MODE === 'edge' ? 'smartpet_edge' : 'smartpet');

/** Config with secrets masked — safe to log at boot. */
export const safeConfig = () =>
  redact({ ...config, MQTT_URL: mqttUrl(), PG_DATABASE: pgDatabase() }, SECRET_KEYS);
