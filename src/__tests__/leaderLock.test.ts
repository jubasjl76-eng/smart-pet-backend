/**
 * Leader-election lock (Phase 20). REDIS_URL unset → always the leader
 * (single instance, nothing to coordinate with). Configured → exactly one
 * caller acquires per window; a Redis error fails open (runs anyway).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../redis.js');
});

describe('leaderLock', () => {
  it('always runs fn when Redis is unconfigured (dev/local, single instance)', async () => {
    const { withLeaderLock } = await import('../leaderLock.js');
    const fn = vi.fn(async () => {});
    await withLeaderLock('lock:test', 1000, fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('runs fn only for the caller that acquires the lock', async () => {
    vi.doMock('../redis.js', () => ({
      redis: { set: vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null) },
    }));
    const { withLeaderLock } = await import('../leaderLock.js');
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    await withLeaderLock('lock:test', 1000, first);
    await withLeaderLock('lock:test', 1000, second);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it('fails open — runs fn if the Redis call throws', async () => {
    vi.doMock('../redis.js', () => ({
      redis: { set: vi.fn().mockRejectedValue(new Error('redis down')) },
    }));
    const { withLeaderLock } = await import('../leaderLock.js');
    const fn = vi.fn(async () => {});
    await withLeaderLock('lock:test', 1000, fn);
    expect(fn).toHaveBeenCalledOnce();
  });
});
