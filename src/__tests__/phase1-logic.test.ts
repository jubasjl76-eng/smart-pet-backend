import { describe, it, expect } from 'vitest';
import { sha256 } from '../auth/tokens.js';
import { makePairingCode, DEVICE_TYPES } from '../breeder/devices.js';
import { buildAcl, deviceAclStanza, type AclDevice } from '../mqtt/acl.js';

describe('sha256', () => {
  it('is stable and hex', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256('abc')).not.toBe(sha256('abd'));
  });
});

describe('pairing codes', () => {
  it('prefix per device type + 4 unambiguous chars', () => {
    for (const t of DEVICE_TYPES) {
      const code = makePairingCode(t);
      expect(code).toMatch(/^[A-Z]{2,4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
      // the random body (after the '-') avoids ambiguous glyphs
      expect(code.split('-')[1]).not.toMatch(/[O0I1]/);
    }
    expect(makePairingCode('feeder').startsWith('FEED-')).toBe(true);
    expect(makePairingCode('gps').startsWith('GPS-')).toBe(true);
  });
  it('is random', () => {
    const codes = new Set(Array.from({ length: 50 }, () => makePairingCode('feeder')));
    expect(codes.size).toBeGreaterThan(40);
  });
});

describe('mosquitto ACL generation', () => {
  const feeder: AclDevice = {
    device_id: 'feeder-01', device_type: 'feeder', kennel_id: 'home', mqtt_username: 'device:feeder-01',
  };
  const hub: AclDevice = {
    device_id: 'hub-01', device_type: 'hub', kennel_id: 'home', mqtt_username: 'device:hub-01',
  };

  it('a feeder reads only its command, writes its state leaves', () => {
    const s = deviceAclStanza(feeder);
    expect(s).toContain('user device:feeder-01');
    expect(s).toContain('topic read kennel/home/feeder/feeder-01/command');
    expect(s).toContain('topic write kennel/home/feeder/feeder-01/status');
    expect(s).toContain('topic write kennel/home/feeder/feeder-01/presence');
    expect(s).not.toContain('write kennel/home/feeder/feeder-01/command');
  });

  it('a hub gets the whole kennel prefix', () => {
    expect(deviceAclStanza(hub)).toContain('topic readwrite kennel/home/#');
  });

  it('skips devices without creds or kennel', () => {
    expect(deviceAclStanza({ ...feeder, mqtt_username: null })).toBe('');
    expect(deviceAclStanza({ ...feeder, kennel_id: null })).toBe('');
  });

  it('full file includes the backend account and every device', () => {
    const acl = buildAcl([feeder, hub], 'smart-pet-backend');
    expect(acl).toContain('user smart-pet-backend');
    expect(acl).toContain('topic readwrite kennel/#');
    expect(acl).toContain('user device:feeder-01');
    expect(acl).toContain('user device:hub-01');
  });
});
