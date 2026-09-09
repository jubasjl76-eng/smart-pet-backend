import { Router } from 'express';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad, need, type KennelRequest } from '../http.js';
import { assessPuppyWeight, expectedPuppyWeightG, adultWeightTrend, hasWeightLoss } from '../logic/growth.js';
import { wellnessInsights } from '../logic/wellness.js';
import { buildPedigree, type PedigreeAnimal } from '../logic/pedigree.js';
import { raiseException } from '../exceptions.js';

const router = Router();

// ── Pens ──────────────────────────────────────────────────────────────────
router.get('/pens', ah(async (req, res) => {
  const rows = await query(
    `SELECT p.*, COUNT(a.id)::int AS occupancy
       FROM pens p LEFT JOIN animals a ON a.current_pen_id = p.id AND a.status='active'
      WHERE p.kennel_id = $1 GROUP BY p.id ORDER BY p.name`,
    [req.kennelId]
  );
  res.json({ pens: rows });
}));

router.post('/pens', ah(async (req, res) => {
  const err = need(req.body, ['name']);
  if (err) return bad(res, err);
  const { name, kind = 'run', capacity = 1, doorDeviceId = null } = req.body;
  const row = await queryOne(
    `INSERT INTO pens (kennel_id, name, kind, capacity, door_device_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.kennelId, name, kind, capacity, doorDeviceId]
  );
  res.status(201).json({ pen: row });
}));

// ── Animals ───────────────────────────────────────────────────────────────
router.get('/', ah(async (req, res) => {
  const rows = await query(
    `SELECT a.*, p.name AS pen_name
       FROM animals a LEFT JOIN pens p ON p.id = a.current_pen_id
      WHERE a.kennel_id = $1 ORDER BY a.name`,
    [req.kennelId]
  );
  res.json({ animals: rows });
}));

router.post('/', ah(async (req, res) => {
  const err = need(req.body, ['name']);
  if (err) return bad(res, err);
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO animals
       (kennel_id, name, call_name, breed, sex, dob, microchip, registration_no,
        sire_id, dam_id, collar_device_id, ble_tag_id, current_pen_id, role, adult_weight_kg, photo_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      req.kennelId, b.name, b.callName ?? null, b.breed ?? null, b.sex ?? null, b.dob ?? null,
      b.microchip ?? null, b.registrationNo ?? null, b.sireId ?? null, b.damId ?? null,
      b.collarDeviceId ?? null, b.bleTagId ?? null, b.penId ?? null, b.role ?? 'breeding',
      b.adultWeightKg ?? null, b.photoUrl ?? null,
    ]
  );
  res.status(201).json({ animal: row });
}));

router.get('/:id', ah(async (req, res) => {
  const animal = await queryOne(
    `SELECT * FROM animals WHERE id = $1 AND kennel_id = $2`,
    [req.params.id, req.kennelId]
  );
  if (!animal) return bad(res, 'Animal not found', 404);
  const carePlan = await queryOne(`SELECT * FROM care_plans WHERE animal_id = $1`, [req.params.id]);
  res.json({ animal, carePlan: carePlan ?? null });
}));

router.patch('/:id', ah(async (req, res) => {
  const allowed = ['name', 'call_name', 'breed', 'sex', 'dob', 'microchip', 'registration_no',
    'collar_device_id', 'ble_tag_id', 'current_pen_id', 'role', 'status', 'adult_weight_kg', 'photo_url'];
  const camel: Record<string, string> = {
    callName: 'call_name', registrationNo: 'registration_no', collarDeviceId: 'collar_device_id',
    bleTagId: 'ble_tag_id', penId: 'current_pen_id', adultWeightKg: 'adult_weight_kg', photoUrl: 'photo_url',
  };
  const sets: string[] = [];
  const vals: unknown[] = [req.params.id, req.kennelId];
  for (const [k, v] of Object.entries(req.body)) {
    const col = camel[k] ?? k;
    if (allowed.includes(col)) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
  }
  if (!sets.length) return bad(res, 'No updatable fields');
  const row = await queryOne(
    `UPDATE animals SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND kennel_id = $2 RETURNING *`,
    vals
  );
  if (!row) return bad(res, 'Animal not found', 404);
  res.json({ animal: row });
}));

router.post('/:id/move', ah(async (req, res) => {
  const err = need(req.body, ['penId']);
  if (err) return bad(res, err);
  const row = await queryOne(
    `UPDATE animals SET current_pen_id = $3, updated_at = NOW()
      WHERE id = $1 AND kennel_id = $2 RETURNING *`,
    [req.params.id, req.kennelId, req.body.penId]
  );
  if (!row) return bad(res, 'Animal not found', 404);
  res.json({ animal: row });
}));

// ── Care plan ─────────────────────────────────────────────────────────────
router.put('/:id/care-plan', ah(async (req, res) => {
  const animal = await queryOne<{ id: string }>(
    `SELECT id FROM animals WHERE id = $1 AND kennel_id = $2`, [req.params.id, req.kennelId]
  );
  if (!animal) return bad(res, 'Animal not found', 404);
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO care_plans
       (animal_id, kennel_id, food_sku, grams_per_day, meals_per_day, feeder_device_id, water_device_id,
        allergies, diet_notes, exercise_notes, vet_name, vet_phone, emergency_contact, emergency_phone, notes, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (animal_id) DO UPDATE SET
       food_sku=EXCLUDED.food_sku, grams_per_day=EXCLUDED.grams_per_day, meals_per_day=EXCLUDED.meals_per_day,
       feeder_device_id=EXCLUDED.feeder_device_id, water_device_id=EXCLUDED.water_device_id,
       allergies=EXCLUDED.allergies, diet_notes=EXCLUDED.diet_notes, exercise_notes=EXCLUDED.exercise_notes,
       vet_name=EXCLUDED.vet_name, vet_phone=EXCLUDED.vet_phone, emergency_contact=EXCLUDED.emergency_contact,
       emergency_phone=EXCLUDED.emergency_phone, notes=EXCLUDED.notes, updated_by=EXCLUDED.updated_by, updated_at=NOW()
     RETURNING *`,
    [
      req.params.id, req.kennelId, b.foodSku ?? null, b.gramsPerDay ?? null, b.mealsPerDay ?? 2,
      b.feederDeviceId ?? null, b.waterDeviceId ?? null, b.allergies ?? null, b.dietNotes ?? null,
      b.exerciseNotes ?? null, b.vetName ?? null, b.vetPhone ?? null, b.emergencyContact ?? null,
      b.emergencyPhone ?? null, b.notes ?? null, req.user?.id ?? null,
    ]
  );
  res.json({ carePlan: row });
}));

