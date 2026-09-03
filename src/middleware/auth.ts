import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config.js';
import { canAdmin, isOwner, mapRole } from '../identity/roles.js';
import { queryOne } from '../database/index.js';
import type { AppUser } from '../types.js';

export interface AuthRequest extends Request {
  user?: AppUser;
}

interface JwtPayload {
  userId: string;
  role?: string;
}

function rowToUser(row: any): AppUser {
  const mapped = mapRole(row.role) || 'owner';
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? null,
    role: mapped,
    kennelId: row.kennel_id ?? null,
  };
}

export const auth = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;
    const row = await queryOne<any>('SELECT id, email, name, role, kennel_id FROM users WHERE id = $1', [decoded.userId]);
    if (!row) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    req.user = rowToUser(row);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

export const ownerOnly = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user || !isOwner(req.user.role)) {
    res.status(403).json({ error: 'Owner access required' });
    return;
  }
  next();
};

/** Staff only. Owner tokens must not pass. */
export const adminOnly = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user || !canAdmin(req.user.role)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};

export const generateToken = (userId: string, role: string): string => {
  const mapped = mapRole(role) || 'owner';
  return jwt.sign({ userId, role: mapped }, getJwtSecret(), { expiresIn: '30d' });
};
