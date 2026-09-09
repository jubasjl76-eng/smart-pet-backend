/**
 * Documents & paperwork — uploads (registration papers, certificates, signed
 * contracts) stored behind the storage interface, plus generated text docs
 * (Phase 7 slice 2). Mounted at /api/breeder/documents.
 */
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { getStorage } from '../../services/storage.js';
import { logAccess } from '../accessLog.js';
import {
  DEFAULT_TEMPLATES, KNOWN_SLUGS, defaultTemplate, templateTokens, buildDoc,
} from '../logic/docTemplates.js';

const router = Router();
const T = ['breeder: documents'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const KINDS = ['registration', 'contract', 'receipt', 'guarantee', 'certificate', 'handoff', 'photo', 'other'];
const SUBJECTS = ['animal', 'puppy', 'buyer', 'litter'];

const safeName = (n: string) => (n || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120);

router.post(
  '/',
  apiRoute({
    method: 'post', path: '/api/breeder/documents', tags: T, secure: true,
    summary: 'Upload a document (multipart form-data, field "file").',
    responses: { 201: { description: 'created' }, 400: { description: 'file missing' } },
  }),
  upload.single('file'),
  ah(async (req, res) => {
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
}),
);

router.get(
  '/',
  apiRoute({
    method: 'get', path: '/api/breeder/documents', tags: T, secure: true,
    summary: 'List documents (filter by subjectType / subjectId / kind).',
    request: {
      query: z.object({
        subjectType: z.string().optional(),
        subjectId: z.string().optional(),
        kind: z.string().optional(),
      }),
    },
    responses: { 200: { description: 'ok', schema: z.object({ documents: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
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
}),
);

router.get(
  '/:id/download',
  apiRoute({
    method: 'get', path: '/api/breeder/documents/{id}/download', tags: T, secure: true,
    summary: 'Download a document (binary or generated markdown).',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'file body' }, 404: { description: 'not found' }, 410: { description: 'missing from storage' } },
  }),
  ah(async (req, res) => {
  const doc = await queryOne<{
    storage_key: string | null; filename: string | null; content_type: string | null;
    body: string | null; kind: string; subject_type: string | null; subject_id: string | null;
  }>(
    `SELECT storage_key, filename, content_type, body, kind, subject_type, subject_id
       FROM documents WHERE id=$1 AND kennel_id=$2`,
    [req.params.id, req.kennelId],
  );
  if (!doc) return bad(res, 'Document not found', 404);

  const docId = String(req.params.id);
  await logAccess(req, 'document.download', {
    subjectType: doc.subject_type ?? 'document',
    subjectId: doc.subject_id ?? docId,
    detail: { documentId: docId, kind: doc.kind, generated: !doc.storage_key },
  });

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
}),
);

// ── Generated paperwork (contract / receipt / guarantee / handoff) ──────

/** Built-in defaults with this kennel's edits overlaid, each with its tokens. */
router.get(
  '/templates',
  apiRoute({
    method: 'get', path: '/api/breeder/documents/templates', tags: T, secure: true,
    summary: 'Document templates (defaults + this kennel’s overrides).',
    responses: { 200: { description: 'ok', schema: z.object({ templates: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const overrides = await query<{ slug: string; title: string; body: string }>(
    `SELECT slug, title, body FROM document_templates WHERE kennel_id = $1`,
    [req.kennelId],
  );
  const bySlug = new Map(overrides.map((o) => [o.slug, o]));
  const templates = DEFAULT_TEMPLATES.map((t) => {
    const o = bySlug.get(t.slug);
    const body = o?.body ?? t.body;
    return {
      slug: t.slug, kind: t.kind, title: o?.title ?? t.title, body,
      customised: !!o, tokens: templateTokens(body),
    };
  });
  res.json({ templates });
}),
);

/** Upsert this kennel's override for one template slug. */
router.put(
  '/templates/:slug',
  apiRoute({
    method: 'put', path: '/api/breeder/documents/templates/{slug}', tags: T, secure: true,
    summary: 'Upsert this kennel’s override for one template slug.',
    request: {
      params: z.object({ slug: z.string() }),
      body: z.object({ body: z.string().min(1), title: z.string().optional() }),
    },
    responses: { 200: { description: 'ok' }, 404: { description: 'unknown template' } },
  }),
  ah(async (req, res) => {
  const slug = String(req.params.slug);
  if (!KNOWN_SLUGS.includes(slug)) return bad(res, `Unknown template: ${slug}`, 404);
  const title = req.body.title || defaultTemplate(slug)!.title;
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO document_templates (kennel_id, slug, title, body, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (kennel_id, slug)
       DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body,
                     updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING slug, title, body, updated_at`,
    [req.kennelId, slug, title, String(req.body.body), req.user?.id ?? null],
  );
  res.json({ template: { ...row, tokens: templateTokens(String(req.body.body)) } });
}),
);

/**
 * Render a template into a stored `documents` row. Auto-fills tokens from a
 * puppy or buyer subject; anything else (price, deposit, litter/animal
 * subjects) comes from `tokens` on the request.
 * ponytail: puppy + buyer auto-fill only; other subject types pass tokens.
 */
router.post(
  '/generate',
  apiRoute({
    method: 'post', path: '/api/breeder/documents/generate', tags: T, secure: true,
    summary: 'Render a template into a stored document row.',
    request: {
      body: z.object({
        template: z.string().min(1),
        subjectType: z.string().min(1),
        subjectId: z.string().min(1),
        tokens: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      }),
    },
    responses: { 201: { description: 'created' }, 404: { description: 'template or subject not found' } },
  }),
  ah(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const slug = String(b.template);
  const def = defaultTemplate(slug);
  if (!def) return bad(res, `Unknown template: ${slug}`, 404);
  const subjectType = String(b.subjectType);
  const subjectId = String(b.subjectId);
  if (!SUBJECTS.includes(subjectType)) return bad(res, `Bad subjectType: ${subjectType}`);

  const override = await queryOne<{ title: string; body: string }>(
    `SELECT title, body FROM document_templates WHERE kennel_id = $1 AND slug = $2`,
    [req.kennelId, slug],
  );
  const tpl = { ...def, title: override?.title ?? def.title, body: override?.body ?? def.body };

  const kennel = await queryOne<{ name: string }>(
    `SELECT name FROM kennels WHERE slug = $1`, [req.kennelId],
  );
  const auto: Record<string, string | number | null | undefined> = {
    today: new Date().toISOString().slice(0, 10),
    kennel_name: kennel?.name,
  };

  if (subjectType === 'puppy') {
    const p = await queryOne<Record<string, string | null>>(
      `SELECT pu.name AS puppy_name, pu.sex AS puppy_sex, pu.color AS puppy_color,
              pu.microchip,
              to_char(pu.go_home_on, 'YYYY-MM-DD') AS go_home_on,
              l.breed,
              to_char(l.whelped_at, 'YYYY-MM-DD') AS birth_date,
              d.name AS dam_name, s.name AS sire_name,
              bu.name AS buyer_name, bu.email AS buyer_email
         FROM puppies pu
         LEFT JOIN litters l ON l.id = pu.litter_id
         LEFT JOIN animals d ON d.id = l.dam_id
         LEFT JOIN animals s ON s.id = l.sire_id
         LEFT JOIN buyers bu ON bu.id = pu.buyer_id
        WHERE pu.id = $1 AND pu.kennel_id = $2`,
      [subjectId, req.kennelId],
    );
    if (!p) return bad(res, 'Puppy not found', 404);
    Object.assign(auto, p);
  } else if (subjectType === 'buyer') {
    const bu = await queryOne<Record<string, string | null>>(
      `SELECT name AS buyer_name, email AS buyer_email FROM buyers WHERE id = $1 AND kennel_id = $2`,
      [subjectId, req.kennelId],
    );
    if (!bu) return bad(res, 'Buyer not found', 404);
    Object.assign(auto, bu);
  }

  const caller = (b.tokens && typeof b.tokens === 'object' ? b.tokens : {}) as Record<string, string | number>;
  let doc: { kind: string; title: string; body: string };
  try {
    doc = buildDoc(tpl, auto, caller);
  } catch (e) {
    return bad(res, (e as Error).message);
  }

  const row = await queryOne(
    `INSERT INTO documents
       (kennel_id, kind, subject_type, subject_id, title, body, meta, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, kind, subject_type, subject_id, title, (body IS NOT NULL) AS generated, created_at`,
    [
      req.kennelId, doc.kind, subjectType, subjectId, doc.title, doc.body,
      JSON.stringify({ template: slug, tokens: { ...auto, ...caller } }), req.user?.id ?? null,
    ],
  );
  res.status(201).json({ document: row, body: doc.body });
}),
);

router.delete(
  '/:id',
  apiRoute({
    method: 'delete', path: '/api/breeder/documents/{id}', tags: T, secure: true,
    summary: 'Delete a document (and its stored file).',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  const doc = await queryOne<{ storage_key: string | null }>(
    `SELECT storage_key FROM documents WHERE id=$1 AND kennel_id=$2`,
    [req.params.id, req.kennelId],
  );
  if (doc?.storage_key) await getStorage().remove(doc.storage_key).catch(() => undefined);
  await execute(`DELETE FROM documents WHERE id=$1 AND kennel_id=$2`, [req.params.id, req.kennelId]);
  res.json({ ok: true });
}),
);

export default router;
