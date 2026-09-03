import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { queryOne } from '../database/index.js';

export interface AuthUser {
  id: string;
  _id: string;
  email: string;
  name: string | null;
  role: 'owner' | 'staff' | 'user';
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is unset — refusing to boot');
  }
  return secret;
}

export function getJwtSecret(): string {
  return requireJwtSecret();
}

function mapRole(role: string | null | undefined): AuthUser['role'] {
  if (role === 'staff' || role === 'admin') return 'staff';
  return 'owner';
}

export const auth = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, requireJwtSecret()) as { userId: string };
    const user = await queryOne<any>('SELECT id, email, name, role FROM users WHERE id = $1', [decoded.userId]);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    const role = mapRole(user.role);
    req.user = { id: user.id, _id: user.id, email: user.email, name: user.name, role };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

export const adminOnly = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user || req.user.role !== 'staff') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};

export const generateToken = (userId: string): string => {
  return jwt.sign({ userId }, requireJwtSecret(), { expiresIn: '30d' });
};

export const ownerOnly = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user || (req.user.role !== 'owner' && req.user.role !== 'staff')) {
    res.status(403).json({ error: 'Owner access required' });
    return;
  }
  next();
};
