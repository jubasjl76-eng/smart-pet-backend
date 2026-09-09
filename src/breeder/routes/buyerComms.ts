/**
 * Buyer communications — broadcasts, direct messages, and the weekly puppy
 * "update pack". Messages go out through the Phase 4 notifier (email if the
 * buyer has an address, else logged). Mounted at /api/breeder/buyers.
 */
import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { dailyGainG } from '../logic/growth.js';
import { renderUpdatePack, personalize } from '../logic/buyerComms.js';

const router = Router();
const T = ['breeder: buyer comms'];
const msgBody = z.object({ subject: z.string().min(1), body: z.string().min(1) });

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
router.post(
  '/messages/broadcast',
  apiRoute({
    method: 'post', path: '/api/breeder/buyers/messages/broadcast', tags: T, secure: true,
    summary: 'Broadcast a message to a group of buyers.',
    request: {
      body: msgBody.extend({
        litterId: z.string().nullable().optional(),
        status: z.string().nullable().optional(),
      }),
    },
    responses: { 200: { description: 'ok', schema: z.object({ sent: z.number() }) } },
  }),
  ah(async (req, res) => {
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
}),
);

// ── Direct message to one buyer ──────────────────────────────────────────
router.post(
  '/messages/:buyerId',
  apiRoute({
    method: 'post', path: '/api/breeder/buyers/messages/{buyerId}', tags: T, secure: true,
    summary: 'Send a direct message to one buyer.',
    request: { params: z.object({ buyerId: z.string() }), body: msgBody },
    responses: { 201: { description: 'created' }, 404: { description: 'buyer not found' } },
  }),
  ah(async (req, res) => {
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
}),
);

router.get(
  '/messages',
  apiRoute({
    method: 'get', path: '/api/breeder/buyers/messages', tags: T, secure: true,
    summary: 'Buyer message history (filter by buyerId / litterId).',
    request: { query: z.object({ buyerId: z.string().optional(), litterId: z.string().optional() }) },
    responses: { 200: { description: 'ok', schema: z.object({ messages: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
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
}),
);

// ── Weekly update-pack subscriptions ─────────────────────────────────────
router.get(
  '/update-pack/subscriptions',
  apiRoute({
    method: 'get', path: '/api/breeder/buyers/update-pack/subscriptions', tags: T, secure: true,
    summary: 'Weekly update-pack subscriptions.',
    responses: { 200: { description: 'ok', schema: z.object({ subscriptions: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const rows = await query(
    `SELECT s.*, b.name AS buyer_name, pu.name AS puppy_name
       FROM update_pack_subscriptions s
       JOIN buyers b ON b.id = s.buyer_id
       JOIN puppies pu ON pu.id = s.puppy_id
      WHERE s.kennel_id = $1 ORDER BY s.active DESC, s.next_run_at`,
    [req.kennelId],
  );
  res.json({ subscriptions: rows });
}),
);

router.post(
  '/update-pack/subscribe',
  apiRoute({
    method: 'post', path: '/api/breeder/buyers/update-pack/subscribe', tags: T, secure: true,
    summary: 'Subscribe a buyer to a puppy’s weekly update pack.',
    request: { body: z.object({ buyerId: z.string().min(1), puppyId: z.string().min(1) }) },
    responses: { 201: { description: 'created' } },
  }),
  ah(async (req, res) => {
  const row = await queryOne(
    `INSERT INTO update_pack_subscriptions (kennel_id, buyer_id, puppy_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (buyer_id, puppy_id) DO UPDATE SET active = true
     RETURNING *`,
    [req.kennelId, req.body.buyerId, req.body.puppyId],
  );
  res.status(201).json({ subscription: row });
}),
);

router.patch(
  '/update-pack/subscriptions/:id',
  apiRoute({
    method: 'patch', path: '/api/breeder/buyers/update-pack/subscriptions/{id}', tags: T, secure: true,
    summary: 'Activate / deactivate an update-pack subscription.',
    request: { params: z.object({ id: z.string() }), body: z.object({ active: z.boolean() }) },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
  if (typeof req.body?.active !== 'boolean') return bad(res, 'Pass { active }');
  const row = await queryOne(
    `UPDATE update_pack_subscriptions SET active = $3 WHERE id = $1 AND kennel_id = $2 RETURNING *`,
    [req.params.id, req.kennelId, req.body.active],
  );
  if (!row) return bad(res, 'Subscription not found', 404);
  res.json({ subscription: row });
}),
);

// ── Go-home pack ────────────────────────────────────────────────────────
router.get(
  '/puppies/:pupId/go-home-pack',
  apiRoute({
    method: 'get', path: '/api/breeder/buyers/puppies/{pupId}/go-home-pack', tags: T, secure: true,
    summary: 'Assembled go-home pack for a puppy.',
    request: { params: z.object({ pupId: z.string() }) },
    responses: { 200: { description: 'ok' }, 404: { description: 'puppy not found' } },
  }),
  ah(async (req, res) => {
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
}),
);

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

router.post(
  '/update-pack/run',
  apiRoute({
    method: 'post', path: '/api/breeder/buyers/update-pack/run', tags: T, secure: true,
    summary: 'Run the weekly update-pack sweep now.',
    responses: { 200: { description: 'ok', schema: z.object({ sent: z.number() }) } },
  }),
  ah(async (_req, res) => {
  res.json(await updatePackSweep());
}),
);

export default router;
