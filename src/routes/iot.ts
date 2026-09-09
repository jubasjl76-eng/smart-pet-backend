/**
 * Device HTTP ingress. Owner JWT is not accepted here.
 * Feed Now success is MQTT ack+status, not POST /api/iot/events.
 */
import { Router, Response } from 'express';
import { deviceAuth, DeviceAuthRequest } from '../middleware/deviceAuth.js';
import { execute } from '../database/index.js';

const router = Router();

router.post('/events', deviceAuth, async (req: DeviceAuthRequest, res: Response) => {
  try {
    const { eventType, value, unit, metadata } = req.body || {};
    const deviceId = req.deviceCred!.deviceId;
    if (req.body?.deviceId && req.body.deviceId !== deviceId) {
      res.status(403).json({ error: 'deviceId does not match credentials' });
      return;
    }
    await execute(
      `INSERT INTO device_events (user_id, device_id, event_type, value, unit, kennel_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.deviceCred!.userId,
        deviceId,
        eventType || 'unknown',
        value ?? null,
        unit || null,
        req.deviceCred!.kennelId,
        JSON.stringify(metadata || {}),
      ]
    );
    res.status(201).json({ success: true });
  } catch (error) {
    console.error('iot event error:', error);
    res.status(500).json({ error: 'Failed to process event' });
  }
});

export default router;
