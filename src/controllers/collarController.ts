import { Request, Response } from 'express';
import { Device, Location, Dog, SafeZone, Alert } from '../models/index.js';

// ============== DOGS ==============

export const getDogs = async (req: Request, res: Response): Promise<void> => {
  try {
    const dogs = await Dog.find({ userId: (req as any).user._id })
      .populate('deviceId')
      .sort({ createdAt: -1 });
    res.json({ dogs });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dogs' });
  }
};

export const getDogById = async (req: Request, res: Response): Promise<void> => {
  try {
    const dog = await Dog.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    }).populate('deviceId');
    
    if (!dog) {
      res.status(404).json({ error: 'Dog not found' });
      return;
    }
    
    res.json({ dog });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dog' });
  }
};

export const createDog = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, breed, age, weight, photo, deviceId } = req.body;
    
    // Validate device exists and belongs to user
    const device = await Device.findOne({
      _id: deviceId,
      userId: (req as any).user._id,
      type: 'collar'
    });
    
    if (!device) {
      res.status(404).json({ error: 'Collar device not found' });
      return;
    }
    
    const dog = new Dog({
      userId: (req as any).user._id,
      deviceId: device._id,
      name,
      breed,
      age,
      weight,
      photo
    });
    
    await dog.save();
    res.status(201).json({ dog });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create dog profile' });
  }
};

export const updateDog = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, breed, age, weight, photo } = req.body;
    
    const dog = await Dog.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    });
    
    if (!dog) {
      res.status(404).json({ error: 'Dog not found' });
      return;
    }
    
    if (name) dog.name = name;
    if (breed) dog.breed = breed;
    if (age !== undefined) dog.age = age;
    if (weight !== undefined) dog.weight = weight;
    if (photo) dog.photo = photo;
    
    await dog.save();
    res.json({ dog });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update dog' });
  }
};

export const deleteDog = async (req: Request, res: Response): Promise<void> => {
  try {
    const dog = await Dog.findOneAndDelete({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    });
    
    if (!dog) {
      res.status(404).json({ error: 'Dog not found' });
      return;
    }
    
    // Delete associated safe zones
    await SafeZone.deleteMany({ dogId: dog._id });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete dog' });
  }
};

// ============== LOCATIONS ==============

export const getLocationHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { dogId, from, to, limit = 100 } = req.query;
    
    // Get dog to find device
    const dog = await Dog.findOne({
      _id: dogId,
      userId: (req as any).user._id
    });
    
    if (!dog) {
      res.status(404).json({ error: 'Dog not found' });
      return;
    }
    
    const query: any = { deviceId: dog.deviceId };
    
    if (from || to) {
      query.timestamp = {};
      if (from) query.timestamp.$gte = new Date(from as string);
      if (to) query.timestamp.$lte = new Date(to as string);
    }
    
    const locations = await Location.find(query)
      .sort({ timestamp: -1 })
      .limit(Number(limit));
    
    res.json({ locations });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch location history' });
  }
};

export const getLatestLocation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { dogId } = req.params;
    
    const dog = await Dog.findOne({
      _id: dogId,
      userId: (req as any).user._id
    });
    
    if (!dog) {
      res.status(404).json({ error: 'Dog not found' });
      return;
    }
    
    const location = await Location.findOne({ deviceId: dog.deviceId })
      .sort({ timestamp: -1 });
    
    res.json({ location });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch location' });
  }
};

// ============== SAFE ZONES ==============

export const getSafeZones = async (req: Request, res: Response): Promise<void> => {
  try {
    const { dogId } = req.query;
    
    const query: any = { userId: (req as any).user._id };
    if (dogId) query.dogId = dogId;
    
    const safeZones = await SafeZone.find(query).sort({ createdAt: -1 });
    res.json({ safeZones });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch safe zones' });
  }
};

