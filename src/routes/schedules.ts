import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import * as scheduleController from '../controllers/scheduleController.js';

const router = Router();

const validate = (req: Request, res: Response, next: Function): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }
  next();
};

router.get('/', scheduleController.getAllSchedules);
router.get('/:id', scheduleController.getScheduleById);
router.post('/', [
  body('deviceId').notEmpty(),
  body('time').optional().matches(/^([01]\d|2[0-3]):([0-5]\d)$/),
  body('hour').optional().isInt({ min: 0, max: 23 }),
  body('minute').optional().isInt({ min: 0, max: 59 }),
  body('amount').isFloat({ gt: 0 }),
  body('enabled').optional().isBoolean(),
], validate, scheduleController.createSchedule);
router.put('/:id', [
  body('time').optional().matches(/^([01]\d|2[0-3]):([0-5]\d)$/),
  body('hour').optional().isInt({ min: 0, max: 23 }),
  body('minute').optional().isInt({ min: 0, max: 59 }),
  body('amount').optional().isFloat({ gt: 0 }),
  body('enabled').optional().isBoolean(),
], validate, scheduleController.updateSchedule);
router.delete('/:id', scheduleController.deleteSchedule);
router.post('/:id/toggle', scheduleController.toggleSchedule);

export default router;
