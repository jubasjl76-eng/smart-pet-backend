/**
 * Device pairing + claiming for the breeder platform.
 *
 * Flow: a staff member generates a short pairing code for a device type/pen.
 * They enter it into the device's setup portal (or the claim screen). The device
 * (or the screen) then claims itself against the code — which binds it to the
 * kennel, mints its MQTT credentials once, and refreshes the broker ACL.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query, queryOne, execute } from '../database/index.js';
import { syncAclFile } from '../mqtt/acl.js';
import { mqttPublicUrl } from '../config/index.js';

export const DEVICE_TYPES = ['feeder', 'water', 'door', 'sensor', 'gps', 'scale', 'hub'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

const PREFIX: Record<DeviceType, string> = {
  feeder: 'FEED', water: 'WATR', door: 'DOOR', sensor: 'SENS', gps: 'GPS', scale: 'SCAL', hub: 'HUB',
};

// unambiguous alphabet (no 0/O/1/I)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makePairingCode(deviceType: DeviceType): string {
  let body = '';
  const bytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) body += ALPHABET[bytes[i] % ALPHABET.length];
  return `${PREFIX[deviceType]}-${body}`;
}

const PAIRING_TTL_MIN = parseInt(process.env.PAIRING_TTL_MIN || '60', 10);

export interface CreatePairingInput {
  kennelId: string;
  deviceType: DeviceType;
  suggestedName?: string;
  penId?: string | null;
  createdBy: string | null;
}

export async function createPairing(input: CreatePairingInput): Promise<{ code: string; expiresAt: Date }> {
  if (!(DEVICE_TYPES as readonly string[]).includes(input.deviceType)) {
    throw new Error(`Unknown device type: ${input.deviceType}`);
  }
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MIN * 60_000);
  // retry on the (astronomically unlikely) code collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makePairingCode(input.deviceType);
    try {
      await execute(
        `INSERT INTO device_pairings (code, kennel_id, device_type, suggested_name, pen_id, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [code, input.kennelId, input.deviceType, input.suggestedName ?? null, input.penId ?? null, input.createdBy, expiresAt]
      );
      return { code, expiresAt };
    } catch (e) {
      if (attempt === 4) throw e;
    }
  }
  throw new Error('Could not allocate a pairing code');
}

export async function listOpenPairings(kennelId: string): Promise<unknown[]> {
  return query(
    `SELECT code, device_type, suggested_name, pen_id, expires_at, created_at
       FROM device_pairings
      WHERE kennel_id = $1 AND claimed_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC`,
    [kennelId]
  );
}

export async function cancelPairing(code: string, kennelId: string): Promise<boolean> {
  const rows = await query<{ code: string }>(
    `DELETE FROM device_pairings WHERE code = $1 AND kennel_id = $2 AND claimed_at IS NULL RETURNING code`,
    [code, kennelId]
  );
  return rows.length > 0;
}

export interface ClaimInput {
  code: string;
  deviceId: string;
  kennelId: string;         // from the caller's context; must match the pairing
  name?: string;
  claimedBy: string | null;
}

export interface ClaimResult {
  device: Record<string, unknown>;
  mqtt: {
    username: string;
    password: string;       // shown once
    host: string | null;
    topics: { command: string; status: string };
  };
}

export async function claimByPairing(input: ClaimInput): Promise<ClaimResult> {
  const code = input.code.trim().toUpperCase();
  const deviceId = input.deviceId.trim();
  if (!deviceId) throw new Error('deviceId is required');

  const pairing = await queryOne<{
    kennel_id: string; device_type: DeviceType; suggested_name: string | null;
    pen_id: string | null; claimed_at: string | null; expires_at: string;
  }>(`SELECT kennel_id, device_type, suggested_name, pen_id, claimed_at, expires_at
        FROM device_pairings WHERE code = $1`, [code]);

  if (!pairing) throw new Error('Unknown pairing code');
  if (pairing.claimed_at) throw new Error('Pairing code already used');
  if (new Date(pairing.expires_at).getTime() < Date.now()) throw new Error('Pairing code expired');
  if (pairing.kennel_id !== input.kennelId) throw new Error('Pairing code belongs to another kennel');

  const existing = await queryOne<{ id: string; user_id: string | null }>(
    `SELECT id, user_id FROM devices WHERE device_id = $1`, [deviceId]
  );
  const name = input.name || pairing.suggested_name || `${pairing.device_type} ${deviceId}`;

  let id: string;
  if (!existing) {
    const rows = await query<{ id: string }>(
      `INSERT INTO devices (device_id, device_type, name, kennel_id, pen_id, status, is_online, claimed_by, claimed_at)
       VALUES ($1, $2, $3, $4, $5, 'offline', false, $6, NOW()) RETURNING id`,
      [deviceId, pairing.device_type, name, pairing.kennel_id, pairing.pen_id, input.claimedBy]
    );
    id = rows[0].id;
  } else {
    id = existing.id;
    await execute(
      `UPDATE devices SET device_type = $2, name = $3, kennel_id = $4, pen_id = COALESCE($5, pen_id),
              claimed_by = $6, claimed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [id, pairing.device_type, name, pairing.kennel_id, pairing.pen_id, input.claimedBy]
    );
  }

  const secret = crypto.randomBytes(24).toString('base64url');
  const mqttUsername = `device:${deviceId}`;
  await execute(
    `UPDATE devices SET mqtt_username = $2, mqtt_password_hash = $3, claim_code = $4, updated_at = NOW() WHERE id = $1`,
    [id, mqttUsername, await bcrypt.hash(secret, 10), code]
  );
  // nosemgrep: breeder-query-must-be-kennel-scoped — device-side claim; the pairing `code` is a kennel-scoped one-time secret, no req context here
  await execute(
    `UPDATE device_pairings SET claimed_at = NOW(), claimed_device_id = $2 WHERE code = $1`,
    [code, deviceId]
  );

  await syncAclFile().catch((e) => console.warn('[devices] ACL sync failed', e.message));

  const device = await queryOne<Record<string, unknown>>(`SELECT * FROM devices WHERE id = $1`, [id]);
  return {
    device: device!,
    mqtt: {
      username: mqttUsername,
      password: secret,
      host: mqttPublicUrl(),
      topics: {
        command: `kennel/${pairing.kennel_id}/${pairing.device_type}/${deviceId}/command`,
        status: `kennel/${pairing.kennel_id}/${pairing.device_type}/${deviceId}/status`,
      },
    },
  };
}

export async function listDevices(kennelId: string): Promise<unknown[]> {
  return query(
    `SELECT d.id, d.device_id, d.device_type, d.name, d.kennel_id, d.pen_id, p.name AS pen_name,
            d.status, d.is_online, d.last_seen, d.claimed_at, d.mqtt_username IS NOT NULL AS provisioned
       FROM devices d
       LEFT JOIN pens p ON p.id = d.pen_id
      WHERE d.kennel_id = $1
      ORDER BY d.device_type, d.name`,
    [kennelId]
  );
}
