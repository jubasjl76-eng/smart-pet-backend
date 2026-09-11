/**
 * Server-Sent Events for the breeder console — live care-inbox + device state.
 *
 * A module EventEmitter fans out to this instance's connected clients,
 * filtered by kennel — unchanged from before Phase 20, and still how a
 * single-instance (dev/local) deployment works end to end.
 *
 * Once `REDIS_URL` is set (Phase 20), `emitStream()` also PUBLISHes to a
 * shared Redis channel, and this module SUBSCRIBEs to it on a dedicated
 * connection (ioredis puts a connection into subscriber-only mode once it
 * issues SUBSCRIBE, so it can't share the app's main `redis` client) — every
 * instance re-emits what every OTHER instance publishes on its own local
 * bus, so a client on ANY instance sees events raised on ANY instance. Each
 * publish carries this process's `ORIGIN` id so an instance ignores its own
 * echo instead of double-delivering to its own clients (it already emitted
 * locally, synchronously, before the publish round-trips back).
 *
 * `GET /api/breeder/stream` (behind auth + withKennel). No client change
 * needed: the dashboard's `useStream` already reconnects to the general
 * (load-balanced) API base, so whichever instance it lands on now has every
 * kennel's events, not just the ones it happened to have a live MQTT/DB
 * write on.
 *
 *   emitStream(kennelId, { type: 'exception', action: 'created', exception })
 *   emitStream(kennelId, { type: 'device',    deviceId, status })
 *   emitStream(kennelId, { type: 'rule_fired', rule })
 *   emitStream(kennelId, { type: 'seed' | 'ping' })
 */
import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { KennelRequest } from './http.js';
import { redis } from '../redis.js';
import { log } from '../log.js';

const slog = log.child({ mod: 'stream' });

export type StreamEvent =
  | { type: 'exception'; action: 'created' | 'updated'; exception: Record<string, unknown> }
  | { type: 'device'; deviceId: string; status: string; extra?: Record<string, unknown> }
  | { type: 'rule_fired'; rule: string; ruleId?: string }
  | { type: 'notification'; exceptionId: string; channel: string; status: string }
  | { type: 'ping' };

const bus = new EventEmitter();
bus.setMaxListeners(0);

const CHANNEL = 'sse';
const ORIGIN = randomUUID();

const sub = redis?.duplicate() ?? null;
if (sub) {
  sub.on('error', (err) => slog.error({ err }, 'redis subscriber error'));
  sub.subscribe(CHANNEL).catch((err) => slog.error({ err }, 'sse subscribe failed'));
  sub.on('message', (_channel, raw) => {
    try {
      const { kennelId, event, origin } = JSON.parse(raw) as {
        kennelId: string;
        event: StreamEvent;
        origin: string;
      };
      if (origin === ORIGIN) return; // this instance already emitted it locally
      bus.emit(kennelId, event);
    } catch (err) {
      slog.warn({ err }, 'malformed sse pub/sub message');
    }
  });
}

export async function closeStreamRedis(): Promise<void> {
  if (sub) await sub.quit().catch(() => {});
}

export function emitStream(kennelId: string, event: StreamEvent): void {
  bus.emit(kennelId, event); // this instance's own clients — always, even without Redis
  if (redis) {
    redis
      .publish(CHANNEL, JSON.stringify({ kennelId, event, origin: ORIGIN }))
      .catch((err) => slog.warn({ err }, 'sse publish failed'));
  }
}

/** Express handler for GET /api/breeder/stream */
export function streamHandler(req: KennelRequest, res: Response): void {
  const kennelId = req.kennelId!;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ kennelId, at: Date.now() })}\n\n`);

  const onEvent = (event: StreamEvent) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  bus.on(kennelId, onEvent);

  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off(kennelId, onEvent);
  });
}
