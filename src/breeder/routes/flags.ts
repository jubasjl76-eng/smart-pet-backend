/**
 * Feature flags — admin CRUD over the Phase 12 `feature_flags` table
 * (hardening Phase 20, A12). `src/services/flags.ts` is the read-only,
 * 30s-cached view `GET /api/config` exposes to the dashboard/app; these
 * routes are how an operator actually manages a flag without touching the
 * DB directly. Mounted at /api/breeder/flags, behind the guard.
 */
import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { invalidateFlags } from '../../services/flags.js';
import { logAccess } from '../accessLog.js';

const router = Router();
const T = ['breeder: flags'];
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

router.get(
  '/',
  apiRoute({
    method: 'get',
    path: '/api/breeder/flags',
    tags: T,
    secure: true,
    summary: 'List every feature flag.',
    responses: {
      200: {
        description: 'ok',
        schema: z.object({ flags: z.array(z.record(z.string(), z.unknown())) }),
      },
    },
  }),
  ah(async (_req, res) => {
    const flags = await query(
      `SELECT key, enabled, description, updated_at FROM feature_flags ORDER BY key`,
    );
    res.json({ flags });
  }),
);

router.put(
  '/:key',
  apiRoute({
    method: 'put',
    path: '/api/breeder/flags/{key}',
    tags: T,
    secure: true,
    summary: 'Create or toggle a flag.',
    request: {
      params: z.object({ key: z.string() }),
      body: z.object({ enabled: z.boolean(), description: z.string().nullable().optional() }),
    },
    responses: { 200: { description: 'ok' }, 400: { description: 'bad key' } },
  }),
  ah(async (req, res) => {
    const key = String(req.params.key);
    if (!KEY_RE.test(key)) return bad(res, 'key must be lowercase letters, digits, hyphens');
    const enabled = Boolean(req.body?.enabled);
    const description = req.body?.description ?? null;

    const row = await queryOne(
      `INSERT INTO feature_flags (key, enabled, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         description = COALESCE(EXCLUDED.description, feature_flags.description),
         updated_at = NOW()
       RETURNING key, enabled, description, updated_at`,
      [key, enabled, description],
    );
    invalidateFlags();
    await logAccess(req, 'flags.set', { subjectType: 'flag', subjectId: key, detail: { enabled } });
    res.json({ flag: row });
  }),
);

router.delete(
  '/:key',
  apiRoute({
    method: 'delete',
    path: '/api/breeder/flags/{key}',
    tags: T,
    secure: true,
    summary: 'Remove a flag entirely (no row = off).',
    request: { params: z.object({ key: z.string() }) },
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
    const key = String(req.params.key);
    await execute(`DELETE FROM feature_flags WHERE key = $1`, [key]);
    invalidateFlags();
    await logAccess(req, 'flags.delete', { subjectType: 'flag', subjectId: key });
    res.json({ ok: true });
  }),
);

export default router;
