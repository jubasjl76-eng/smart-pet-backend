/**
 * Privacy & data-governance.
 *   Slice 1: read the access log.
 *   Slice 2: retention windows + sweep, GDPR export / delete.
 * Mounted at /api/breeder/privacy, behind the breeder guard.
 */
import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { getStorage } from '../../services/storage.js';
import { logAccess } from '../accessLog.js';
import { dropExpiredMonthPartitions } from '../../db/partitions.js';

const router = Router();
const T = ['breeder: privacy'];

// ── Access log ─────────────────────────────────────────────────────────────
router.get(
  '/access-log',
  apiRoute({
    method: 'get',
    path: '/api/breeder/privacy/access-log',
    tags: T,
    secure: true,
    summary: 'Read the access log (filterable).',
    request: {
      query: z.object({
        action: z.string().optional(),
        subjectType: z.string().optional(),
        subjectId: z.string().optional(),
        userId: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.coerce.number().int().optional(),
      }),
    },
    responses: {
      200: {
        description: 'ok',
        schema: z.object({ entries: z.array(z.record(z.string(), z.unknown())) }),
      },
    },
  }),
  ah(async (req, res) => {
    const params: unknown[] = [req.kennelId];
    const where = ['kennel_id = $1'];
    for (const [q, col] of [
      ['action', 'action'],
      ['subjectType', 'subject_type'],
      ['subjectId', 'subject_id'],
      ['userId', 'user_id'],
    ] as const) {
      if (req.query[q]) {
        params.push(req.query[q]);
        where.push(`${col} = $${params.length}`);
      }
    }
    if (req.query.since) {
      params.push(req.query.since);
      where.push(`at >= $${params.length}`);
    }
    if (req.query.until) {
      params.push(req.query.until);
      where.push(`at <= $${params.length}`);
    }
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    const entries = await query(
      `SELECT id, user_id, action, subject_type, subject_id, ip, detail, at
       FROM access_log WHERE ${where.join(' AND ')}
      ORDER BY at DESC LIMIT ${limit}`,
      params,
    );
    res.json({ entries });
  }),
);

// ── Retention settings ─────────────────────────────────────────────────────
const RETENTION_CLASSES = ['access_log', 'document', 'exception'] as const;

router.get(
  '/retention',
  apiRoute({
    method: 'get',
    path: '/api/breeder/privacy/retention',
    tags: T,
    secure: true,
    summary: 'Retention windows per data class.',
    responses: {
      200: {
        description: 'ok',
        schema: z.object({ classes: z.array(z.record(z.string(), z.unknown())) }),
      },
    },
  }),
  ah(async (req, res) => {
    const rows = await query<{ data_class: string; keep_days: number; updated_at: string }>(
      `SELECT data_class, keep_days, updated_at FROM retention_settings WHERE kennel_id = $1`,
      [req.kennelId],
    );
    const bySlug = new Map(rows.map((r) => [r.data_class, r]));
    res.json({
      classes: RETENTION_CLASSES.map((c) => ({
        dataClass: c,
        keepDays: bySlug.get(c)?.keep_days ?? null, // null = keep forever
        updatedAt: bySlug.get(c)?.updated_at ?? null,
      })),
    });
  }),
);

router.put(
  '/retention/:class',
  apiRoute({
    method: 'put',
    path: '/api/breeder/privacy/retention/{class}',
    tags: T,
    secure: true,
    summary: 'Set (or clear, keepDays < 1) a retention window.',
    request: {
      params: z.object({ class: z.string() }),
      body: z.object({ keepDays: z.coerce.number() }),
    },
    responses: { 200: { description: 'ok' }, 404: { description: 'unknown data class' } },
  }),
  ah(async (req, res) => {
    const dataClass = String(req.params.class);
    if (!RETENTION_CLASSES.includes(dataClass as never))
      return bad(res, `Unknown data class: ${dataClass}`, 404);
    const keepDays = Number(req.body?.keepDays);
    if (!Number.isFinite(keepDays)) return bad(res, 'keepDays must be a number');

    if (keepDays < 1) {
      // Turning retention off for this class.
      await execute(`DELETE FROM retention_settings WHERE kennel_id = $1 AND data_class = $2`, [
        req.kennelId,
        dataClass,
      ]);
      return res.json({ dataClass, keepDays: null });
    }
    const row = await queryOne<{ keep_days: number; updated_at: string }>(
      `INSERT INTO retention_settings (kennel_id, data_class, keep_days, updated_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (kennel_id, data_class)
       DO UPDATE SET keep_days = EXCLUDED.keep_days, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING keep_days, updated_at`,
      [req.kennelId, dataClass, Math.floor(keepDays), req.user?.id ?? null],
    );
    res.json({
      dataClass,
      keepDays: row?.keep_days ?? Math.floor(keepDays),
      updatedAt: row?.updated_at,
    });
  }),
);

