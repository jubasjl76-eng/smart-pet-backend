import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.js';
import { query, queryOne } from '../database/index.js';

export const getAllEvents = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { device_id, limit = 50, offset = 0 } = req.query;
    const params: any[] = [req.user!.id];
    let sql = `SELECT * FROM device_events WHERE user_id = $1`;
    if (device_id) {
      params.push(device_id);
      sql += ` AND device_id = $2`;
    }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const events = await query(sql, params);
    res.json({ events, limit: Number(limit), offset: Number(offset) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch events' });
  }
};

export const getEventById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const event = await queryOne(
      `SELECT * FROM device_events WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    res.json({ event });
  } catch {
    res.status(500).json({ error: 'Failed to fetch event' });
  }
};

export const createEvent = async (req: AuthRequest, res: Response): Promise<void> => {
  res.status(405).json({ error: 'Manual event insert is not a product path; Feed Now succeeds on device ack + status' });
};

export const getEventStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await queryOne<any>(
      `SELECT COUNT(*)::int as count FROM device_events WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [req.user!.id]
    );
    res.json({ today: row?.count || 0 });
  } catch {
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
};

export const getRecentEvents = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { limit = 10 } = req.query;
    const events = await query(
      `SELECT * FROM device_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.user!.id, Number(limit)]
    );
    res.json({ events });
  } catch {
    res.status(500).json({ error: 'Failed to fetch recent events' });
  }
};
