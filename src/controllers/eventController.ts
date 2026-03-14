import { Request, Response } from 'express';
import { Event, Device } from '../models/index.js';

export const getAllEvents = async (req: Request, res: Response): Promise<void> => {
  try {
    const { device_id, limit = 50, offset = 0 } = req.query;
    
    const query: any = { userId: (req as any).user._id };
    if (device_id) query.deviceId = device_id;
    
    const events = await Event.find(query)
      .populate('deviceId', 'name type')
      .sort({ timestamp: -1 })
      .skip(Number(offset))
      .limit(Number(limit));
    
    const total = await Event.countDocuments(query);
    
    res.json({ events, total, limit: Number(limit), offset: Number(offset) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch events' });
  }
};

export const getEventById = async (req: Request, res: Response): Promise<void> => {
  try {
    const event = await Event.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    }).populate('deviceId', 'name type');
    
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    
    res.json({ event });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch event' });
  }
};

export const createEvent = async (req: Request, res: Response): Promise<void> => {
  try {
    const { device_id, type, action, success, message } = req.body;
    
    const device = await Device.findOne({ 
      _id: device_id,
      userId: (req as any).user._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    const event = new Event({
      userId: (req as any).user._id,
      deviceId: device_id,
      type: type || 'api',
      action,
      success: success !== false,
      message,
    });
    
    await event.save();
    
    res.status(201).json({ event });
  } catch (error) {
    res.status(500).json({ error: 'Failed to log event' });
  }
};

export const getEventStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user._id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    const todayEvents = await Event.countDocuments({
      userId,
      timestamp: { $gte: today },
    });
    
    const weekEvents = await Event.countDocuments({
      userId,
      timestamp: { $gte: weekAgo },
    });
    
    const byType = await Event.aggregate([
      { $match: { userId } },
      { $group: { _id: '$action', count: { $sum: 1 } } },
    ]);
    
    const byDevice = await Event.aggregate([
      { $match: { userId } },
      { $group: { _id: '$deviceId', count: { $sum: 1 } } },
      { $lookup: { from: 'devices', localField: '_id', foreignField: '_id', as: 'device' } },
      { $unwind: '$device' },
      { $project: { name: '$device.name', type: '$device.type', count: 1 } },
    ]);
    
    res.json({
      today: todayEvents,
      thisWeek: weekEvents,
      byType: byType.reduce((acc, curr) => ({ ...acc, [curr._id]: curr.count }), {}),
      byDevice,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
};

export const getRecentEvents = async (req: Request, res: Response): Promise<void> => {
  try {
    const { limit = 10 } = req.query;
    
    const events = await Event.find({ userId: (req as any).user._id })
      .populate('deviceId', 'name type')
      .sort({ timestamp: -1 })
      .limit(Number(limit));
    
    res.json({ events });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch recent events' });
  }
};
