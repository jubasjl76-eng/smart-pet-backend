import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../database/index.js';
import { generateToken, AuthRequest } from '../middleware/auth.js';
import { isLocalRegisterAllowed, mapRole } from '../identity/roles.js';

function toJson(user: any) {
  const role = mapRole(user.role);
  return { id: user.id, _id: user.id, email: user.email, name: user.name, role };
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
    const rows = await query<any>(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'owner') RETURNING id, email, name, role`,
      [email, password_hash, name || null]
    );
    const user = rows[0];
    const token = generateToken(user.id, user.role);
    res.status(201).json({ message: 'User registered successfully', user: toJson(user), token });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
};

export const login = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;
    const user = await queryOne<any>('SELECT id, email, name, role, password_hash FROM users WHERE email = $1', [email]);
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const token = generateToken(user.id, user.role);
    res.json({ message: 'Login successful', user: toJson(user), token });
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
    const id = req.user!.id;
    if (email) {
      const existing = await queryOne<any>('SELECT id FROM users WHERE email = $1 AND id <> $2', [email, id]);
      if (existing) {
        res.status(400).json({ error: 'Email already in use' });
        return;
      }
    }
    const user = await queryOne<any>(
      `UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), updated_at = NOW() WHERE id = $3 RETURNING id, email, name, role`,
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
