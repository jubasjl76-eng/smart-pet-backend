/**
 * Fleet & firmware — publish a build, run a staged rollout, see reported vs
 * target version per device. Mounted at /api/breeder/fleet, behind the guard.
 *
 * The plan calls this `POST /api/fleet/firmware`; it lives under `/api/breeder`
 * with every other tenant route so it shares the auth + kennel guard.
 */
import { Router } from 'express';
import { query, queryOne, execute } from '../../database/index.js';
import { ah, bad, need } from '../http.js';
import { publishCommand } from '../../services/feederMqtt.js';
import { logAccess } from '../accessLog.js';
import { deviceTarget, deviceFwStatus, type Rollout } from '../logic/rollout.js';

const router = Router();
const OTA_PER_TICK = 10; // ponytail: flat cap; make it per-kennel if a fleet gets big

// ── Firmware registry ──────────────────────────────────────────────────────
router.post('/firmware', ah(async (req, res) => {
  const err = need(req.body ?? {}, ['deviceType', 'version', 'url', 'sha256']);
  if (err) return bad(res, err);
  const b = req.body;
  const row = await queryOne(
    `INSERT INTO firmware (device_type, version, channel, url, sha256, signature, size_bytes, min_version, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (device_type, version) DO NOTHING
     RETURNING *`,
    [
      b.deviceType, b.version, b.channel || 'stable', b.url, b.sha256,
      b.signature ?? null, b.sizeBytes ?? null, b.minVersion ?? null, b.notes ?? null,
      req.user?.id ?? null,
    ],
  );
  if (!row) return bad(res, `firmware ${b.deviceType} ${b.version} already exists`, 409);
  res.status(201).json({ firmware: row });
}));

router.get('/firmware', ah(async (req, res) => {
  const params: unknown[] = [];
  let where = '';
  if (req.query.deviceType) { params.push(req.query.deviceType); where = 'WHERE device_type = $1'; }
  const rows = await query(
    `SELECT * FROM firmware ${where} ORDER BY device_type, created_at DESC`, params,
  );
  res.json({ firmware: rows });
}));

// ── Rollouts ───────────────────────────────────────────────────────────────
router.get('/rollouts', ah(async (_req, res) => {
  const rows = await query(
    `SELECT r.*, f.version, f.device_type AS fw_device_type
       FROM firmware_rollouts r JOIN firmware f ON f.id = r.firmware_id
      ORDER BY (r.state <> 'done') DESC, r.updated_at DESC LIMIT 50`,
  );
  res.json({ rollouts: rows });
}));

/** Start (or replace) the live rollout for a device type. Starts at canary 5%. */
router.post('/rollouts', ah(async (req, res) => {
  const err = need(req.body ?? {}, ['firmwareId']);
  if (err) return bad(res, err);
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
}));

/** Advance / pause / finish. Body { state?, percent? }. Percent only grows. */
router.patch('/rollouts/:id', ah(async (req, res) => {
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
}));

// ── Fleet view ─────────────────────────────────────────────────────────────
router.get('/devices', ah(async (req, res) => {
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
}));

/** Push the OTA offer to one device now (canary / manual retry). */
router.post('/devices/:deviceId/ota', ah(async (req, res) => {
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
}));

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

router.post('/sweep', ah(async (_req, res) => {
  res.json(await fleetSweep());
}));

// ── helpers ────────────────────────────────────────────────────────────────
function clampPercent(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return 5;
  return Math.min(100, Math.max(1, v));
}

interface FwRow { id: string; device_type: string; version: string; url: string; sha256: string; signature: string | null }

async function pickFirmware(firmwareId: string | undefined, deviceType: string): Promise<FwRow | null> {
  if (firmwareId) {
    return queryOne<FwRow>(`SELECT id, device_type, version, url, sha256, signature FROM firmware WHERE id = $1`, [firmwareId]);
  }
  const live = await liveRolloutsByType();
  return live.get(deviceType)?.fw ?? null;
}

async function sendOta(kennelId: string, deviceId: string, deviceType: string, fw: FwRow): Promise<void> {
  await publishCommand(
    kennelId, deviceId,
    {
      command: 'ota', deviceId, kennelId, timestamp: Date.now(),
      params: { url: fw.url, version: fw.version, sha256: fw.sha256, signature: fw.signature },
    },
    deviceType,
  );
}

async function liveRolloutsByType(): Promise<Map<string, { rollout: Rollout; version: string; fw: FwRow }>> {
  const rows = await query<{
    state: 'rolling' | 'paused' | 'done'; percent: number;
    id: string; device_type: string; version: string; url: string; sha256: string; signature: string | null;
  }>(
    `SELECT r.state, r.percent,
            f.id, f.device_type, f.version, f.url, f.sha256, f.signature
       FROM firmware_rollouts r JOIN firmware f ON f.id = r.firmware_id
      WHERE r.state <> 'done'`,
  );
  const m = new Map<string, { rollout: Rollout; version: string; fw: FwRow }>();
  for (const r of rows) {
    m.set(r.device_type, {
      rollout: { state: r.state, percent: r.percent },
      version: r.version,
      fw: { id: r.id, device_type: r.device_type, version: r.version, url: r.url, sha256: r.sha256, signature: r.signature },
    });
  }
  return m;
}

export default router;
