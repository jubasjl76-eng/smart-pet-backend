/**
 * Lightweight OpenAPI registry (hardening Phase 14, A1).
 *
 * `apiRoute(spec)` does two jobs from one definition:
 *   1. returns an Express middleware that validates the request with the zod
 *      schemas (replacing express-validator), and
 *   2. records the route so `buildOpenApiDoc()` can emit `/openapi.json`.
 *
 * Routes are migrated file-by-file. Anything still on express-validator is
 * simply absent from the spec until it moves over.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from '@jubasjl76-eng/shared';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteSpec {
  method: Method;
  /** OpenAPI path, e.g. `/api/auth/login` (no `/v1` — servers cover both). */
  path: string;
  tags?: string[];
  summary?: string;
  /** true → documented as requiring the bearer JWT. */
  secure?: boolean;
  /** true → documented as honouring `Idempotency-Key`. */
  idempotent?: boolean;
  request?: { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType };
  responses: Record<number, { description: string; schema?: z.ZodType }>;
}

const registry: RouteSpec[] = [];

const jsonSchema = (s: z.ZodType, io: 'input' | 'output') =>
  z.toJSONSchema(s, { target: 'openapi-3.0', io, unrepresentable: 'any' });

/** Register + return the request-validation middleware for a route. */
export function apiRoute(spec: RouteSpec): RequestHandler {
  registry.push(spec);
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (spec.request?.params)
        req.params = spec.request.params.parse(req.params) as typeof req.params;
      if (spec.request?.query) Object.assign(req.query, spec.request.query.parse(req.query));
      if (spec.request?.body) req.body = spec.request.body.parse(req.body);
      next();
    } catch (e) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: 'validation', issues: e.issues });
        return;
      }
      next(e);
    }
  };
}

function paramList(schema: z.ZodType | undefined, location: 'path' | 'query') {
  if (!schema) return [];
  const js = jsonSchema(schema, 'input') as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return Object.entries(js.properties ?? {}).map(([name, s]) => ({
    name,
    in: location,
    required: location === 'path' || (js.required ?? []).includes(name),
    schema: s,
  }));
}

export function buildOpenApiDoc(version = 'v1') {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const r of registry) {
    const item = (paths[r.path] ??= {});
    const params = [
      ...paramList(r.request?.params, 'path'),
      ...paramList(r.request?.query, 'query'),
    ];
    item[r.method] = {
      tags: r.tags,
      summary: r.summary,
      ...(r.secure ? { security: [{ bearerAuth: [] }] } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(r.idempotent
        ? { parameters: [...params, { $ref: '#/components/parameters/IdempotencyKey' }] }
        : {}),
      ...(r.request?.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: jsonSchema(r.request.body, 'input') } },
            },
          }
        : {}),
      responses: {
        ...Object.fromEntries(
          Object.entries(r.responses).map(([code, resp]) => [
            code,
            {
              description: resp.description,
              ...(resp.schema
                ? { content: { 'application/json': { schema: jsonSchema(resp.schema, 'output') } } }
                : {}),
            },
          ]),
        ),
        '429': { $ref: '#/components/responses/RateLimited' },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Smart Pet API',
      version,
      description:
        'Unified API for the breeder platform + owner device loop. Routes are being migrated to this spec file-by-file; anything not listed here is still served but not yet documented.',
    },
    servers: [{ url: '/api/v1' }, { url: '/api', description: 'unversioned alias (deprecated)' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          schema: { type: 'string', maxLength: 255 },
          description:
            'A client-chosen key; a retried request with the same key returns the first result (enforced from Phase 20).',
        },
        Cursor: {
          name: 'cursor',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'Opaque pagination cursor from a previous response.',
        },
        Limit: {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
      responses: {
        RateLimited: {
          description: 'Too many requests. Back off per `Retry-After`.',
          headers: {
            'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait.' },
            'RateLimit-Limit': { schema: { type: 'integer' } },
            'RateLimit-Remaining': { schema: { type: 'integer' } },
            'RateLimit-Reset': {
              schema: { type: 'integer' },
              description: 'Seconds until the window resets.',
            },
          },
          content: {
            'application/json': {
              schema: { type: 'object', properties: { error: { type: 'string' } } },
            },
          },
        },
      },
    },
    paths,
  };
}

/** The Scalar API-reference page, loaded from a CDN. */
export const docsHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Smart Pet API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