// ── GDPR export ────────────────────────────────────────────────────────────
const EXPORT_SUBJECTS = ['buyer', 'animal', 'litter'] as const;

router.get(
  '/export',
  apiRoute({
    method: 'get',
    path: '/api/breeder/privacy/export',
    tags: T,
    secure: true,
    summary: 'GDPR data export for a buyer / animal / litter.',
    request: { query: z.object({ subjectType: z.enum(EXPORT_SUBJECTS), id: z.string().min(1) }) },
    responses: { 200: { description: 'bundle' }, 404: { description: 'subject not found' } },
  }),
  ah(async (req, res) => {
    const subjectType = String(req.query.subjectType ?? '');
    const id = String(req.query.id ?? '');
    if (!EXPORT_SUBJECTS.includes(subjectType as never)) {
      return bad(
        res,
        `subjectType must be one of: ${EXPORT_SUBJECTS.join(', ')} (owner data lives in the pet-owner app, not yet built)`,
      );
    }
    if (!id) return bad(res, 'id is required');

    const k = req.kennelId;
    const bundle: Record<string, unknown> = {
      subjectType,
      id,
      exportedAt: new Date().toISOString(),
    };

    if (subjectType === 'buyer') {
      const buyer = await queryOne(`SELECT * FROM buyers WHERE id = $1 AND kennel_id = $2`, [
        id,
        k,
      ]);
      if (!buyer) return bad(res, 'Buyer not found', 404);
      bundle.buyer = buyer;
      bundle.messages = await query(
        `SELECT * FROM buyer_messages WHERE buyer_id = $1 ORDER BY created_at`,
        [id],
      );
      bundle.updatePackSubscriptions = await query(
        `SELECT * FROM update_pack_subscriptions WHERE buyer_id = $1`,
        [id],
      );
      bundle.puppies = await query(
        `SELECT id, name, status, go_home_on FROM puppies WHERE buyer_id = $1 AND kennel_id = $2`,
        [id, k],
      );
      bundle.documents = await query(
        `SELECT id, kind, title, filename, created_at FROM documents
        WHERE kennel_id = $1 AND subject_type = 'buyer' AND subject_id = $2`,
        [k, id],
      );
      bundle.accessLog = await query(
        `SELECT id, action, ip, detail, at FROM access_log
        WHERE kennel_id = $1 AND subject_type = 'buyer' AND subject_id = $2 ORDER BY at`,
        [k, id],
      );
    } else if (subjectType === 'animal') {
      const animal = await queryOne(`SELECT * FROM animals WHERE id = $1 AND kennel_id = $2`, [
        id,
        k,
      ]);
      if (!animal) return bad(res, 'Animal not found', 404);
      bundle.animal = animal;
      bundle.weightReadings = await query(
        `SELECT * FROM weight_readings WHERE animal_id = $1 ORDER BY taken_at`,
        [id],
      );
      bundle.vaccinationRecords = await query(
        `SELECT * FROM vaccination_records WHERE animal_id = $1 ORDER BY due_on`,
        [id],
      );
      bundle.heatCycles = await query(
        `SELECT * FROM heat_cycles WHERE animal_id = $1 ORDER BY started_on`,
        [id],
      );
      bundle.litters = await query(
        `SELECT id, name, status, whelped_at FROM litters WHERE dam_id = $1 OR sire_id = $1`,
        [id],
      );
      bundle.documents = await query(
        `SELECT id, kind, title, filename, created_at FROM documents
        WHERE kennel_id = $1 AND subject_type = 'animal' AND subject_id = $2`,
        [k, id],
      );
    } else {
      const litter = await queryOne(`SELECT * FROM litters WHERE id = $1 AND kennel_id = $2`, [
        id,
        k,
      ]);
      if (!litter) return bad(res, 'Litter not found', 404);
      bundle.litter = litter;
      bundle.puppies = await query(
        `SELECT * FROM puppies WHERE litter_id = $1 ORDER BY created_at`,
        [id],
      );
      bundle.waitlist = await query(
        `SELECT id, name, status, waitlist_rank FROM buyers WHERE wants_litter_id = $1`,
        [id],
      );
      bundle.documents = await query(
        `SELECT id, kind, title, filename, created_at FROM documents
        WHERE kennel_id = $1 AND subject_type = 'litter' AND subject_id = $2`,
        [k, id],
      );
    }

    await logAccess(req, 'privacy.export', { subjectType, subjectId: id });
    res.json(bundle);
  }),
);

