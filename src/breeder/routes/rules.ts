import { Router } from 'express';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad, need } from '../http.js';
import { presetRules, evaluateRule, type Rule, type RuleEvent } from '../logic/rules.js';

const router = Router();

function toRule(row: any): Rule {
  return {
    id: row.id, kennelId: row.kennel_id, name: row.name, enabled: row.enabled,
    trigger: row.trigger, conditions: row.conditions ?? [], actions: row.actions ?? [],
    cooldownSeconds: row.cooldown_seconds ?? 300, lastFiredAt: row.last_fired_at,
  };
}

router.get('/', ah(async (req, res) => {
  const rows = await query(`SELECT * FROM rules WHERE kennel_id=$1 ORDER BY name`, [req.kennelId]);
  res.json({ rules: rows });
}));

router.post('/', ah(async (req, res) => {
  const err = need(req.body, ['name', 'trigger', 'actions']);
  if (err) return bad(res, err);
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO rules (kennel_id, name, enabled, trigger, conditions, actions, cooldown_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.kennelId, b.name, b.enabled ?? true, JSON.stringify(b.trigger),
     JSON.stringify(b.conditions ?? []), JSON.stringify(b.actions), b.cooldownSeconds ?? 300]
  );
  res.status(201).json({ rule: row });
}));

router.patch('/:id', ah(async (req, res) => {
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
}));

router.delete('/:id', ah(async (req, res) => {
  await execute(`DELETE FROM rules WHERE id=$1 AND kennel_id=$2`, [req.params.id, req.kennelId]);
  res.json({ ok: true });
}));

/** Install the parameterised preset rules for this kennel (skips ones already present by name). */
router.post('/install-presets', ah(async (req, res) => {
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
}));

/** Dry-run a rule against a sample event without firing its actions. */
router.post('/:id/test', ah(async (req, res) => {
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
}));

router.get('/:id/firings', ah(async (req, res) => {
  const rows = await query(
    `SELECT * FROM rule_firings WHERE rule_id=$1 AND kennel_id=$2 ORDER BY fired_at DESC LIMIT 100`,
    [req.params.id, req.kennelId]
  );
  res.json({ firings: rows });
}));

export default router;
