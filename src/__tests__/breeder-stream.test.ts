import { describe, it, expect, vi } from 'vitest';
import { emitStream, streamHandler } from '../breeder/stream.js';

function fakeReqRes(kennelId: string) {
  const writes: string[] = [];
  let closeCb: (() => void) | undefined;
  const req: any = { kennelId, on: (ev: string, cb: () => void) => { if (ev === 'close') closeCb = cb; } };
  const res: any = {
    writeHead: vi.fn(),
    write: (s: string) => { writes.push(s); return true; },
  };
  return { req, res, writes, close: () => closeCb?.() };
}

describe('breeder SSE stream', () => {
  it('greets, forwards kennel-scoped events, and stops on close', () => {
    vi.useFakeTimers();
    const a = fakeReqRes('home');
    streamHandler(a.req, a.res);
    expect(a.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'text/event-stream' }));
    expect(a.writes.join('')).toContain('event: hello');

    emitStream('home', { type: 'exception', action: 'created', exception: { id: 'x1', title: 'hot' } });
    const frame = a.writes.at(-1)!;
    expect(frame).toContain('event: exception');
    expect(frame).toContain('"title":"hot"');

    // other kennel → not delivered here
    const before = a.writes.length;
    emitStream('other', { type: 'ping' });
    expect(a.writes.length).toBe(before);

    a.close();
    emitStream('home', { type: 'ping' });
    expect(a.writes.length).toBe(before); // nothing after close
    vi.useRealTimers();
  });

  it('two clients on the same kennel both receive', () => {
    vi.useFakeTimers();
    const a = fakeReqRes('k'); const b = fakeReqRes('k');
    streamHandler(a.req, a.res); streamHandler(b.req, b.res);
    emitStream('k', { type: 'device', deviceId: 'feeder-1', status: 'online' });
    expect(a.writes.at(-1)).toContain('feeder-1');
    expect(b.writes.at(-1)).toContain('feeder-1');
    a.close(); b.close();
    vi.useRealTimers();
  });
});
