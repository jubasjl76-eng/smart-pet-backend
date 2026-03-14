import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import * as deviceController from '../controllers/deviceController.js';
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

// GET /api/devices
router.get('/', auth, deviceController.getAllDevices);

// GET /api/devices/:id
router.get('/:id', auth, deviceController.getDeviceById);

// POST /api/devices
router.post('/', auth, [
  body('name').trim().notEmpty(),
  body('type').isIn(['feeder', 'water']),
], validate, deviceController.createDevice);

// PUT /api/devices/:id
router.put('/:id', auth, [
  body('name').optional().trim().notEmpty(),
], validate, deviceController.updateDevice);

// DELETE /api/devices/:id
router.delete('/:id', auth, deviceController.deleteDevice);

// POST /api/devices/:id/status
router.post('/:id/status', auth, deviceController.updateDeviceStatus);

// POST /api/devices/:id/feed
router.post('/:id/feed', auth, deviceController.triggerFeed);

// POST /api/devices/:id/dispense
router.post('/:id/dispense', auth, deviceController.triggerDispense);

export default router;
