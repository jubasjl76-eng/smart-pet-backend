/**
 * RDS read replica (Phase 21, A11/A12). `PG_REPLICA_HOST` unset (this test
 * env, and any env without a replica) → no replica pool is constructed and
 * `queryReplica()`/`queryOneReplica()` fall back to the primary pool. That
 * fallback itself is exercised by every route test that mocks
 * `database/index.js` (privacy.test.ts's GDPR export, the growth-chart
 * routes) — this just proves `hasReadReplica()` reports the unconfigured
 * state correctly.
 */
import { describe, it, expect } from 'vitest';

describe('read replica', () => {
  it('reports no replica when PG_REPLICA_HOST is unset', async () => {
    const { hasReadReplica, closeReplicaPool } = await import('../database/index.js');
    expect(hasReadReplica()).toBe(false);
    await expect(closeReplicaPool()).resolves.toBeUndefined();
  });
});
