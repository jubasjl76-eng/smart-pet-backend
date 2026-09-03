import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

vi.mock('../database/index.js', () => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
}));

import { queryOne, execute } from '../database/index.js';
import { adminOnly, auth, generateToken, ownerOnly, type AuthRequest } from '../middleware/auth.js';
import { deviceAuth, parseDeviceBasic, parseDeviceUsername } from '../middleware/deviceAuth.js';
import { canAdmin, isLocalRegisterAllowed, isOwner, mapRole } from '../identity/roles.js';
import { register } from '../controllers/authController.js';
import { getJwtSecret } from '../config.js';

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

describe('identity roles', () => {
  it('maps user → owner', () => {
    expect(mapRole('user')).toBe('owner');
    expect(mapRole('owner')).toBe('owner');
    expect(mapRole('staff')).toBe('staff');
    expect(isOwner('user')).toBe(true);
    expect(canAdmin('owner')).toBe(false);
    expect(canAdmin('staff')).toBe(true);
  });

  it('allows register only on localhost', () => {
    expect(isLocalRegisterAllowed({ ip: '127.0.0.1' })).toBe(true);
    expect(isLocalRegisterAllowed({ ip: '::1' })).toBe(true);
    expect(isLocalRegisterAllowed({ hostname: 'localhost' })).toBe(true);
    expect(isLocalRegisterAllowed({ ip: '8.8.8.8', hostname: 'api.example.com' })).toBe(false);
  });
});

describe('token issuer', () => {
  it('requires JWT_SECRET (no hardcoded fallback)', () => {
    expect(getJwtSecret()).toBeTruthy();
    expect(getJwtSecret()).not.toMatch(/smart-pet-secret-key-change-in-production/);
  });

  it('embeds mapped owner role', () => {
    const token = generateToken('user-1', 'user');
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    expect(decoded.userId).toBe('user-1');
    expect(decoded.role).toBe('owner');
  });

  it('embeds staff role on the same issuer', () => {
    const token = generateToken('staff-1', 'staff');
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    expect(decoded.role).toBe('staff');
  });
});

describe('owner vs staff middleware', () => {
  it('ownerOnly allows owner and rejects staff', () => {
    const next = vi.fn();
    const ownerRes = mockRes();
    ownerOnly({ user: { role: 'owner' } } as AuthRequest, ownerRes, next);
    expect(next).toHaveBeenCalledTimes(1);

    const staffRes = mockRes();
    const staffNext = vi.fn();
    ownerOnly({ user: { role: 'staff' } } as AuthRequest, staffRes, staffNext);
    expect(staffNext).not.toHaveBeenCalled();
    expect(staffRes.statusCode).toBe(403);
  });

  it('adminOnly allows staff and rejects owner', () => {
    const next = vi.fn();
    const staffRes = mockRes();
    adminOnly({ user: { role: 'staff' } } as AuthRequest, staffRes, next);
    expect(next).toHaveBeenCalledTimes(1);

    const ownerRes = mockRes();
    const ownerNext = vi.fn();
    adminOnly({ user: { role: 'owner' } } as AuthRequest, ownerRes, ownerNext);
    expect(ownerNext).not.toHaveBeenCalled();
    expect(ownerRes.statusCode).toBe(403);
    expect(ownerRes.body.error).toBe('Admin access required');
  });
});

describe('device credentials', () => {
  it('parses device:<id> Basic auth', () => {
    const header = 'Basic ' + Buffer.from('device:feeder-sim-001:unit-test-secret').toString('base64');
    expect(parseDeviceBasic(header)).toEqual({
      username: 'device:feeder-sim-001',
      password: 'unit-test-secret',
    });
    expect(parseDeviceUsername('device:feeder-sim-001')).toBe('feeder-sim-001');
    expect(parseDeviceUsername('owner@localhost')).toBeNull();
  });

  it('rejects X-API-Key as a product path', async () => {
    const res = mockRes();
    const next = vi.fn();
    await deviceAuth({ headers: { 'x-api-key': 'not-a-product-path' } } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/X-API-Key/);
  });

  it('rejects owner Bearer token as a device credential', async () => {
    const token = generateToken('owner-1', 'owner');
    const res = mockRes();
    const next = vi.fn();
    await deviceAuth({ headers: { authorization: `Bearer ${token}` } } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/not a device credential/);
  });

  it('accepts minted device Basic credentials', async () => {
    const secret = 'once-only-secret';
    const hash = await bcrypt.hash(secret, 4);
    vi.mocked(queryOne).mockResolvedValueOnce({
      device_id: 'feeder-sim-001',
      kennel_id: 'home',
      user_id: 'owner-1',
      mqtt_username: 'device:feeder-sim-001',
      mqtt_password_hash: hash,
    });
    const res = mockRes();
    const next = vi.fn();
    const req: any = {
      headers: {
        authorization: 'Basic ' + Buffer.from(`device:feeder-sim-001:${secret}`).toString('base64'),
      },
    };
    await deviceAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.deviceCred.deviceId).toBe('feeder-sim-001');
  });
});

describe('register', () => {
  beforeEach(() => {
    vi.mocked(queryOne).mockReset();
    vi.mocked(execute).mockReset();
  });

  it('is closed off localhost', async () => {
    const res = mockRes();
    await register({ ip: '203.0.113.5', hostname: 'example.com', body: { email: 'a@b.c', password: 'secret1', name: 'A' } } as any, res);
    expect(res.statusCode).toBe(403);
  });

  it('never mints staff', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'new-owner',
        email: 'a@b.c',
        name: 'A',
        role: 'owner',
        kennel_id: 'kennel-x',
      });
    vi.mocked(execute).mockResolvedValue();
    const res = mockRes();
    await register(
      {
        ip: '127.0.0.1',
        hostname: 'localhost',
        body: { email: 'a@b.c', password: 'secret1', name: 'A', role: 'staff' },
      } as any,
      res
    );
    expect(res.statusCode).toBe(201);
    expect(res.body.user.role).toBe('owner');
    const insert = vi.mocked(execute).mock.calls[0][0] as string;
    expect(insert).toMatch(/'owner'/);
    expect(insert).not.toMatch(/staff/);
  });
});

describe('auth middleware maps DB role user → owner', () => {
  it('loads owner from user role', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'u1',
      email: 'owner@localhost',
      name: 'O',
      role: 'user',
      kennel_id: 'home',
    });
    const token = generateToken('u1', 'user');
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = vi.fn();
    await auth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.role).toBe('owner');
  });
});
