import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { queryOne } from '../database/index.js';
import { canAdmin, isOwner, mapRole, type Role } from '../identity/roles.js';
import { config } from '../config/index.js';

export interface AuthUser {
  id: string;
  _id: string;
  email: string;
  name: string | null;
  role: Role;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

// JWT keyset with a grace window (Phase 21, A12 #20). A deterministic `kid`
// derived from the secret itself — no separate kid to keep in sync with it,
// no operator error possible there. New tokens are always signed with the
// CURRENT secret; JWT_SECRET_PREVIOUS (if set) verifies tokens signed
// before a rotation until they naturally expire (ACCESS_TTL) or the
// operator unsets it to close the grace window early — see
// runbooks/key-rotation.md.
export function kidFor(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

/** Pure — resolve the verification secret for a token's `kid` given the
 * current + optional previous secret. `null` for anything that isn't
 * either (an unknown key — reject, don't guess). Exported for testing
 * without needing to mutate the (frozen) config singleton; `secretForKid`
 * below is the thin config-reading wrapper actually used at request time. */
export function resolveVerificationSecret(
  kid: string | undefined,
  current: string,
  previous?: string,
): string | null {
  if (!kid || kid === kidFor(current)) return current;
  if (previous && kid === kidFor(previous)) return previous;
  return null;
}

function requireJwtSecret(): string {
  return config.JWT_SECRET;
}

export function getJwtSecret(): string {
  return requireJwtSecret();
}

function secretForKid(kid: string | undefined): string | null {
  return resolveVerificationSecret(kid, config.JWT_SECRET, config.JWT_SECRET_PREVIOUS);
}

export const auth = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    // `?token=` fallback for EventSource (SSE), which can't set headers.
    const queryToken = typeof req.query?.token === 'string' ? req.query.token : null;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : queryToken;
    if (!token) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    const header = jwt.decode(token, { complete: true })?.header as { kid?: string } | undefined;
    const secret = secretForKid(header?.kid);
    if (!secret) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    const decoded = jwt.verify(token, secret) as { userId: string; role?: string };
    const user = await queryOne<any>(
      'SELECT id, email, name, role, active FROM users WHERE id = $1',
      [decoded.userId],
    );
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    if (user.active === false) {
      res.status(403).json({ error: 'Account deactivated' });
      return;
    }
    const role = mapRole(user.role);
    req.user = { id: user.id, _id: user.id, email: user.email, name: user.name, role };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

/** Staff-only. Owner cannot pass adminOnly. */
export const adminOnly = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user || !canAdmin(req.user.role)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};

/** Short-lived access token. Pair with a rotating refresh token (src/auth/tokens.ts). */
export const ACCESS_TTL = process.env.ACCESS_TTL || '12h';

export const generateToken = (userId: string, role?: string): string => {
  const secret = requireJwtSecret();
  return jwt.sign({ userId, role: mapRole(role) }, secret, {
    expiresIn: ACCESS_TTL as any,
    keyid: kidFor(secret),
  });
};

/** Owner household routes. Staff JWT (same issuer) does not pass. */
export const ownerOnly = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user || !isOwner(req.user.role)) {
    res.status(403).json({ error: 'Owner access required' });
    return;
  }
  next();
};
