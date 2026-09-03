/**
 * Product roles: owner (household) and staff (adminOnly).
 * Legacy JWT/DB values: user → owner, admin → staff.
 */
export type Role = 'owner' | 'staff';

export function mapRole(raw: string | null | undefined): Role {
  const r = String(raw || 'owner').toLowerCase().trim();
  if (r === 'staff' || r === 'admin') return 'staff';
  // user → owner (and any other non-staff value)
  return 'owner';
}

export function isOwner(raw: string | null | undefined): boolean {
  return mapRole(raw) === 'owner';
}

export function isOwnerRole(raw: string | null | undefined): boolean {
  return isOwner(raw);
}

export function isStaffRole(raw: string | null | undefined): boolean {
  return mapRole(raw) === 'staff';
}

export function canAdmin(raw: string | null | undefined): boolean {
  return mapRole(raw) === 'staff';
}

export function isDeviceUsername(username: string | null | undefined): boolean {
  return typeof username === 'string' && username.startsWith('device:');
}

export function isLocalRegisterAllowed(req: { ip?: string; hostname?: string; socket?: { remoteAddress?: string } }): boolean {
  const host = String(req.hostname || '').toLowerCase();
  const ips = [req.ip, req.socket?.remoteAddress].filter(Boolean).map((ip) => String(ip).replace(/^::ffff:/, ''));
  if (host === 'localhost' || host === '127.0.0.1') return true;
  return ips.some((ip) => ip === '127.0.0.1' || ip === '::1' || ip === 'localhost');
}
