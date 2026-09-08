/**
 * Exercises raiseException / transitionException against a pglite-backed
 * database layer (the real SQL, no live Postgres).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { BREEDER_DDL } from '../breeder/schema.js';

const db = new PGlite();

vi.mock('../database/index.js', () => ({
  query: async (text: string, params?: unknown[]) => (await db.query(text, params as any[])).rows,
  queryOne: async (text: string, params?: unknown[]) => (await db.query(text, params as any[])).rows[0] ?? null,
  execute: async (text: string, params?: unknown[]) => { await db.query(text, params as any[]); },
  pool: {},
}));

// Imported after the mock is registered.
const { raiseException, transitionException } = await import('../breeder/exceptions.js');

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email VARCHAR(255) UNIQUE, role VARCHAR(20) DEFAULT 'owner');
    CREATE TABLE devices (device_id VARCHAR(255) PRIMARY KEY, name VARCHAR(255), device_type VARCHAR(50), kennel_id VARCHAR(255), status VARCHAR(20), is_online BOOLEAN, last_seen TIMESTAMPTZ);
  `);
  await db.exec(BREEDER_DDL);
  await db.query(`INSERT INTO kennels (slug, name) VALUES ('home','Home')`);
});

afterAll(async () => { await db.close(); });

describe('raiseException', () => {
  it('creates once and dedups while open, then allows a fresh one after resolve', async () => {
    const first = await raiseException({
      kennelId: 'home', kind: 'temp-high', severity: 'critical',
      title: 'Whelping room hot', deviceId: 'sensor-1',
      suggestedAction: 'fan on',
    });
    expect(first.created).toBe(true);
    expect(first.exception.priority).toBeGreaterThan(60); // critical + kind bump

    const dup = await raiseException({
      kennelId: 'home', kind: 'temp-high', severity: 'critical',
      title: 'Whelping room hot again', deviceId: 'sensor-1', detail: '31C',
    });
    expect(dup.created).toBe(false);
    expect(dup.exception.id).toBe(first.exception.id);

    const rows = (await db.query(`SELECT count(*)::int AS n FROM exceptions WHERE dedup_key='temp-high:sensor-1'`)).rows as any[];
    expect(rows[0].n).toBe(1);

    await transitionException(first.exception.id, 'home', 'resolve', { note: 'cooled down' });

    const third = await raiseException({
      kennelId: 'home', kind: 'temp-high', severity: 'warning',
      title: 'Hot once more', deviceId: 'sensor-1',
    });
    expect(third.created).toBe(true);
    expect(third.exception.id).not.toBe(first.exception.id);
  });

  it('queues a log notification when no prefs exist', async () => {
    const { exception } = await raiseException({
      kennelId: 'home', kind: 'missed-meal', severity: 'critical', title: 'skipped 2 meals', animalId: null,
    });
    const notes = (await db.query(
      `SELECT channel, status FROM notifications WHERE exception_id = $1`, [exception.id]
    )).rows as any[];
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0].channel).toBe('log');
    expect(notes[0].status).toBe('queued');
  });

  it('transitions: acknowledge, snooze, escalate, reopen', async () => {
    const { exception } = await raiseException({
      kennelId: 'home', kind: 'low-battery', severity: 'warning', title: 'collar low', deviceId: 'collar-9',
    });
    const ack = await transitionException(exception.id, 'home', 'acknowledge', { userId: null });
    expect(ack?.status).toBe('acknowledged');

    const snoozed = await transitionException(exception.id, 'home', 'snooze', { snoozeMinutes: 30 });
    expect(snoozed?.status).toBe('snoozed');
    expect(new Date(snoozed!.snoozed_until as string).getTime()).toBeGreaterThan(Date.now());

    const esc = await transitionException(exception.id, 'home', 'escalate', {});
    expect(esc?.status).toBe('escalated');
    expect(esc?.escalation_step).toBe(1);

    const reopened = await transitionException(exception.id, 'home', 'reopen', {});
    expect(reopened?.status).toBe('open');
    expect(reopened?.snoozed_until).toBeNull();
  });

  it('returns null for an unknown exception id', async () => {
    const res = await transitionException(
      '00000000-0000-0000-0000-000000000000', 'home', 'resolve', {}
    );
    expect(res).toBeNull();
  });
});
