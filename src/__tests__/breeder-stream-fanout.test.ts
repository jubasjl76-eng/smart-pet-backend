/**
 * Cross-instance SSE fan-out (Phase 20). REDIS_URL unset (existing
 * breeder-stream.test.ts) → unchanged single-instance behavior. This file
 * mocks a Redis pub/sub pair to prove the two things that matter once
 * REDIS_URL is set: every emit gets published, tagged with this instance's
 * origin, and an instance ignores its own echo but re-emits a message that
 * originated on a different instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../redis.js');
});

function fakeReqRes(kennelId: string) {
  const writes: string[] = [];
  const req = {
    kennelId,
    on: (_ev: string, _cb: () => void) => {},
  } as unknown as Parameters<typeof import('../breeder/stream.js').streamHandler>[0];
  const res = {
    writeHead: vi.fn(),
    write: (s: string) => {
      writes.push(s);
      return true;
    },
  } as unknown as Parameters<typeof import('../breeder/stream.js').streamHandler>[1];
  return { req, res, writes };
}

function makeFakeRedis() {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const fake = {
    publish: vi.fn(async () => 1),
    subscribe: vi.fn(async () => undefined),
    on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    quit: vi.fn(async () => 'OK'),
    emitMessage: (channel: string, raw: string) =>
      listeners.message?.forEach((cb) => cb(channel, raw)),
  };
  return { ...fake, duplicate: vi.fn(() => fake) };
}

describe('breeder SSE cross-instance fan-out', () => {
  it('publishes every emitted event to Redis, tagged with this instance origin', async () => {
    const fake = makeFakeRedis();
    vi.doMock('../redis.js', () => ({ redis: fake }));
    const { emitStream } = await import('../breeder/stream.js');

    emitStream('k1', { type: 'ping' });
    expect(fake.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = fake.publish.mock.calls[0];
    expect(channel).toBe('sse');
    const msg = JSON.parse(raw as string);
    expect(msg.kennelId).toBe('k1');
    expect(msg.event).toEqual({ type: 'ping' });
    expect(typeof msg.origin).toBe('string');
  });

  it('ignores its own echo but re-emits a message from another instance', async () => {
    const fake = makeFakeRedis();
    vi.doMock('../redis.js', () => ({ redis: fake }));
    const { emitStream, streamHandler } = await import('../breeder/stream.js');

    const client = fakeReqRes('k1');
    streamHandler(client.req, client.res);

    emitStream('k1', { type: 'ping' }); // learn this instance's own origin below
    const before = client.writes.length;
    const [, raw] = fake.publish.mock.calls[0];
    const { origin } = JSON.parse(raw as string);

    // this instance's own publish echoing back — must not double-deliver
    fake.emitMessage('sse', JSON.stringify({ kennelId: 'k1', event: { type: 'ping' }, origin }));
    expect(client.writes.length).toBe(before);

    // a message from a different instance — must be delivered locally
    fake.emitMessage(
      'sse',
      JSON.stringify({
        kennelId: 'k1',
        event: { type: 'device', deviceId: 'x', status: 'online' },
        origin: 'other-instance',
      }),
    );
    expect(client.writes.at(-1)).toContain('"deviceId":"x"');
  });
});