// ── GDPR delete (erasure) ──────────────────────────────────────────────────
async function dropDocuments(
  kennelId: string,
  subjectType: string,
  subjectId: string,
): Promise<number> {
  const docs = await query<{ id: string; storage_key: string | null }>(
    `SELECT id, storage_key FROM documents WHERE kennel_id = $1 AND subject_type = $2 AND subject_id = $3`,
    [kennelId, subjectType, subjectId],
  );
  for (const d of docs) {
    if (d.storage_key)
      await getStorage()
        .remove(d.storage_key)
        .catch(() => undefined);
  }
  await execute(
    `DELETE FROM documents WHERE kennel_id = $1 AND subject_type = $2 AND subject_id = $3`,
    [kennelId, subjectType, subjectId],
  );
  return docs.length;
}

router.post(
  '/delete',
  apiRoute({
    method: 'post',
    path: '/api/breeder/privacy/delete',
    tags: T,
    secure: true,
    summary: 'GDPR erasure for a buyer / animal / litter (needs { confirm: true }).',
    request: {
      body: z.object({
        subjectType: z.enum(EXPORT_SUBJECTS),
        id: z.string().min(1),
        confirm: z.boolean().optional(),
      }),
    },
    responses: {
      200: { description: 'ok' },
      404: { description: 'not found' },
      409: { description: 'blocked by dependents' },
    },
  }),
  ah(async (req, res) => {
    if (req.body.confirm !== true) return bad(res, 'Pass { confirm: true } to erase this subject');
    const subjectType = String(req.body.subjectType);
    const id = String(req.body.id);
    const k = req.kennelId;
    const deleted: Record<string, number> = {};

    if (subjectType === 'buyer') {
      const buyer = await queryOne(`SELECT id FROM buyers WHERE id = $1 AND kennel_id = $2`, [
        id,
        k,
      ]);
      if (!buyer) return bad(res, 'Buyer not found', 404);
      // Keep the puppies (kennel inventory); just detach them.
      await execute(`UPDATE puppies SET buyer_id = NULL WHERE buyer_id = $1`, [id]);
      deleted.documents = await dropDocuments(k!, 'buyer', id);
      // buyer_messages + update_pack_subscriptions cascade on the buyers FK.
      await execute(`DELETE FROM buyers WHERE id = $1 AND kennel_id = $2`, [id, k]);
      deleted.buyers = 1;
    } else if (subjectType === 'animal') {
      const animal = await queryOne(`SELECT id FROM animals WHERE id = $1 AND kennel_id = $2`, [
        id,
        k,
      ]);
      if (!animal) return bad(res, 'Animal not found', 404);
      const parentOf = await queryOne<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM litters WHERE dam_id = $1 OR sire_id = $1`,
        [id],
      );
      if ((parentOf?.n ?? 0) > 0) {
        return bad(
          res,
          'This animal is a parent on one or more litters. Erase or reassign those litters first.',
          409,
        );
      }
      deleted.documents = await dropDocuments(k!, 'animal', id);
      // weight_readings, vaccination_records, heat_cycles cascade on animal_id.
      await execute(`DELETE FROM animals WHERE id = $1 AND kennel_id = $2`, [id, k]);
      deleted.animals = 1;
    } else if (subjectType === 'litter') {
      const litter = await queryOne(`SELECT id FROM litters WHERE id = $1 AND kennel_id = $2`, [
        id,
        k,
      ]);
      if (!litter) return bad(res, 'Litter not found', 404);
      const active = await queryOne<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM puppies WHERE litter_id = $1 AND status IN ('reserved','sold','kept')`,
        [id],
      );
      if ((active?.n ?? 0) > 0) {
        return bad(res, 'This litter has reserved, sold or kept puppies. Erase those first.', 409);
      }
      deleted.documents = await dropDocuments(k!, 'litter', id);
      // puppies cascade on litter_id; their weight_readings cascade on puppy_id;
      // buyer_messages / update_pack_subscriptions on puppy_id are SET NULL / CASCADE per migration 005.
      await execute(`DELETE FROM litters WHERE id = $1 AND kennel_id = $2`, [id, k]);
      deleted.litters = 1;
    } else {
      return bad(res, `subjectType must be one of: ${EXPORT_SUBJECTS.join(', ')}`);
    }

    await logAccess(req, 'privacy.delete', { subjectType, subjectId: id, detail: { deleted } });
    res.json({ ok: true, deleted });
  }),
);

