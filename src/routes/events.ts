import { Router } from 'express';
import * as eventController from '../controllers/eventController.js';

const router = Router();

router.get('/', eventController.getAllEvents);
router.get('/stats', eventController.getEventStats);
router.get('/recent', eventController.getRecentEvents);
router.get('/:id', eventController.getEventById);
router.post('/', eventController.createEvent);

export default router;
