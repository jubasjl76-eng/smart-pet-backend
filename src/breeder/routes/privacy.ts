/**
 * Privacy & data-governance. Slice 1: read the access log. Slice 2 adds
 * GDPR export / delete and retention config. Mounted at /api/breeder/privacy.
 */
import { Router } from 'express';
import { query } from '../../database/index.js';
import { ah } from '../http.js';

const router = Router();

router.get('/access-log', ah(async (req, res) => {
  const params: unknown[] = [req.kennelId];
  const where = ['kennel_id = $1'];
  for (const [q, col] of [
    ['action', 'action'], ['subjectType', 'subject_type'],
    ['subjectId', 'subject_id'], ['userId', 'user_id'],
  ] as const) {
    if (req.query[q]) { params.push(req.query[q]); where.push(`${col} = $${params.length}`); }
  }
  if (req.query.since) { params.push(req.query.since); where.push(`at >= $${params.length}`); }
  if (req.query.until) { params.push(req.query.until); where.push(`at <= $${params.length}`); }
  const limit = Math.min(Number(req.query.limit) || 200, 1000);

  const entries = await query(
    `SELECT id, user_id, action, subject_type, subject_id, ip, detail, at
       FROM access_log WHERE ${where.join(' AND ')}
      ORDER BY at DESC LIMIT ${limit}`,
    params,
  );
  res.json({ entries });
}));

export default router;
