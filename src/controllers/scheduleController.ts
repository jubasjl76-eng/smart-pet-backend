import { Response } from 'express';
import { query, queryOne } from '../database/index.js';
import { AuthRequest } from '../middleware/auth.js';
import { publishScheduleSet } from '../services/feederMqtt.js';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function mapRow(row: any) {
  const [h, m] = String(row.time || '00:00').split(':');
  return {
    id: row.id,
    _id: row.id,
    deviceId: row.device_id,
    hour: row.hour ?? parseInt(h, 10),
    minute: row.minute ?? parseInt(m, 10),
    time: row.time,
    enabled: row.enabled,
    action: row.schedule_type || 'feed',
    amount: row.amount ?? 100,
  };
}

async function pushSnapshot(userId: string, deviceId: string): Promise<void> {
  const device = await queryOne<any>(
    `SELECT * FROM devices WHERE user_id = $1 AND (id::text = $2 OR device_id = $2)`,
    [userId, deviceId]
  );
  if (!device || device.device_type !== 'feeder') return;
  const rows = await query<any>(
    `SELECT * FROM schedules WHERE user_id = $1 AND device_id = $2 ORDER BY time ASC`,
    [userId, device.device_id]
  );
  const schedules = rows.map((r: any) => ({
    id: r.id,
    time: r.time,
    amount: r.amount ?? 100,
    enabled: !!r.enabled,
  }));
  try {
    await publishScheduleSet(device.kennel_id || userId, device.device_id, schedules);
  } catch (e) {
    console.error('[schedule] MQTT publish failed', e);
  }
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
    const rows = await query<any>(sql, params);
    res.json({ schedules: rows.map(mapRow) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch schedules' });
  }
};

export const getScheduleById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await queryOne<any>(
      `SELECT * FROM schedules WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!row) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json({ schedule: mapRow(row) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
};

export const createSchedule = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { deviceId, hour, minute, enabled, amount } = req.body;
    const device = await queryOne<any>(
      `SELECT * FROM devices WHERE user_id = $1 AND (id::text = $2 OR device_id = $2)`,
      [req.user!.id, deviceId]
    );
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
    const rows = await query<any>(
      `INSERT INTO schedules (user_id, device_id, schedule_type, time, enabled, amount)
       VALUES ($1, $2, 'feed', $3, $4, $5) RETURNING *`,
      [req.user!.id, device.device_id, time, enabled !== false, amount ?? 100]
    );
    await pushSnapshot(req.user!.id, device.device_id);
    res.status(201).json({ schedule: mapRow(rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create schedule' });
  }
};

export const updateSchedule = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const existing = await queryOne<any>(
      `SELECT * FROM schedules WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!existing) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    const hour = req.body.hour !== undefined ? req.body.hour : parseInt(String(existing.time).split(':')[0], 10);
    const minute = req.body.minute !== undefined ? req.body.minute : parseInt(String(existing.time).split(':')[1], 10);
    const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
    const row = await queryOne<any>(
      `UPDATE schedules SET time = $1, enabled = COALESCE($2, enabled), amount = COALESCE($3, amount), updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [time, req.body.enabled, req.body.amount, req.params.id]
    );
    await pushSnapshot(req.user!.id, existing.device_id);
    res.json({ schedule: mapRow(row) });
  } catch {
    res.status(500).json({ error: 'Failed to update schedule' });
  }
};

export const deleteSchedule = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await queryOne<any>(
      `DELETE FROM schedules WHERE id = $1 AND user_id = $2 RETURNING device_id`,
      [req.params.id, req.user!.id]
    );
    if (!row) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    await pushSnapshot(req.user!.id, row.device_id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
};

export const toggleSchedule = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await queryOne<any>(
      `UPDATE schedules SET enabled = NOT enabled, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user!.id]
    );
    if (!row) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    await pushSnapshot(req.user!.id, row.device_id);
    res.json({ schedule: mapRow(row) });
  } catch {
    res.status(500).json({ error: 'Failed to toggle schedule' });
  }
};
