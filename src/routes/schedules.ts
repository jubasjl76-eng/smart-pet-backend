import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { z } from '@jubasjl76-eng/shared';
import { apiRoute } from '../openapi/index.js';
import * as scheduleController from '../controllers/scheduleController.js';
import { auth } from '../middleware/auth.js';

const router = Router();
const T = ['owner: schedules'];
const idParam = z.object({ id: z.string() });

const validate = (req: Request, res: Response, next: Function): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }
  next();
};

// GET /api/schedules
router.get(
  '/',
  apiRoute({ method: 'get', path: '/api/schedules', tags: T, secure: true, summary: 'All schedules for the owner.', responses: { 200: { description: 'ok' } } }),
  auth,
  scheduleController.getAllSchedules,
);

// GET /api/schedules/:id
router.get(
  '/:id',
  apiRoute({ method: 'get', path: '/api/schedules/{id}', tags: T, secure: true, summary: 'One schedule.', request: { params: idParam }, responses: { 200: { description: 'ok' }, 404: { description: 'not found' } } }),
  auth,
  scheduleController.getScheduleById,
);

// POST /api/schedules
router.post('/', apiRoute({ method: 'post', path: '/api/schedules', tags: T, secure: true, summary: 'Create a schedule.', responses: { 201: { description: 'created' }, 400: { description: 'validation' } } }), auth, [
  body('deviceId').notEmpty(),
  body('hour').isInt({ min: 0, max: 23 }),
  body('minute').isInt({ min: 0, max: 59 }),
  body('action').optional().isIn(['feed', 'dispense']),
  body('enabled').optional().isBoolean(),
], validate, scheduleController.createSchedule);

// PUT /api/schedules/:id
router.put('/:id', apiRoute({ method: 'put', path: '/api/schedules/{id}', tags: T, secure: true, summary: 'Update a schedule.', request: { params: idParam }, responses: { 200: { description: 'ok' }, 400: { description: 'validation' } } }), auth, [
  body('hour').optional().isInt({ min: 0, max: 23 }),
  body('minute').optional().isInt({ min: 0, max: 59 }),
  body('action').optional().isIn(['feed', 'dispense']),
  body('enabled').optional().isBoolean(),
], validate, scheduleController.updateSchedule);

// DELETE /api/schedules/:id
router.delete(
  '/:id',
  apiRoute({ method: 'delete', path: '/api/schedules/{id}', tags: T, secure: true, summary: 'Delete a schedule.', request: { params: idParam }, responses: { 200: { description: 'ok' } } }),
  auth,
  scheduleController.deleteSchedule,
);

// POST /api/schedules/:id/toggle
router.post(
  '/:id/toggle',
  apiRoute({ method: 'post', path: '/api/schedules/{id}/toggle', tags: T, secure: true, summary: 'Enable / disable a schedule.', request: { params: idParam }, responses: { 200: { description: 'ok' } } }),
  auth,
  scheduleController.toggleSchedule,
);

export default router;
