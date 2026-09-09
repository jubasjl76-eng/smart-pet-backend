/**
 * GPS geofencing — safe-zone CRUD, position ingest with enter/exit detection,
 * and an escape alert into the care inbox. Mounted at /api/breeder/geo.
 *
 * A collar posts fixes to POST /positions (directly, or via the edge gateway /
 * simulator). `ingestPosition` is exported so an MQTT subscriber can call the
 * same path once the collar firmware lands (Phase 9.4).
 */
import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { raiseException } from '../exceptions.js';
import { evaluate, isEscape, type Zone } from '../logic/geofence.js';

const router = Router();
const T = ['breeder: geofencing'];
const idParam = z.object({ id: z.string() });
const KINDS = ['boundary', 'exclusion'];

// ── Safe-zone CRUD ─────────────────────────────────────────────────────────
router.get(
  '/zones',
  apiRoute({
    method: 'get', path: '/api/breeder/geo/zones', tags: T, secure: true,
    summary: 'Safe zones for the kennel.',
    responses: { 200: { description: 'ok', schema: z.object({ zones: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
    const rows = await query(
      `SELECT z.*, a.name AS animal_name
         FROM safe_zones z LEFT JOIN animals a ON a.id = z.animal_id
        WHERE z.kennel_id = $1 ORDER BY z.created_at`,
      [req.kennelId],
    );
    res.json({ zones: rows });
  }),
);

router.post(
  '/zones',
  apiRoute({
    method: 'post', path: '/api/breeder/geo/zones', tags: T, secure: true,
    summary: 'Create a safe zone (boundary or exclusion circle).',
    request: {
      body: z.object({
        name: z.string().min(1),
        centerLat: z.coerce.number(),
        centerLng: z.coerce.number(),
        kind: z.enum(['boundary', 'exclusion']).optional(),
        radiusM: z.coerce.number().optional(),
        animalId: z.string().nullable().optional(),
      }),
    },
    responses: { 201: { description: 'created' } },
  }),
  ah(async (req, res) => {
  const b = req.body;
  const kind = KINDS.includes(b.kind) ? b.kind : 'boundary';
  const radius = Math.max(10, Math.floor(Number(b.radiusM) || 100));
  const row = await queryOne(
    `INSERT INTO safe_zones (kennel_id, animal_id, name, kind, center_lat, center_lng, radius_m, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.kennelId, b.animalId ?? null, b.name, kind, Number(b.centerLat), Number(b.centerLng), radius, req.user?.id ?? null],
  );
  res.status(201).json({ zone: row });
}));

router.patch(
  '/zones/:id',
  apiRoute({
    method: 'patch', path: '/api/breeder/geo/zones/{id}', tags: T, secure: true,
    summary: 'Update a safe zone (partial).',
    request: {
      params: idParam,
      body: z.object({
        name: z.string().optional(),
        kind: z.enum(['boundary', 'exclusion']).optional(),
        radiusM: z.coerce.number().optional(),
        centerLat: z.coerce.number().optional(),
        centerLng: z.coerce.number().optional(),
        active: z.coerce.boolean().optional(),
      }),
    },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
  const b = req.body ?? {};
  const sets: string[] = [];
  const params: unknown[] = [String(req.params.id), req.kennelId];
  for (const [key, col, cast] of [
    ['name', 'name', String], ['kind', 'kind', String], ['radiusM', 'radius_m', Number],
    ['centerLat', 'center_lat', Number], ['centerLng', 'center_lng', Number], ['active', 'active', Boolean],
  ] as const) {
    if (b[key] !== undefined) { params.push(cast(b[key])); sets.push(`${col} = $${params.length}`); }
  }
  if (!sets.length) return bad(res, 'nothing to update');
  const row = await queryOne(
    `UPDATE safe_zones SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1 AND kennel_id = $2 RETURNING *`, params,
  );
  if (!row) return bad(res, 'zone not found', 404);
  res.json({ zone: row });
}),
);

router.delete(
  '/zones/:id',
  apiRoute({
    method: 'delete', path: '/api/breeder/geo/zones/{id}', tags: T, secure: true,
    summary: 'Delete a safe zone.',
    request: { params: idParam },
    responses: { 200: { description: 'ok' } },
  }),
  ah(async (req, res) => {
  await execute(`DELETE FROM safe_zones WHERE id = $1 AND kennel_id = $2`, [String(req.params.id), req.kennelId]);
  res.json({ ok: true });
}),
);

// ── Position ingest + detection ────────────────────────────────────────────
export interface Fix { animalId?: string; deviceId?: string; lat: number; lng: number; at?: string }

export async function ingestPosition(kennelId: string, fix: Fix): Promise<{
  animalId: string; insideZoneIds: string[]; entered: string[]; exited: string[]; alerts: number;
}> {
  const animal = fix.animalId
    ? await queryOne<{ id: string }>(`SELECT id FROM animals WHERE id = $1 AND kennel_id = $2`, [fix.animalId, kennelId])
    : await queryOne<{ id: string }>(`SELECT id FROM animals WHERE collar_device_id = $1 AND kennel_id = $2`, [fix.deviceId, kennelId]);
  if (!animal) throw new Error('no animal for this fix (unknown animalId / collar deviceId)');

  const at = fix.at ? new Date(fix.at) : new Date();
  await execute(
    `UPDATE animals SET last_lat = $2, last_lng = $3, last_fix_at = $4, updated_at = NOW() WHERE id = $1`,
    [animal.id, fix.lat, fix.lng, at],
  );

  const zones = await query<Zone>(
    `SELECT id, kind, center_lat, center_lng, radius_m FROM safe_zones
      WHERE kennel_id = $1 AND active AND (animal_id IS NULL OR animal_id = $2)`,
    [kennelId, animal.id],
  );
  const prevRows = await query<{ zone_id: string }>(
    `SELECT zone_id FROM geofence_state WHERE animal_id = $1 AND inside = true`, [animal.id],
  );
  const prevInside = new Set(prevRows.map((r) => r.zone_id));

  const { insideIds, entered, exited } = evaluate({ lat: fix.lat, lng: fix.lng }, zones, prevInside);

  for (const z of [...entered, ...exited]) {
    const inside = entered.includes(z);
    await execute(
      `INSERT INTO geofence_state (animal_id, zone_id, inside, since, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW())
       ON CONFLICT (animal_id, zone_id) DO UPDATE SET inside = EXCLUDED.inside, since = NOW(), updated_at = NOW()`,
      [animal.id, z.id, inside],
    );
  }

  let alerts = 0;
  for (const z of entered) {
    if (isEscape(z, 'enter')) { await escapeAlert(kennelId, animal.id, z, 'entered an exclusion zone'); alerts++; }
  }
  for (const z of exited) {
    if (isEscape(z, 'exit')) { await escapeAlert(kennelId, animal.id, z, 'left its boundary'); alerts++; }
  }
  // Back inside a boundary zone → clear a standing escape alert.
  if (entered.some((z) => z.kind === 'boundary')) {
    await execute(
      `UPDATE exceptions SET status = 'resolved', resolved_at = NOW(),
              resolution_note = 'Dog returned to a safe zone', updated_at = NOW()
        WHERE kennel_id = $1 AND dedup_key = $2 AND status IN ('open','snoozed','escalated')`,
      [kennelId, `geofence-escape:${animal.id}`],
    );
  }

  return {
    animalId: animal.id, insideZoneIds: insideIds,
    entered: entered.map((z) => z.id), exited: exited.map((z) => z.id), alerts,
  };
}

async function escapeAlert(kennelId: string, animalId: string, zone: Zone, what: string): Promise<void> {
  const a = await queryOne<{ name: string }>(`SELECT name FROM animals WHERE id = $1`, [animalId]);
  await raiseException({
    kennelId, kind: 'geofence-escape', severity: 'critical', animalId,
    title: `${a?.name ?? 'A dog'} ${what}`,
    detail: `Last fix is outside "${zone.id}". Check the collar map.`,
    suggestedAction: 'Locate the dog and check the fence or gate',
    dedupKey: `geofence-escape:${animalId}`,
    notifyAudience: 'on-call',
  });
}

router.post(
  '/positions',
  apiRoute({
    method: 'post', path: '/api/breeder/geo/positions', tags: T, secure: true,
    summary: 'Ingest a GPS fix (enter/exit detection + escape alerts).',
    request: {
      body: z.object({
        lat: z.coerce.number(),
        lng: z.coerce.number(),
        animalId: z.string().optional(),
        deviceId: z.string().optional(),
        at: z.string().optional(),
      }),
    },
    responses: { 201: { description: 'ingested' }, 404: { description: 'no animal for this fix' } },
  }),
  ah(async (req, res) => {
  if (!req.body.animalId && !req.body.deviceId) return bad(res, 'pass animalId or deviceId');
  try {
    const out = await ingestPosition(req.kennelId!, {
      animalId: req.body.animalId, deviceId: req.body.deviceId,
      lat: Number(req.body.lat), lng: Number(req.body.lng), at: req.body.at,
    });
    res.status(201).json(out);
  } catch (e) {
    return bad(res, (e as Error).message, 404);
  }
}),
);

router.get(
  '/positions/latest',
  apiRoute({
    method: 'get', path: '/api/breeder/geo/positions/latest', tags: T, secure: true,
    summary: 'Latest fix + inside-zone list per collared animal.',
    responses: { 200: { description: 'ok', schema: z.object({ positions: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const rows = await query(
    `SELECT a.id AS animal_id, a.name, a.collar_device_id, a.last_lat, a.last_lng, a.last_fix_at,
            COALESCE(
              (SELECT array_agg(gs.zone_id) FROM geofence_state gs
                WHERE gs.animal_id = a.id AND gs.inside = true), '{}') AS inside_zone_ids
       FROM animals a
      WHERE a.kennel_id = $1 AND a.collar_device_id IS NOT NULL
      ORDER BY a.name`,
    [req.kennelId],
  );
  res.json({ positions: rows });
}),
);

export default router;