// ── Weights + growth ──────────────────────────────────────────────────────
router.post('/:id/weights', ah(async (req, res) => {
  const err = need(req.body, ['grams']);
  if (err) return bad(res, err);
  const { grams, source = 'manual', deviceId = null, note = null, takenAt = null } = req.body;
  const row = await queryOne(
    `INSERT INTO weight_readings (kennel_id, animal_id, grams, source, device_id, note, taken_at)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, NOW())) RETURNING *`,
    [req.kennelId, req.params.id, grams, source, deviceId, note, takenAt]
  );

  // Adult body-condition check against the plan target / first reading.
  const animal = await queryOne<{ adult_weight_kg: number | null; dob: string | null; name: string }>(
    `SELECT adult_weight_kg, dob, name FROM animals WHERE id = $1`, [req.params.id]
  );
  const history = await query<{ grams: number; taken_at: string }>(
    `SELECT grams, taken_at FROM weight_readings WHERE animal_id = $1 ORDER BY taken_at ASC LIMIT 30`,
    [req.params.id]
  );
  let assessment: unknown = null;
  if (animal?.dob && animal.adult_weight_kg) {
    const ageDays = Math.floor((Date.now() - Date.parse(animal.dob)) / 86_400_000);
    if (ageDays < 400) {
      const a = assessPuppyWeight(animal.adult_weight_kg, ageDays, grams);
      assessment = a;
      if (a.flag === 'concern') {
        await raiseException({
          kennelId: req.kennelId!, kind: 'weight-concern', severity: 'critical',
          animalId: String(req.params.id), title: `${animal.name}: weight well below curve`,
          detail: `${Math.round(grams)} g at ${ageDays} d, expected ~${Math.round(a.expectedG)} g`,
          suggestedAction: 'Weigh again, check nursing/feeding, consider vet',
          notifyAudience: 'manager',
        });
      }
    }
  }
  if (history.length >= 2) {
    const loss = hasWeightLoss(history.map((h) => ({ grams: h.grams, takenAt: h.taken_at })), 3);
    if (loss.lost) {
      await raiseException({
        kennelId: req.kennelId!, kind: 'weight-loss', severity: 'warning', animalId: String(req.params.id),
        title: `${animal?.name ?? 'Animal'}: weight dropped ${loss.worstPct}%`,
        suggestedAction: 'Review intake log and health', notifyAudience: 'manager',
      });
    }
  }
  res.status(201).json({ reading: row, assessment });
}));

router.get('/:id/growth', ah(async (req, res) => {
  const animal = await queryOne<{ adult_weight_kg: number | null; dob: string | null }>(
    `SELECT adult_weight_kg, dob FROM animals WHERE id = $1 AND kennel_id = $2`,
    [req.params.id, req.kennelId]
  );
  if (!animal) return bad(res, 'Animal not found', 404);
  const readings = await query<{ grams: number; taken_at: string }>(
    `SELECT grams, taken_at FROM weight_readings WHERE animal_id = $1 ORDER BY taken_at ASC`,
    [req.params.id]
  );
  const curve = readings.map((r) => {
    const point: Record<string, unknown> = { takenAt: r.taken_at, grams: r.grams };
    if (animal.dob && animal.adult_weight_kg) {
      const ageDays = Math.floor((Date.parse(r.taken_at) - Date.parse(animal.dob)) / 86_400_000);
      point.ageDays = ageDays;
      point.expectedG = Math.round(expectedPuppyWeightG(animal.adult_weight_kg, ageDays));
    }
    return point;
  });
  const first = readings[0]?.grams;
  const last = readings[readings.length - 1]?.grams;
  res.json({
    curve,
    adultTrend: first && last ? adultWeightTrend(last, first) : null,
  });
}));