export const createSafeZone = async (req: Request, res: Response): Promise<void> => {
  try {
    const { dogId, name, centerLat, centerLng, radius, notifyOnEnter, notifyOnExit } = req.body;
    
    // Verify dog belongs to user
    const dog = await Dog.findOne({
      _id: dogId,
      userId: (req as any).user._id
    });
    
    if (!dog) {
      res.status(404).json({ error: 'Dog not found' });
      return;
    }
    
    const safeZone = new SafeZone({
      userId: (req as any).user._id,
      dogId,
      name,
      centerLat,
      centerLng,
      radius,
      notifyOnEnter: notifyOnEnter ?? true,
      notifyOnExit: notifyOnExit ?? true
    });
    
    await safeZone.save();
    res.status(201).json({ safeZone });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create safe zone' });
  }
};

export const updateSafeZone = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, centerLat, centerLng, radius, active, notifyOnEnter, notifyOnExit } = req.body;
    
    const safeZone = await SafeZone.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    });
    
    if (!safeZone) {
      res.status(404).json({ error: 'Safe zone not found' });
      return;
    }
    
    if (name) safeZone.name = name;
    if (centerLat !== undefined) safeZone.centerLat = centerLat;
    if (centerLng !== undefined) safeZone.centerLng = centerLng;
    if (radius !== undefined) safeZone.radius = radius;
    if (active !== undefined) safeZone.active = active;
    if (notifyOnEnter !== undefined) safeZone.notifyOnEnter = notifyOnEnter;
    if (notifyOnExit !== undefined) safeZone.notifyOnExit = notifyOnExit;
    
    await safeZone.save();
    res.json({ safeZone });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update safe zone' });
  }
};

export const deleteSafeZone = async (req: Request, res: Response): Promise<void> => {
  try {
    const safeZone = await SafeZone.findOneAndDelete({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    });
    
    if (!safeZone) {
      res.status(404).json({ error: 'Safe zone not found' });
      return;
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete safe zone' });
  }
};

// ============== ALERTS ==============

export const getAlerts = async (req: Request, res: Response): Promise<void> => {
  try {
    const { dogId, unreadOnly, limit = 50 } = req.query;
    
    const query: any = { userId: (req as any).user._id };
    if (dogId) query.dogId = dogId;
    if (unreadOnly === 'true') query.read = false;
    
    const alerts = await Alert.find(query)
      .populate('dogId')
      .sort({ createdAt: -1 })
      .limit(Number(limit));
    
    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
};

export const markAlertRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const alert = await Alert.findOneAndUpdate(
      { _id: req.params.id, userId: (req as any).user._id },
      { read: true },
      { new: true }
    );
    
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    
    res.json({ alert });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark alert as read' });
  }
};

export const markAllAlertsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    await Alert.updateMany(
      { userId: (req as any).user._id, read: false },
      { read: true }
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark alerts as read' });
  }
};

export const getUnreadAlertCount = async (req: Request, res: Response): Promise<void> => {
  try {
    const count = await Alert.countDocuments({
      userId: (req as any).user._id,
      read: false
    });
    
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get alert count' });
  }
};

// ============== DEVICE MANAGEMENT ==============

export const registerCollarDevice = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, deviceId, firmware } = req.body;
    
    // Check if device already registered
    const existing = await Device.findOne({ deviceId });
    if (existing) {
      res.status(400).json({ error: 'Device already registered' });
      return;
    }
    
    const device = new Device({
      userId: (req as any).user._id,
      type: 'collar',
      name,
      deviceId,
      firmware: firmware || '1.0.0',
      status: 'offline',
      battery: 100,
      isOnline: false
    });
    
    await device.save();
    res.status(201).json({ device });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register device' });
  }
};

export const getCollarDevices = async (req: Request, res: Response): Promise<void> => {
  try {
    const devices = await Device.find({ 
      userId: (req as any).user._id,
      type: 'collar'
    }).sort({ lastSeen: -1 });
    
    res.json({ devices });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
};

export const updateCollarSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const { trackingInterval, sleepMode } = req.body;
    
    const device = await Device.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id,
      type: 'collar'
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    if (!device.settings) {
      device.settings = { trackingInterval: 60, sleepMode: false };
    }
    
    if (trackingInterval !== undefined) device.settings.trackingInterval = trackingInterval;
    if (sleepMode !== undefined) device.settings.sleepMode = sleepMode;
    
    await device.save();
    res.json({ device });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
};
