import { Request, Response } from 'express';
import { Schedule, Device } from '../models/index.js';

export const getAllSchedules = async (req: Request, res: Response): Promise<void> => {
  try {
    const { device_id } = req.query;
    
    const query: any = { userId: (req as any).user._id };
    if (device_id) query.deviceId = device_id;
    
    const schedules = await Schedule.find(query)
      .populate('deviceId', 'name type')
      .sort({ hour: 1, minute: 1 });
    
    res.json({ schedules });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch schedules' });
  }
};

export const getScheduleById = async (req: Request, res: Response): Promise<void> => {
  try {
    const schedule = await Schedule.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    }).populate('deviceId', 'name type');
    
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    
    res.json({ schedule });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
};

export const createSchedule = async (req: Request, res: Response): Promise<void> => {
  try {
    const { deviceId, hour, minute, action, enabled } = req.body;
    
    // Verify device belongs to user
    const device = await Device.findOne({ 
      _id: deviceId,
      userId: (req as any).user._id 
    });
    
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    
    const schedule = new Schedule({
      userId: (req as any).user._id,
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
};

export const updateSchedule = async (req: Request, res: Response): Promise<void> => {
  try {
    const { hour, minute, action, enabled } = req.body;
    
    const schedule = await Schedule.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id 
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
};

export const deleteSchedule = async (req: Request, res: Response): Promise<void> => {
  try {
    const schedule = await Schedule.findOneAndDelete({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    });
    
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
};

export const toggleSchedule = async (req: Request, res: Response): Promise<void> => {
  try {
    const schedule = await Schedule.findOne({ 
      _id: req.params.id,
      userId: (req as any).user._id 
    });
    
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    
    schedule.enabled = !schedule.enabled;
    await schedule.save();
    
    res.json({ schedule });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle schedule' });
  }
};
