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

export function isOwnerRole(raw: string | null | undefined): boolean {
  return mapRole(raw) === 'owner';
}

export function isStaffRole(raw: string | null | undefined): boolean {
  return mapRole(raw) === 'staff';
}

export function isDeviceUsername(username: string | null | undefined): boolean {
  return typeof username === 'string' && username.startsWith('device:');
}
