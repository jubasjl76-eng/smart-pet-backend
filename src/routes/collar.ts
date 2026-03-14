import { Router } from 'express';
import {
  getDogs,
  getDogById,
  createDog,
  updateDog,
  deleteDog,
  getLocationHistory,
  getLatestLocation,
  getSafeZones,
  createSafeZone,
  updateSafeZone,
  deleteSafeZone,
  getAlerts,
  markAlertRead,
  markAllAlertsRead,
  getUnreadAlertCount,
  registerCollarDevice,
  getCollarDevices,
  updateCollarSettings
} from '../controllers/collarController.js';

const router = Router();

// Device registration
router.post('/devices/register', registerCollarDevice);
router.get('/devices', getCollarDevices);
router.put('/devices/:id/settings', updateCollarSettings);

// Dogs
router.get('/dogs', getDogs);
router.get('/dogs/:id', getDogById);
router.post('/dogs', createDog);
router.put('/dogs/:id', updateDog);
router.delete('/dogs/:id', deleteDog);

// Locations
router.get('/locations', getLocationHistory);
router.get('/locations/latest/:dogId', getLatestLocation);

// Safe Zones
router.get('/safezones', getSafeZones);
router.post('/safezones', createSafeZone);
router.put('/safezones/:id', updateSafeZone);
router.delete('/safezones/:id', deleteSafeZone);

// Alerts
router.get('/alerts', getAlerts);
router.get('/alerts/unread-count', getUnreadAlertCount);
router.put('/alerts/:id/read', markAlertRead);
router.put('/alerts/read-all', markAllAlertsRead);

export default router;
