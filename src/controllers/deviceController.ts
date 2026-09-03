import { Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../database/index.js';
import { AuthRequest } from '../middleware/auth.js';
import { isFoodLow, publishFeedAndWait } from '../services/feederMqtt.js';

function mapDevice(row: any) {
  if (!row) return null;
  const status = row.status || (row.is_online ? 'online' : 'offline');
  const foodLevel = row.food_level ?? row.latest_value ?? null;
  return {
    id: row.id,
    _id: row.id,
    deviceId: row.device_id,
    device_id: row.device_id,
    name: row.name,
    type: row.device_type,
    device_type: row.device_type,
    kennelId: row.kennel_id,
    status,
    isOnline: status === 'online',
    is_online: status === 'online',
    foodLevel,
    food_level: foodLevel,
    lastFeed: row.last_feed,
    lastSeen: row.last_seen,
    isFoodLow: isFoodLow(foodLevel),
  };
}

export const getAllDevices = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await query<any>(
      `SELECT * FROM devices WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.id]
    );
    res.json({ devices: rows.map(mapDevice) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
};

export const getDeviceById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await queryOne<any>(
      `SELECT * FROM devices WHERE user_id = $1 AND (id::text = $2 OR device_id = $2)`,
      [req.user!.id, req.params.id]
    );
    if (!row) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    res.json({ device: mapDevice(row) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch device' });
  }
};

export const createDevice = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, type, kennelId } = req.body;
    const deviceId = `${type || 'feeder'}-${crypto.randomBytes(3).toString('hex')}`;
    const rows = await query<any>(
      `INSERT INTO devices (user_id, device_id, device_type, name, kennel_id, status, is_online)
       VALUES ($1, $2, $3, $4, $5, 'offline', false) RETURNING *`,
      [req.user!.id, deviceId, type || 'feeder', name, kennelId || req.user!.id]
    );
    res.status(201).json({ device: mapDevice(rows[0]) });
  } catch {
    res.status(500).json({ error: 'Failed to create device' });
  }
};

export const claimDevice = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const code = String(req.body.code || req.body.deviceId || '').trim();
    const name = req.body.name || 'Feeder';
    if (!code) {
      res.status(400).json({ error: 'code is required' });
      return;
    }
    let row = await queryOne<any>(
      `SELECT * FROM devices WHERE claim_code = $1 OR device_id = $1`,
      [code]
    );
    const kennelId = String(req.body.kennelId || req.user!.id);
    if (!row) {
      const inserted = await query<any>(
        `INSERT INTO devices (user_id, device_id, device_type, name, kennel_id, claim_code, status, is_online)
         VALUES ($1, $2, 'feeder', $3, $4, $2, 'offline', false) RETURNING *`,
        [req.user!.id, code, name, kennelId]
      );
      row = inserted[0];
    } else if (row.user_id && row.user_id !== req.user!.id) {
      res.status(409).json({ error: 'Device already claimed' });
      return;
    } else {
      await query(
        `UPDATE devices SET user_id = $1, name = COALESCE($2, name), kennel_id = $3, updated_at = NOW() WHERE id = $4`,
        [req.user!.id, name, kennelId, row.id]
      );
      row = await queryOne<any>(`SELECT * FROM devices WHERE id = $1`, [row.id]);
    }
    const secret = crypto.randomBytes(24).toString('base64url');
    const hash = await bcrypt.hash(secret, 10);
    const mqttUser = `device:${row.device_id}`;
    await query(
      `UPDATE devices SET mqtt_username = $1, mqtt_password_hash = $2, updated_at = NOW() WHERE id = $3`,
      [mqttUser, hash, row.id]
    );
    const device = mapDevice(await queryOne<any>(`SELECT * FROM devices WHERE id = $1`, [row.id]));
    res.json({
      device,
      mqtt: {
        username: mqttUser,
        password: secret,
        topicCommand: `kennel/${kennelId}/feeder/${row.device_id}/command`,
        topicStatus: `kennel/${kennelId}/feeder/${row.device_id}/status`,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to claim device' });
  }
};

export const updateDevice = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await queryOne<any>(
      `UPDATE devices SET name = COALESCE($1, name), updated_at = NOW()
       WHERE user_id = $2 AND (id::text = $3 OR device_id = $3) RETURNING *`,
      [req.body.name || null, req.user!.id, req.params.id]
    );
    if (!row) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    res.json({ device: mapDevice(row) });
  } catch {
    res.status(500).json({ error: 'Failed to update device' });
  }
};

export const deleteDevice = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await queryOne<any>(
      `DELETE FROM devices WHERE user_id = $1 AND (id::text = $2 OR device_id = $2) RETURNING id`,
      [req.user!.id, req.params.id]
    );
    if (!row) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete device' });
  }
};

export const updateDeviceStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  res.status(405).json({ error: 'Use MQTT retained status; HTTP status ingest is not the product path' });
};

export const triggerFeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await queryOne<any>(
      `SELECT * FROM devices WHERE user_id = $1 AND (id::text = $2 OR device_id = $2)`,
      [req.user!.id, req.params.id]
    );
    if (!row) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    if (row.device_type !== 'feeder') {
      res.status(400).json({ error: 'Device is not a feeder' });
      return;
    }
    const amount = Number(req.body?.amount ?? 100);
    const kennelId = row.kennel_id || req.user!.id;
    const ack = await publishFeedAndWait(kennelId, row.device_id, amount);
    res.json({
      success: true,
      acked: true,
      status: ack.status,
      foodLevel: ack.foodLevel,
      message: 'Device ack received',
    });
  } catch (error: any) {
    const msg = error?.message || 'Failed to trigger feeding';
    const timeout = /timeout/i.test(msg);
    res.status(timeout ? 504 : 500).json({ success: false, acked: false, error: msg });
  }
};

export const triggerDispense = async (_req: AuthRequest, res: Response): Promise<void> => {
  res.status(501).json({ error: 'Water loop is out of scope this sprint' });
};
