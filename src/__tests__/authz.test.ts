import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

vi.mock('../database/index.js', () => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
}));

import { queryOne, execute } from '../database/index.js';
import {
  adminOnly,
  auth,
  generateToken,
  getJwtSecret,
  kidFor,
  ownerOnly,
  resolveVerificationSecret,
  type AuthRequest,
} from '../middleware/auth.js';
import { deviceAuth, parseDeviceBasic, parseDeviceUsername } from '../middleware/deviceAuth.js';
import { canAdmin, isLocalRegisterAllowed, isOwner, mapRole } from '../identity/roles.js';
import { register } from '../controllers/authController.js';

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
    const header =
      'Basic ' + Buffer.from('device:feeder-sim-001:unit-test-secret').toString('base64');
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
    await register(
      {
        ip: '203.0.113.5',
        hostname: 'example.com',
        body: { email: 'a@b.c', password: 'secret1', name: 'A' },
      } as any,
      res,
    );
    expect(res.statusCode).toBe(403);
  });

  it('never mints staff', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null) // existing-email check
      .mockResolvedValueOnce({
        // read-back of the new user
        id: 'new-owner',
        email: 'a@b.c',
        name: 'A',
        role: 'owner',
        kennel_id: 'kennel-x',
      })
      .mockResolvedValueOnce({ family: 'fam-1' }); // issueRefreshToken INSERT ... RETURNING family
    vi.mocked(execute).mockResolvedValue();
    const res = mockRes();
    await register(
      {
        ip: '127.0.0.1',
        hostname: 'localhost',
        headers: {},
        body: { email: 'a@b.c', password: 'secret1', name: 'A', role: 'staff' },
      } as any,
      res,
    );
    expect(res.statusCode).toBe(201);
    expect(res.body.user.role).toBe('owner');
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.accessToken).toBeTruthy();
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

// JWT key rotation (Phase 21, A12 #20). resolveVerificationSecret is pure
// (given the kid + current/previous secrets, not read from config), so the
// interesting branch logic is tested directly rather than by mutating the
// (frozen) config singleton or juggling module resets.
describe('JWT key rotation', () => {
  const current = 'current-secret';
  const previous = 'previous-secret';

  it('resolves the current key when the kid is absent (pre-rotation token format)', () => {
    expect(resolveVerificationSecret(undefined, current, previous)).toBe(current);
  });

  it('resolves the current key when the kid matches it', () => {
    expect(resolveVerificationSecret(kidFor(current), current, previous)).toBe(current);
  });

  it('resolves the previous key during its grace window', () => {
    expect(resolveVerificationSecret(kidFor(previous), current, previous)).toBe(previous);
  });

  it('rejects the previous key once the grace window closes (no previous secret given)', () => {
    expect(resolveVerificationSecret(kidFor(previous), current, undefined)).toBeNull();
  });

  it('rejects a kid matching neither key', () => {
    expect(resolveVerificationSecret('deadbeef', current, previous)).toBeNull();
  });

  it('generateToken embeds a kid derived from the current secret', () => {
    const token = generateToken('u1', 'user');
    const header = jwt.decode(token, { complete: true })!.header as { kid?: string };
    expect(header.kid).toBe(kidFor(process.env.JWT_SECRET!));
  });

  it('auth middleware still accepts a kid-less token (pre-rotation format) against the current secret', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'u1',
      email: 'o@x.io',
      name: 'O',
      role: 'user',
    });
    const legacyToken = jwt.sign({ userId: 'u1', role: 'owner' }, process.env.JWT_SECRET!); // no keyid
    const req: any = { headers: { authorization: `Bearer ${legacyToken}` } };
    const res = mockRes();
    const next = vi.fn();
    await auth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.id).toBe('u1');
  });
});
