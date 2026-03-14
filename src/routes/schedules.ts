import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { Schedule, Device } from '../models/index.js';
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

// GET /api/schedules - Get all user's schedules
router.get('/', auth, async (req: AuthRequest, res: Response) => {
  try {
    const { device_id } = req.query;
    
    const query: any = { userId: req.user?._id };
    if (device_id) query.deviceId = device_id;
    
    const schedules = await Schedule.find(query)
      .populate('deviceId', 'name type')
      .sort({ hour: 1, minute: 1 });
    
    res.json({ schedules });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch schedules' });
  }
});

// POST /api/schedules - Create schedule
router.post('/', auth, [
  body('deviceId').notEmpty(),
  body('hour').isInt({ min: 0, max: 23 }),
  body('minute').isInt({ min: 0, max: 59 }),
  body('action').optional().isIn(['feed', 'dispense']),
  body('enabled').optional().isBoolean(),
], validate, async (req: AuthRequest, res: Response) => {
  try {
    const { deviceId, hour, minute, action, enabled } = req.body;
    
    // Verify device belongs to user
    const device = await Device.findOne({ 
      _id: deviceId,
      userId: req.user?._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    const schedule = new Schedule({
      userId: req.user?._id,
      deviceId,
      hour,
      minute,
      action: action || (device.type === 'feeder' ? 'feed' : 'dispense'),
      enabled: enabled !== false,
    });
    
    await schedule.save();
    
    res.status(201).json({ schedule });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create schedule' });
  }
});

// PUT /api/schedules/:id - Update schedule
router.put('/:id', auth, [
  body('hour').optional().isInt({ min: 0, max: 23 }),
  body('minute').optional().isInt({ min: 0, max: 59 }),
  body('action').optional().isIn(['feed', 'dispense']),
  body('enabled').optional().isBoolean(),
], validate, async (req: AuthRequest, res: Response) => {
  try {
    const { hour, minute, action, enabled } = req.body;
    
    const schedule = await Schedule.findOne({ 
      _id: req.params.id,
      userId: req.user?._id 
    });
    
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    
    if (hour !== undefined) schedule.hour = hour;
    if (minute !== undefined) schedule.minute = minute;
    if (action !== undefined) schedule.action = action;
    if (enabled !== undefined) schedule.enabled = enabled;
    
    await schedule.save();
    
    res.json({ schedule });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// DELETE /api/schedules/:id - Delete schedule
router.delete('/:id', auth, async (req: AuthRequest, res: Response) => {
  try {
    const schedule = await Schedule.findOneAndDelete({ 
      _id: req.params.id,
      userId: req.user?._id 
    });
    
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
});

export default router;
