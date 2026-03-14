import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { Device } from '../models/index.js';
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

// GET /api/devices - Get all user's devices
router.get('/', auth, async (req: AuthRequest, res: Response) => {
  try {
    const devices = await Device.find({ userId: req.user?._id }).sort({ createdAt: -1 });
    res.json({ devices });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// GET /api/devices/:id - Get single device
router.get('/:id', auth, async (req: AuthRequest, res: Response) => {
  try {
    const device = await Device.findOne({ 
      _id: req.params.id,
      userId: req.user?._id 
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

// POST /api/devices - Register new device
router.post('/', auth, [
  body('name').trim().notEmpty(),
  body('type').isIn(['feeder', 'water']),
], validate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, type } = req.body;
    
    const device = new Device({
      userId: req.user?._id,
      name,
      type,
      foodLevel: 100,
      waterLevel: 100,
    });
    
    await device.save();
    
    res.status(201).json({ device });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create device' });
  }
});

// PUT /api/devices/:id - Update device
router.put('/:id', auth, [
  body('name').optional().trim().notEmpty(),
], validate, async (req: AuthRequest, res: Response) => {
  try {
    const { name } = req.body;
    
    const device = await Device.findOne({ 
      _id: req.params.id,
      userId: req.user?._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    if (name) device.name = name;
    await device.save();
    
    res.json({ device });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update device' });
  }
});

// DELETE /api/devices/:id - Delete device
router.delete('/:id', auth, async (req: AuthRequest, res: Response) => {
  try {
    const device = await Device.findOneAndDelete({ 
      _id: req.params.id,
      userId: req.user?._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

// POST /api/devices/:id/status - Update device status (from IoT device)
router.post('/:id/status', auth, async (req: AuthRequest, res: Response) => {
  try {
    const { 
      food_level, 
      is_low_food, 
      water_level, 
      is_low_water, 
      tds, 
      temperature, 
      water_quality, 
      wifi_rssi, 
      uptime_ms 
    } = req.body;
    
    const device = await Device.findOne({ 
      _id: req.params.id,
      userId: req.user?._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    // Update fields
    if (food_level !== undefined) device.foodLevel = food_level;
    if (water_level !== undefined) device.waterLevel = water_level;
    if (is_low_food !== undefined) device.isLowFood = is_low_food;
    if (is_low_water !== undefined) device.isLowWater = is_low_water;
    if (tds !== undefined) device.tds = tds;
    if (temperature !== undefined) device.temperature = temperature;
    if (water_quality !== undefined) device.waterQuality = water_quality;
    if (wifi_rssi !== undefined) device.wifiRssi = wifi_rssi;
    if (uptime_ms !== undefined) device.uptimeMs = uptime_ms;
    
    device.isOnline = true;
    device.lastSeen = new Date();
    
    await device.save();
    
    res.json({ success: true, device });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// POST /api/devices/:id/feed - Trigger feeding
router.post('/:id/feed', auth, async (req: AuthRequest, res: Response) => {
  try {
    const device = await Device.findOne({ 
      _id: req.params.id,
      userId: req.user?._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    if (device.type !== 'feeder') {
      res.status(400).json({ error: 'Device is not a feeder' });
      return;
    }
    
    // In a real system, this would send command to the IoT device
    // For now, we just log the event
    
    res.json({ 
      success: true, 
      message: 'Feed command sent to device',
      device 
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to trigger feeding' });
  }
});

// POST /api/devices/:id/dispense - Trigger water dispense
router.post('/:id/dispense', auth, async (req: AuthRequest, res: Response) => {
  try {
    const device = await Device.findOne({ 
      _id: req.params.id,
      userId: req.user?._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    if (device.type !== 'water') {
      res.status(400).json({ error: 'Device is not a water dispenser' });
      return;
    }
    
    res.json({ 
      success: true, 
      message: 'Dispense command sent to device',
      device 
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to trigger dispense' });
  }
});

export default router;
