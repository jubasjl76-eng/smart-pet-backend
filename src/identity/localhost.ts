import { Request } from 'express';

function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
}

export function isLoopbackAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const n = normalizeIp(ip);
  return n === '127.0.0.1' || n === '::1' || n === 'localhost';
}

/** Register is localhost-only. Does not trust X-Forwarded-For (trust proxy is off). */
export function isLocalhostRequest(req: Request): boolean {
  const candidates = [req.socket?.remoteAddress, req.ip, ...(req.ips || [])];
  return candidates.some((ip) => isLoopbackAddress(ip));
}
