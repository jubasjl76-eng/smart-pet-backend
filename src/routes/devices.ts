import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { z } from '@jubasjl76-eng/shared';
import { apiRoute } from '../openapi/index.js';
import { idempotent } from '../middleware/idempotency.js';
import * as deviceController from '../controllers/deviceController.js';

const router = Router();
const T = ['owner: devices'];
const idParam = z.object({ id: z.string() });

const validate = (req: Request, res: Response, next: NextFunction): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }
  next();
};

// OpenAPI registration is doc-only here — express-validator stays the request
// validator for the write routes.
router.get(
  '/',
  apiRoute({
    method: 'get',
    path: '/api/devices',
    tags: T,
    secure: true,
    summary: 'All devices for the owner.',
    responses: { 200: { description: 'ok' } },
  }),
  deviceController.getAllDevices,
);
router.post(
  '/claim',
  apiRoute({
    method: 'post',
    path: '/api/devices/claim',
    tags: T,
    secure: true,
    idempotent: true,
    summary: 'Claim a device (issues MQTT creds once).',
    responses: { 201: { description: 'claimed' } },
  }),
  idempotent(),
  deviceController.claimDevice,
);
router.post(
  '/',
  apiRoute({
    method: 'post',
    path: '/api/devices',
    tags: T,
    secure: true,
    summary: 'Create a device.',
    responses: { 201: { description: 'created' }, 400: { description: 'validation' } },
  }),
  [body('name').trim().notEmpty(), body('type').isIn(['feeder', 'water'])],
  validate,
  deviceController.createDevice,
);
router.get(
  '/:id/levels',
  apiRoute({
    method: 'get',
    path: '/api/devices/{id}/levels',
    tags: T,
    secure: true,
    summary: 'Food / water levels for a device.',
    request: { params: idParam },
    responses: { 200: { description: 'ok' } },
  }),
  deviceController.getDeviceLevels,
);
router.get(
  '/:id',
  apiRoute({
    method: 'get',
    path: '/api/devices/{id}',
    tags: T,
    secure: true,
    summary: 'One device.',
    request: { params: idParam },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  deviceController.getDeviceById,
);
router.put(
  '/:id',
  apiRoute({
    method: 'put',
    path: '/api/devices/{id}',
    tags: T,
    secure: true,
    summary: 'Update a device.',
    request: { params: idParam },
    responses: { 200: { description: 'ok' }, 400: { description: 'validation' } },
  }),
  [body('name').optional().trim().notEmpty()],
  validate,
  deviceController.updateDevice,
);
router.delete(
  '/:id',
  apiRoute({
    method: 'delete',
    path: '/api/devices/{id}',
    tags: T,
    secure: true,
    summary: 'Delete a device.',
    request: { params: idParam },
    responses: { 200: { description: 'ok' } },
  }),
  deviceController.deleteDevice,
);
router.post(
  '/:id/status',
  apiRoute({
    method: 'post',
    path: '/api/devices/{id}/status',
    tags: T,
    secure: true,
    summary: 'Update reported device status.',
    request: { params: idParam },
    responses: { 200: { description: 'ok' } },
  }),
  deviceController.updateDeviceStatus,
);
router.post(
  '/:id/feed',
  apiRoute({
    method: 'post',
    path: '/api/devices/{id}/feed',
    tags: T,
    secure: true,
    idempotent: true,
    summary: 'Trigger a feed (waits for device ack).',
    request: { params: idParam },
    responses: { 200: { description: 'ok' } },
  }),
  idempotent(),
  deviceController.triggerFeed,
);
router.post(
  '/:id/dispense',
  apiRoute({
    method: 'post',
    path: '/api/devices/{id}/dispense',
    tags: T,
    secure: true,
    summary: 'Trigger a water dispense.',
    request: { params: idParam },
    responses: { 200: { description: 'ok' } },
  }),
  deviceController.triggerDispense,
);

export default router;
