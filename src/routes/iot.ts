import { Router, Response } from 'express';
import { body, validationResult, query } from 'express-validator';
import { IoTDevice, DeviceEvent, DeviceCommand, Alert, DeviceHealth } from '../models/index.js';
import { auth, AuthRequest } from '../middleware/auth.js';

const router = Router();

// Validation middleware
const validate = (req: AuthRequest, res: Response, next: Function): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }
  next();
};

// ============== DEVICE ROUTES ==============

// GET /api/iot/devices - Get all IoT devices
router.get('/devices', auth, async (req: AuthRequest, res: Response) => {
  try {
    const { kennelId, deviceType, status } = req.query;
    
    const query: any = { ownerId: req.user?._id };
    if (kennelId) query.kennelId = kennelId;
    if (deviceType) query.deviceType = deviceType;
    if (status) query.status = status;
    
    const devices = await IoTDevice.find(query).sort({ createdAt: -1 });
    res.json({ devices });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// GET /api/iot/devices/:deviceId - Get single device
router.get('/devices/:deviceId', auth, async (req: AuthRequest, res: Response) => {
  try {
    const device = await IoTDevice.findOne({
      deviceId: req.params.deviceId,
      ownerId: req.user?._id
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    res.json({ device });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch device' });
  }
});

// POST /api/iot/devices - Register new device
router.post('/devices', auth, [
  body('deviceId').notEmpty().trim(),
  body('deviceType').isIn(['sensor', 'camera', 'feeder', 'water', 'door', 'gps']),
  body('kennelId').notEmpty().trim(),
  body('name').notEmpty().trim(),
  body('location').optional().trim(),
], validate, async (req: AuthRequest, res: Response) => {
  try {
    const { deviceId, deviceType, kennelId, name, location, metadata } = req.body;
    
    // Check if device already exists
    const existing = await IoTDevice.findOne({ deviceId });
    if (existing) {
      res.status(400).json({ error: 'Device already registered' });
      return;
    }
    
    const device = new IoTDevice({
      deviceId,
      deviceType,
      kennelId,
      ownerId: req.user?._id,
      name,
      location,
      metadata,
      status: 'offline',
    });
    
    await device.save();
    
    // Create initial health record
    const health = new DeviceHealth({
      deviceId,
      kennelId,
      isOnline: false,
      lastHeartbeat: new Date(),
    });
    await health.save();
    
    res.status(201).json({ device });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// DELETE /api/iot/devices/:deviceId - Unregister device
router.delete('/devices/:deviceId', auth, async (req: AuthRequest, res: Response) => {
  try {
    const device = await IoTDevice.findOneAndDelete({
      deviceId: req.params.deviceId,
      ownerId: req.user?._id
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    // Also delete related records
    await DeviceEvent.deleteMany({ deviceId: req.params.deviceId });
    await DeviceCommand.deleteMany({ deviceId: req.params.deviceId });
    await DeviceHealth.deleteOne({ deviceId: req.params.deviceId });
    await Alert.deleteMany({ deviceId: req.params.deviceId });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

// ============== DEVICE EVENTS ==============

// POST /api/iot/events - Receive device event (from IoT devices)
router.post('/events', async (req: AuthRequest, res: Response) => {
  try {
    const { deviceId, eventType, value, unit, metadata } = req.body;
    
    // Verify device exists
    const device = await IoTDevice.findOne({ deviceId });
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    // Create event
    const event = new DeviceEvent({
      deviceId,
      kennelId: device.kennelId,
      eventType,
      value,
      unit,
      metadata,
      timestamp: new Date(),
    });
    
    await event.save();
    
    // Update device heartbeat
    device.lastHeartbeat = new Date();
    device.status = 'online';
    await device.save();
    
    // Update health
    await DeviceHealth.findOneAndUpdate(
      { deviceId },
      {
        isOnline: true,
        lastHeartbeat: new Date(),
        lastSeen: new Date(),
        missedHeartbeats: 0,
      }
    );
    
    // Check for alerts
    await checkAlerts(device, eventType, value);
    
    res.status(201).json({ success: true, event });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process event' });
  }
});

// GET /api/iot/devices/:deviceId/events - Get device events
router.get('/devices/:deviceId/events', auth, async (req: AuthRequest, res: Response) => {
  try {
    const { limit = 50, offset = 0, eventType } = req.query;
    
    const device = await IoTDevice.findOne({
      deviceId: req.params.deviceId,
      ownerId: req.user?._id
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    const query: any = { deviceId: req.params.deviceId };
    if (eventType) query.eventType = eventType;
    
    const events = await DeviceEvent.find(query)
      .sort({ timestamp: -1 })
      .skip(Number(offset))
      .limit(Number(limit));
    
    const total = await DeviceEvent.countDocuments(query);
    
    res.json({ events, total, limit: Number(limit), offset: Number(offset) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// ============== DEVICE COMMANDS ==============

// POST /api/iot/devices/:deviceId/command - Send command to device
router.post('/devices/:deviceId/command', auth, [
  body('command').notEmpty(),
], validate, async (req: AuthRequest, res: Response) => {
  try {
    const { command, params } = req.body;
    
    const device = await IoTDevice.findOne({
      deviceId: req.params.deviceId,
      ownerId: req.user?._id
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    // Create command
    const cmd = new DeviceCommand({
      commandId: `cmd_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      deviceId: req.params.deviceId,
      kennelId: device.kennelId,
      command,
      params,
      status: 'pending',
    });
    
    await cmd.save();
    
    // TODO: Publish to MQTT
    
    // Update command status to sent
    cmd.status = 'sent';
    cmd.sentAt = new Date();
    await cmd.save();
    
    res.status(201).json({ command: cmd });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send command' });
  }
});

// ============== DEVICE HEALTH ==============

// GET /api/iot/devices/:deviceId/health - Get device health
router.get('/devices/:deviceId/health', auth, async (req: AuthRequest, res: Response) => {
  try {
    const device = await IoTDevice.findOne({
      deviceId: req.params.deviceId,
      ownerId: req.user?._id
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    let health = await DeviceHealth.findOne({ deviceId: req.params.deviceId });
    
    if (!health) {
      health = new DeviceHealth({
        deviceId: req.params.deviceId,
        kennelId: device.kennelId,
        isOnline: false,
        lastHeartbeat: new Date(),
      });
      await health.save();
    }
    
    res.json({ health });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch health' });
  }
});

// GET /api/iot/kennels/:kennelId/devices - Get all devices in a kennel
router.get('/kennels/:kennelId/devices', auth, async (req: AuthRequest, res: Response) => {
  try {
    const devices = await IoTDevice.find({
      kennelId: req.params.kennelId,
      ownerId: req.user?._id
    });
    
    // Also get health for each device
    const deviceIds = devices.map(d => d.deviceId);
    const healthRecords = await DeviceHealth.find({ deviceId: { $in: deviceIds } });
    const healthMap = new Map(healthRecords.map(h => [h.deviceId, h]));
    
    const devicesWithHealth = devices.map(d => ({
      ...d.toObject(),
      health: healthMap.get(d.deviceId),
    }));
    
    res.json({ devices: devicesWithHealth });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch kennel devices' });
  }
});

// ============== ALERTS ==============

// GET /api/iot/alerts - Get alerts
router.get('/alerts', auth, async (req: AuthRequest, res: Response) => {
  try {
    const { acknowledged, resolved, limit = 50 } = req.query;
    
    // Get user's kennels
    const devices = await IoTDevice.find({ ownerId: req.user?._id });
    const kennelIds = [...new Set(devices.map(d => d.kennelId))];
    
    const query: any = { kennelId: { $in: kennelIds } };
    if (acknowledged !== undefined) query.acknowledged = acknowledged === 'true';
    if (resolved !== undefined) query.resolved = resolved === 'true';
    
    const alerts = await Alert.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit));
    
    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// PUT /api/iot/alerts/:alertId/acknowledge - Acknowledge alert
router.put('/alerts/:alertId/acknowledge', auth, async (req: AuthRequest, res: Response) => {
  try {
    const alert = await Alert.findOneAndUpdate(
      { alertId: req.params.alertId },
      {
        acknowledged: true,
        acknowledgedAt: new Date(),
        acknowledgedBy: req.user?._id,
      },
      { new: true }
    );
    
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    
    res.json({ alert });
  } catch (error) {
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

// ============== HELPER FUNCTIONS ==============

async function checkAlerts(device: any, eventType: string, value: any): Promise<void> {
  const alerts: Array<{alertType: string, severity: string, title: string, message: string}> = [];
  
  // Temperature alerts
  if (eventType === 'temperature') {
    if (value > 30) {
      alerts.push({
        alertType: 'temperature_high',
        severity: 'critical',
        title: 'High Temperature Alert',
        message: `${device.name} reports ${value}°C - too hot!`,
      });
    } else if (value < 10) {
      alerts.push({
        alertType: 'temperature_low',
        severity: 'warning',
        title: 'Low Temperature Alert',
        message: `${device.name} reports ${value}°C - too cold!`,
      });
    }
  }
  
  // Battery alerts
  if (eventType === 'battery' && value < 20) {
    alerts.push({
      alertType: 'battery_low',
      severity: 'warning',
      title: 'Low Battery',
      message: `${device.name} battery at ${value}%`,
    });
  }
  
  // Water/Food low alerts
  if (eventType === 'status') {
    if (device.deviceType === 'feeder' && value.foodLevel < 20) {
      alerts.push({
        alertType: 'food_low',
        severity: 'warning',
        title: 'Low Food',
        message: `${device.name} food level at ${value.foodLevel}%`,
      });
    }
    if (device.deviceType === 'water' && value.waterLevel < 20) {
      alerts.push({
        alertType: 'water_low',
        severity: 'warning',
        title: 'Low Water',
        message: `${device.name} water level at ${value.waterLevel}%`,
      });
    }
  }
  
  // Save alerts
  for (const a of alerts) {
    const alert = new Alert({
      alertId: `alert_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
      kennelId: device.kennelId,
      deviceId: device.deviceId,
      ...a,
    });
    await alert.save();
  }
}

export default router;
