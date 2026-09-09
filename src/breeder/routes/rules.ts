import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { presetRules, evaluateRule, type Rule, type RuleEvent } from '../logic/rules.js';

const router = Router();
const T = ['breeder: rules'];
const idParam = z.object({ id: z.string() });

function toRule(row: any): Rule {
  return {
    id: row.id, kennelId: row.kennel_id, name: row.name, enabled: row.enabled,
    trigger: row.trigger, conditions: row.conditions ?? [], actions: row.actions ?? [],
    cooldownSeconds: row.cooldown_seconds ?? 300, lastFiredAt: row.last_fired_at,
  };
}

const ruleBody = z.object({
  name: z.string().min(1),
  trigger: z.record(z.string(), z.unknown()),
  actions: z.array(z.unknown()).min(1),
  enabled: z.boolean().optional(),
  conditions: z.array(z.unknown()).optional(),
  cooldownSeconds: z.coerce.number().int().nonnegative().optional(),
});

router.get(
  '/',
  apiRoute({
    method: 'get', path: '/api/breeder/rules', tags: T, secure: true,
    summary: 'List automation rules for the kennel.',
    responses: { 200: { description: 'ok', schema: z.object({ rules: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
    const rows = await query(`SELECT * FROM rules WHERE kennel_id=$1 ORDER BY name`, [req.kennelId]);
    res.json({ rules: rows });
  }),
);

router.post(
  '/',
  apiRoute({
    method: 'post', path: '/api/breeder/rules', tags: T, secure: true,
    summary: 'Create a rule.',
    request: { body: ruleBody },
    responses: { 201: { description: 'created' } },
  }),
  ah(async (req, res) => {
    const b = req.body;
    const row = await queryOne(
      `INSERT INTO rules (kennel_id, name, enabled, trigger, conditions, actions, cooldown_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.kennelId, b.name, b.enabled ?? true, JSON.stringify(b.trigger),
       JSON.stringify(b.conditions ?? []), JSON.stringify(b.actions), b.cooldownSeconds ?? 300]
    );
    res.status(201).json({ rule: row });
  }),
);

router.patch(
  '/:id',
  apiRoute({
    method: 'patch', path: '/api/breeder/rules/{id}', tags: T, secure: true,
    summary: 'Update a rule (partial).',
    request: { params: idParam, body: ruleBody.partial() },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
    const camel: Record<string, string> = { cooldownSeconds: 'cooldown_seconds' };
    const jsonCols = new Set(['trigger', 'conditions', 'actions']);
    const allowed = ['name', 'enabled', 'trigger', 'conditions', 'actions', 'cooldown_seconds'];
    const sets: string[] = []; const vals: unknown[] = [req.params.id, req.kennelId];
    for (const [k, v] of Object.entries(req.body)) {
      const col = camel[k] ?? k;
      if (!allowed.includes(col)) continue;
      vals.push(jsonCols.has(col) ? JSON.stringify(v) : v);
      sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) return bad(res, 'No updatable fields');
    const row = await queryOne(`UPDATE rules SET ${sets.join(', ')} WHERE id=$1 AND kennel_id=$2 RETURNING *`, vals);
    if (!row) return bad(res, 'Rule not found', 404);
    res.json({ rule: row });
  }),
);

router.delete(
  '/:id',
  apiRoute({
    method: 'delete', path: '/api/breeder/rules/{id}', tags: T, secure: true,
    summary: 'Delete a rule.',
    request: { params: idParam },
    responses: { 200: { description: 'deleted' } },
  }),
  ah(async (req, res) => {
    await execute(`DELETE FROM rules WHERE id=$1 AND kennel_id=$2`, [req.params.id, req.kennelId]);
    res.json({ ok: true });
  }),
);

router.post(
  '/install-presets',
  apiRoute({
    method: 'post', path: '/api/breeder/rules/install-presets', tags: T, secure: true,
    summary: 'Install the parameterised preset rules (skips ones already present by name).',
    responses: { 200: { description: 'ok', schema: z.object({ installed: z.number() }) } },
  }),
  ah(async (req, res) => {
    const existing = new Set(
      (await query<{ name: string }>(`SELECT name FROM rules WHERE kennel_id=$1`, [req.kennelId])).map((r) => r.name)
    );
    let installed = 0;
    for (const p of presetRules(req.kennelId!)) {
      if (existing.has(p.name)) continue;
      await execute(
        `INSERT INTO rules (kennel_id, name, enabled, trigger, conditions, actions, cooldown_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.kennelId, p.name, p.enabled, JSON.stringify(p.trigger),
         JSON.stringify(p.conditions), JSON.stringify(p.actions), p.cooldownSeconds]
      );
      installed++;
    }
    res.json({ installed });
  }),
);

router.post(
  '/:id/test',
  apiRoute({
    method: 'post', path: '/api/breeder/rules/{id}/test', tags: T, secure: true,
    summary: 'Dry-run a rule against a sample event without firing its actions.',
    request: {
      params: idParam,
      body: z.object({
        type: z.string().optional(),
        deviceId: z.string().optional(),
        deviceType: z.string().optional(),
        metric: z.string().optional(),
        value: z.number().optional(),
        status: z.string().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
    const row = await queryOne<any>(`SELECT * FROM rules WHERE id=$1 AND kennel_id=$2`, [req.params.id, req.kennelId]);
    if (!row) return bad(res, 'Rule not found', 404);
    const sample: RuleEvent = {
      type: req.body.type ?? row.trigger?.type ?? 'telemetry',
      kennelId: req.kennelId!,
      deviceId: req.body.deviceId,
      deviceType: req.body.deviceType,
      metric: req.body.metric,
      value: req.body.value,
      status: req.body.status,
      meta: req.body.meta ?? {},
      at: new Date(),
    };
    const result = evaluateRule(toRule(row), sample, new Date());
    res.json({ result, sample });
  }),
);

router.get(
  '/:id/firings',
  apiRoute({
    method: 'get', path: '/api/breeder/rules/{id}/firings', tags: T, secure: true,
    summary: 'Recent firings for a rule (last 100).',
    request: { params: idParam },
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
    const rows = await query(
      `SELECT * FROM rule_firings WHERE rule_id=$1 AND kennel_id=$2 ORDER BY fired_at DESC LIMIT 100`,
      [req.params.id, req.kennelId]
    );
    res.json({ firings: rows });
  }),
);

export default router;
