/**
 * Public marketing-site API — read-only, no auth. Mounted at /api/public.
 * Serves ONLY rows flagged `published`. Consumed by smart-pet-website
 * (see its docs/public-api.md — that file is the canonical contract).
 */
import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { raiseException } from '../exceptions.js';
import { inquiryLimiter } from '../../middleware/rateLimit.js';

const router = Router();
const T = ['public'];

// The public site is one operation → one kennel.
async function publicKennel() {
  return queryOne<Record<string, unknown>>(`SELECT * FROM kennels ORDER BY created_at LIMIT 1`);
}

// ── status derivation (pure, unit-tested in __tests__/public-api.test.ts) ──
export type PublicLitterStatus =
  'planned' | 'expecting' | 'born' | 'available' | 'reserved' | 'sold_out';

export function deriveLitterStatus(
  litterStatus: string,
  puppies: { status: string }[],
): PublicLitterStatus {
  if (litterStatus === 'planned') return 'planned';
  if (litterStatus === 'expecting') return 'expecting';
  // whelped / weaning / dispersed
  if (puppies.length === 0) return 'born';
  if (puppies.some((p) => p.status === 'available')) return 'available';
  if (puppies.some((p) => p.status === 'reserved')) return 'reserved';
  return 'sold_out';
}

// ── mappers ──────────────────────────────────────────────────────────────
function toPhotos(row: { photos?: unknown; photo_url?: unknown }): string[] {
  const arr = Array.isArray(row.photos)
    ? row.photos.filter((x): x is string => typeof x === 'string')
    : [];
  if (arr.length) return arr;
  return typeof row.photo_url === 'string' && row.photo_url ? [row.photo_url] : [];
}

function isoDate(v: unknown): string | undefined {
  return v ? String(v).slice(0, 10) : undefined;
}

function toPublicDog(a: Record<string, unknown>) {
  return {
    id: a.id,
    name: a.name,
    sex: a.sex,
    breed: (a.breed as string) ?? 'Retriever',
    role: a.sex === 'male' ? 'sire' : 'dam',
    dob: isoDate(a.dob),
    titles: (a.titles as string) ?? undefined,
    bio: (a.bio as string) ?? undefined,
    healthTests: Array.isArray(a.health_tests) ? a.health_tests : [],
    photos: toPhotos(a),
  };
}

const LITTER_SELECT = `
  SELECT l.*, l.public_description,
         d.id AS dam_id, d.name AS dam_name, d.breed AS dam_breed,
         s.id AS sire_id, s.name AS sire_name, s.breed AS sire_breed
    FROM litters l
    LEFT JOIN animals d ON d.id = l.dam_id
    LEFT JOIN animals s ON s.id = l.sire_id
`;
const LITTER_ORDER = ` ORDER BY COALESCE(l.whelped_at, l.due_on::timestamptz) DESC NULLS LAST`;

async function loadLitter(row: Record<string, unknown>) {
  // n+1 over puppies + weights — fine for a marketing site's one or two litters.
  const puppies = await query<Record<string, unknown>>(
    `SELECT * FROM puppies WHERE litter_id = $1 AND published = true
      ORDER BY collar_color NULLS LAST, name`,
    [row.id],
  );
  const withWeights = await Promise.all(
    puppies.map(async (p) => {
      const w = await query<{ taken_at: string; grams: number }>(
        `SELECT taken_at, grams FROM weight_readings WHERE puppy_id = $1 ORDER BY taken_at ASC`,
        [p.id],
      );
      const status = p.status === 'kept' ? 'sold' : (p.status as string);
      return {
        id: p.id,
        name: (p.name as string) ?? (p.collar_color as string) ?? 'Puppy',
        sex: p.sex,
        status,
        color: (p.color as string) ?? undefined,
        photos: toPhotos(p),
        weightSeries: w.map((x) => ({
          date: String(x.taken_at).slice(0, 10),
          grams: Math.round(x.grams),
        })),
      };
    }),
  );

  const damName = row.dam_name as string | null;
  const sireName = row.sire_name as string | null;
  return {
    id: row.id,
    name: (row.name as string) ?? `${damName ?? 'Dam'} x ${sireName ?? 'Sire'}`,
    breed: (row.dam_breed as string) ?? (row.sire_breed as string) ?? 'Retriever',
    status: deriveLitterStatus(row.status as string, puppies as { status: string }[]),
    sire: row.sire_id ? { id: row.sire_id, name: sireName } : undefined,
    dam: row.dam_id ? { id: row.dam_id, name: damName } : undefined,
    bornOn: isoDate(row.whelped_at),
    expectedOn: isoDate(row.due_on),
    description: (row.public_description as string) ?? (row.notes as string) ?? undefined,
    photos: toPhotos(row),
    puppyCount: withWeights.length,
    availableCount: withWeights.filter((p) => p.status === 'available').length,
    puppies: withWeights,
  };
}

