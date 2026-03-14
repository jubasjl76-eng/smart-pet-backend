/**
 * Smart Pet - Unified Backend API with MongoDB + JWT Auth
 * 
 * Features:
 * - User authentication (register, login, JWT)
 * - Device management (feeders, water dispensers)
 * - Scheduling system
 * - Event tracking
 * - Statistics dashboard
 * 
 * Port: 3000
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import scheduleRoutes from './routes/schedules.js';
import eventRoutes from './routes/events.js';
import collarRoutes from './routes/collar.js';
import { auth, optionalAuth } from './middleware/auth.js';

// Load environment variables
dotenv.config();

const app: Express = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/smart-pet';

// ============== MIDDLEWARE ==============
app.use(cors());
app.use(express.json());

// ============== MONGODB CONNECTION ==============
const connectDB = async (): Promise<void> => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ MongoDB connected');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    // Don't exit in development - allow running without DB for testing
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
};

connectDB();

// ============== ROUTES ==============

// Health check (no auth required)
app.get('/health', async (_req: Request, res: Response) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoStatus,
    version: '2.0.0',
  });
});

// Auth routes (register, login)
app.use('/api/auth', authRoutes);

// Protected routes (require JWT auth)
app.use('/api/devices', auth, deviceRoutes);
app.use('/api/schedules', auth, scheduleRoutes);
app.use('/api/events', auth, eventRoutes);
app.use('/api/collar', auth, collarRoutes);

// Dashboard stats (protected)
app.get('/api/stats', auth, async (req: Request, res: Response) => {
  const { Device, Schedule, Event, User } = await import('./models/index.js');
  const userId = (req as any).user?._id;
  
  try {
    const devices = await Device.find({ userId });
    const schedules = await Schedule.find({ userId });
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayEvents = await Event.countDocuments({
      userId,
      timestamp: { $gte: today },
    });
    
    const feeders = devices.filter(d => d.type === 'feeder');
    const waterDevices = devices.filter(d => d.type === 'water');
    
    res.json({
      totalDevices: devices.length,
      feeders: feeders.length,
      waterDispensers: waterDevices.length,
      totalSchedules: schedules.length,
      activeSchedules: schedules.filter(s => s.enabled).length,
      todayEvents,
      alerts: {
        lowFoodFeeders: feeders.filter(d => d.isLowFood).length,
        lowWaterDevices: waterDevices.filter(d => d.isLowWater).length,
        offlineDevices: devices.filter(d => !d.isOnline).length,
      },
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
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║         🐾 Smart Pet API v2.0 - MongoDB + Auth 🐾              ║
╠═══════════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                         ║
║  MongoDB: ${MONGODB_URI.split('@')[1] || 'localhost'}                      ║
╠═══════════════════════════════════════════════════════════════════╣
║  Endpoints:                                                      ║
║  POST /api/auth/register   - Register new user                   ║
║  POST /api/auth/login      - Login (returns JWT)                 ║
║  GET  /api/auth/me         - Get current user                   ║
║  GET  /api/devices        - List devices (JWT required)         ║
║  POST /api/devices        - Register device                      ║
║  POST /api/devices/:id/feed   - Trigger feeding                 ║
║  POST /api/devices/:id/dispense - Trigger water                  ║
║  GET  /api/schedules      - List schedules                       ║
║  POST /api/schedules      - Create schedule                      ║
║  GET  /api/events         - List events                          ║
║  GET  /api/stats          - Dashboard statistics                ║
╠═══════════════════════════════════════════════════════════════════╣
║  Header format: Authorization: Bearer <JWT_TOKEN>                ║
╚═══════════════════════════════════════════════════════════════════╝
  `);
});

export default app;
