import { Router } from 'express';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad, need } from '../http.js';
import { expectedPuppyWeightG, assessPuppyWeight, dailyGainG } from '../logic/growth.js';

const router = Router();

// ── Litters ───────────────────────────────────────────────────────────────
router.get('/', ah(async (req, res) => {
  const rows = await query(
    `SELECT l.*,
            d.name AS dam_name, s.name AS sire_name,
            COUNT(pu.id)::int AS puppy_count,
            COUNT(pu.id) FILTER (WHERE pu.status='available')::int AS available_count,
            COUNT(pu.id) FILTER (WHERE pu.status IN ('reserved','sold'))::int AS placed_count
       FROM litters l
       LEFT JOIN animals d ON d.id = l.dam_id
       LEFT JOIN animals s ON s.id = l.sire_id
       LEFT JOIN puppies pu ON pu.litter_id = l.id
      WHERE l.kennel_id = $1
      GROUP BY l.id, d.name, s.name
      ORDER BY COALESCE(l.whelped_at, l.due_on::timestamptz) DESC NULLS LAST`,
    [req.kennelId]
  );
  res.json({ litters: rows });
}));

router.post('/', ah(async (req, res) => {
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO litters (kennel_id, name, dam_id, sire_id, pen_id, mated_on, due_on, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.kennelId, b.name ?? null, b.damId ?? null, b.sireId ?? null, b.penId ?? null,
     b.matedOn ?? null, b.dueOn ?? null, b.status ?? 'planned', b.notes ?? null]
  );
  res.status(201).json({ litter: row });
}));

router.post('/:id/whelp', ah(async (req, res) => {
  const b = req.body;
  const row = await queryOne(
    `UPDATE litters SET status='whelped', whelped_at = COALESCE($3, NOW()),
            count_born=$4, count_alive=$5, updated_at=NOW()
      WHERE id=$1 AND kennel_id=$2 RETURNING *`,
    [req.params.id, req.kennelId, b.whelpedAt ?? null, b.countBorn ?? null, b.countAlive ?? null]
  ).catch(() => null);
  if (!row) return bad(res, 'Litter not found', 404);
  res.json({ litter: row });
}));

// ── Puppies ───────────────────────────────────────────────────────────────
router.get('/:id/puppies', ah(async (req, res) => {
  const litter = await queryOne<{ id: string; dam_id: string | null; whelped_at: string | null }>(
    `SELECT id, dam_id, whelped_at FROM litters WHERE id=$1 AND kennel_id=$2`,
    [req.params.id, req.kennelId]
  );
  if (!litter) return bad(res, 'Litter not found', 404);
  const dam = litter.dam_id
    ? await queryOne<{ adult_weight_kg: number | null }>(`SELECT adult_weight_kg FROM animals WHERE id=$1`, [litter.dam_id])
    : null;
  const pups = await query<{ id: string; name: string; status: string; birth_weight_g: number | null }>(
    `SELECT * FROM puppies WHERE litter_id=$1 ORDER BY collar_color, name`, [req.params.id]
  );
  const withGrowth = await Promise.all(pups.map(async (p) => {
    const w = await query<{ grams: number; taken_at: string }>(
      `SELECT grams, taken_at FROM weight_readings WHERE puppy_id=$1 ORDER BY taken_at ASC`, [p.id]
    );
    let assessment: unknown = null;
    if (dam?.adult_weight_kg && litter.whelped_at && w.length) {
      const ageDays = Math.floor((Date.parse(w[w.length - 1].taken_at) - Date.parse(litter.whelped_at)) / 86_400_000);
      assessment = assessPuppyWeight(dam.adult_weight_kg, ageDays, w[w.length - 1].grams);
    }
    return {
      ...p,
      weights: w,
      dailyGainG: dailyGainG(w.map((x) => ({ grams: x.grams, takenAt: x.taken_at }))),
      assessment,
    };
  }));
  res.json({ puppies: withGrowth });
}));

router.post('/:id/puppies', ah(async (req, res) => {
  const err = need(req.body, ['name']);
  if (err) return bad(res, err);
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO puppies (kennel_id, litter_id, name, collar_color, sex, birth_weight_g, microchip, ble_tag_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.kennelId, req.params.id, b.name, b.collarColor ?? null, b.sex ?? null,
     b.birthWeightG ?? null, b.microchip ?? null, b.bleTagId ?? null]
  );
  if (b.birthWeightG && row) {
    await execute(
      `INSERT INTO weight_readings (kennel_id, puppy_id, grams, source, note) VALUES ($1,$2,$3,'manual','birth weight')`,
      [req.kennelId, (row as { id: string }).id, b.birthWeightG]
    );
  }
  res.status(201).json({ puppy: row });
}));

router.post('/puppies/:pupId/weights', ah(async (req, res) => {
  const err = need(req.body, ['grams']);
  if (err) return bad(res, err);
  const row = await queryOne(
    `INSERT INTO weight_readings (kennel_id, puppy_id, grams, source, device_id, note, taken_at)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, NOW())) RETURNING *`,
    [req.kennelId, req.params.pupId, req.body.grams, req.body.source ?? 'manual',
     req.body.deviceId ?? null, req.body.note ?? null, req.body.takenAt ?? null]
  );
  res.status(201).json({ reading: row });
}));

