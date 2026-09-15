/**
 * Structured logging (hardening Phase 16).
 *
 * `log` is a pino instance: JSON on staging/prod (one object per line, ready
 * for Grafana Loki), pretty-printed in development. `LOG_LEVEL` overrides the
 * default (`debug` in dev, `info` elsewhere).
 *
 * Every line carries `service` + `version`, and — when there's an active
 * OpenTelemetry span — `traceId` / `spanId`, so a log links to its trace.
 *
 * Migration is incremental: the boot path, the engine and the MQTT + error
 * handlers use `log`; other `console.*` calls move over as files are touched.
 */
import pino from 'pino';
import { trace, context } from '@opentelemetry/api';
import { config } from './config/index.js';
import { VERSION } from './version.js';

const isDev = config.NODE_ENV === 'development';

/** Adds traceId / spanId to a log line when there's an active OTel span. */
export function traceMixin(): Record<string, string> {
  const span = trace.getSpanContext(context.active());
  return span?.traceId ? { traceId: span.traceId, spanId: span.spanId } : {};
}

export const log = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  base: { service: 'smart-pet-backend', version: VERSION },
  mixin: traceMixin,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie',
      '*.password', '*.token', '*.jwt', '*.secret',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,version' },
        },
      }
    : {}),
});
