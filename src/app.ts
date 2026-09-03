import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import scheduleRoutes from './routes/schedules.js';
import eventRoutes from './routes/events.js';
import iotRoutes from './routes/iot.js';
import { auth, ownerOnly } from './middleware/auth.js';
import { deviceAuth, DeviceAuthRequest } from './middleware/deviceAuth.js';
import { execute, queryOne } from './database/index.js';
import { getStats } from './controllers/deviceController.js';
import { presentDevice } from './services/statusIngest.js';
import type { DeviceRow } from './types.js';

export function createApp(): Express {
  const app: Express = express();
  app.set('trust proxy', false);
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '3.1.0-feeder-command-path',
    });
  });

  app.post('/api/devices/ingest', deviceAuth, async (req: DeviceAuthRequest, res: Response) => {
    try {
      const deviceId = req.deviceCred!.deviceId;
      if (req.body?.deviceId && req.body.deviceId !== deviceId) {
        res.status(403).json({ error: 'deviceId does not match credentials' });
        return;
      }
      const { eventType, value, unit, metadata } = req.body || {};
      await execute(
        `INSERT INTO device_events (user_id, device_id, event_type, value, unit, kennel_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.deviceCred!.userId,
          deviceId,
          eventType || 'unknown',
          value ?? null,
          unit || null,
          req.deviceCred!.kennelId,
          JSON.stringify(metadata || {}),
        ]
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Ingest error:', error);
      res.status(500).json({ error: 'Failed to ingest device data' });
    }
  });

  app.post('/api/sync/events', deviceAuth, async (req: DeviceAuthRequest, res: Response) => {
    try {
      const { events } = req.body || {};
      if (!events || !Array.isArray(events)) {
        res.status(400).json({ error: 'Invalid events array' });
        return;
      }
      const deviceId = req.deviceCred!.deviceId;
      let synced = 0;
      for (const event of events) {
        if (event.deviceId && event.deviceId !== deviceId) continue;
        await execute(
          `INSERT INTO device_events (user_id, device_id, event_type, value, unit, kennel_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            req.deviceCred!.userId,
            deviceId,
            event.eventType,
            event.value ?? null,
            event.unit || null,
            req.deviceCred!.kennelId,
            JSON.stringify(event.metadata || {}),
          ]
        );
        synced++;
      }
      res.json({ success: true, synced });
    } catch (error) {
      console.error('Sync error:', error);
      res.status(500).json({ error: 'Failed to sync events' });
    }
  });

  app.get('/api/devices/state', deviceAuth, async (req: DeviceAuthRequest, res: Response) => {
    try {
      const device = await queryOne<DeviceRow>(
        `SELECT * FROM devices WHERE device_id = $1`,
        [req.deviceCred!.deviceId]
      );
      if (!device) {
        res.status(404).json({ error: 'Device not found' });
        return;
      }
      res.json({ device: presentDevice(device) });
    } catch {
      res.status(500).json({ error: 'Failed to fetch device state' });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/devices', auth, ownerOnly, deviceRoutes);
  app.use('/api/schedules', auth, ownerOnly, scheduleRoutes);
  app.use('/api/events', auth, ownerOnly, eventRoutes);
  app.use('/api/iot', iotRoutes);
  app.get('/api/stats', auth, ownerOnly, getStats);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
