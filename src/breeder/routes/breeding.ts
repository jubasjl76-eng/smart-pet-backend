/**
 * Breeding calendar — heat cycles, mating detail on litters, progesterone
 * guidance, and one assembled `/calendar` feed for the console timeline.
 * A "planned mating" is a `litters` row in status 'planned'.
 */
import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { raiseException } from '../exceptions.js';
import {
  predictNextHeat,
  fertileWindow,
  dueFromMating,
  progesteroneGuidance,
} from '../logic/breeding.js';

const router = Router();
const T = ['breeder: breeding'];
const idParam = z.object({ id: z.string() });

// ── Heat cycles ──────────────────────────────────────────────────────────
router.get(
  '/heat-cycles',
  apiRoute({
    method: 'get', path: '/api/breeder/breeding/heat-cycles', tags: T, secure: true,
    summary: 'Heat cycles (filter by animalId).',
    request: { query: z.object({ animalId: z.string().optional() }) },
    responses: { 200: { description: 'ok', schema: z.object({ heatCycles: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const params: unknown[] = [req.kennelId];
  let where = 'kennel_id = $1';
  if (req.query.animalId) { params.push(req.query.animalId); where += ` AND animal_id = $${params.length}`; }
  const rows = await query(
    `SELECT * FROM heat_cycles WHERE ${where} ORDER BY started_on DESC`,
    params,
  );
  res.json({ heatCycles: rows });
}),
);

router.post(
  '/heat-cycles',
  apiRoute({
    method: 'post', path: '/api/breeder/breeding/heat-cycles', tags: T, secure: true,
    summary: 'Record a heat cycle.',
    request: {
      body: z.object({
        animalId: z.string().min(1),
        startedOn: z.string().min(1),
        endedOn: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    },
    responses: { 201: { description: 'created' } },
  }),
  ah(async (req, res) => {
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO heat_cycles (kennel_id, animal_id, started_on, ended_on, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.kennelId, b.animalId, b.startedOn, b.endedOn ?? null, b.notes ?? null],
  );
  res.status(201).json({ heatCycle: row });
}),
);

router.patch(
  '/heat-cycles/:id',
  apiRoute({
    method: 'patch', path: '/api/breeder/breeding/heat-cycles/{id}', tags: T, secure: true,
    summary: 'Update a heat cycle (partial).',
    request: { params: idParam },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
  const camel: Record<string, string> = { startedOn: 'started_on', endedOn: 'ended_on' };
  const allowed = ['started_on', 'ended_on', 'notes'];
  const sets: string[] = [];
  const vals: unknown[] = [req.params.id, req.kennelId];
  for (const [k, v] of Object.entries(req.body ?? {})) {
    const col = camel[k] ?? k;
    if (!allowed.includes(col)) continue;
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return bad(res, 'No updatable fields');
  const row = await queryOne(
    `UPDATE heat_cycles SET ${sets.join(', ')} WHERE id=$1 AND kennel_id=$2 RETURNING *`,
    vals,
  );
  if (!row) return bad(res, 'Heat cycle not found', 404);
  res.json({ heatCycle: row });
}),
);

router.delete(
  '/heat-cycles/:id',
  apiRoute({
    method: 'delete', path: '/api/breeder/breeding/heat-cycles/{id}', tags: T, secure: true,
    summary: 'Delete a heat cycle.',
    request: { params: idParam },
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  await execute(`DELETE FROM heat_cycles WHERE id=$1 AND kennel_id=$2`, [req.params.id, req.kennelId]);
  res.json({ ok: true });
}),
);

// ── Mating detail on a litter ────────────────────────────────────────────
router.post(
  '/litters/:id/mated',
  apiRoute({
    method: 'post', path: '/api/breeder/breeding/litters/{id}/mated', tags: T, secure: true,
    summary: 'Record mating detail on a litter (planned → expecting).',
    request: {
      params: idParam,
      body: z.object({
        matedOn: z.string().min(1),
        method: z.string().nullable().optional(),
        progesterone: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
    },
    responses: { 200: { description: 'ok' }, 404: { description: 'litter not found' } },
  }),
  ah(async (req, res) => {
  const b = req.body;
  const litter = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM litters WHERE id=$1 AND kennel_id=$2`,
    [req.params.id, req.kennelId],
  );
  if (!litter) return bad(res, 'Litter not found', 404);

  const nextStatus = litter.status === 'planned' ? 'expecting' : litter.status;
  const row = await queryOne(
    `UPDATE litters
        SET mated_on = $3, due_on = $4, mating_method = COALESCE($5, mating_method),
            status = $6,
            progesterone = CASE WHEN $7::jsonb IS NULL THEN progesterone ELSE $7::jsonb END
      WHERE id=$1 AND kennel_id=$2 RETURNING *`,
    [
      req.params.id, req.kennelId, b.matedOn, dueFromMating(b.matedOn),
      b.method ?? null, nextStatus,
      Array.isArray(b.progesterone) ? JSON.stringify(b.progesterone) : null,
    ],
  );
  res.json({ litter: row });
}),
);

router.post(
  '/litters/:id/progesterone',
  apiRoute({
    method: 'post', path: '/api/breeder/breeding/litters/{id}/progesterone', tags: T, secure: true,
    summary: 'Append a progesterone reading + get guidance.',
    request: {
      params: idParam,
      body: z.object({ on: z.string().min(1), ngml: z.coerce.number() }),
    },
    responses: { 200: { description: 'ok' }, 404: { description: 'litter not found' } },
  }),
  ah(async (req, res) => {
  const litter = await queryOne<{ progesterone: { on: string; ngml: number }[] }>(
    `SELECT progesterone FROM litters WHERE id=$1 AND kennel_id=$2`,
    [req.params.id, req.kennelId],
  );
  if (!litter) return bad(res, 'Litter not found', 404);
  const readings = [...(litter.progesterone ?? []), { on: String(req.body.on), ngml: Number(req.body.ngml) }]
    .sort((a, b) => String(a.on).localeCompare(String(b.on)));
  await execute(
    `UPDATE litters SET progesterone = $3::jsonb WHERE id=$1 AND kennel_id=$2`,
    [req.params.id, req.kennelId, JSON.stringify(readings)],
  );
  res.json({ progesterone: readings, guidance: progesteroneGuidance(readings) });
}),
);

// ── Assembled calendar feed ──────────────────────────────────────────────
router.get(
  '/calendar',
  apiRoute({
    method: 'get', path: '/api/breeder/breeding/calendar', tags: T, secure: true,
    summary: 'Assembled breeding calendar — heats, litters, go-home dates.',
    responses: { 200: { description: 'ok', schema: z.object({ heats: z.array(z.record(z.string(), z.unknown())), litters: z.array(z.record(z.string(), z.unknown())), goHome: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const kennelId = req.kennelId;

  const dams = await query<{ id: string; name: string }>(
    `SELECT id, name FROM animals
      WHERE kennel_id=$1 AND sex='female' AND role IN ('breeding','retired') ORDER BY name`,
    [kennelId],
  );
  const cycles = await query<{ animal_id: string; started_on: string }>(
    `SELECT animal_id, started_on FROM heat_cycles WHERE kennel_id=$1 ORDER BY started_on`,
    [kennelId],
  );
  const byDam = new Map<string, string[]>();
  for (const c of cycles) {
    const arr = byDam.get(c.animal_id) ?? [];
    arr.push(c.started_on);
    byDam.set(c.animal_id, arr);
  }
  const heats = dams.map((d) => {
    const starts = byDam.get(d.id) ?? [];
    const prediction = predictNextHeat(starts);
    return {
      damId: d.id,
      name: d.name,
      lastHeat: starts.at(-1) ?? null,
      predictedNextHeat: prediction?.nextStart ?? null,
      intervalDays: prediction?.intervalDays ?? null,
      fertileWindow: prediction ? fertileWindow(prediction.nextStart) : null,
    };
  });

  const litters = await query(
    `SELECT l.id, l.name, l.status, l.mated_on, l.due_on, l.whelped_at,
            d.name AS dam_name, s.name AS sire_name
       FROM litters l
       LEFT JOIN animals d ON d.id = l.dam_id
       LEFT JOIN animals s ON s.id = l.sire_id
      WHERE l.kennel_id=$1
      ORDER BY COALESCE(l.due_on::timestamptz, l.whelped_at, l.created_at) DESC`,
    [kennelId],
  );

  const goHome = await query(
    `SELECT pu.id, pu.name, pu.go_home_on, l.name AS litter_name
       FROM puppies pu JOIN litters l ON l.id = pu.litter_id
      WHERE pu.kennel_id=$1 AND pu.go_home_on IS NOT NULL
      ORDER BY pu.go_home_on`,
    [kennelId],
  );

  res.json({ heats, litters, goHome });
}),
);

// ── Sweep: season + whelping reminders ──────────────────────────────────
export async function breedingSweep(): Promise<{ raised: number }> {
  let raised = 0;

  const rows = await query<{ animal_id: string; name: string; kennel_id: string; starts: string[] }>(
    `SELECT hc.animal_id, a.name, hc.kennel_id, array_agg(hc.started_on ORDER BY hc.started_on) AS starts
       FROM heat_cycles hc JOIN animals a ON a.id = hc.animal_id
      GROUP BY hc.animal_id, a.name, hc.kennel_id`,
  );
  const now = Date.now();
  for (const r of rows) {
    const p = predictNextHeat(r.starts);
    if (!p) continue;
    const days = (Date.parse(p.nextStart) - now) / 86_400_000;
    if (days < 0 || days > 7) continue;
    await raiseException({
      kennelId: r.kennel_id,
      kind: 'heat-due',
      severity: 'info',
      animalId: r.animal_id,
      title: `${r.name}: season expected around ${p.nextStart}`,
      detail: `Interval ~${p.intervalDays} days. Watch for the first signs and start progesterone if a mating is planned.`,
      suggestedAction: 'Confirm the season start date when it comes, then plan the mating',
      dedupKey: `heat-due:${r.animal_id}:${p.nextStart}`,
      notifyAudience: 'manager',
    }).catch(() => {});
    raised++;
  }

  const dueLitters = await query<{ id: string; name: string | null; kennel_id: string; due_on: string }>(
    `SELECT id, name, kennel_id, due_on::text FROM litters
      WHERE whelped_at IS NULL AND due_on IS NOT NULL
        AND due_on BETWEEN CURRENT_DATE - 3 AND CURRENT_DATE + 5`,
  );
  for (const l of dueLitters) {
    await raiseException({
      kennelId: l.kennel_id,
      kind: 'whelping-soon',
      severity: 'warning',
      title: `${l.name ?? 'A litter'} due around ${l.due_on}`,
      detail: 'Set up the whelping box, check the kit, and confirm the vet is on call.',
      suggestedAction: 'Record the birth on the litter as soon as it happens',
      dedupKey: `whelping-soon:${l.id}`,
      notifyAudience: 'on-call',
    }).catch(() => {});
    raised++;
  }
  return { raised };
}

router.post(
  '/sweep',
  apiRoute({
    method: 'post', path: '/api/breeder/breeding/sweep', tags: T, secure: true,
    summary: 'Raise season + whelping reminders into the care inbox.',
    responses: { 200: { description: 'ok', schema: z.object({ raised: z.number() }) } },
  }),
  ah(async (_req, res) => {
  res.json(await breedingSweep());
}),
);

export default router;