// ── Retention sweep (also on the engine timer) ─────────────────────────────
export async function retentionSweep(
  now: Date = new Date(),
): Promise<{ accessLog: number; documents: number; exceptions: number }> {
  const settings = await query<{ kennel_id: string; data_class: string; keep_days: number }>(
    `SELECT kennel_id, data_class, keep_days FROM retention_settings WHERE keep_days >= 1`,
  );
  const result = { accessLog: 0, documents: 0, exceptions: 0 };

  for (const s of settings) {
    const cutoffDate = new Date(now.getTime() - s.keep_days * 86_400_000);
    const cutoff = cutoffDate.toISOString();

    if (s.data_class === 'access_log') {
      // Fast path first: whole expired months go via DROP TABLE (A12 #23),
      // so the row-level DELETE below only ever touches what a
      // month-granularity drop can't — the partial boundary month and the
      // default (out-of-range) partition.
      result.accessLog += await dropExpiredMonthPartitions('access_log', cutoffDate, s.kennel_id);
      const r = await query<{ id: string }>(
        `DELETE FROM access_log WHERE kennel_id = $1 AND at < $2 RETURNING id`,
        [s.kennel_id, cutoff],
      );
      result.accessLog += r.length;
    } else if (s.data_class === 'exception') {
      // Only resolved exceptions are eligible — an old but still-open alert
      // shouldn't vanish just because it's past the retention window.
      result.exceptions += await dropExpiredMonthPartitions(
        'exceptions',
        cutoffDate,
        s.kennel_id,
        `status <> 'resolved'`,
      );
      const r = await query<{ id: string }>(
        `DELETE FROM exceptions WHERE kennel_id = $1 AND created_at < $2 AND status = 'resolved' RETURNING id`,
        [s.kennel_id, cutoff],
      );
      result.exceptions += r.length;
    } else if (s.data_class === 'document') {
      // ponytail: one window for all document kinds. Split into
      // 'document.contract' / 'document.certificate' etc. if the breeder needs
      // different windows (a contract is often a 6-year legal keep).
      const docs = await query<{ id: string; storage_key: string | null }>(
        `SELECT id, storage_key FROM documents WHERE kennel_id = $1 AND created_at < $2 LIMIT 500`,
        [s.kennel_id, cutoff],
      );
      for (const d of docs) {
        if (d.storage_key)
          await getStorage()
            .remove(d.storage_key)
            .catch(() => undefined);
        await execute(`DELETE FROM documents WHERE id = $1`, [d.id]);
      }
      result.documents += docs.length;
    }
  }
  return result;
}

router.post(
  '/retention/run',
  apiRoute({
    method: 'post',
    path: '/api/breeder/privacy/retention/run',
    tags: T,
    secure: true,
    summary: 'Run the retention sweep now.',
    responses: {
      200: {
        description: 'ok',
        schema: z.object({ accessLog: z.number(), documents: z.number() }),
      },
    },
  }),
  ah(async (_req, res) => {
    res.json(await retentionSweep());
  }),
);

export default router;
