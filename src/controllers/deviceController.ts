import { Request, Response } from 'express';
import { Device, Event } from '../models/index.js';

export const getAllDevices = async (req: Request, res: Response): Promise<void> => {
  try {
    const devices = await Device.find({ userId: (req as any).user._id }).sort({ createdAt: -1 });
    res.json({ devices });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
};

export const getDeviceById = async (req: Request, res: Response): Promise<void> => {
  try {
    const device = await Device.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    res.json({ device });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch device' });
  }
};

export const createDevice = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, type } = req.body;
    
    const device = new Device({
      userId: (req as any).user._id,
      name,
      type,
      foodLevel: 100,
      waterLevel: 100,
    });
    
    await device.save();
    
    // Also add to user's device list
    const user = (req as any).user;
    user.devices.push(device._id);
    await user.save();
    
    res.status(201).json({ device });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create device' });
  }
};

export const updateDevice = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name } = req.body;
    
    const device = await Device.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id 
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
};

export const deleteDevice = async (req: Request, res: Response): Promise<void> => {
  try {
    const device = await Device.findOneAndDelete({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    // Also delete associated schedules and events
    await import('../models/index.js').then(m => m.Schedule).deleteMany({ deviceId: req.params.id });
    await import('../models/index.js').then(m => m.Event).deleteMany({ deviceId: req.params.id });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete device' });
  }
};

export const updateDeviceStatus = async (req: Request, res: Response): Promise<void> => {
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
      userId: (req as any).user._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
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
};

export const triggerFeed = async (req: Request, res: Response): Promise<void> => {
  try {
    const device = await Device.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    if (device.type !== 'feeder') {
      res.status(400).json({ error: 'Device is not a feeder' });
      return;
    }
    
    // Log the event
    const event = new Event({
      userId: (req as any).user._id,
      deviceId: device._id,
      type: 'manual',
      action: 'feed',
      success: true,
      message: 'Feed triggered via app',
    });
    await event.save();
    
    res.json({ 
      success: true, 
      message: 'Feed command sent to device',
      event 
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to trigger feeding' });
  }
};

export const triggerDispense = async (req: Request, res: Response): Promise<void> => {
  try {
    const device = await Device.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    if (device.type !== 'water') {
      res.status(400).json({ error: 'Device is not a water dispenser' });
      return;
    }
    
    // Log the event
    const event = new Event({
      userId: (req as any).user._id,
      deviceId: device._id,
      type: 'manual',
      action: 'dispense',
      success: true,
      message: 'Dispense triggered via app',
    });
    await event.save();
    
    res.json({ 
      success: true, 
      message: 'Dispense command sent to device',
      event 
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to trigger dispense' });
  }
};
