/**
 * Smart Pet - Unified Backend API
 * 
 * Single API that manages:
 * - Smart Feeders
 * - Smart Water Dispensers
 * - All devices in one unified system
 * 
 * Port: 3000
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();
const PORT = process.env.PORT || 3000;

// ============== DATABASE (In-Memory) ==============
interface Device {
  id: string;
  type: 'feeder' | 'water';
  name: string;
  foodLevel?: number;
  waterLevel?: number;
  isLowFood?: boolean;
  isLowWater?: boolean;
  tds?: number;
  temperature?: number;
  waterQuality?: number;
  wifiRssi: number;
  uptimeMs: number;
  lastSeen: string;
  createdAt: string;
}

interface Schedule {
  id: string;
  deviceId: string;
  hour: number;
  minute: number;
  enabled: boolean;
  createdAt: string;
}

interface Event {
  id: string;
  deviceId: string;
  type: 'scheduled' | 'manual' | 'api';
  action: 'feed' | 'dispense';
  timestamp: string;
  success: boolean;
  message?: string;
}

interface ApiLog {
  id: string;
  deviceId: string;
  endpoint: string;
  method: string;
  statusCode: number;
  timestamp: string;
}

// In-memory database
let devices: Device[] = [];
let schedules: Schedule[] = [];
let events: Event[] = [];
let logs: ApiLog[] = [];

// ============== MIDDLEWARE ==============
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY || 'smart-pet-api-key-2026';

const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const providedKey = req.headers['x-api-key'] as string;
  
  if (!providedKey || providedKey !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    return;
  }
  
  next();
};

// Logging middleware
const logMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const log: ApiLog = {
    id: uuidv4(),
    deviceId: req.body.device_id || req.body.feeder_id || 'unknown',
    endpoint: req.path,
    method: req.method,
    statusCode: 200,
    timestamp: new Date().toISOString()
  };
  logs.push(log);
  if (logs.length > 100) logs = logs.slice(-100);
  next();
};

// ============== HEALTH ==============
app.get('/health', (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      feeders: devices.filter(d => d.type === 'feeder').length,
      waterDispensers: devices.filter(d => d.type === 'water').length,
      schedules: schedules.length,
      events: events.length
    }
  });
});

// ============== DEVICE ROUTES ==============

// Get all devices
app.get('/api/devices', authMiddleware, logMiddleware, (_req: Request, res: Response) => {
  res.json({ devices });
});

// Get device by ID
app.get('/api/devices/:id', authMiddleware, logMiddleware, (req: Request, res: Response) => {
  const device = devices.find(d => d.id === req.params.id);
  
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  
  res.json(device);
});

// Register new device
app.post('/api/devices', authMiddleware, logMiddleware, (req: Request, res: Response) => {
  const { name, type } = req.body;
  
  if (!name || !type || !['feeder', 'water'].includes(type)) {
    res.status(400).json({ error: 'Missing or invalid required fields: name, type (feeder|water)' });
    return;
  }
  
  const device: Device = {
    id: `${type}_${uuidv4().slice(0, 8)}`,
    type: type as 'feeder' | 'water',
    name,
    foodLevel: 100,
    waterLevel: 100,
    isLowFood: false,
    isLowWater: false,
    tds: 0,
    temperature: 0,
    waterQuality: 0,
    wifiRssi: 0,
    uptimeMs: 0,
    lastSeen: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  
  devices.push(device);
  res.status(201).json(device);
});

// Update device status
app.post('/api/status', authMiddleware, logMiddleware, (req: Request, res: Response) => {
  const { device_id, food_level, is_low_food, water_level, is_low_water, tds, temperature, water_quality, wifi_rssi, uptime_ms } = req.body;
  
  const device = devices.find(d => d.id === device_id);
  
  if (!device) {
    // Auto-register new device
    const newDevice: Device = {
      id: device_id,
      type: device_id.startsWith('water') ? 'water' : 'feeder',
      name: 'Auto-registered Device',
      foodLevel: food_level,
      waterLevel: water_level,
      isLowFood: is_low_food,
      isLowWater: is_low_water,
      tds: tds || 0,
      temperature: temperature || 0,
      waterQuality: water_quality || 0,
      wifiRssi: wifi_rssi || 0,
      uptimeMs: uptime_ms || 0,
      lastSeen: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    devices.push(newDevice);
    res.json({ success: true, device: newDevice, autoRegistered: true });
    return;
  }
  
  // Update existing device
  if (food_level !== undefined) device.foodLevel = food_level;
  if (water_level !== undefined) device.waterLevel = water_level;
  if (is_low_food !== undefined) device.isLowFood = is_low_food;
  if (is_low_water !== undefined) device.isLowWater = is_low_water;
  if (tds !== undefined) device.tds = tds;
  if (temperature !== undefined) device.temperature = temperature;
  if (water_quality !== undefined) device.waterQuality = water_quality;
  if (wifi_rssi !== undefined) device.wifiRssi = wifi_rssi;
  if (uptime_ms !== undefined) device.uptimeMs = uptime_ms;
  device.lastSeen = new Date().toISOString();
  
  res.json({ success: true, device });
});

// Delete device
app.delete('/api/devices/:id', authMiddleware, logMiddleware, (req: Request, res: Response) => {
  const index = devices.findIndex(d => d.id === req.params.id);
  
  if (index === -1) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  
  devices.splice(index, 1);
  // Also delete associated schedules
  schedules = schedules.filter(s => s.deviceId !== req.params.id);
  
  res.json({ success: true });
});

// ============== ACTION ROUTES ==============

// Feed action
app.post('/api/feed', authMiddleware, logMiddleware, (req: Request, res: Response) => {
  const { device_id } = req.body;
  
  const device = devices.find(d => d.id === device_id);
  
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  
  if (device.type !== 'feeder') {
    res.status(400).json({ error: 'Device is not a feeder' });
    return;
  }
  
  const event: Event = {
    id: uuidv4(),
    deviceId: device_id,
    type: 'api',
    action: 'feed',
    timestamp: new Date().toISOString(),
    success: true,
    message: 'Feed command sent'
  };
  
  events.push(event);
  if (events.length > 100) events = events.slice(-100);
  
  res.json({ success: true, event });
});

// Dispense water action
app.post('/api/dispense', authMiddleware, logMiddleware, (req: Request, res: Response) => {
  const { device_id } = req.body;
  
  const device = devices.find(d => d.id === device_id);
  
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  
  if (device.type !== 'water') {
    res.status(400).json({ error: 'Device is not a water dispenser' });
    return;
  }
  
  const event: Event = {
    id: uuidv4(),
    deviceId: device_id,
    type: 'api',
    action: 'dispense',
    timestamp: new Date().toISOString(),
    success: true,
    message: 'Water dispense command sent'
  };
  
  events.push(event);
  if (events.length > 100) events = events.slice(-100);
  
  res.json({ success: true, event });
});

// ============== SCHEDULE ROUTES ==============

// Get all schedules
app.get('/api/schedules', authMiddleware, logMiddleware, (req: Request, res: Response) => {
  const { device_id } = req.query;
  
  let result = schedules;
  if (device_id) {
    result = schedules.filter(s => s.deviceId === device_id);
  }
  
  res.json({ schedules: result });
});

// Create schedule
app.post('/api/schedules', authMiddleware, logMiddleware, (req: Request, res: Response) => {
  const { device_id, hour, minute, action = 'feed', enabled = true } = req.body;
  
  if (!device_id || hour === undefined || minute === undefined) {
    res.status(400).json({ error: 'Missing required fields: device_id, hour, minute' });
    return;
  }
  
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    res.status(400).json({ error: 'Invalid time values' });
    return;
  }
  
  const device = devices.find(d => d.id === device_id);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  
  const schedule: Schedule = {
    id: uuidv4(),
    deviceId: device_id,
    hour,
    minute,
    enabled,
    createdAt: new Date().toISOString()
  };
  
  schedules.push(schedule);
  res.status(201).json(schedule);
});

// Update schedule
app.put('/api/schedules/:id', authMiddleware, logMiddleware, (req: Request, res: Response) => {
  const { hour, minute, enabled } = req.body;
  
  const schedule = schedules.find(s => s.id === req.params.id);
  
  if (!schedule) {
    res.status(404).json({ error: 'Schedule not found' });
    return;
  }
  
  if (hour !== undefined) {
    if (hour < 0 || hour > 23) {
      res.status(400).json({ error: 'Invalid hour' });
      return;
    }
    schedule.hour = hour;
  }
  
  if (minute !== undefined) {
    if (minute < 0 || minute > 59) {
      res.status(400).json({ error: 'Invalid minute' });
      return;
    }
    schedule.minute = minute;
  }
  
  if (enabled !== undefined) schedule.enabled = enabled;
  
  res.json(schedule);
});

// Delete schedule
app.delete('/api/schedules/:id', authMiddleware, logMiddleware, (req: Request, res: Response) => {
  const index = schedules.findIndex(s => s.id === req.params.id);
  
  if (index === -1) {
    res.status(404).json({ error: 'Schedule not found' });
    return;
  }
  
  schedules.splice(index, 1);
  res.json({ success: true });
});

// ============== EVENT ROUTES ==============

// Get events
app.get('/api/events', authMiddleware, logMiddleware, (req: Request, res: Response) => {
  const { device_id, limit = 50 } = req.query;
  
  let result = events;
  if (device_id) {
    result = events.filter(e => e.deviceId === device_id);
  }
  
  result = result.slice(-Number(limit));
  res.json({ events: result });
});

// ============== LOGS ROUTES ==============

// Get API logs
app.get('/api/logs', authMiddleware, logMiddleware, (_req: Request, res: Response) => {
  res.json({ logs: logs.slice(-50) });
});

// ============== STATS ROUTES ==============

// Get dashboard stats
app.get('/api/stats', authMiddleware, logMiddleware, (_req: Request, res: Response) => {
  const feeders = devices.filter(d => d.type === 'feeder');
  const waterDevices = devices.filter(d => d.type === 'water');
  
  const lowFoodFeeders = feeders.filter(d => d.isLowFood).length;
  const lowWaterDevices = waterDevices.filter(d => d.isLowWater).length;
  
  const todayEvents = events.filter(e => {
    const eventDate = new Date(e.timestamp).toDateString();
    return eventDate === new Date().toDateString();
  });
  
  res.json({
    totalDevices: devices.length,
    feeders: feeders.length,
    waterDispensers: waterDevices.length,
    totalSchedules: schedules.length,
    activeSchedules: schedules.filter(s => s.enabled).length,
    todayEvents: todayEvents.length,
    alerts: {
      lowFoodFeeders,
      lowWaterDevices,
      offlineDevices: devices.filter(d => {
        const lastSeen = new Date(d.lastSeen).getTime();
        const now = Date.now();
        return (now - lastSeen) > 5 * 60 * 1000; // 5 min offline
      }).length
    },
    systemHealth: {
      cpu: process.cpuUsage().user,
      memory: process.memoryUsage().heapUsed,
      uptime: process.uptime()
    }
  });
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
╔═══════════════════════════════════════════════════════════╗
║         🐾 Smart Pet - Unified Backend API 🐾           ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}               ║
║  API Key: ${API_KEY}                        ║
╠═══════════════════════════════════════════════════════════╣
║  Endpoints:                                               ║
║  GET  /health              - Health check                ║
║  GET  /api/devices        - List all devices             ║
║  POST /api/devices        - Register device              ║
║  POST /api/status         - Update device status         ║
║  POST /api/feed           - Trigger feeding              ║
║  POST /api/dispense       - Trigger water dispense       ║
║  GET  /api/schedules      - Get schedules                ║
║  POST /api/schedules      - Create schedule              ║
║  GET  /api/events         - Get events                   ║
║  GET  /api/stats          - Dashboard statistics         ║
║  GET  /api/logs           - API access logs              ║
╠═══════════════════════════════════════════════════════════╣
║  Header required: X-API-Key: ${API_KEY}      ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
