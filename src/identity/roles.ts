import type { AppRole } from '../types.js';

/** Map legacy JWT/DB role "user" → owner. Staff stays staff. */
export function mapRole(role: string | undefined | null): AppRole | null {
  if (!role) return null;
  const r = role.toLowerCase();
  if (r === 'owner' || r === 'user') return 'owner';
  if (r === 'staff') return 'staff';
  return null;
}

export function isOwner(role: string | undefined | null): boolean {
  return mapRole(role) === 'owner';
}

export function isStaff(role: string | undefined | null): boolean {
  return mapRole(role) === 'staff';
}

/** adminOnly: staff only. Owner tokens must not pass. */
export function canAdmin(role: string | undefined | null): boolean {
  return isStaff(role);
}

export function isLocalhostAddress(ipOrHost: string | undefined | null): boolean {
  if (!ipOrHost) return false;
  const v = ipOrHost.trim().toLowerCase().replace('::ffff:', '');
  return v === '127.0.0.1' || v === '::1' || v === 'localhost';
}

export function isLocalRegisterAllowed(req: {
  ip?: string;
  hostname?: string;
  socket?: { remoteAddress?: string };
}): boolean {
  const candidates = [req.ip, req.hostname, req.socket?.remoteAddress];
  return candidates.some((c) => isLocalhostAddress(c));
}
