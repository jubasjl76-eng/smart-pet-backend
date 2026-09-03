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

router.get('/', auth, deviceController.getAllDevices);
router.post('/claim', auth, deviceController.claimDevice);
router.get('/:id', auth, deviceController.getDeviceById);
router.post('/', auth, [
  body('name').trim().notEmpty(),
  body('type').isIn(['feeder', 'water']),
], validate, deviceController.createDevice);
router.put('/:id', auth, [
  body('name').optional().trim().notEmpty(),
], validate, deviceController.updateDevice);
router.delete('/:id', auth, deviceController.deleteDevice);
router.post('/:id/status', auth, deviceController.updateDeviceStatus);
router.post('/:id/feed', auth, deviceController.triggerFeed);
router.post('/:id/dispense', auth, deviceController.triggerDispense);

export default router;
