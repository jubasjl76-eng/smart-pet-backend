import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { raiseException, transitionException, type Transition } from '../exceptions.js';
import { exceptionPriority } from '../logic/delivery.js';

const router = Router();
const T = ['breeder: care inbox'];
const idParam = z.object({ id: z.string() });

/**
 * The care inbox. Default view = actionable items (open / snoozed-due / escalated),
 * ranked by a freshly recomputed priority so stale criticals rise.
 */
router.get(
  '/',
  apiRoute({
    method: 'get', path: '/api/breeder/inbox', tags: T, secure: true,
    summary: 'Care inbox — actionable items by default, ranked by live priority.',
    request: { query: z.object({ status: z.enum(['active', 'all', 'open', 'escalated', 'snoozed', 'resolved']).optional() }) },
    responses: { 200: { description: 'ok', schema: z.object({ items: z.array(z.record(z.string(), z.unknown())), counts: z.record(z.string(), z.number()) }) } },
  }),
  ah(async (req, res) => {
    const status = String(req.query.status ?? 'active');
    const where =
      status === 'active' ? `e.status IN ('open','escalated') OR (e.status='snoozed' AND (e.snoozed_until IS NULL OR e.snoozed_until <= NOW()))`
      : status === 'all' ? 'TRUE'
      : 'e.status = $2';
    const params: unknown[] = [req.kennelId];
    if (status !== 'active' && status !== 'all') params.push(status);

    const rows = await query<any>(
      `SELECT e.*, a.name AS animal_name, p.name AS pen_name
         FROM exceptions e
         LEFT JOIN animals a ON a.id = e.animal_id
         LEFT JOIN pens p ON p.id = e.pen_id
        WHERE e.kennel_id = $1 AND (${where})
        ORDER BY e.created_at DESC
        LIMIT 200`,
      params
    );
    const now = Date.now();
    const items = rows.map((r) => ({
      ...r,
      livePriority: exceptionPriority({
        severity: r.severity,
        kind: r.kind,
        ageSeconds: (now - Date.parse(r.created_at)) / 1000,
        escalationStep: r.escalation_step,
      }),
    })).sort((a, b) => b.livePriority - a.livePriority);

    const counts = await queryOne<any>(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('open','escalated'))::int AS open,
         COUNT(*) FILTER (WHERE severity='critical' AND status IN ('open','escalated'))::int AS critical,
         COUNT(*) FILTER (WHERE status='snoozed')::int AS snoozed
       FROM exceptions WHERE kennel_id = $1`,
      [req.kennelId]
    );
    res.json({ items, counts });
  }),
);

router.get(
  '/:id',
  apiRoute({
    method: 'get', path: '/api/breeder/inbox/{id}', tags: T, secure: true,
    summary: 'One exception + its notification history.',
    request: { params: idParam },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
    const ex = await queryOne(`SELECT * FROM exceptions WHERE id=$1 AND kennel_id=$2`, [req.params.id, req.kennelId]);
    if (!ex) return bad(res, 'Exception not found', 404);
    const notes = await query(
      `SELECT channel, status, subject, created_at, sent_at FROM notifications WHERE exception_id=$1 ORDER BY created_at`,
      [req.params.id]
    );
    res.json({ exception: ex, notifications: notes });
  }),
);

/** Manually raise an exception (e.g. staff spotting something the sensors missed). */
router.post(
  '/',
  apiRoute({
    method: 'post', path: '/api/breeder/inbox', tags: T, secure: true,
    summary: 'Manually raise an exception.',
    request: {
      body: z.object({
        kind: z.string().min(1),
        title: z.string().min(1),
        severity: z.enum(['info', 'warning', 'critical']).optional(),
        detail: z.string().optional(),
        deviceId: z.string().nullable().optional(),
        animalId: z.string().nullable().optional(),
        penId: z.string().nullable().optional(),
        suggestedAction: z.string().nullable().optional(),
        notifyAudience: z.string().nullable().optional(),
      }),
    },
    responses: { 201: { description: 'created' }, 200: { description: 'already open (deduped)' } },
  }),
  ah(async (req, res) => {
    const b = req.body;
    const { exception, created } = await raiseException({
      kennelId: req.kennelId!,
      kind: b.kind, title: b.title,
      severity: b.severity ?? 'warning',
      detail: b.detail,
      deviceId: b.deviceId ?? null,
      animalId: b.animalId ?? null,
      penId: b.penId ?? null,
      suggestedAction: b.suggestedAction ?? null,
      notifyAudience: b.notifyAudience ?? null,
    });
    res.status(created ? 201 : 200).json({ exception, created });
  }),
);

const TRANSITIONS: Transition[] = ['acknowledge', 'snooze', 'resolve', 'escalate', 'assign', 'reopen'];
for (const t of TRANSITIONS) {
  router.post(
    `/:id/${t}`,
    apiRoute({
      method: 'post', path: `/api/breeder/inbox/{id}/${t}`, tags: T, secure: true,
      summary: `Transition an exception: ${t}.`,
      request: {
        params: idParam,
        body: z.object({
          note: z.string().optional(),
          minutes: z.coerce.number().int().positive().optional(),
          userId: z.string().optional(),
        }),
      },
      responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
    }),
    ah(async (req, res) => {
      const updated = await transitionException(String(req.params.id), req.kennelId!, t, {
        userId: req.user?.id ?? null,
        note: req.body?.note,
        snoozeMinutes: req.body?.minutes,
        assignTo: req.body?.userId ?? null,
      });
      if (!updated) return bad(res, 'Exception not found', 404);
      res.json({ exception: updated });
    }),
  );
}

export default router;
