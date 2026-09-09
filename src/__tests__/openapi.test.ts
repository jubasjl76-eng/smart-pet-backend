import { describe, it, expect } from 'vitest';
import { buildOpenApiDoc, apiRoute } from '../openapi/index.js';
import { z } from '@jubasjl76-eng/shared';
import '../routes/auth.js'; // registers the auth routes on import

describe('openapi registry', () => {
  const doc = buildOpenApiDoc();

  it('emits a 3.1 doc with both server URLs', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers.map((s) => s.url)).toEqual(['/api/v1', '/api']);
  });

  it('documents the auth routes with request bodies + responses', () => {
    const login = (doc.paths['/api/auth/login'] as any).post;
    expect(login.summary).toMatch(/access token/i);
    expect(login.requestBody.content['application/json'].schema.required).toEqual([
      'email',
      'password',
    ]);
    expect(Object.keys(login.responses)).toContain('200');
    expect(Object.keys(login.responses)).toContain('429'); // the shared rate-limit response
  });

  it('marks secured routes', () => {
    expect((doc.paths['/api/auth/me'] as any).get.security).toEqual([{ bearerAuth: [] }]);
    expect((doc.paths['/api/auth/login'] as any).post.security).toBeUndefined();
  });

  it('carries the traffic-contract components', () => {
    expect(doc.components.responses.RateLimited).toBeDefined();
    expect(doc.components.parameters.IdempotencyKey).toBeDefined();
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });
});

describe('apiRoute middleware', () => {
  it('parses + coerces the request body, 400s on a bad one', () => {
    const mw = apiRoute({
      method: 'post',
      path: '/_t',
      request: { body: z.object({ n: z.coerce.number() }) },
      responses: { 200: { description: 'ok' } },
    });
    const req: any = { body: { n: '42' }, params: {}, query: {} };
    let nexted = false;
    mw(req, {} as any, () => (nexted = true));
    expect(nexted).toBe(true);
    expect(req.body.n).toBe(42);

    const bad: any = { body: { n: 'x' }, params: {}, query: {} };
    let code = 0;
    const res: any = { status: (c: number) => ((code = c), res), json: () => res };
    mw(bad, res, () => {});
    expect(code).toBe(400);
  });
});
