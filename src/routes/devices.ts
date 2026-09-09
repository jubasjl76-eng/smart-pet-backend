import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import * as deviceController from '../controllers/deviceController.js';

const router = Router();

const validate = (req: Request, res: Response, next: Function): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }
  next();
};

router.get('/', deviceController.getAllDevices);
router.post('/claim', deviceController.claimDevice);
router.post('/', [
  body('name').trim().notEmpty(),
  body('type').isIn(['feeder', 'water']),
], validate, deviceController.createDevice);
router.get('/:id/levels', deviceController.getDeviceLevels);
router.get('/:id', deviceController.getDeviceById);
router.put('/:id', [
  body('name').optional().trim().notEmpty(),
], validate, deviceController.updateDevice);
router.delete('/:id', deviceController.deleteDevice);
router.post('/:id/status', deviceController.updateDeviceStatus);
router.post('/:id/feed', deviceController.triggerFeed);
router.post('/:id/dispense', deviceController.triggerDispense);

export default router;
