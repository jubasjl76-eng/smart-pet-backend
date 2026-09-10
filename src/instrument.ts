/**
 * Sentry — MUST be imported first in `src/index.ts`, before express / pg / mqtt,
 * so the SDK can patch them (hardening Phase 15).
 *
 * No DSN → `Sentry.init` is a no-op and the service runs exactly as before, so
 * this can land ahead of the Sentry project existing. Set `SENTRY_DSN` (+ the
 * optional knobs) per environment to turn it on.
 *
 * Reads raw `process.env` (not the zod config) to stay ahead of every other
 * import; it runs its own `dotenv.config()` — idempotent with config/index.ts.
 */
import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/core';
import { VERSION } from './version.js';

dotenv.config();

/** Strip the bearer token + cookies from an outbound error event. */
export function scrub(event: ErrorEvent): ErrorEvent {
  if (event.request?.headers) {
    delete event.request.headers.authorization;
    delete event.request.headers.Authorization;
    delete event.request.headers.cookie;
  }
  delete event.request?.cookies;
  return event;
}

const dsn = process.env.SENTRY_DSN?.trim() || undefined;

Sentry.init({
  dsn,
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
  release: process.env.SENTRY_RELEASE || `smart-pet-backend@${VERSION}`,
  // Perf tracing stays off until Phase 16 wires OTel; opt in per env.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0,
  sendDefaultPii: false,
  beforeSend: scrub,
});

if (dsn) {
  console.log(`[boot] Sentry enabled (env=${process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV})`);
}
