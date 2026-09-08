import { Router } from 'express';
import { query, queryOne } from '../../database/index.js';
import { ah, bad, need } from '../http.js';
import { scheduledDoses, missedDoses, complianceReport, type MedSchedule, type MedLog } from '../logic/medications.js';
import { raiseException } from '../exceptions.js';

const router = Router();

function toSchedule(row: any): MedSchedule {
  return {
    id: row.id,
    timesOfDay: row.times_of_day ?? [],
    daysOfWeek: row.days_of_week ?? [],
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    active: row.active,
  };
}

router.get('/', ah(async (req, res) => {
  const rows = await query(
    `SELECT m.*, a.name AS animal_name
       FROM medications m LEFT JOIN animals a ON a.id = m.animal_id
      WHERE m.kennel_id = $1 ORDER BY m.active DESC, a.name`,
    [req.kennelId]
  );
  res.json({ medications: rows });
}));

router.post('/', ah(async (req, res) => {
  const err = need(req.body, ['animalId', 'name']);
  if (err) return bad(res, err);
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO medications
       (kennel_id, animal_id, name, dose, route, times_of_day, days_of_week, starts_on, ends_on, instructions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.kennelId, b.animalId, b.name, b.dose ?? null, b.route ?? null,
     b.timesOfDay ?? [], b.daysOfWeek ?? [], b.startsOn ?? null, b.endsOn ?? null, b.instructions ?? null]
  );
  res.status(201).json({ medication: row });
}));

router.patch('/:id', ah(async (req, res) => {
  const camel: Record<string, string> = { timesOfDay: 'times_of_day', daysOfWeek: 'days_of_week', startsOn: 'starts_on', endsOn: 'ends_on' };
  const allowed = ['name', 'dose', 'route', 'times_of_day', 'days_of_week', 'starts_on', 'ends_on', 'active', 'instructions'];
  const sets: string[] = []; const vals: unknown[] = [req.params.id, req.kennelId];
  for (const [k, v] of Object.entries(req.body)) {
    const col = camel[k] ?? k;
    if (allowed.includes(col)) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
  }
  if (!sets.length) return bad(res, 'No updatable fields');
  const row = await queryOne(`UPDATE medications SET ${sets.join(', ')} WHERE id=$1 AND kennel_id=$2 RETURNING *`, vals);
  if (!row) return bad(res, 'Medication not found', 404);
  res.json({ medication: row });
}));

/** Doses due in the next `hours` (default 24) across the kennel, for the staff worklist. */
router.get('/due', ah(async (req, res) => {
  const hours = Math.min(72, Number(req.query.hours ?? 24));
  const meds = await query<any>(
    `SELECT m.*, a.name AS animal_name FROM medications m
       LEFT JOIN animals a ON a.id = m.animal_id
      WHERE m.kennel_id = $1 AND m.active = true`,
    [req.kennelId]
  );
  const now = new Date();
  const due = meds.flatMap((m) =>
    scheduledDoses(toSchedule(m), now, hours).map((when) => ({
      medicationId: m.id, animalId: m.animal_id, animalName: m.animal_name,
      name: m.name, dose: m.dose, route: m.route, scheduledFor: when.toISOString(),
    }))
  ).sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  res.json({ due });
}));

/** Staff registers that a dose was given / skipped / refused. */
router.post('/:id/log', ah(async (req, res) => {
  const med = await queryOne<any>(`SELECT * FROM medications WHERE id=$1 AND kennel_id=$2`, [req.params.id, req.kennelId]);
  if (!med) return bad(res, 'Medication not found', 404);
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO medication_logs
       (kennel_id, medication_id, animal_id, scheduled_for, administered_by, outcome, note, photo_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.kennelId, med.id, med.animal_id, b.scheduledFor ?? null, req.user?.id ?? null,
     b.outcome ?? 'given', b.note ?? null, b.photoUrl ?? null]
  );
  res.status(201).json({ log: row });
}));

router.get('/:id/compliance', ah(async (req, res) => {
  const med = await queryOne<any>(`SELECT * FROM medications WHERE id=$1 AND kennel_id=$2`, [req.params.id, req.kennelId]);
  if (!med) return bad(res, 'Medication not found', 404);
  const logs = await query<any>(
    `SELECT medication_id, scheduled_for, outcome FROM medication_logs
      WHERE medication_id=$1 AND administered_at > NOW() - INTERVAL '45 days'`, [med.id]
  );
  const medLogs: MedLog[] = logs.map((l) => ({ medicationId: l.medication_id, scheduledFor: l.scheduled_for ?? l.administered_at, outcome: l.outcome }));
  const now = new Date();
  const report = complianceReport(toSchedule(med), medLogs, now, 30);
  const missed = missedDoses(toSchedule(med), medLogs, now);
  res.json({ compliance: report, missedRecent: missed.map((d) => d.toISOString()) });
}));

/**
 * Sweep for missed doses and raise a care-inbox exception per medication that
 * has an overdue dose with no log. Called by the engine on a timer; also here
 * for on-demand use / tests.
 */
router.post('/sweep-missed', ah(async (req, res) => {
  const meds = await query<any>(`SELECT * FROM medications WHERE kennel_id=$1 AND active=true`, [req.kennelId]);
  const now = new Date();
  let raised = 0;
  for (const m of meds) {
    const logs = await query<any>(
      `SELECT medication_id, scheduled_for, administered_at, outcome FROM medication_logs
        WHERE medication_id=$1 AND administered_at > NOW() - INTERVAL '3 days'`, [m.id]
    );
    const medLogs: MedLog[] = logs.map((l) => ({ medicationId: l.medication_id, scheduledFor: l.scheduled_for ?? l.administered_at, outcome: l.outcome }));
    const missed = missedDoses(toSchedule(m), medLogs, now);
    if (missed.length) {
      const animal = await queryOne<{ name: string }>(`SELECT name FROM animals WHERE id=$1`, [m.animal_id]);
      await raiseException({
        kennelId: req.kennelId!, kind: 'med-missed', severity: 'critical',
        animalId: m.animal_id, title: `Missed dose: ${m.name} for ${animal?.name ?? 'animal'}`,
        detail: `${missed.length} overdue dose(s), oldest ${missed[0].toISOString()}`,
        suggestedAction: 'Give the dose now and log it, or mark skipped with a reason',
        dedupKey: `med-missed:${m.id}`, notifyAudience: 'on-call',
      });
      raised++;
    }
  }
  res.json({ raised });
}));

export default router;
