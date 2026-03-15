/**
 * Smart Pet Backend - Unified Edge + Cloud API
 * 
 * Supports two modes:
 * - EDGE: Local backend with SQLite, queues events for cloud sync
 * - CLOUD: Authoritative server with PostgreSQL
 * 
 * Port: 3000
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import scheduleRoutes from './routes/schedules.js';
import eventRoutes from './routes/events.js';
import collarRoutes from './routes/collar.js';
import iotRoutes from './routes/iot.js';
import { auth, optionalAuth } from './middleware/auth.js';
import { initializeDatabase, query, queryOne } from './database/index.js';

// Load environment variables
dotenv.config();

const app: Express = express();
const PORT = parseInt(process.env.PORT || '3000');
const BACKEND_MODE = (process.env.BACKEND_MODE || 'cloud').toLowerCase();

// ============== MIDDLEWARE ==============
app.use(cors());
app.use(express.json());

// ============== DATABASE INITIALIZATION ==============
initializeDatabase();

// ============== ROUTES ==============

// Health check (no auth required)
app.get('/health', async (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    mode: BACKEND_MODE,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '3.0.0-edge-cloud',
  });
});

// Device ingest endpoint (for IoT services/sensors)
app.post('/api/devices/ingest', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { deviceId, deviceType, eventType, value, unit, kennelId, metadata } = req.body;
    
    // Store the event
    await query(`
      INSERT INTO device_events (device_id, event_type, value, unit, kennel_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [deviceId, eventType, value, unit || null, kennelId || null, JSON.stringify(metadata || {})]);
    
    // Update device last seen
    await query(`
      UPDATE devices SET last_seen = NOW(), is_online = true
      WHERE device_id = $1
    `, [deviceId]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Ingest error:', error);
    res.status(500).json({ error: 'Failed to ingest device data' });
  }
});

// Sync endpoint - for edge to cloud sync
app.post('/api/sync/events', async (req: Request, res: Response) => {
  try {
    const { events, gatewayId, kennelId } = req.body;
    
    if (!events || !Array.isArray(events)) {
      res.status(400).json({ error: 'Invalid events array' });
      return;
    }
    
    let synced = 0;
    for (const event of events) {
      await query(`
        INSERT INTO device_events (device_id, event_type, value, unit, kennel_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [event.deviceId, event.eventType, event.value, event.unit, kennelId, JSON.stringify({ ...event.metadata, gatewayId }) }]);
      synced++;
    }
    
    res.json({ success: true, synced });
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ error: 'Failed to sync events' });
  }
});

// Get device state
app.get('/api/devices/state', async (req: Request, res: Response) => {
  try {
    const devices = await query(`
      SELECT device_id, device_type, name, is_online, last_seen, 
             COALESCE(latest_value, 0) as latest_value, 
             COALESCE(latest_event, 'unknown') as latest_event
      FROM devices 
      ORDER BY name
    `);
    
    res.json({ devices });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch device state' });
  }
});

// Auth routes (register, login)
app.use('/api/auth', authRoutes);

// Protected routes (require JWT auth)
app.use('/api/devices', auth, deviceRoutes);
app.use('/api/schedules', auth, scheduleRoutes);
app.use('/api/events', auth, eventRoutes);
app.use('/api/collar', auth, collarRoutes);

// IoT routes (device-to-backend communication)
app.use('/api/iot', iotRoutes);

// Dashboard stats (protected)
app.get('/api/stats', auth, async (req: Request, res: Response) => {
  const userId = (req as any).user?._id;
  
  try {
    const devices = await query(`
      SELECT * FROM devices WHERE user_id = $1
    `, [userId]);
    
    const schedules = await query(`
      SELECT * FROM schedules WHERE user_id = $1
    `, [userId]);
    
    const todayEvents = await queryOne(`
      SELECT COUNT(*) as count FROM device_events 
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
    `, [userId]);
    
    const feeders = devices.filter((d: any) => d.device_type === 'feeder');
    const waterDevices = devices.filter((d: any) => d.device_type === 'water');
    
    res.json({
      totalDevices: devices.length,
      feeders: feeders.length,
      waterDispensers: waterDevices.length,
      totalSchedules: schedules.length,
      activeSchedules: schedules.filter((s: any) => s.enabled).length,
      todayEvents: todayEvents?.count || 0,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ============== ERROR HANDLING ==============
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ============== START SERVER ==============
app.listen(PORT, () => {
  const modeLabel = BACKEND_MODE === 'edge' ? 'EDGE (Local)' : 'CLOUD (Authoritative)';
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║         🐾 Smart Pet API v3.0 - ${modeLabel.padEnd(38)}║
╠═══════════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT.toString().padEnd(36)}║
║  Mode: ${BACKEND_MODE.toUpperCase().padEnd(46)}║
╠═══════════════════════════════════════════════════════════════════╣
║  Endpoints:                                                      ║
║  POST /api/devices/ingest   - Device data ingestion              ║
║  POST /api/sync/events     - Edge to cloud sync                  ║
║  GET  /api/devices/state   - Get all device states               ║
║  POST /api/auth/register   - Register new user                   ║
║  POST /api/auth/login      - Login (returns JWT)                 ║
║  GET  /api/devices        - List devices (JWT required)          ║
║  GET  /api/stats          - Dashboard statistics                 ║
╠═══════════════════════════════════════════════════════════════════╣
║  Header: Authorization: Bearer <JWT_TOKEN>                       ║
╚═══════════════════════════════════════════════════════════════════╝
  `);
});

export default app;
