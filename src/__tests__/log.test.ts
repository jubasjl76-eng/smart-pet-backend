import { describe, it, expect, beforeAll } from 'vitest';
import * as api from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { log, traceMixin } from '../log.js';

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

describe('log', () => {
  it('exports a usable pino logger', () => {
    expect(typeof log.info).toBe('function');
    expect(typeof log.child).toBe('function');
  });

  it('traceMixin adds traceId / spanId under an active span context', () => {
    const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const fields = api.context.with(
      api.propagation.extract(api.context.active(), { traceparent: TP }),
      () => traceMixin(),
    );
    expect(fields).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
    });
  });

  it('traceMixin is empty with no active span', () => {
    expect(traceMixin()).toEqual({});
  });
});
