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
router.post('/claim', [
  body('deviceId').optional().trim().notEmpty(),
  body('name').optional().trim().notEmpty(),
], validate, deviceController.claimFeeder);
router.get('/:id/level', deviceController.getDeviceLevel);
router.post('/:id/feed', deviceController.triggerFeed);
router.get('/:id', deviceController.getDeviceById);

export default router;
