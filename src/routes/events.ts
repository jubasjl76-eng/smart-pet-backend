import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { apiRoute } from '../openapi/index.js';
import * as eventController from '../controllers/eventController.js';

const router = Router();
const T = ['owner: events'];

router.get(
  '/',
  apiRoute({ method: 'get', path: '/api/events', tags: T, secure: true, summary: 'Feed / device events for the owner.', responses: { 200: { description: 'ok' } } }),
  eventController.getAllEvents,
);
router.get(
  '/stats',
  apiRoute({ method: 'get', path: '/api/events/stats', tags: T, secure: true, summary: 'Aggregate event stats.', responses: { 200: { description: 'ok' } } }),
  eventController.getEventStats,
);
router.get(
  '/recent',
  apiRoute({ method: 'get', path: '/api/events/recent', tags: T, secure: true, summary: 'Most recent events.', responses: { 200: { description: 'ok' } } }),
  eventController.getRecentEvents,
);
router.get(
  '/:id',
  apiRoute({ method: 'get', path: '/api/events/{id}', tags: T, secure: true, summary: 'One event.', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'ok' }, 404: { description: 'not found' } } }),
  eventController.getEventById,
);
router.post(
  '/',
  apiRoute({ method: 'post', path: '/api/events', tags: T, secure: true, summary: 'Record an event.', responses: { 201: { description: 'created' } } }),
  eventController.createEvent,
);

export default router;