// ── routes ───────────────────────────────────────────────────────────────
router.get(
  '/kennel',
  apiRoute({
    method: 'get',
    path: '/api/public/kennel',
    tags: T,
    summary: 'Public kennel profile.',
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (_req, res) => {
    const k = await publicKennel();
    if (!k) return bad(res, 'Not found', 404);
    const breeds = await query<{ breed: string }>(
      `SELECT DISTINCT breed FROM animals
        WHERE kennel_id = $1 AND published = true AND breed IS NOT NULL ORDER BY breed`,
      [k.slug],
    );
    res.json({
      name: k.name,
      tagline: (k.public_tagline as string) ?? '',
      about: (k.public_about as string) ?? '',
      breeds: breeds.length ? breeds.map((b) => b.breed) : k.breed_focus ? [k.breed_focus] : [],
      location: (k.public_location as string) ?? '',
      email: (k.public_email as string) ?? '',
      phone: (k.public_phone as string) ?? undefined,
      socials: Array.isArray(k.public_socials) ? k.public_socials : [],
    });
  }),
);

router.get(
  '/dogs',
  apiRoute({
    method: 'get',
    path: '/api/public/dogs',
    tags: T,
    summary: 'Published breeding / retired dogs.',
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (_req, res) => {
    const k = await publicKennel();
    if (!k) return res.json([]);
    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM animals
        WHERE kennel_id = $1 AND published = true AND role IN ('breeding','retired')
        ORDER BY sex DESC, name`,
      [k.slug],
    );
    res.json(rows.map(toPublicDog));
  }),
);

router.get(
  '/litters',
  apiRoute({
    method: 'get',
    path: '/api/public/litters',
    tags: T,
    summary: 'Published litters with puppies.',
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (_req, res) => {
    const k = await publicKennel();
    if (!k) return res.json([]);
    const rows = await query<Record<string, unknown>>(
      `${LITTER_SELECT} WHERE l.kennel_id = $1 AND l.published = true ${LITTER_ORDER}`,
      [k.slug],
    );
    res.json(await Promise.all(rows.map(loadLitter)));
  }),
);

router.get(
  '/litters/:id',
  apiRoute({
    method: 'get',
    path: '/api/public/litters/{id}',
    tags: T,
    summary: 'One published litter.',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
    const k = await publicKennel();
    if (!k) return bad(res, 'Not found', 404);
    const row = await queryOne<Record<string, unknown>>(
      `${LITTER_SELECT} WHERE l.id = $1 AND l.kennel_id = $2 AND l.published = true`,
      [req.params.id, k.slug],
    );
    if (!row) return bad(res, 'Not found', 404);
    res.json(await loadLitter(row));
  }),
);

// ── inquiries ────────────────────────────────────────────────────────────
// Rate-limited on top of the general /api/public limiter — see
// src/middleware/rateLimit.ts (Phase 20; was an in-memory, single-process
// limiter here, which would have under-counted at prod's ×2+ instances).
router.post(
  '/inquiries',
  inquiryLimiter,
  apiRoute({
    method: 'post',
    path: '/api/public/inquiries',
    tags: T,
    summary: 'Submit a website inquiry (rate-limited per IP).',
    request: {
      body: z.object({
        name: z.string().min(1),
        email: z.string().min(1),
        phone: z.string().optional(),
        message: z.string().optional(),
        litterId: z.string().optional(),
        puppyId: z.string().optional(),
      }),
    },
    responses: { 201: { description: 'created' }, 429: { description: 'too many requests' } },
  }),
  ah(async (req, res) => {
    const k = await publicKennel();
    if (!k) return bad(res, 'Not found', 404);

    const b = req.body as Record<string, string | undefined>;
    const rank = await queryOne<{ next: number }>(
      `SELECT COALESCE(MAX(waitlist_rank), 0) + 1 AS next FROM buyers WHERE kennel_id = $1`,
      [k.slug],
    );
    const buyer = await queryOne<{ id: string }>(
      `INSERT INTO buyers
         (kennel_id, name, email, phone, notes, status, source, wants_litter_id, puppy_id, waitlist_rank)
       VALUES ($1,$2,$3,$4,$5,'waitlist','website',$6,$7,$8) RETURNING id`,
      [
        k.slug,
        String(b.name).slice(0, 120),
        String(b.email).slice(0, 200),
        b.phone ?? null,
        b.message ?? null,
        b.litterId ?? null,
        b.puppyId ?? null,
        rank?.next ?? 1,
      ],
    );

    const about = b.puppyId ? 'a specific puppy' : b.litterId ? 'a litter' : 'the waitlist';
    await raiseException({
      kennelId: k.slug as string,
      kind: 'website-inquiry',
      severity: 'info',
      title: `Website inquiry from ${b.name}`,
      detail:
        `${b.email}${b.phone ? ` (${b.phone})` : ''}. Asking about ${about}. ${b.message ?? ''}`.trim(),
      suggestedAction: 'Reply, and set a waitlist rank if you want to progress them.',
      dedupKey: `website-inquiry:${buyer?.id}`,
      notifyAudience: 'manager',
    });

    res.status(201).json({ ok: true });
  }),
);

export default router;