router.patch('/puppies/:pupId', ah(async (req, res) => {
  const camel: Record<string, string> = { collarColor: 'collar_color', bleTagId: 'ble_tag_id', buyerId: 'buyer_id', goHomeOn: 'go_home_on' };
  const allowed = ['name', 'collar_color', 'sex', 'microchip', 'ble_tag_id', 'status', 'buyer_id', 'go_home_on'];
  const sets: string[] = []; const vals: unknown[] = [req.params.pupId, req.kennelId];
  for (const [k, v] of Object.entries(req.body)) {
    const col = camel[k] ?? k;
    if (allowed.includes(col)) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
  }
  if (!sets.length) return bad(res, 'No updatable fields');
  const row = await queryOne(
    `UPDATE puppies SET ${sets.join(', ')} WHERE id=$1 AND kennel_id=$2 RETURNING *`, vals
  );
  if (!row) return bad(res, 'Puppy not found', 404);
  res.json({ puppy: row });
}));

// ── Buyers / waitlist ─────────────────────────────────────────────────────
router.get('/buyers/list', ah(async (req, res) => {
  const rows = await query(
    `SELECT b.*, l.name AS litter_name, p.name AS puppy_name
       FROM buyers b
       LEFT JOIN litters l ON l.id = b.wants_litter_id
       LEFT JOIN puppies p ON p.id = b.puppy_id
      WHERE b.kennel_id = $1
      ORDER BY b.status, COALESCE(b.waitlist_rank, 9999), b.created_at`,
    [req.kennelId]
  );
  res.json({ buyers: rows });
}));

router.post('/buyers', ah(async (req, res) => {
  const err = need(req.body, ['name']);
  if (err) return bad(res, err);
  const b = req.body;
  const rank = await queryOne<{ next: number }>(
    `SELECT COALESCE(MAX(waitlist_rank),0)+1 AS next FROM buyers WHERE kennel_id=$1`, [req.kennelId]
  );
  const row = await queryOne(
    `INSERT INTO buyers (kennel_id, name, email, phone, city, notes, status, deposit_paid, wants_litter_id, waitlist_rank)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.kennelId, b.name, b.email ?? null, b.phone ?? null, b.city ?? null, b.notes ?? null,
     b.status ?? 'waitlist', b.depositPaid ?? false, b.wantsLitterId ?? null, rank?.next ?? 1]
  );
  res.status(201).json({ buyer: row });
}));

router.patch('/buyers/:buyerId', ah(async (req, res) => {
  const camel: Record<string, string> = {
    depositPaid: 'deposit_paid', wantsLitterId: 'wants_litter_id', puppyId: 'puppy_id', waitlistRank: 'waitlist_rank',
  };
  const allowed = ['name', 'email', 'phone', 'city', 'notes', 'status', 'deposit_paid', 'wants_litter_id', 'puppy_id', 'waitlist_rank'];
  const sets: string[] = []; const vals: unknown[] = [req.params.buyerId, req.kennelId];
  for (const [k, v] of Object.entries(req.body)) {
    const col = camel[k] ?? k;
    if (allowed.includes(col)) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
  }
  if (!sets.length) return bad(res, 'No updatable fields');
  const row = await queryOne(`UPDATE buyers SET ${sets.join(', ')} WHERE id=$1 AND kennel_id=$2 RETURNING *`, vals);
  if (!row) return bad(res, 'Buyer not found', 404);
  // If assigned to a puppy, reflect the reservation on the puppy row.
  if (req.body.puppyId) {
    await execute(`UPDATE puppies SET status='reserved', buyer_id=$1 WHERE id=$2 AND kennel_id=$3`,
      [req.params.buyerId, req.body.puppyId, req.kennelId]);
  }
  res.json({ buyer: row });
}));

// ── Puppy buyer "update pack" (replaces the boarding stay-report) ─────────
router.get('/puppies/:pupId/update-pack', ah(async (req, res) => {
  const pup = await queryOne<{ id: string; name: string; litter_id: string; status: string; go_home_on: string | null }>(
    `SELECT id, name, litter_id, status, go_home_on FROM puppies WHERE id=$1 AND kennel_id=$2`,
    [req.params.pupId, req.kennelId]
  );
  if (!pup) return bad(res, 'Puppy not found', 404);
  const weights = await query(
    `SELECT grams, taken_at FROM weight_readings WHERE puppy_id=$1 ORDER BY taken_at ASC`, [pup.id]
  );
  const meds = await query(
    `SELECT m.name, ml.outcome, ml.administered_at
       FROM medication_logs ml JOIN medications m ON m.id = ml.medication_id
      WHERE ml.animal_id IS NULL AND ml.kennel_id=$1
      ORDER BY ml.administered_at DESC LIMIT 20`, [req.kennelId]
  );
  res.json({
    puppy: pup,
    weightSeries: weights,
    weightGainGramsPerDay: dailyGainG((weights as Array<{ grams: number; taken_at: string }>).map((w) => ({ grams: w.grams, takenAt: w.taken_at }))),
    healthLog: meds,
    note: 'Attach photos in the app; this endpoint provides the data half of the weekly buyer pack.',
  });
}));

export default router;
