import { Router } from 'express';
import { ah, bad, need } from '../http.js';
import {
  createPairing, listOpenPairings, cancelPairing, claimByPairing, listDevices,
  DEVICE_TYPES, type DeviceType,
} from '../devices.js';

const router = Router();

// GET /api/breeder/ops/devices — every device in the kennel
router.get('/', ah(async (req, res) => {
  res.json({ devices: await listDevices(req.kennelId!) });
}));

// POST /api/breeder/ops/devices/pairing — mint a short code for a device to claim itself
router.post('/pairing', ah(async (req, res) => {
  const err = need(req.body, ['deviceType']);
  if (err) return bad(res, err);
  if (!(DEVICE_TYPES as readonly string[]).includes(req.body.deviceType)) {
    return bad(res, `deviceType must be one of: ${DEVICE_TYPES.join(', ')}`);
  }
  const { code, expiresAt } = await createPairing({
    kennelId: req.kennelId!,
    deviceType: req.body.deviceType as DeviceType,
    suggestedName: req.body.name,
    penId: req.body.penId ?? null,
    createdBy: req.user?.id ?? null,
  });
  res.status(201).json({ code, expiresAt });
}));

router.get('/pairing', ah(async (req, res) => {
  res.json({ pairings: await listOpenPairings(req.kennelId!) });
}));

router.delete('/pairing/:code', ah(async (req, res) => {
  const ok = await cancelPairing(String(req.params.code), req.kennelId!);
  res.status(ok ? 200 : 404).json({ ok });
}));

// POST /api/breeder/ops/devices/claim — { code, deviceId, name?, penId? }
// Returns the device + its MQTT credentials (password shown once).
router.post('/claim', ah(async (req, res) => {
  const err = need(req.body, ['code', 'deviceId']);
  if (err) return bad(res, err);
  try {
    const result = await claimByPairing({
      code: String(req.body.code),
      deviceId: String(req.body.deviceId),
      kennelId: req.kennelId!,
      name: req.body.name,
      claimedBy: req.user?.id ?? null,
    });
    res.status(201).json(result);
  } catch (e) {
    return bad(res, (e as Error).message, 409);
  }
}));

export default router;
