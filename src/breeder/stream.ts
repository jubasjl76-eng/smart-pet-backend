/**
 * Server-Sent Events for the breeder console — live care-inbox + device state.
 *
 * One process, no Redis: a module EventEmitter fans out to connected clients,
 * filtered by kennel. `GET /api/breeder/stream` (behind auth + withKennel).
 *
 *   emitStream(kennelId, { type: 'exception', action: 'created', exception })
 *   emitStream(kennelId, { type: 'device',    deviceId, status })
 *   emitStream(kennelId, { type: 'rule_fired', rule })
 *   emitStream(kennelId, { type: 'seed' | 'ping' })
 */
import { EventEmitter } from 'events';
import type { Response } from 'express';
import type { KennelRequest } from './http.js';

export type StreamEvent =
  | { type: 'exception'; action: 'created' | 'updated'; exception: Record<string, unknown> }
  | { type: 'device'; deviceId: string; status: string; extra?: Record<string, unknown> }
  | { type: 'rule_fired'; rule: string; ruleId?: string }
  | { type: 'notification'; exceptionId: string; channel: string; status: string }
  | { type: 'ping' };

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitStream(kennelId: string, event: StreamEvent): void {
  bus.emit(kennelId, event);
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
