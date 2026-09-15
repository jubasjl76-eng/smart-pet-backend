/**
 * Vaccination & worming — protocol templates, per-dog/puppy records, and a
 * due-reminder sweep into the care inbox. Certificates are a URL for now
 * (Phase 7 adds real file upload behind a storage interface).
 */
import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { raiseException } from '../exceptions.js';
import {
  scheduleFromProtocol,
  recordStatus,
  DEFAULT_PROTOCOL,
  type ProtocolDose,
} from '../logic/vaccinations.js';

const router = Router();
const T = ['breeder: vaccinations'];
const idParam = z.object({ id: z.string() });
const doseSchema = z.array(z.record(z.string(), z.unknown()));

// ── Protocols ─────────────────────────────────────────────────────────────
router.get(
  '/protocols',
  apiRoute({
    method: 'get', path: '/api/breeder/vaccinations/protocols', tags: T, secure: true,
    summary: 'Vaccination protocol templates.',
    responses: { 200: { description: 'ok', schema: z.object({ protocols: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const rows = await query(
    `SELECT * FROM vaccination_protocols WHERE kennel_id=$1 ORDER BY is_default DESC, name`,
    [req.kennelId],
  );
  res.json({ protocols: rows });
}),
);

router.post(
  '/protocols',
  apiRoute({
    method: 'post', path: '/api/breeder/vaccinations/protocols', tags: T, secure: true,
    summary: 'Create a vaccination protocol.',
    request: {
      body: z.object({
        name: z.string().min(1),
        doses: doseSchema,
        species: z.string().optional(),
        isDefault: z.boolean().optional(),
      }),
    },
    responses: { 201: { description: 'created' } },
  }),
  ah(async (req, res) => {
  const b = req.body;
  if (b.isDefault) {
    await execute(`UPDATE vaccination_protocols SET is_default=false WHERE kennel_id=$1`, [req.kennelId]);
  }
  const row = await queryOne(
    `INSERT INTO vaccination_protocols (kennel_id, name, species, doses, is_default)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.kennelId, b.name, b.species ?? 'dog', JSON.stringify(b.doses), b.isDefault ?? false],
  );
  res.status(201).json({ protocol: row });
}),
);

router.patch(
  '/protocols/:id',
  apiRoute({
    method: 'patch', path: '/api/breeder/vaccinations/protocols/{id}', tags: T, secure: true,
    summary: 'Update a vaccination protocol (partial).',
    request: {
      params: idParam,
      body: z.object({
        name: z.string().optional(),
        species: z.string().optional(),
        doses: doseSchema.optional(),
        isDefault: z.boolean().optional(),
      }),
    },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
  const camel: Record<string, string> = { isDefault: 'is_default' };
  const allowed = ['name', 'species', 'doses', 'is_default'];
  const sets: string[] = [];
  const vals: unknown[] = [req.params.id, req.kennelId];
  for (const [k, v] of Object.entries(req.body ?? {})) {
    const col = camel[k] ?? k;
    if (!allowed.includes(col)) continue;
    vals.push(col === 'doses' ? JSON.stringify(v) : v);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return bad(res, 'No updatable fields');
  if (req.body?.isDefault) {
    await execute(`UPDATE vaccination_protocols SET is_default=false WHERE kennel_id=$1`, [req.kennelId]);
  }
  const row = await queryOne(
    `UPDATE vaccination_protocols SET ${sets.join(', ')} WHERE id=$1 AND kennel_id=$2 RETURNING *`,
    vals,
  );
  if (!row) return bad(res, 'Protocol not found', 404);
  res.json({ protocol: row });
}),
);

router.delete(
  '/protocols/:id',
  apiRoute({
    method: 'delete', path: '/api/breeder/vaccinations/protocols/{id}', tags: T, secure: true,
    summary: 'Delete a vaccination protocol.',
    request: { params: idParam },
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  await execute(`DELETE FROM vaccination_protocols WHERE id=$1 AND kennel_id=$2`, [req.params.id, req.kennelId]);
  res.json({ ok: true });
}),
);

// ── Apply a protocol to an animal / puppy / whole litter ──────────────────
router.post(
  '/apply',
  apiRoute({
    method: 'post', path: '/api/breeder/vaccinations/apply', tags: T, secure: true,
    summary: 'Apply a protocol to an animal / puppy / whole litter.',
    request: {
      body: z.object({
        protocolId: z.string().optional(),
        doses: doseSchema.optional(),
        animalId: z.string().optional(),
        puppyId: z.string().optional(),
        litterId: z.string().optional(),
      }),
    },
    responses: { 201: { description: 'created' }, 404: { description: 'subject or protocol not found' } },
  }),
  ah(async (req, res) => {
  const b = req.body ?? {};
  let doses: ProtocolDose[] = Array.isArray(b.doses) ? b.doses : [];
  let protocolId: string | null = b.protocolId ?? null;

  if (protocolId) {
    const p = await queryOne<{ doses: ProtocolDose[] }>(
      `SELECT doses FROM vaccination_protocols WHERE id=$1 AND kennel_id=$2`,
      [protocolId, req.kennelId],
    );
    if (!p) return bad(res, 'Protocol not found', 404);
    doses = p.doses ?? [];
  } else if (!doses.length) {
    const def = await queryOne<{ id: string; doses: ProtocolDose[] }>(
      `SELECT id, doses FROM vaccination_protocols WHERE kennel_id=$1 AND is_default=true LIMIT 1`,
      [req.kennelId],
    );
    doses = def?.doses ?? DEFAULT_PROTOCOL;
    protocolId = def?.id ?? null;
  }
  if (!doses.length) return bad(res, 'No doses to apply');

  // resolve subjects → [{ col, id, birth }]
  type Subject = { col: 'animal_id' | 'puppy_id'; id: string; birth: string | null };
  const subjects: Subject[] = [];
  if (b.animalId) {
    const a = await queryOne<{ dob: string | null }>(`SELECT dob FROM animals WHERE id=$1 AND kennel_id=$2`, [b.animalId, req.kennelId]);
    if (!a) return bad(res, 'Animal not found', 404);
    subjects.push({ col: 'animal_id', id: b.animalId, birth: a.dob });
  }
  if (b.puppyId) {
    const p = await queryOne<{ whelped_at: string | null }>(
      `SELECT l.whelped_at FROM puppies pu JOIN litters l ON l.id=pu.litter_id WHERE pu.id=$1 AND pu.kennel_id=$2`,
      [b.puppyId, req.kennelId],
    );
    if (!p) return bad(res, 'Puppy not found', 404);
    subjects.push({ col: 'puppy_id', id: b.puppyId, birth: p.whelped_at });
  }
  if (b.litterId) {
    const litter = await queryOne<{ whelped_at: string | null }>(
      `SELECT whelped_at FROM litters WHERE id=$1 AND kennel_id=$2`, [b.litterId, req.kennelId],
    );
    if (!litter) return bad(res, 'Litter not found', 404);
    const pups = await query<{ id: string }>(`SELECT id FROM puppies WHERE litter_id=$1`, [b.litterId]);
    for (const pu of pups) subjects.push({ col: 'puppy_id', id: pu.id, birth: litter.whelped_at });
  }
  if (!subjects.length) return bad(res, 'Pass animalId, puppyId or litterId');

  let created = 0;
  for (const s of subjects) {
    if (!s.birth) continue; // no birth date → can't schedule
    const existing = new Set(
      (await query<{ name: string }>(
        `SELECT name FROM vaccination_records WHERE ${s.col}=$1`, [s.id],
      )).map((r) => r.name),
    );
    for (const row of scheduleFromProtocol(s.birth, doses)) {
      if (existing.has(row.name)) continue;
      await execute(
        `INSERT INTO vaccination_records (kennel_id, ${s.col}, protocol_id, name, kind, due_on)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.kennelId, s.id, protocolId, row.name, row.kind, row.dueOn],
      );
      created++;
    }
  }
  res.status(201).json({ created, subjects: subjects.length });
}),
);

// ── Records ───────────────────────────────────────────────────────────────
router.get(
  '/',
  apiRoute({
    method: 'get', path: '/api/breeder/vaccinations', tags: T, secure: true,
    summary: 'Vaccination records (filter by animalId / puppyId / status).',
    request: {
      query: z.object({
        animalId: z.string().optional(),
        puppyId: z.string().optional(),
        status: z.string().optional(),
      }),
    },
    responses: { 200: { description: 'ok', schema: z.object({ records: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const where: string[] = ['kennel_id = $1'];
  const params: unknown[] = [req.kennelId];
  if (req.query.animalId) { params.push(req.query.animalId); where.push(`animal_id = $${params.length}`); }
  if (req.query.puppyId) { params.push(req.query.puppyId); where.push(`puppy_id = $${params.length}`); }
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM vaccination_records WHERE ${where.join(' AND ')} ORDER BY due_on NULLS LAST, name`,
    params,
  );
  const now = new Date();
  let items = rows.map((r) => ({
    ...r,
    status: recordStatus(r as { given_on: string | null; due_on: string | null }, now),
  }));
  if (typeof req.query.status === 'string') {
    items = items.filter((r) => r.status === req.query.status);
  }
  res.json({ records: items });
}),
);

router.patch(
  '/:id',
  apiRoute({
    method: 'patch', path: '/api/breeder/vaccinations/{id}', tags: T, secure: true,
    summary: 'Update a vaccination record (partial).',
    request: { params: idParam },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
  const camel: Record<string, string> = { givenOn: 'given_on', dueOn: 'due_on', batchNo: 'batch_no', vetName: 'vet_name', certificateUrl: 'certificate_url' };
  const allowed = ['name', 'kind', 'due_on', 'given_on', 'batch_no', 'vet_name', 'certificate_url', 'notes'];
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
    `UPDATE vaccination_records SET ${sets.join(', ')} WHERE id=$1 AND kennel_id=$2 RETURNING *`,
    vals,
  );
  if (!row) return bad(res, 'Record not found', 404);
  res.json({ record: row });
}),
);

// ── Overdue sweep (also runs on the engine timer) ────────────────────────
export async function vaccinationSweep(): Promise<{ raised: number }> {
  const overdue = await query<{
    kennel_id: string; animal_id: string | null; puppy_id: string | null;
    subject_name: string; names: string[]; oldest: string;
  }>(
    `SELECT v.kennel_id,
            v.animal_id, v.puppy_id,
            COALESCE(a.name, pu.name, 'a dog') AS subject_name,
            array_agg(v.name ORDER BY v.due_on) AS names,
            min(v.due_on)::text AS oldest
       FROM vaccination_records v
       LEFT JOIN animals a  ON a.id  = v.animal_id
       LEFT JOIN puppies pu ON pu.id = v.puppy_id
      WHERE v.given_on IS NULL AND v.due_on < CURRENT_DATE
      GROUP BY v.kennel_id, v.animal_id, v.puppy_id, subject_name`,
  );
  let raised = 0;
  for (const g of overdue) {
    const subj = g.animal_id ?? g.puppy_id!;
    await raiseException({
      kennelId: g.kennel_id,
      kind: 'vaccination-due',
      severity: 'warning',
      animalId: g.animal_id ?? undefined,
      title: `${g.subject_name}: ${g.names.length} vaccination${g.names.length === 1 ? '' : 's'} overdue`,
      detail: `${g.names.join(', ')}. Oldest due ${g.oldest}`,
      suggestedAction: 'Book the vet, then log the dose with its batch number',
      dedupKey: `vaccination-due:${subj}`,
      notifyAudience: 'manager',
    }).catch(() => {});
    raised++;
  }
  return { raised };
}

router.post(
  '/sweep',
  apiRoute({
    method: 'post', path: '/api/breeder/vaccinations/sweep', tags: T, secure: true,
    summary: 'Raise a care-inbox exception per subject with overdue vaccinations.',
    responses: { 200: { description: 'ok', schema: z.object({ raised: z.number() }) } },
  }),
  ah(async (_req, res) => {
  res.json(await vaccinationSweep());
}),
);

export default router;
