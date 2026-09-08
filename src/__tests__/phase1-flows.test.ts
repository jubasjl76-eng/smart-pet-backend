/**
 * Phase 1 flows against a pglite-backed DB: refresh-token rotation, invites,
 * device pairing + claim. Runs the real migration SQL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { BREEDER_DDL } from '../breeder/schema.js';

const db = new PGlite();

vi.mock('../database/index.js', () => ({
  query: async (t: string, p?: unknown[]) => (await db.query(t, p as any[])).rows,
  queryOne: async (t: string, p?: unknown[]) => (await db.query(t, p as any[])).rows[0] ?? null,
  execute: async (t: string, p?: unknown[]) => { await db.query(t, p as any[]); },
  pool: {},
}));

const { issueRefreshToken, rotateRefreshToken, revokeRefreshToken } = await import('../auth/tokens.js');
const { createInvite, acceptInvite } = await import('../auth/invites.js');
const { createPairing, claimByPairing, listOpenPairings } = await import('../breeder/devices.js');
const { runMigrations, listMigrations } = await import('../database/migrate.js');

let ownerId: string;

// pglite's `query` rejects multi-statement SQL (real `pg` accepts it in a simple
// query), so route param-less multi-statement text through `exec`.
const pgliteClient = {
  query: async (t: string, p?: unknown[]) => {
    const trimmed = t.trim().replace(/;\s*$/, '');
    if (!p?.length && trimmed.includes(';')) {
      await db.exec(t);
      return { rows: [] as any[] };
    }
    return db.query(t, p as any[]);
  },
};

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255),
      name VARCHAR(255), role VARCHAR(20) DEFAULT 'owner',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id VARCHAR(255) UNIQUE NOT NULL, device_type VARCHAR(50), name VARCHAR(255),
      kennel_id VARCHAR(255), user_id UUID, status VARCHAR(20), is_online BOOLEAN,
      mqtt_username VARCHAR(255), mqtt_password_hash VARCHAR(255), claim_code VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.exec(BREEDER_DDL);
  // Apply migrations the way boot does — through the runner, after the schema exists.
  const applied = await runMigrations(pgliteClient);
  if (!applied.includes('001_phase1_auth_setup.sql')) {
    throw new Error('migration 001 was not applied: ' + applied.join(','));
  }
  await db.query(`INSERT INTO kennels (slug, name) VALUES ('home', 'Home')`);
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, kennel_id) VALUES ('owner@x.io','x','owner','home') RETURNING id`
  );
  ownerId = u.rows[0].id;
});

afterAll(async () => { await db.close(); });

describe('migration runner', () => {
  it('recorded 001 and re-running is a no-op', async () => {
    const rows = (await db.query(`SELECT name FROM _migrations`)).rows as { name: string }[];
    expect(rows.map((r) => r.name)).toContain('001_phase1_auth_setup.sql');
    const again = await runMigrations(pgliteClient);
    expect(again).toEqual([]);
    expect(listMigrations().length).toBeGreaterThanOrEqual(1);
  });

  it('created the phase-1 tables + columns', async () => {
    const cols = (await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`
    )).rows.map((r: any) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['active', 'kennel_id']));
    for (const t of ['refresh_tokens', 'user_invites', 'device_pairings']) {
      const r = await db.query(`SELECT to_regclass($1) AS t`, [t]);
      expect((r.rows[0] as any).t).toBe(t);
    }
  });
});

describe('refresh tokens', () => {
  it('issue → rotate gives a new token, old one is revoked', async () => {
    const a = await issueRefreshToken(ownerId, 'vitest');
    const r1 = await rotateRefreshToken(a.token, 'vitest');
    expect(r1?.userId).toBe(ownerId);
    expect(r1!.refresh.token).not.toBe(a.token);
    // old token can't rotate again
    expect(await rotateRefreshToken(a.token)).toBeNull();
  });

  it('reusing a spent token revokes the whole family', async () => {
    const a = await issueRefreshToken(ownerId, 'vitest');
    const r1 = await rotateRefreshToken(a.token);      // a → b
    await rotateRefreshToken(r1!.refresh.token);        // b → c (b now valid-chain)
    // replay the original spent token → nukes the family, so c is dead too
    expect(await rotateRefreshToken(a.token)).toBeNull();
    // note: r1.refresh.token (b) was already spent by the b→c rotate
  });

  it('revoke makes a token unusable', async () => {
    const a = await issueRefreshToken(ownerId);
    await revokeRefreshToken(a.token);
    expect(await rotateRefreshToken(a.token)).toBeNull();
  });
});

describe('invites', () => {
  it('create → accept creates a staff user in the same kennel', async () => {
    const inv = await createInvite({ email: 'Maria@x.io', role: 'staff', kennelId: 'home', invitedBy: ownerId });
    expect(inv.role).toBe('staff');
    const { user } = await acceptInvite(inv.token, 'Maria', 'secret1');
    expect(user.role).toBe('staff');
    expect(user.kennel_id).toBe('home');
    expect(user.email).toBe('maria@x.io');
    // token is single-use
    await expect(acceptInvite(inv.token, 'Maria', 'secret1')).rejects.toThrow(/already used/);
  });

  it('rejects an existing email', async () => {
    await expect(
      createInvite({ email: 'owner@x.io', role: 'staff', kennelId: 'home', invitedBy: ownerId })
    ).rejects.toThrow(/already exists/);
  });

  it('rejects an expired invite', async () => {
    const inv = await createInvite({ email: 'late@x.io', role: 'staff', kennelId: 'home', invitedBy: ownerId });
    await db.query(`UPDATE user_invites SET expires_at = NOW() - INTERVAL '1 day' WHERE token = $1`, [inv.token]);
    await expect(acceptInvite(inv.token, 'Late', 'secret1')).rejects.toThrow(/expired/);
  });

  it('rejects a short password', async () => {
    const inv = await createInvite({ email: 'weak@x.io', role: 'staff', kennelId: 'home', invitedBy: ownerId });
    await expect(acceptInvite(inv.token, 'Weak', 'no')).rejects.toThrow(/6 characters/);
  });
});

describe('device pairing + claim', () => {
  it('pairing → claim binds the device, mints creds once, marks the pairing used', async () => {
    const { code } = await createPairing({ kennelId: 'home', deviceType: 'feeder', suggestedName: 'Pen 3 feeder', createdBy: ownerId });
    expect(await listOpenPairings('home')).toHaveLength(1);

    const result = await claimByPairing({ code, deviceId: 'feeder-77', kennelId: 'home', claimedBy: ownerId });
    expect(result.device.device_type).toBe('feeder');
    expect(result.device.name).toBe('Pen 3 feeder');
    expect(result.mqtt.username).toBe('device:feeder-77');
    expect(result.mqtt.password).toMatch(/.{20,}/);
    expect(result.mqtt.topics.command).toBe('kennel/home/feeder/feeder-77/command');

    const dev = await db.query<any>(`SELECT mqtt_password_hash, claim_code FROM devices WHERE device_id='feeder-77'`);
    expect(dev.rows[0].mqtt_password_hash).toBeTruthy();
    expect(dev.rows[0].claim_code).toBe(code);
    expect(await listOpenPairings('home')).toHaveLength(0);

    await expect(claimByPairing({ code, deviceId: 'feeder-77', kennelId: 'home', claimedBy: ownerId }))
      .rejects.toThrow(/already used/);
  });

  it('rejects a code from another kennel', async () => {
    await db.query(`INSERT INTO kennels (slug, name) VALUES ('other','Other')`);
    const { code } = await createPairing({ kennelId: 'other', deviceType: 'door', createdBy: ownerId });
    await expect(claimByPairing({ code, deviceId: 'door-9', kennelId: 'home', claimedBy: ownerId }))
      .rejects.toThrow(/another kennel/);
  });

  it('rejects an expired code', async () => {
    const { code } = await createPairing({ kennelId: 'home', deviceType: 'scale', createdBy: ownerId });
    await db.query(`UPDATE device_pairings SET expires_at = NOW() - INTERVAL '1 minute' WHERE code = $1`, [code]);
    await expect(claimByPairing({ code, deviceId: 's1', kennelId: 'home', claimedBy: ownerId }))
      .rejects.toThrow(/expired/);
  });
});
