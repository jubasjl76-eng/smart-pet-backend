import { describe, it, expect, beforeAll } from 'vitest';
import * as api from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { injectTrace, withExtractedTrace } from '../mqtt/trace.js';

/** Minimal synchronous context manager so `context.with` is not a no-op in tests.
 *  Production registers AsyncLocalStorageContextManager via @sentry/node. */
class SyncStackContextManager implements api.ContextManager {
  private stack: api.Context[] = [api.ROOT_CONTEXT];
  active(): api.Context { return this.stack[this.stack.length - 1]; }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: api.Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A
  ): ReturnType<F> {
    this.stack.push(ctx);
    try { return fn.call(thisArg as ThisParameterType<F>, ...args); }
    finally { this.stack.pop(); }
  }
  bind<T>(_ctx: api.Context, target: T): T { return target; }
  enable(): this { return this; }
  disable(): this { this.stack = [api.ROOT_CONTEXT]; return this; }
}

beforeAll(() => {
  api.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  api.context.setGlobalContextManager(new SyncStackContextManager());
});

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('mqtt trace propagation', () => {
  it('extracts a traceparent and makes it the active context', () => {
    const traceId = withExtractedTrace({ traceparent: TRACEPARENT }, () =>
      api.trace.getSpanContext(api.context.active())?.traceId,
    );
    expect(traceId).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('injectTrace is a no-op when there is no active span', () => {
    const carrier: Record<string, unknown> = {};
    injectTrace(carrier);
    expect(carrier.traceparent).toBeUndefined();
  });

  it('round-trips: inject inside an extracted context', () => {
    const carrier: Record<string, unknown> = {};
    withExtractedTrace({ traceparent: TRACEPARENT }, () => injectTrace(carrier));
    expect(carrier.traceparent).toMatch(/^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/);
  });
});
