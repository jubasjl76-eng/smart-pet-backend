import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.js';
import { execute, query, queryOne } from '../database/index.js';
import { getFeederBus } from '../services/feederMqtt.js';
import { buildScheduleSet, commandTopic } from '../mqtt/contract.js';
import type { DeviceRow, ScheduleRow, ScheduleSetEntry } from '../types.js';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normalizeTime(body: any): string | null {
  if (typeof body?.time === 'string' && TIME_RE.test(body.time)) return body.time;
  if (body?.hour !== undefined && body?.minute !== undefined) {
    const h = Number(body.hour);
    const m = Number(body.minute);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  return null;
}

function presentSchedule(row: ScheduleRow) {
  return {
    id: row.id,
    deviceId: row.device_id,
    time: row.time,
    amount: row.amount,
    enabled: row.enabled,
  };
}

async function loadDeviceForOwner(userId: string, deviceKey: string): Promise<DeviceRow | null> {
  return queryOne<DeviceRow>(
    `SELECT * FROM devices WHERE (id::text = $1 OR device_id = $1) AND user_id = $2`,
    [deviceKey, userId]
  );
}

async function publishScheduleSetForDevice(device: DeviceRow): Promise<boolean> {
  if (!device.kennel_id) return false;
  const bus = getFeederBus();
  if (!bus) return false;
  const rows = await query<ScheduleRow>(
    `SELECT id, user_id, device_id, time, amount, enabled FROM schedules WHERE device_id = $1 ORDER BY time ASC`,
    [device.device_id]
  );
  const schedules: ScheduleSetEntry[] = rows.map((r) => ({
    id: r.id,
    time: r.time || '00:00',
    amount: Number(r.amount || 0),
    enabled: !!r.enabled,
  }));
  const payload = buildScheduleSet({
    deviceId: device.device_id,
    kennelId: device.kennel_id,
    timestamp: Date.now(),
    schedules,
  });
  await bus.publishCommand(commandTopic(device.kennel_id, device.device_id), payload);
  return true;
}

export const getAllSchedules = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const deviceId = req.query.device_id || req.query.deviceId;
    const params: any[] = [req.user!.id];
    let sql = `SELECT * FROM schedules WHERE user_id = $1`;
    if (deviceId) {
      params.push(deviceId);
      sql += ` AND device_id = $2`;
    }
    sql += ` ORDER BY time ASC`;
    const schedules = await query<ScheduleRow>(sql, params);
    res.json({ schedules: schedules.map(presentSchedule) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch schedules' });
  }
};

export const getScheduleById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const schedule = await queryOne<ScheduleRow>(
      `SELECT * FROM schedules WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json({ schedule: presentSchedule(schedule) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
};

export const createSchedule = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const deviceKey = req.body.deviceId;
    const time = normalizeTime(req.body);
    const amount = Number(req.body.amount);
    const enabled = req.body.enabled !== false;
    if (!deviceKey || !time || !Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'deviceId, time (HH:mm), and positive amount are required' });
      return;
    }
    const device = await loadDeviceForOwner(req.user!.id, deviceKey);
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    await execute(
      `INSERT INTO schedules (user_id, device_id, schedule_type, time, amount, enabled)
       VALUES ($1, $2, 'daily', $3, $4, $5)`,
      [req.user!.id, device.device_id, time, amount, enabled]
    );
    const schedule = await queryOne<ScheduleRow>(
      `SELECT * FROM schedules WHERE user_id = $1 AND device_id = $2 AND time = $3 ORDER BY created_at DESC LIMIT 1`,
      [req.user!.id, device.device_id, time]
    );
    const published = await publishScheduleSetForDevice(device);
    res.status(201).json({ schedule: presentSchedule(schedule!), mqttPublished: published });
  } catch (error) {
    console.error('Create schedule error:', error);
    res.status(500).json({ error: 'Failed to create schedule' });
  }
};

export const updateSchedule = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const schedule = await queryOne<ScheduleRow>(
      `SELECT * FROM schedules WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    const time = (req.body.time || req.body.hour !== undefined) ? (normalizeTime(req.body) || schedule.time) : schedule.time;
    const amount = req.body.amount !== undefined ? Number(req.body.amount) : schedule.amount;
    const enabled = req.body.enabled !== undefined ? !!req.body.enabled : schedule.enabled;
    await execute(
      `UPDATE schedules SET time = $1, amount = $2, enabled = $3, updated_at = NOW() WHERE id = $4`,
      [time, amount, enabled, schedule.id]
    );
    const device = await loadDeviceForOwner(req.user!.id, schedule.device_id);
    const published = device ? await publishScheduleSetForDevice(device) : false;
    const updated = await queryOne<ScheduleRow>('SELECT * FROM schedules WHERE id = $1', [schedule.id]);
    res.json({ schedule: presentSchedule(updated!), mqttPublished: published });
  } catch {
    res.status(500).json({ error: 'Failed to update schedule' });
  }
};

export const deleteSchedule = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const schedule = await queryOne<ScheduleRow>(
      `SELECT * FROM schedules WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    await execute('DELETE FROM schedules WHERE id = $1', [schedule.id]);
    const device = await loadDeviceForOwner(req.user!.id, schedule.device_id);
    const published = device ? await publishScheduleSetForDevice(device) : false;
    res.json({ success: true, mqttPublished: published });
  } catch {
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
};

export const toggleSchedule = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const schedule = await queryOne<ScheduleRow>(
      `SELECT * FROM schedules WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    await execute(
      `UPDATE schedules SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1`,
      [schedule.id]
    );
    const updated = await queryOne<ScheduleRow>('SELECT * FROM schedules WHERE id = $1', [schedule.id]);
    const device = await loadDeviceForOwner(req.user!.id, schedule.device_id);
    const published = device ? await publishScheduleSetForDevice(device) : false;
    res.json({ schedule: presentSchedule(updated!), mqttPublished: published });
  } catch {
    res.status(500).json({ error: 'Failed to toggle schedule' });
  }
};
