/**
 * Shared HTTP plumbing for breeder routes: kennel resolution + async wrapper.
 * All breeder routes sit behind the existing `auth` middleware, so req.user is set.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { queryOne } from '../database/index.js';
import type { AuthRequest } from '../middleware/auth.js';

export interface KennelRequest extends AuthRequest {
  kennelId?: string;
}

/** Resolve the caller's kennel (breeder tenant) once per request. */
export const withKennel: RequestHandler = async (req: KennelRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const row = await queryOne<{ kennel_id: string | null }>(
      'SELECT kennel_id FROM users WHERE id = $1',
      [userId]
    );
    let kennelId = row?.kennel_id ?? null;
    if (!kennelId) {
      // Fall back to the single seeded kennel.
      const k = await queryOne<{ slug: string }>('SELECT slug FROM kennels ORDER BY created_at LIMIT 1');
      kennelId = k?.slug ?? process.env.BREEDER_KENNEL_SLUG ?? 'home';
    }
    req.kennelId = kennelId;
    next();
  } catch (err) {
    console.error('[breeder] withKennel failed', err);
    res.status(500).json({ error: 'Failed to resolve kennel' });
  }
};

export function ah(fn: (req: KennelRequest, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as KennelRequest, res)).catch((err) => {
      console.error('[breeder] route error', err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
      else next(err);
    });
  };
}

export function bad(res: Response, message: string, code = 400): void {
  res.status(code).json({ error: message });
}

/** Minimal body validation without pulling in express-validator per route. */
export function need<T extends Record<string, unknown>>(body: T, fields: (keyof T)[]): string | null {
  for (const f of fields) {
    const v = body[f];
    if (v === undefined || v === null || v === '') return `Missing field: ${String(f)}`;
  }
  return null;
}
