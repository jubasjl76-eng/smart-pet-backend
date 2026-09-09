/**
 * Documents & paperwork — uploads (registration papers, certificates, signed
 * contracts) stored behind the storage interface, plus generated text docs
 * (Phase 7 slice 2). Mounted at /api/breeder/documents.
 */
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { getStorage } from '../../services/storage.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const KINDS = ['registration', 'contract', 'receipt', 'guarantee', 'certificate', 'handoff', 'photo', 'other'];
const SUBJECTS = ['animal', 'puppy', 'buyer', 'litter'];

const safeName = (n: string) => (n || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120);

router.post('/', upload.single('file'), ah(async (req, res) => {
  if (!req.file) return bad(res, 'file is required (multipart field "file")');
  const b = (req.body ?? {}) as Record<string, string>;
  const kind = KINDS.includes(b.kind) ? b.kind : 'other';
  const subjectType = SUBJECTS.includes(b.subjectType) ? b.subjectType : null;
  const key = `${req.kennelId}/${randomUUID()}-${safeName(req.file.originalname)}`;

  await getStorage().put(key, req.file.buffer, req.file.mimetype);

  const row = await queryOne(
    `INSERT INTO documents
       (kennel_id, kind, subject_type, subject_id, title, filename, content_type, size_bytes, storage_key, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, kind, subject_type, subject_id, title, filename, content_type, size_bytes, created_at`,
    [
      req.kennelId, kind, subjectType, b.subjectId || null,
      b.title || req.file.originalname, req.file.originalname,
      req.file.mimetype, req.file.size, key, req.user?.id ?? null,
    ],
  );
  res.status(201).json({ document: row });
}));

router.get('/', ah(async (req, res) => {
  const params: unknown[] = [req.kennelId];
  let where = 'kennel_id = $1';
  for (const [q, col] of [['subjectType', 'subject_type'], ['subjectId', 'subject_id'], ['kind', 'kind']] as const) {
    if (req.query[q]) {
      params.push(req.query[q]);
      where += ` AND ${col} = $${params.length}`;
    }
  }
  const rows = await query(
    `SELECT id, kind, subject_type, subject_id, title, filename, content_type, size_bytes,
            (body IS NOT NULL) AS generated, created_at
       FROM documents WHERE ${where} ORDER BY created_at DESC`,
    params,
  );
  res.json({ documents: rows });
}));

router.get('/:id/download', ah(async (req, res) => {
  const doc = await queryOne<{
    storage_key: string | null; filename: string | null; content_type: string | null; body: string | null;
  }>(
    `SELECT storage_key, filename, content_type, body FROM documents WHERE id=$1 AND kennel_id=$2`,
    [req.params.id, req.kennelId],
  );
  if (!doc) return bad(res, 'Document not found', 404);

  if (!doc.storage_key && doc.body != null) {
    res.type('text/markdown').send(doc.body);
    return;
  }
  try {
    const buf = await getStorage().get(doc.storage_key!);
    res.setHeader('Content-Type', doc.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename || 'document'}"`);
    res.send(buf);
  } catch {
    return bad(res, 'File is missing from storage', 410);
  }
}));

router.delete('/:id', ah(async (req, res) => {
  const doc = await queryOne<{ storage_key: string | null }>(
    `SELECT storage_key FROM documents WHERE id=$1 AND kennel_id=$2`,
    [req.params.id, req.kennelId],
  );
  if (doc?.storage_key) await getStorage().remove(doc.storage_key).catch(() => undefined);
  await execute(`DELETE FROM documents WHERE id=$1 AND kennel_id=$2`, [req.params.id, req.kennelId]);
  res.json({ ok: true });
}));

export default router;
