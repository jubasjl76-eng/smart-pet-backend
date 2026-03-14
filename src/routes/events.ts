import { Router, Request, Response } from 'express';
import * as eventController from '../controllers/eventController.js';
import { auth } from '../middleware/auth.js';

const router = Router();

// GET /api/events
router.get('/', auth, eventController.getAllEvents);

// GET /api/events/stats
router.get('/stats', auth, eventController.getEventStats);

// GET /api/events/recent
router.get('/recent', auth, eventController.getRecentEvents);

// GET /api/events/:id
router.get('/:id', auth, eventController.getEventById);

// POST /api/events
router.post('/', auth, eventController.createEvent);

export default router;
