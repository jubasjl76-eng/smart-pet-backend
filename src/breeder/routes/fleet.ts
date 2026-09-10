/**
 * Fleet & firmware — publish a build, run a staged rollout, see reported vs
 * target version per device. Mounted at /api/breeder/fleet, behind the guard.
 *
 * The plan calls this `POST /api/fleet/firmware`; it lives under `/api/breeder`
 * with every other tenant route so it shares the auth + kennel guard.
 */
import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import { publishCommand, publishFleetControl } from '../../services/feederMqtt.js';
import { logAccess } from '../accessLog.js';
import { deviceTarget, deviceFwStatus, type Rollout } from '../logic/rollout.js';

const router = Router();
const T = ['breeder: fleet'];
const OTA_PER_TICK = 10; // ponytail: flat cap; make it per-kennel if a fleet gets big

// ── Firmware registry ──────────────────────────────────────────────────────
router.post(
  '/firmware',
  apiRoute({
    method: 'post', path: '/api/breeder/fleet/firmware', tags: T, secure: true,
    summary: 'Register a firmware build.',
    request: {
      body: z.object({
        deviceType: z.string().min(1),
        version: z.string().min(1),
        url: z.string().min(1),
        sha256: z.string().min(1),
        channel: z.string().optional(),
        signature: z.string().nullable().optional(),
        signingKeyId: z.string().max(128).nullable().optional(),
        provenance: z.record(z.string(), z.unknown()).nullable().optional(),
        sizeBytes: z.coerce.number().nullable().optional(),
        minVersion: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    },
    responses: { 201: { description: 'created' }, 409: { description: 'already exists' } },
  }),
  ah(async (req, res) => {
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO firmware (device_type, version, channel, url, sha256, signature, signing_key_id, provenance, size_bytes, min_version, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
     ON CONFLICT (device_type, version) DO NOTHING
     RETURNING *`,
    [
      b.deviceType, b.version, b.channel || 'stable', b.url, b.sha256,
      b.signature ?? null, b.signingKeyId ?? null, b.provenance ? JSON.stringify(b.provenance) : null,
      b.sizeBytes ?? null, b.minVersion ?? null, b.notes ?? null,
      req.user?.id ?? null,
    ],
  );
  if (!row) return bad(res, `firmware ${b.deviceType} ${b.version} already exists`, 409);
  res.status(201).json({ firmware: row });
}),
);

router.get(
  '/firmware',
  apiRoute({
    method: 'get', path: '/api/breeder/fleet/firmware', tags: T, secure: true,
    summary: 'List firmware builds (optionally by deviceType).',
    request: { query: z.object({ deviceType: z.string().optional() }) },
    responses: { 200: { description: 'ok', schema: z.object({ firmware: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const params: unknown[] = [];
  let where = '';
  if (req.query.deviceType) { params.push(req.query.deviceType); where = 'WHERE device_type = $1'; }
  const rows = await query(
    `SELECT * FROM firmware ${where} ORDER BY device_type, created_at DESC`, params,
  );
  res.json({ firmware: rows });
}),
);

// ── Rollouts ───────────────────────────────────────────────────────────────
router.get(
  '/rollouts',
  apiRoute({
    method: 'get', path: '/api/breeder/fleet/rollouts', tags: T, secure: true,
    summary: 'Recent firmware rollouts (live first).',
    responses: { 200: { description: 'ok', schema: z.object({ rollouts: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (_req, res) => {
  const rows = await query(
    `SELECT r.*, f.version, f.device_type AS fw_device_type
       FROM firmware_rollouts r JOIN firmware f ON f.id = r.firmware_id
      ORDER BY (r.state <> 'done') DESC, r.updated_at DESC LIMIT 50`,
  );
  res.json({ rollouts: rows });
}),
);

/** Start (or replace) the live rollout for a device type. Starts at canary 5%. */
router.post(
  '/rollouts',
  apiRoute({
    method: 'post', path: '/api/breeder/fleet/rollouts', tags: T, secure: true,
    summary: 'Start (or replace) the live rollout for a device type.',
    request: { body: z.object({ firmwareId: z.string().min(1), percent: z.coerce.number().optional() }) },
    responses: { 201: { description: 'created' }, 404: { description: 'firmware not found' } },
  }),
  ah(async (req, res) => {
  const fw = await queryOne<{ id: string; device_type: string; version: string }>(
    `SELECT id, device_type, version FROM firmware WHERE id = $1`, [req.body.firmwareId],
  );
  if (!fw) return bad(res, 'firmware not found', 404);
  const percent = clampPercent(req.body.percent ?? 5);

  // Close any live rollout for this device type, then open the new one.
  await execute(
    `UPDATE firmware_rollouts SET state = 'done', updated_at = NOW()
      WHERE device_type = $1 AND state <> 'done'`, [fw.device_type],
  );
  const row = await queryOne(
    `INSERT INTO firmware_rollouts (firmware_id, device_type, state, percent, updated_by)
     VALUES ($1,$2,'rolling',$3,$4) RETURNING *`,
    [fw.id, fw.device_type, percent, req.user?.id ?? null],
  );
  await logAccess(req, 'fleet.rollout.start', {
    subjectType: 'device_type', subjectId: fw.device_type,
    detail: { version: fw.version, percent },
  });
  res.status(201).json({ rollout: row });
}),
);

/** Advance / pause / finish. Body { state?, percent? }. Percent only grows. */
router.patch(
  '/rollouts/:id',
  apiRoute({
    method: 'patch', path: '/api/breeder/fleet/rollouts/{id}', tags: T, secure: true,
    summary: 'Advance / pause / finish a rollout (percent only grows).',
    request: {
      params: z.object({ id: z.string() }),
      body: z.object({
        state: z.enum(['rolling', 'paused', 'done']).optional(),
        percent: z.coerce.number().optional(),
      }),
    },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
  const cur = await queryOne<{ id: string; state: string; percent: number; device_type: string }>(
    `SELECT id, state, percent, device_type FROM firmware_rollouts WHERE id = $1`, [req.params.id],
  );
  if (!cur) return bad(res, 'rollout not found', 404);

  const state = req.body?.state ?? cur.state;
  if (!['rolling', 'paused', 'done'].includes(state)) return bad(res, 'bad state');
  let percent = cur.percent;
  if (req.body?.percent != null) {
    percent = clampPercent(req.body.percent);
    if (percent < cur.percent) return bad(res, 'percent can only increase (roll forward, not back)');
  }
  if (state === 'done') percent = 100;

  const row = await queryOne(
    `UPDATE firmware_rollouts SET state = $2, percent = $3, updated_at = NOW(), updated_by = $4
      WHERE id = $1 RETURNING *`,
    [cur.id, state, percent, req.user?.id ?? null],
  );
  await logAccess(req, 'fleet.rollout.update', {
    subjectType: 'device_type', subjectId: cur.device_type, detail: { state, percent },
  });
  res.json({ rollout: row });
}),
);

// ── Fleet view ─────────────────────────────────────────────────────────────
router.get(
  '/devices',
  apiRoute({
    method: 'get', path: '/api/breeder/fleet/devices', tags: T, secure: true,
    summary: 'Fleet view — reported vs target firmware per device.',
    responses: { 200: { description: 'ok', schema: z.object({ devices: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  const devices = await query<{
    device_id: string; device_type: string; name: string | null;
    is_online: boolean; last_seen: string | null; fw_version: string | null; fw_updated_at: string | null;
  }>(
    `SELECT device_id, device_type, name, is_online, last_seen, fw_version, fw_updated_at
       FROM devices WHERE kennel_id = $1 ORDER BY device_type, name`,
    [req.kennelId],
  );
  const live = await liveRolloutsByType();

  res.json({
    devices: devices.map((d) => {
      const r = live.get(d.device_type);
      const target = r ? deviceTarget(r.rollout, r.version, d.device_id) : null;
      return {
        deviceId: d.device_id, deviceType: d.device_type, name: d.name,
        isOnline: d.is_online, lastSeen: d.last_seen,
        fwVersion: d.fw_version, fwUpdatedAt: d.fw_updated_at,
        target, fwStatus: deviceFwStatus(d.fw_version, target),
      };
    }),
  });
}),
);

/** Push the OTA offer to one device now (canary / manual retry). */
router.post(
  '/devices/:deviceId/ota',
  apiRoute({
    method: 'post', path: '/api/breeder/fleet/devices/{deviceId}/ota', tags: T, secure: true,
    summary: 'Push the OTA offer to one device now.',
    request: {
      params: z.object({ deviceId: z.string() }),
      body: z.object({ firmwareId: z.string().optional() }),
    },
    responses: { 200: { description: 'ok' }, 404: { description: 'device not found' }, 502: { description: 'broker error' } },
  }),
  ah(async (req, res) => {
  const deviceId = String(req.params.deviceId);
  const dev = await queryOne<{ device_type: string }>(
    `SELECT device_type FROM devices WHERE device_id = $1 AND kennel_id = $2`, [deviceId, req.kennelId],
  );
  if (!dev) return bad(res, 'device not found', 404);
  const fw = await pickFirmware(req.body?.firmwareId, dev.device_type);
  if (!fw) return bad(res, 'no firmware to send (pass firmwareId, or start a rollout first)', 400);

  try {
    await sendOta(req.kennelId!, deviceId, dev.device_type, fw);
  } catch (e) {
    return res.status(502).json({ ok: false, error: (e as Error).message });
  }
  await logAccess(req, 'fleet.ota.push', { subjectType: 'device', subjectId: deviceId, detail: { version: fw.version } });
  res.json({ ok: true, sent: { version: fw.version } });
}),
);

// ── Engine sweep: nudge in-bucket online devices onto the rollout target ────
export async function fleetSweep(): Promise<{ pushed: number }> {
  const live = await liveRolloutsByType();
  if (live.size === 0) return { pushed: 0 };

  let pushed = 0;
  for (const [deviceType, r] of live) {
    const candidates = await query<{ device_id: string; kennel_id: string; fw_version: string | null }>(
      `SELECT device_id, kennel_id, fw_version FROM devices
        WHERE device_type = $1 AND is_online = true`,
      [deviceType],
    );
    for (const d of candidates) {
      if (pushed >= OTA_PER_TICK) return { pushed };
      const target = deviceTarget(r.rollout, r.version, d.device_id);
      if (!target || d.fw_version === target) continue;
      try {
        await sendOta(d.kennel_id, d.device_id, deviceType, r.fw);
        pushed++;
      } catch {
        // broker down or device unreachable — next tick retries
      }
    }
  }
  return { pushed };
}

router.post(
  '/sweep',
  apiRoute({
    method: 'post', path: '/api/breeder/fleet/sweep', tags: T, secure: true,
    summary: 'Nudge in-bucket online devices onto the rollout target.',
    responses: { 200: { description: 'ok', schema: z.object({ pushed: z.number() }) } },
  }),
  ah(async (_req, res) => {
  res.json(await fleetSweep());
}),
);

// ── Kill switch (Phase 19, A12 #17) ────────────────────────────────────────
const controlShape = z.object({
  safeMode: z.boolean(),
  reason: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

router.get(
  '/control',
  apiRoute({
    method: 'get', path: '/api/breeder/fleet/control', tags: T, secure: true,
    summary: 'Current fleet kill-switch state for the kennel.',
    responses: { 200: { description: 'ok', schema: controlShape } },
  }),
  ah(async (req, res) => {
    const row = await queryOne<{ safe_mode: boolean; reason: string | null; updated_at: string }>(
      `SELECT safe_mode, reason, updated_at FROM fleet_control WHERE kennel_id = $1`,
      [req.kennelId],
    );
    res.json({
      safeMode: row?.safe_mode ?? false,
      reason: row?.reason ?? null,
      updatedAt: row?.updated_at ?? null,
    });
  }),
);

async function setSafeMode(kennelId: string, userId: string | null, safeMode: boolean, reason: string | null) {
  await execute(
    `INSERT INTO fleet_control (kennel_id, safe_mode, reason, set_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (kennel_id) DO UPDATE
       SET safe_mode = EXCLUDED.safe_mode, reason = EXCLUDED.reason,
           set_by = EXCLUDED.set_by, updated_at = NOW()`,
    [kennelId, safeMode, reason, userId],
  );
  // DB is the source of truth; the broker re-syncs on connect if this fails now.
  let broker = true;
  try {
    await publishFleetControl(kennelId, {
      safeMode,
      reason: reason ?? undefined,
      at: new Date().toISOString(),
      by: userId ?? undefined,
    });
  } catch {
    broker = false;
  }
  return broker;
}

router.post(
  '/halt',
  apiRoute({
    method: 'post', path: '/api/breeder/fleet/halt', tags: T, secure: true,
    summary: 'Halt the whole kennel: devices stop actuating, keep reporting.',
    request: { body: z.object({ reason: z.string().max(280).optional() }) },
    responses: { 200: { description: 'ok', schema: z.object({ safeMode: z.boolean(), brokerPublished: z.boolean() }) } },
  }),
  ah(async (req, res) => {
    const reason = (req.body?.reason ?? '').toString().trim() || null;
    const broker = await setSafeMode(req.kennelId!, req.user?.id ?? null, true, reason);
    await logAccess(req, 'fleet.halt', { detail: { reason } });
    res.json({ safeMode: true, brokerPublished: broker });
  }),
);

router.post(
  '/resume',
  apiRoute({
    method: 'post', path: '/api/breeder/fleet/resume', tags: T, secure: true,
    summary: 'Lift the kennel halt — devices resume normal operation.',
    responses: { 200: { description: 'ok', schema: z.object({ safeMode: z.boolean(), brokerPublished: z.boolean() }) } },
  }),
  ah(async (req, res) => {
    const broker = await setSafeMode(req.kennelId!, req.user?.id ?? null, false, null);
    await logAccess(req, 'fleet.resume', {});
    res.json({ safeMode: false, brokerPublished: broker });
  }),
);

// ── helpers ────────────────────────────────────────────────────────────────
function clampPercent(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return 5;
  return Math.min(100, Math.max(1, v));
}

interface FwRow { id: string; device_type: string; version: string; url: string; sha256: string; signature: string | null; signing_key_id: string | null }

async function pickFirmware(firmwareId: string | undefined, deviceType: string): Promise<FwRow | null> {
  if (firmwareId) {
    return queryOne<FwRow>(`SELECT id, device_type, version, url, sha256, signature, signing_key_id FROM firmware WHERE id = $1`, [firmwareId]);
  }
  const live = await liveRolloutsByType();
  return live.get(deviceType)?.fw ?? null;
}

async function sendOta(kennelId: string, deviceId: string, deviceType: string, fw: FwRow): Promise<void> {
  await publishCommand(
    kennelId, deviceId,
    {
      command: 'ota', deviceId, kennelId, timestamp: Date.now(),
      params: {
        url: fw.url, version: fw.version, sha256: fw.sha256,
        signature: fw.signature, signingKeyId: fw.signing_key_id,
      },
    },
    deviceType,
  );
}

async function liveRolloutsByType(): Promise<Map<string, { rollout: Rollout; version: string; fw: FwRow }>> {
  const rows = await query<{
    state: 'rolling' | 'paused' | 'done'; percent: number;
    id: string; device_type: string; version: string; url: string; sha256: string;
    signature: string | null; signing_key_id: string | null;
  }>(
    `SELECT r.state, r.percent,
            f.id, f.device_type, f.version, f.url, f.sha256, f.signature, f.signing_key_id
       FROM firmware_rollouts r JOIN firmware f ON f.id = r.firmware_id
      WHERE r.state <> 'done'`,
  );
  const m = new Map<string, { rollout: Rollout; version: string; fw: FwRow }>();
  for (const r of rows) {
    m.set(r.device_type, {
      rollout: { state: r.state, percent: r.percent },
      version: r.version,
      fw: {
        id: r.id, device_type: r.device_type, version: r.version, url: r.url,
        sha256: r.sha256, signature: r.signature, signing_key_id: r.signing_key_id,
      },
    });
  }
  return m;
}

export default router;
