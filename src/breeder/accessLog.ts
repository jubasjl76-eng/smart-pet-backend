/**
 * Access log — one row per read of sensitive data (document downloads today;
 * camera/door reads once those endpoints exist). Call `logAccess` from the
 * handler after the read is authorised. It never throws: an audit-write failure
 * must not break the request it is auditing.
 */
import { execute } from '../database/index.js';
import type { KennelRequest } from './http.js';

export function clientIp(req: KennelRequest): string | null {
  const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return xff || req.socket?.remoteAddress || null;
}

export async function logAccess(
  req: KennelRequest,
  action: string,
  opts: {
    subjectType?: string | null;
    subjectId?: string | null;
    detail?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    await execute(
      `INSERT INTO access_log (kennel_id, user_id, action, subject_type, subject_id, ip, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        req.kennelId ?? null,
        req.user?.id ?? null,
        action,
        opts.subjectType ?? null,
        opts.subjectId ?? null,
        clientIp(req),
        JSON.stringify(opts.detail ?? {}),
      ],
    );
  } catch (err) {
    console.error('[access_log] insert failed', err);
  }
}
