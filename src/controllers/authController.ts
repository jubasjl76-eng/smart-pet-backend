import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { generateToken, AuthRequest } from '../middleware/auth.js';
import { isLocalRegisterAllowed, mapRole } from '../identity/roles.js';
import { execute, queryOne } from '../database/index.js';

function publicUser(row: any) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: mapRole(row.role) || 'owner',
    kennelId: row.kennel_id,
  };
}

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isLocalRegisterAllowed(req)) {
      res.status(403).json({ error: 'Registration is only open on localhost' });
      return;
    }

    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      res.status(400).json({ error: 'email, password, and name are required' });
      return;
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [String(email).toLowerCase()]);
    if (existing) {
      res.status(400).json({ error: 'Email already registered' });
      return;
    }

    // Register never mints staff, even if the client sends role.
    const hash = await bcrypt.hash(password, 10);
    const kennelId = `kennel-${randomUUID().slice(0, 8)}`;
    await execute(
      `INSERT INTO users (email, password_hash, name, role, kennel_id) VALUES ($1, $2, $3, 'owner', $4)`,
      [String(email).toLowerCase(), hash, name, kennelId]
    );
    const user = await queryOne<any>('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
    if (!user) {
      res.status(500).json({ error: 'Registration failed' });
      return;
    }

    const token = generateToken(user.id, 'owner');
    res.status(201).json({
      message: 'User registered successfully',
      user: publicUser(user),
      token,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;
    const user = await queryOne<any>('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase()]);
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const role = mapRole(user.role) || 'owner';
    const token = generateToken(user.id, role);
    res.json({
      message: 'Login successful',
      user: publicUser(user),
      token,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
};

export const getMe = async (req: AuthRequest, res: Response): Promise<void> => {
  res.json({ user: req.user });
};

export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, email } = req.body;
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (email) {
      const existing = await queryOne<any>('SELECT id FROM users WHERE email = $1', [String(email).toLowerCase()]);
      if (existing && existing.id !== req.user.id) {
        res.status(400).json({ error: 'Email already in use' });
        return;
      }
    }
    await execute(
      `UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), updated_at = NOW() WHERE id = $3`,
      [name || null, email ? String(email).toLowerCase() : null, req.user.id]
    );
    const user = await queryOne<any>('SELECT * FROM users WHERE id = $1', [req.user.id]);
    res.json({ user: publicUser(user) });
  } catch {
    res.status(500).json({ error: 'Update failed' });
  }
};

export const changePassword = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const user = await queryOne<any>('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await execute('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id]);
    res.json({ message: 'Password updated successfully' });
  } catch {
    res.status(500).json({ error: 'Password update failed' });
  }
};
