/**
 * Buyer communications — broadcasts, direct messages, and the weekly puppy
 * "update pack". Messages go out through the Phase 4 notifier (email if the
 * buyer has an address, else logged). Mounted at /api/breeder/buyers.
 */
import { Router } from 'express';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad, need } from '../http.js';
import { dailyGainG } from '../logic/growth.js';
import { renderUpdatePack, personalize } from '../logic/buyerComms.js';

const router = Router();

type BuyerRow = { id: string; name: string | null; email: string | null };

async function queueForBuyer(
  kennelId: string,
  buyer: BuyerRow,
  subject: string,
  body: string,
): Promise<string | null> {
  const channel = buyer.email ? 'email' : 'log';
  const n = await queryOne<{ id: string }>(
    `INSERT INTO notifications (kennel_id, channel, target, subject, body)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [kennelId, channel, buyer.email ?? null, subject.slice(0, 250), body],
  );
  return n?.id ?? null;
}

// ── Broadcast to a group of buyers ───────────────────────────────────────
router.post('/messages/broadcast', ah(async (req, res) => {
  const err = need(req.body, ['subject', 'body']);
  if (err) return bad(res, err);
  const { subject, body, litterId = null, status = null } = req.body;

  const buyers = await query<BuyerRow>(
    `SELECT id, name, email FROM buyers
      WHERE kennel_id = $1
        AND ($2::uuid IS NULL OR wants_litter_id = $2)
        AND ($3::text IS NULL OR status = $3)`,
    [req.kennelId, litterId, status],
  );
  if (buyers.length === 0) return res.json({ sent: 0 });

  for (const b of buyers) {
    const text = personalize(body, b.name);
    const notificationId = await queueForBuyer(req.kennelId!, b, subject, text);
    await execute(
      `INSERT INTO buyer_messages (kennel_id, buyer_id, litter_id, kind, subject, body, notification_id, created_by)
       VALUES ($1,$2,$3,'broadcast',$4,$5,$6,$7)`,
      [req.kennelId, b.id, litterId, subject, text, notificationId, req.user?.id ?? null],
    );
  }
  res.json({ sent: buyers.length });
}));

// ── Direct message to one buyer ──────────────────────────────────────────
router.post('/messages/:buyerId', ah(async (req, res) => {
  const err = need(req.body, ['subject', 'body']);
  if (err) return bad(res, err);
  const buyer = await queryOne<BuyerRow>(
    `SELECT id, name, email FROM buyers WHERE id = $1 AND kennel_id = $2`,
    [req.params.buyerId, req.kennelId],
  );
  if (!buyer) return bad(res, 'Buyer not found', 404);

  const notificationId = await queueForBuyer(req.kennelId!, buyer, req.body.subject, req.body.body);
  const row = await queryOne(
    `INSERT INTO buyer_messages (kennel_id, buyer_id, kind, subject, body, notification_id, created_by)
     VALUES ($1,$2,'direct',$3,$4,$5,$6) RETURNING *`,
    [req.kennelId, buyer.id, req.body.subject, req.body.body, notificationId, req.user?.id ?? null],
  );
  res.status(201).json({ message: row });
}));

router.get('/messages', ah(async (req, res) => {
  const where: string[] = ['bm.kennel_id = $1'];
  const params: unknown[] = [req.kennelId];
  if (req.query.buyerId) { params.push(req.query.buyerId); where.push(`bm.buyer_id = $${params.length}`); }
  if (req.query.litterId) { params.push(req.query.litterId); where.push(`bm.litter_id = $${params.length}`); }
  const rows = await query(
    `SELECT bm.*, b.name AS buyer_name, n.status AS delivery_status
       FROM buyer_messages bm
       LEFT JOIN buyers b ON b.id = bm.buyer_id
       LEFT JOIN notifications n ON n.id = bm.notification_id
      WHERE ${where.join(' AND ')}
      ORDER BY bm.created_at DESC LIMIT 200`,
    params,
  );
  res.json({ messages: rows });
}));

// ── Weekly update-pack subscriptions ─────────────────────────────────────
router.get('/update-pack/subscriptions', ah(async (req, res) => {
  const rows = await query(
    `SELECT s.*, b.name AS buyer_name, pu.name AS puppy_name
       FROM update_pack_subscriptions s
       JOIN buyers b ON b.id = s.buyer_id
       JOIN puppies pu ON pu.id = s.puppy_id
      WHERE s.kennel_id = $1 ORDER BY s.active DESC, s.next_run_at`,
    [req.kennelId],
  );
  res.json({ subscriptions: rows });
}));

router.post('/update-pack/subscribe', ah(async (req, res) => {
  const err = need(req.body, ['buyerId', 'puppyId']);
  if (err) return bad(res, err);
  const row = await queryOne(
    `INSERT INTO update_pack_subscriptions (kennel_id, buyer_id, puppy_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (buyer_id, puppy_id) DO UPDATE SET active = true
     RETURNING *`,
    [req.kennelId, req.body.buyerId, req.body.puppyId],
  );
  res.status(201).json({ subscription: row });
}));

router.patch('/update-pack/subscriptions/:id', ah(async (req, res) => {
  if (typeof req.body?.active !== 'boolean') return bad(res, 'Pass { active }');
  const row = await queryOne(
    `UPDATE update_pack_subscriptions SET active = $3 WHERE id = $1 AND kennel_id = $2 RETURNING *`,
    [req.params.id, req.kennelId, req.body.active],
  );
  if (!row) return bad(res, 'Subscription not found', 404);
  res.json({ subscription: row });
}));

// ── Go-home pack ────────────────────────────────────────────────────────
router.get('/puppies/:pupId/go-home-pack', ah(async (req, res) => {
  const pup = await queryOne<Record<string, unknown>>(
    `SELECT pu.id, pu.name, pu.sex, pu.color, pu.microchip, pu.birth_weight_g, pu.go_home_on, pu.photos,
            pu.buyer_id, l.name AS litter_name, l.breed AS litter_breed,
            d.name AS dam_name, s.name AS sire_name
       FROM puppies pu
       LEFT JOIN litters l ON l.id = pu.litter_id
       LEFT JOIN animals d ON d.id = l.dam_id
       LEFT JOIN animals s ON s.id = l.sire_id
      WHERE pu.id = $1 AND pu.kennel_id = $2`,
    [req.params.pupId, req.kennelId],
  );
  if (!pup) return bad(res, 'Puppy not found', 404);

  const [buyer, weights, vaccinations, documents] = await Promise.all([
    pup.buyer_id
      ? queryOne(`SELECT name, email, phone FROM buyers WHERE id = $1`, [pup.buyer_id])
      : Promise.resolve(null),
    query(`SELECT grams, taken_at FROM weight_readings WHERE puppy_id = $1 ORDER BY taken_at ASC`, [pup.id]),
    query(
      `SELECT name, kind, given_on, batch_no, vet_name, certificate_url
         FROM vaccination_records
        WHERE puppy_id = $1 AND given_on IS NOT NULL ORDER BY given_on`,
      [pup.id],
    ),
    query(
      `SELECT id, kind, title, filename, (body IS NOT NULL) AS generated, created_at
         FROM documents
        WHERE kennel_id = $1
          AND ( (subject_type = 'puppy' AND subject_id = $2)
             OR (subject_type = 'buyer' AND subject_id = $3) )
        ORDER BY created_at DESC`,
      [req.kennelId, pup.id, pup.buyer_id ?? null],
    ),
  ]);

  res.json({
    puppy: pup,
    buyer,
    weightSeries: weights,
    vaccinations,
    documents,
    generatedAt: new Date().toISOString(),
  });
}));

// ── Weekly sweep (also on the engine timer) ─────────────────────────────
export async function updatePackSweep(): Promise<{ sent: number }> {
  const due = await query<{
    id: string; kennel_id: string; buyer_id: string; puppy_id: string;
    buyer_name: string | null; buyer_email: string | null;
    puppy_name: string | null; puppy_photos: unknown; go_home_on: string | null;
    whelped_at: string | null;
  }>(
    `SELECT s.id, s.kennel_id, s.buyer_id, s.puppy_id,
            b.name AS buyer_name, b.email AS buyer_email,
            pu.name AS puppy_name, pu.photos AS puppy_photos, pu.go_home_on,
            l.whelped_at
       FROM update_pack_subscriptions s
       JOIN buyers b ON b.id = s.buyer_id
       JOIN puppies pu ON pu.id = s.puppy_id
       LEFT JOIN litters l ON l.id = pu.litter_id
      WHERE s.active AND s.next_run_at <= NOW()
      LIMIT 50`,
  );

  let sent = 0;
  for (const s of due) {
    const weights = await query<{ grams: number; taken_at: string }>(
      `SELECT grams, taken_at FROM weight_readings WHERE puppy_id = $1 ORDER BY taken_at ASC`,
      [s.puppy_id],
    );
    const latest = weights.at(-1) ?? null;
    const weeksOld = s.whelped_at
      ? Math.floor((Date.now() - Date.parse(s.whelped_at)) / (7 * 86_400_000))
      : null;
    const { subject, body } = renderUpdatePack({
      puppyName: s.puppy_name ?? 'your puppy',
      buyerName: s.buyer_name,
      latestGrams: latest ? Math.round(latest.grams) : null,
      gainPerDay: dailyGainG(weights.map((w) => ({ grams: w.grams, takenAt: w.taken_at }))),
      weeksOld,
      photos: Array.isArray(s.puppy_photos) ? (s.puppy_photos as string[]) : [],
      goHomeOn: s.go_home_on,
    });

    const channel = s.buyer_email ? 'email' : 'log';
    const n = await queryOne<{ id: string }>(
      `INSERT INTO notifications (kennel_id, channel, target, subject, body)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [s.kennel_id, channel, s.buyer_email ?? null, subject, body],
    );
    await execute(
      `INSERT INTO buyer_messages (kennel_id, buyer_id, puppy_id, kind, subject, body, notification_id)
       VALUES ($1,$2,$3,'update-pack',$4,$5,$6)`,
      [s.kennel_id, s.buyer_id, s.puppy_id, subject, body, n?.id ?? null],
    );
    await execute(
      `UPDATE update_pack_subscriptions
          SET next_run_at = next_run_at + INTERVAL '7 days', last_sent_at = NOW()
        WHERE id = $1`,
      [s.id],
    );
    sent++;
  }
  return { sent };
}

router.post('/update-pack/run', ah(async (_req, res) => {
  res.json(await updatePackSweep());
}));

export default router;
