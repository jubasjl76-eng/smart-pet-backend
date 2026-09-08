import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne, execute } from '../database/index.js';
import { generateToken, AuthRequest } from '../middleware/auth.js';
import { isLocalRegisterAllowed, mapRole } from '../identity/roles.js';
import {
  issueRefreshToken, rotateRefreshToken, revokeRefreshToken, revokeAllForUser,
} from '../auth/tokens.js';
import { acceptInvite as consumeInvite } from '../auth/invites.js';

function toJson(user: any) {
  const role = mapRole(user.role);
  return {
    id: user.id, _id: user.id, email: user.email, name: user.name, role,
    kennelId: user.kennel_id ?? null,
    active: user.active ?? true,
  };
}

async function authPayload(user: any, req: Request) {
  const accessToken = generateToken(user.id, user.role);
  const { token: refreshToken } = await issueRefreshToken(user.id, req.headers['user-agent']);
  // `token` kept for back-compat with older callers.
  return { user: toJson(user), token: accessToken, accessToken, refreshToken };
}

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isLocalRegisterAllowed(req)) {
      res.status(403).json({ error: 'Register is localhost-only' });
      return;
    }
    const { email, password, name } = req.body;
    const existing = await queryOne<any>('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) {
      res.status(400).json({ error: 'Email already registered' });
      return;
    }
    const password_hash = await bcrypt.hash(password, 10);
    // Register always creates role=owner. Never mints staff, whatever the body says.
    await execute(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'owner')`,
      [email, password_hash, name || null]
    );
    const user = await queryOne<any>(
      'SELECT id, email, name, role, kennel_id, active FROM users WHERE email = $1',
      [email]
    );
    if (!user) {
      res.status(500).json({ error: 'Registration failed' });
      return;
    }
    res.status(201).json({ message: 'User registered successfully', ...(await authPayload(user, req)) });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
};

export const login = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;
    const user = await queryOne<any>(
      'SELECT id, email, name, role, kennel_id, active, password_hash FROM users WHERE email = $1',
      [email]
    );
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    if (user.active === false) {
      res.status(403).json({ error: 'Account deactivated' });
      return;
    }
    res.json({ message: 'Login successful', ...(await authPayload(user, req)) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
};

/** POST /api/auth/refresh — rotate a refresh token for a fresh access token. */
export const refresh = async (req: Request, res: Response): Promise<void> => {
  try {
    const raw = String(req.body?.refreshToken || '').trim();
    if (!raw) {
      res.status(400).json({ error: 'refreshToken required' });
      return;
    }
    const result = await rotateRefreshToken(raw, req.headers['user-agent']);
    if (!result) {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }
    const user = await queryOne<any>(
      'SELECT id, email, name, role, kennel_id, active FROM users WHERE id = $1',
      [result.userId]
    );
    if (!user || user.active === false) {
      res.status(401).json({ error: 'Account unavailable' });
      return;
    }
    const accessToken = generateToken(user.id, user.role);
    res.json({ user: toJson(user), token: accessToken, accessToken, refreshToken: result.refresh.token });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Refresh failed' });
  }
};

/** POST /api/auth/logout — revoke one refresh token, or all for the user. */
export const logout = async (req: AuthRequest, res: Response): Promise<void> => {
  const raw = String(req.body?.refreshToken || '').trim();
  if (raw) await revokeRefreshToken(raw);
  else if (req.user?.id) await revokeAllForUser(req.user.id);
  res.json({ ok: true });
};

/** POST /api/auth/accept-invite — { token, name, password } → creates the account. */
export const acceptInvite = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, name, password } = req.body || {};
    if (!token || !password) {
      res.status(400).json({ error: 'token and password are required' });
      return;
    }
    const { user } = await consumeInvite(String(token), String(name || ''), String(password));
    res.status(201).json({ message: 'Account created', ...(await authPayload(user, req)) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
};

export const getMe = async (req: AuthRequest, res: Response): Promise<void> => {
  res.json({ user: req.user });
};

export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, email } = req.body;
    const id = req.user!.id;
    if (email) {
      const existing = await queryOne<any>('SELECT id FROM users WHERE email = $1 AND id <> $2', [email, id]);
      if (existing) {
        res.status(400).json({ error: 'Email already in use' });
        return;
      }
    }
    const user = await queryOne<any>(
      `UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), updated_at = NOW() WHERE id = $3 RETURNING id, email, name, role, kennel_id, active`,
      [name || null, email || null, id]
    );
    res.json({ user: toJson(user) });
  } catch {
    res.status(500).json({ error: 'Update failed' });
  }
};

export const changePassword = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body;
    const row = await queryOne<any>('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    const password_hash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [password_hash, req.user!.id]);
    res.json({ message: 'Password updated successfully' });
  } catch {
    res.status(500).json({ error: 'Password update failed' });
  }
};
