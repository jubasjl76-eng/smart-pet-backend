/**
 * Smart Pet Backend - Unified API (port 3000 only)
 * 24 Sep feeder loop: owner JWT + MQTT command/status on kennel/{kennelId}/feeder/{deviceId}/
 * mqttConsumer.ts is quarantined and is not started here.
 */
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is unset — refusing to boot');
  process.exit(1);
}

import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import scheduleRoutes from './routes/schedules.js';
import eventRoutes from './routes/events.js';
import collarRoutes from './routes/collar.js';
import { auth, ownerOnly, adminOnly } from './middleware/auth.js';
import { initializeDatabase, query, queryOne } from './database/index.js';
import { startFeederMqtt } from './services/feederMqtt.js';

const app: Express = express();
const PORT = 3000;
if (process.env.PORT && process.env.PORT !== '3000') {
  console.warn('[boot] API is locked to port 3000; ignoring PORT=' + process.env.PORT);
}
const BACKEND_MODE = (process.env.BACKEND_MODE || 'cloud').toLowerCase();

app.set('trust proxy', false);
app.use(cors());
app.use(express.json());

initializeDatabase().then(() => startFeederMqtt()).catch((e) => {
  console.error('[boot] database/mqtt failed', e);
});

app.get('/health', async (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    mode: BACKEND_MODE,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '3.1.0-feeder-command',
    port: PORT,
  });
});

function closed(_req: Request, res: Response) {
  res.status(403).json({
    error: 'closed',
    message: 'Device path is MQTT status on kennel/{kennelId}/feeder/{deviceId}/status. Owner JWT is not a device credential. X-API-Key is not a product path.',
  });
}
app.post('/api/devices/ingest', closed);
app.post('/api/sync/events', closed);
app.get('/api/devices/state', closed);
app.post('/api/iot/events', closed);
app.use('/api/iot', closed);

app.use('/api/auth', authRoutes);
app.use('/api/devices', auth, ownerOnly, deviceRoutes);
app.use('/api/schedules', auth, ownerOnly, scheduleRoutes);
app.use('/api/events', auth, ownerOnly, eventRoutes);
app.use('/api/collar', auth, collarRoutes);

app.get('/api/admin/ping', auth, adminOnly, (req: Request, res: Response) => {
  res.json({ ok: true, role: (req as any).user?.role });
});

app.get('/api/pet', auth, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  try {
    const pet = await queryOne<any>('SELECT id, name FROM pets WHERE user_id = $1 LIMIT 1', [userId]);
    res.json({ pet: pet || { name: null } });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

app.put('/api/pet', auth, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  const name = String(req.body?.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'name required' });
    return;
  }
  try {
    const existing = await queryOne<any>('SELECT id FROM pets WHERE user_id = $1 LIMIT 1', [userId]);
    if (existing) {
      const pet = await queryOne<any>('UPDATE pets SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name', [name, existing.id]);
      res.json({ pet });
    } else {
      const pet = (await query<any>('INSERT INTO pets (user_id, name) VALUES ($1, $2) RETURNING id, name', [userId, name]))[0];
      res.json({ pet });
    }
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

app.get('/api/stats', auth, ownerOnly, async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  try {
    const devices = await query<any>(`SELECT * FROM devices WHERE user_id = $1`, [userId]);
    const schedules = await query<any>(`SELECT * FROM schedules WHERE user_id = $1`, [userId]);
    res.json({
      totalDevices: devices.length,
      feeders: devices.filter((d: any) => d.device_type === 'feeder').length,
      totalSchedules: schedules.length,
      activeSchedules: schedules.filter((s: any) => s.enabled).length,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Smart Pet API on http://localhost:${PORT} mode=${BACKEND_MODE}`);
  console.log('MQTT command: kennel/{kennelId}/feeder/{deviceId}/command QoS 2');
  console.log('MQTT status:  kennel/{kennelId}/feeder/{deviceId}/status retained QoS 1');
  console.log('POST /api/devices/claim issues device:<deviceId> MQTT creds once');
  console.log('POST /api/devices/:id/feed waits for device ack+status');
});

export default app;
