import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import * as scheduleController from '../controllers/scheduleController.js';
import { auth } from '../middleware/auth.js';

const router = Router();

const validate = (req: Request, res: Response, next: Function): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }
  next();
};

// GET /api/schedules
router.get('/', auth, scheduleController.getAllSchedules);

// GET /api/schedules/:id
router.get('/:id', auth, scheduleController.getScheduleById);

// POST /api/schedules
router.post('/', auth, [
  body('deviceId').notEmpty(),
  body('hour').isInt({ min: 0, max: 23 }),
  body('minute').isInt({ min: 0, max: 59 }),
  body('action').optional().isIn(['feed', 'dispense']),
  body('enabled').optional().isBoolean(),
], validate, scheduleController.createSchedule);

// PUT /api/schedules/:id
router.put('/:id', auth, [
  body('hour').optional().isInt({ min: 0, max: 23 }),
  body('minute').optional().isInt({ min: 0, max: 59 }),
  body('action').optional().isIn(['feed', 'dispense']),
  body('enabled').optional().isBoolean(),
], validate, scheduleController.updateSchedule);

// DELETE /api/schedules/:id
router.delete('/:id', auth, scheduleController.deleteSchedule);

// POST /api/schedules/:id/toggle
router.post('/:id/toggle', auth, scheduleController.toggleSchedule);

export default router;
