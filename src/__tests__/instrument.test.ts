import { describe, it, expect } from 'vitest';
import type { ErrorEvent } from '@sentry/core';
import { scrub } from '../instrument.js';

describe('Sentry beforeSend scrub', () => {
  it('drops the bearer token, cookie header and parsed cookies', () => {
    const event = {
      request: {
        url: '/api/breeder/inbox',
        headers: { authorization: 'Bearer secret', Authorization: 'Bearer secret', cookie: 'sid=abc', 'user-agent': 'x' },
        cookies: { sid: 'abc' },
      },
    } as unknown as ErrorEvent;

    const out = scrub(event);

    expect(out.request?.headers).toEqual({ 'user-agent': 'x' });
    expect(out.request?.cookies).toBeUndefined();
  });

  it('is a no-op when there is no request', () => {
    const event = { message: 'boom' } as ErrorEvent;
    expect(scrub(event)).toBe(event);
  });
});
