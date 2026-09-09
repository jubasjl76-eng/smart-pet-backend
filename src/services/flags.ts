/**
 * Feature flags (Phase 12). A `feature_flags` table read by GET /api/config so
 * the dashboard / app can gate UI without a redeploy.
 */
import { query } from '../database/index.js';

type FlagMap = Record<string, boolean>;

let cache: { at: number; flags: FlagMap } | null = null;
const TTL_MS = 30_000; // ponytail: 30s cache; flips take up to 30s to propagate

/** All flags as `{ key: enabled }`. Cached 30s. Never throws — returns {} on error. */
export async function getFlags(): Promise<FlagMap> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.flags;
  try {
    const rows = await query<{ key: string; enabled: boolean }>(
      'SELECT key, enabled FROM feature_flags'
    );
    const flags: FlagMap = {};
    for (const r of rows) flags[r.key] = r.enabled;
    cache = { at: Date.now(), flags };
    return flags;
  } catch {
    return cache?.flags ?? {};
  }
}

/** Drop the cache — call after an admin toggles a flag. */
export function invalidateFlags(): void {
  cache = null;
}
