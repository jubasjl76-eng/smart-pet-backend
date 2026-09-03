import { Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { queryOne } from '../database/index.js';
import type { AuthRequest } from './auth.js';
import { mqttUsername } from '../mqtt/contract.js';

export interface DeviceAuthRequest extends AuthRequest {
  deviceCred?: {
    deviceId: string;
    kennelId: string | null;
    userId: string | null;
  };
}

/**
 * Device MQTT credential over HTTP Basic.
 * Username must be device:<deviceId>. Owner JWT is not a device cred.
 * X-API-Key is not a product path.
 */
export function parseDeviceBasic(authorization: string | undefined): { username: string; password: string } | null {
  if (!authorization || !authorization.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function parseDeviceUsername(username: string): string | null {
  if (!username.startsWith('device:')) return null;
  const deviceId = username.slice('device:'.length);
  return deviceId ? deviceId : null;
}

export const deviceAuth = async (req: DeviceAuthRequest, res: Response, next: NextFunction): Promise<void> => {
  if (req.headers['x-api-key']) {
    res.status(401).json({ error: 'X-API-Key is not a product path' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Owner JWT is not a device credential' });
    return;
  }

  const parsed = parseDeviceBasic(authHeader);
  if (!parsed) {
    res.status(401).json({ error: 'Device credentials required' });
    return;
  }

  const deviceId = parseDeviceUsername(parsed.username);
  if (!deviceId) {
    res.status(401).json({ error: 'Device username must be device:<deviceId>' });
    return;
  }

  const row = await queryOne<any>(
    `SELECT device_id, kennel_id, user_id, mqtt_username, mqtt_password_hash
     FROM devices WHERE device_id = $1`,
    [deviceId]
  );

  if (!row || !row.mqtt_password_hash) {
    res.status(401).json({ error: 'Unknown device' });
    return;
  }

  if (row.mqtt_username && row.mqtt_username !== mqttUsername(deviceId)) {
    res.status(401).json({ error: 'Invalid device credentials' });
    return;
  }

  const ok = await bcrypt.compare(parsed.password, row.mqtt_password_hash);
  if (!ok) {
    res.status(401).json({ error: 'Invalid device credentials' });
    return;
  }

  req.deviceCred = {
    deviceId: row.device_id,
    kennelId: row.kennel_id,
    userId: row.user_id,
  };
  next();
};
