import { Router, Response } from 'express';
import { Event, Device } from '../models/index.js';
import { auth, AuthRequest } from '../middleware/auth.js';

const router = Router();

// GET /api/events - Get all user's events
router.get('/', auth, async (req: AuthRequest, res: Response) => {
  try {
    const { device_id, limit = 50, offset = 0 } = req.query;
    
    const query: any = { userId: req.user?._id };
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
});

// GET /api/events/:id - Get single event
router.get('/:id', auth, async (req: AuthRequest, res: Response) => {
  try {
    const event = await Event.findOne({ 
      _id: req.params.id,
      userId: req.user?._id 
    }).populate('deviceId', 'name type');
    
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    
    res.json({ event });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// POST /api/events - Log event (from IoT device)
router.post('/', auth, async (req: AuthRequest, res: Response) => {
  try {
    const { device_id, type, action, success, message } = req.body;
    
    // Verify device belongs to user
    const device = await Device.findOne({ 
      _id: device_id,
      userId: req.user?._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    const event = new Event({
      userId: req.user?._id,
      deviceId: device_id,
      type: type || 'api',
      action,
      success: success !== false,
      message,
      timestamp: new Date(),
    });
    
    await event.save();
    
    res.status(201).json({ event });
  } catch (error) {
    res.status(500).json({ error: 'Failed to log event' });
  }
});

// GET /api/events/stats - Get event statistics
router.get('/stats/summary', auth, async (req: AuthRequest, res: Response) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    // Today's events
    const todayEvents = await Event.countDocuments({
      userId: req.user?._id,
      timestamp: { $gte: today },
    });
    
    // This week's events
    const weekEvents = await Event.countDocuments({
      userId: req.user?._id,
      timestamp: { $gte: weekAgo },
    });
    
    // By type
    const byType = await Event.aggregate([
      { $match: { userId: req.user?._id } },
      { $group: { _id: '$action', count: { $sum: 1 } } },
    ]);
    
    // By device
    const byDevice = await Event.aggregate([
      { $match: { userId: req.user?._id } },
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
});

export default router;
