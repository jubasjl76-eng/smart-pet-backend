import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { AuthRequest } from '../middleware/auth.js';
import { execute, query, queryOne } from '../database/index.js';
import { presentDevice } from '../services/statusIngest.js';
import { executeFeedNow } from '../services/feedNow.js';
import { getFeederBus } from '../services/feederMqtt.js';
import {
  buildLwtPayload,
  commandTopic,
  mqttUsername,
  statusTopic,
} from '../mqtt/contract.js';
import type { DeviceRow } from '../types.js';

const SIMULATED_FEEDER_ID = 'feeder-sim-001';

export const getAllDevices = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const devices = await query<DeviceRow>(
      `SELECT * FROM devices WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.id]
    );
    res.json({ devices: devices.map(presentDevice) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
};

export const getDeviceById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const device = await queryOne<DeviceRow>(
      `SELECT * FROM devices WHERE (id::text = $1 OR device_id = $1) AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    res.json({ device: presentDevice(device) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch device' });
  }
};

export const getDeviceLevel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const device = await queryOne<DeviceRow>(
      `SELECT * FROM devices WHERE (id::text = $1 OR device_id = $1) AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    const presented = presentDevice(device);
    res.json({
      deviceId: presented.deviceId,
      kennelId: presented.kennelId,
      status: presented.status,
      foodLevel: presented.foodLevel,
      isFoodLow: presented.isFoodLow,
      lastFeed: presented.lastFeed,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch food level' });
  }
};

export const claimFeeder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const existing = await queryOne<DeviceRow>(
      `SELECT * FROM devices WHERE user_id = $1 AND device_type = 'feeder'`,
      [user.id]
    );
    if (existing) {
      res.status(409).json({ error: 'Owner already has a claimed feeder' });
      return;
    }

    const deviceId = String(req.body.deviceId || SIMULATED_FEEDER_ID);
    const name = String(req.body.name || 'Simulated Feeder');
    let kennelId = user.kennelId;
    if (!kennelId) {
      kennelId = `kennel-${user.id.slice(0, 8)}`;
      await execute('UPDATE users SET kennel_id = $1 WHERE id = $2', [kennelId, user.id]);
    }

    const taken = await queryOne<DeviceRow>('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    if (taken && taken.user_id && taken.user_id !== user.id) {
      res.status(409).json({ error: 'Device already claimed' });
      return;
    }

    const secret = randomBytes(24).toString('base64url');
    const hash = await bcrypt.hash(secret, 10);
    const username = mqttUsername(deviceId);

    if (taken) {
      await execute(
        `UPDATE devices
         SET user_id = $1, kennel_id = $2, name = $3, device_type = 'feeder',
             mqtt_username = $4, mqtt_password_hash = $5, claimed_at = NOW(), updated_at = NOW()
         WHERE device_id = $6`,
        [user.id, kennelId, name, username, hash, deviceId]
      );
    } else {
      await execute(
        `INSERT INTO devices (user_id, device_id, device_type, name, kennel_id, mqtt_username, mqtt_password_hash, status, is_online, claimed_at)
         VALUES ($1, $2, 'feeder', $3, $4, $5, $6, 'offline', false, NOW())`,
        [user.id, deviceId, name, kennelId, username, hash]
      );
    }

    const device = await queryOne<DeviceRow>('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    res.status(201).json({
      device: presentDevice(device!),
      mqtt: {
        username,
        password: secret,
        commandTopic: commandTopic(kennelId, deviceId),
        statusTopic: statusTopic(kennelId, deviceId),
        commandQos: 2,
        statusQos: 1,
        statusRetained: true,
        lwt: {
          topic: statusTopic(kennelId, deviceId),
          retained: true,
          payload: buildLwtPayload(deviceId, kennelId),
        },
        acl: {
          subscribe: [commandTopic(kennelId, deviceId)],
          publish: [statusTopic(kennelId, deviceId)],
          deny: ['kennel/+', '#'],
        },
      },
    });
  } catch (error) {
    console.error('Claim error:', error);
    res.status(500).json({ error: 'Failed to claim feeder' });
  }
};

export const triggerFeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const device = await queryOne<DeviceRow>(
      `SELECT * FROM devices WHERE (id::text = $1 OR device_id = $1) AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    if (device.device_type !== 'feeder') {
      res.status(400).json({ error: 'Device is not a feeder' });
      return;
    }

    const amount = Number(req.body?.amount ?? req.body?.params?.amount ?? 1);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'params.amount must be a positive number' });
      return;
    }

    const bus = getFeederBus();
    if (!bus) {
      res.status(503).json({ error: 'MQTT command path unavailable' });
      return;
    }

    const status = await executeFeedNow(device, amount, bus);
    res.json({
      success: true,
      message: 'Feed acknowledged by device status',
      status,
    });
  } catch (error: any) {
    if (String(error?.message || '').includes('did not ack')) {
      res.status(504).json({ error: 'Device did not ack feed via status' });
      return;
    }
    console.error('Feed error:', error);
    res.status(500).json({ error: 'Failed to trigger feeding' });
  }
};

export const getStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const devices = await query<DeviceRow>('SELECT * FROM devices WHERE user_id = $1', [userId]);
    const schedules = await query<any>('SELECT * FROM schedules WHERE user_id = $1', [userId]);
    res.json({
      totalDevices: devices.length,
      feeders: devices.filter((d) => d.device_type === 'feeder').length,
      totalSchedules: schedules.length,
      activeSchedules: schedules.filter((s) => s.enabled).length,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};
