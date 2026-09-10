import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import { ah, bad } from '../http.js';
import { apiRoute } from '../../openapi/index.js';
import {
  createPairing, listOpenPairings, cancelPairing, claimByPairing, listDevices,
  DEVICE_TYPES, type DeviceType,
} from '../devices.js';

const router = Router();
const T = ['breeder: devices'];

// GET /api/breeder/ops/devices — every device in the kennel
router.get(
  '/',
  apiRoute({
    method: 'get', path: '/api/breeder/ops/devices', tags: T, secure: true,
    summary: 'Every device in the kennel.',
    responses: { 200: { description: 'ok', schema: z.object({ devices: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  res.json({ devices: await listDevices(req.kennelId!) });
}),
);

// POST /api/breeder/ops/devices/pairing — mint a short code for a device to claim itself
router.post(
  '/pairing',
  apiRoute({
    method: 'post', path: '/api/breeder/ops/devices/pairing', tags: T, secure: true,
    summary: 'Mint a short pairing code for a device to claim itself.',
    request: {
      body: z.object({
        deviceType: z.enum(DEVICE_TYPES),
        name: z.string().optional(),
        penId: z.string().nullable().optional(),
      }),
    },
    responses: { 201: { description: 'created' } },
  }),
  ah(async (req, res) => {
  const { code, expiresAt } = await createPairing({
    kennelId: req.kennelId!,
    deviceType: req.body.deviceType as DeviceType,
    suggestedName: req.body.name,
    penId: req.body.penId ?? null,
    createdBy: req.user?.id ?? null,
  });
  res.status(201).json({ code, expiresAt });
}),
);

router.get(
  '/pairing',
  apiRoute({
    method: 'get', path: '/api/breeder/ops/devices/pairing', tags: T, secure: true,
    summary: 'Open (unclaimed) pairing codes.',
    responses: { 200: { description: 'ok', schema: z.object({ pairings: z.array(z.record(z.string(), z.unknown())) }) } },
  }),
  ah(async (req, res) => {
  res.json({ pairings: await listOpenPairings(req.kennelId!) });
}),
);

router.delete(
  '/pairing/:code',
  apiRoute({
    method: 'delete', path: '/api/breeder/ops/devices/pairing/{code}', tags: T, secure: true,
    summary: 'Cancel a pairing code.',
    request: { params: z.object({ code: z.string() }) },
    responses: { 200: { description: 'ok' }, 404: { description: 'not found' } },
  }),
  ah(async (req, res) => {
  const ok = await cancelPairing(String(req.params.code), req.kennelId!);
  res.status(ok ? 200 : 404).json({ ok });
}),
);

// POST /api/breeder/ops/devices/claim — { code, deviceId, name?, penId? }
// Returns the device + its MQTT credentials (password shown once).
router.post(
  '/claim',
  apiRoute({
    method: 'post', path: '/api/breeder/ops/devices/claim', tags: T, secure: true,
    summary: 'Claim a device by pairing code (returns MQTT creds once).',
    request: {
      body: z.object({
        code: z.string().min(1),
        deviceId: z.string().min(1),
        name: z.string().optional(),
        penId: z.string().nullable().optional(),
      }),
    },
    responses: { 201: { description: 'claimed' }, 409: { description: 'claim failed' } },
  }),
  ah(async (req, res) => {
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
}),
);

export default router;