// ── Attributed intake (multi-dog identification) ──────────────────────────
router.post('/intake', ah(async (req, res) => {
  const err = need(req.body, ['deviceId', 'kind']);
  if (err) return bad(res, err);
  const b = req.body;
  // Who does the pen/schedule expect at this device?
  const expected = await queryOne<{ id: string; name: string }>(
    `SELECT a.id, a.name FROM animals a
       JOIN care_plans cp ON cp.animal_id = a.id
      WHERE a.kennel_id = $1 AND ($2 = cp.feeder_device_id OR $2 = cp.water_device_id)
      LIMIT 1`,
    [req.kennelId, b.deviceId]
  );
  const actualAnimalId = b.animalId ?? expected?.id ?? null;
  const mismatch = !!(expected && b.animalId && b.animalId !== expected.id);

  const row = await queryOne<{ id: string }>(
    `INSERT INTO intake_events
       (kennel_id, device_id, kind, animal_id, grams_dispensed, grams_consumed, ml_consumed,
        identified_by, expected_animal_id, mismatch, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11, NOW())) RETURNING id`,
    [
      req.kennelId, b.deviceId, b.kind, actualAnimalId, b.gramsDispensed ?? null, b.gramsConsumed ?? null,
      b.mlConsumed ?? null, b.identifiedBy ?? 'schedule', expected?.id ?? null, mismatch, b.occurredAt ?? null,
    ]
  );

  if (mismatch) {
    await raiseException({
      kennelId: req.kennelId!, kind: 'wrong-pen', severity: 'critical', deviceId: b.deviceId,
      animalId: b.animalId, title: 'Wrong dog at a device',
      detail: `Expected ${expected?.name ?? 'another dog'} at ${b.deviceId}`,
      suggestedAction: 'Check collar/BLE tag and return the dog to its pen',
      notifyAudience: 'on-call',
    });
  }
  res.status(201).json({ intakeId: row?.id, mismatch, expectedAnimalId: expected?.id ?? null });
}));

// ── Wellness insights ─────────────────────────────────────────────────────
router.get('/:id/wellness', ah(async (req, res) => {
  const id = req.params.id;
  const foodRows = await query<{ day: string; grams: number }>(
    `SELECT to_char(occurred_at::date,'YYYY-MM-DD') AS day, SUM(COALESCE(grams_consumed,grams_dispensed,0)) AS grams
       FROM intake_events WHERE animal_id=$1 AND kind='food' AND occurred_at > NOW() - INTERVAL '21 days'
      GROUP BY 1 ORDER BY 1`, [id]
  );
  const waterRows = await query<{ day: string; ml: number }>(
    `SELECT to_char(occurred_at::date,'YYYY-MM-DD') AS day, SUM(COALESCE(ml_consumed,0)) AS ml
       FROM intake_events WHERE animal_id=$1 AND kind='water' AND occurred_at > NOW() - INTERVAL '21 days'
      GROUP BY 1 ORDER BY 1`, [id]
  );
  const actRows = await query<{ day: string; minutes: number }>(
    `SELECT to_char(scheduled_start::date,'YYYY-MM-DD') AS day, SUM(COALESCE(activity_minutes,0)) AS minutes
       FROM enrichment_sessions WHERE animal_id=$1 AND scheduled_start > NOW() - INTERVAL '21 days'
      GROUP BY 1 ORDER BY 1`, [id]
  );
  const weightRows = await query<{ taken_at: string; grams: number }>(
    `SELECT taken_at, grams FROM weight_readings WHERE animal_id=$1 AND taken_at > NOW() - INTERVAL '60 days' ORDER BY taken_at`,
    [id]
  );
  const insights = wellnessInsights({
    foodGramsPerDay: foodRows.map((r) => ({ day: r.day, value: Number(r.grams) })),
    waterMlPerDay: waterRows.map((r) => ({ day: r.day, value: Number(r.ml) })),
    activityMinutesPerDay: actRows.map((r) => ({ day: r.day, value: Number(r.minutes) })),
    weightSeriesG: weightRows.map((r) => ({ takenAt: r.taken_at, grams: Number(r.grams) })),
  });
  res.json({ insights });
}));

// ── Pedigree ──────────────────────────────────────────────────────────────
router.get('/:id/pedigree', ah(async (req, res) => {
  const gens = Math.min(5, Math.max(1, Math.floor(Number(req.query.generations ?? 4)) || 4));
  const all = await query<PedigreeAnimal>(
    `SELECT id, name, sex, breed, registration_no, sire_id, dam_id FROM animals WHERE kennel_id = $1`,
    [req.kennelId],
  );
  const byId = new Map(all.map((a) => [a.id, a]));
  const tree = buildPedigree(String(req.params.id), byId, gens);
  if (!tree) return bad(res, 'Animal not found', 404);
  res.json({ pedigree: tree, generations: gens });
}));

export default router;
