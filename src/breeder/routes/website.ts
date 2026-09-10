/**
 * Console-facing controls for the public marketing site. Behind the breeder
 * guard (owner/staff JWT + withKennel). The dashboard's "Publish to website"
 * toggle + photo fields call these; a publish change pings the site to refresh.
 */
import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { fireRevalidate } from '../revalidate.js';

const router = Router();
const T = ['breeder: website'];

const KIND_TABLE: Record<string, string> = {
  animal: 'animals',
  litter: 'litters',
  puppy: 'puppies',
};
const KIND_COLUMNS: Record<string, Record<string, string>> = {
  animal: { published: 'published', photos: 'photos', titles: 'titles', bio: 'bio', healthTests: 'health_tests' },
  litter: { published: 'published', photos: 'photos', publicDescription: 'public_description' },
  puppy: { published: 'published', photos: 'photos', color: 'color' },
};
const JSON_COLS = new Set(['photos', 'health_tests']);

// Current public config + how much is published.
router.get(
  '/',
  apiRoute({
    method: 'get', path: '/api/breeder/website', tags: T, secure: true,
    summary: 'Public site config + published counts.',
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
    const kennel = await queryOne(
      `SELECT slug, name, public_tagline, public_about, public_email, public_phone,
              public_location, public_socials
         FROM kennels WHERE slug = $1`,
      [req.kennelId],
    );
    const counts = await queryOne(
      `SELECT
         (SELECT COUNT(*) FROM animals WHERE kennel_id = $1 AND published)::int AS dogs,
         (SELECT COUNT(*) FROM litters WHERE kennel_id = $1 AND published)::int AS litters,
         (SELECT COUNT(*) FROM puppies WHERE kennel_id = $1 AND published)::int AS puppies`,
      [req.kennelId],
    );
    res.json({ kennel, counts });
  }),
);

// Set the kennel's public identity (tagline / about / contact / socials).
router.put(
  '/kennel',
  apiRoute({
    method: 'put', path: '/api/breeder/website/kennel', tags: T, secure: true,
    summary: 'Set the kennel’s public identity.',
    request: {
      body: z.object({
        tagline: z.string().optional(),
        about: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        location: z.string().optional(),
        socials: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
    const map: Record<string, string> = {
      tagline: 'public_tagline',
      about: 'public_about',
      email: 'public_email',
      phone: 'public_phone',
      location: 'public_location',
      socials: 'public_socials',
    };
    const sets: string[] = [];
    const vals: unknown[] = [req.kennelId];
    for (const [k, v] of Object.entries(req.body ?? {})) {
      const col = map[k];
      if (!col) continue;
      vals.push(col === 'public_socials' ? JSON.stringify(v) : v);
      sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) return bad(res, 'No updatable fields');
    await execute(`UPDATE kennels SET ${sets.join(', ')} WHERE slug = $1`, vals);
    fireRevalidate();
    res.json({ ok: true });
  }),
);

// Toggle publish state / set photos / set public copy for one row.
router.patch(
  '/:kind/:id',
  apiRoute({
    method: 'patch', path: '/api/breeder/website/{kind}/{id}', tags: T, secure: true,
    summary: 'Toggle publish / set photos / set public copy for one row.',
    request: { params: z.object({ kind: z.enum(['animal', 'litter', 'puppy']), id: z.string() }) },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    const table = KIND_TABLE[kind];
    const cols = KIND_COLUMNS[kind];
    if (!table || !cols) return bad(res, `kind must be one of: ${Object.keys(KIND_TABLE).join(', ')}`);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [id, req.kennelId];
    for (const [k, v] of Object.entries(body)) {
      const col = cols[k];
      if (!col) continue;
      vals.push(JSON_COLS.has(col) ? JSON.stringify(v) : v);
      sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) return bad(res, 'No updatable fields');

    const row = await queryOne<{ id: string; published: boolean }>(
      `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 AND kennel_id = $2 RETURNING id, published`,
      vals,
    );
    if (!row) return bad(res, 'Not found', 404);
    if ('published' in body) fireRevalidate();
    res.json({ ok: true, item: row });
  }),
);

// Convenience: everything currently publishable, with its publish + photo state,
// so the console can show one "website" screen.
router.get(
  '/inventory',
  apiRoute({
    method: 'get', path: '/api/breeder/website/inventory', tags: T, secure: true,
    summary: 'Everything publishable with its publish + photo state.',
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
    const [animals, litters, puppies] = await Promise.all([
      query(
        `SELECT id, name, sex, role, breed, published, photos, titles, bio, health_tests
           FROM animals WHERE kennel_id = $1 AND role IN ('breeding','retired') ORDER BY name`,
        [req.kennelId],
      ),
      query(
        `SELECT id, name, status, published, photos, public_description
           FROM litters WHERE kennel_id = $1 ORDER BY COALESCE(whelped_at, due_on::timestamptz) DESC NULLS LAST`,
        [req.kennelId],
      ),
      query(
        `SELECT p.id, p.name, p.sex, p.status, p.published, p.photos, p.color, p.litter_id
           FROM puppies p WHERE p.kennel_id = $1 ORDER BY p.collar_color NULLS LAST, p.name`,
        [req.kennelId],
      ),
    ]);
    res.json({ animals, litters, puppies });
  }),
);

export default router;
