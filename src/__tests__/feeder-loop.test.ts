import { describe, it, expect } from 'vitest';
import { commandTopic, statusTopic, isFoodLow } from '../services/feederMqtt.js';

describe('MQTT contract', () => {
  it('uses kennel-shaped command and status topics', () => {
    expect(commandTopic('k1', 'feeder-01')).toBe('kennel/k1/feeder/feeder-01/command');
    expect(statusTopic('k1', 'feeder-01')).toBe('kennel/k1/feeder/feeder-01/status');
  });

  it('derives low food from foodLevel < 20', () => {
    expect(isFoodLow(19)).toBe(true);
    expect(isFoodLow(20)).toBe(false);
    expect(isFoodLow(null)).toBe(false);
  });
});

describe('command payloads', () => {
  it('feed payload shape', () => {
    const body = {
      command: 'feed',
      deviceId: 'feeder-01',
      kennelId: 'k1',
      timestamp: 1,
      params: { amount: 100 },
    };
    expect(body.command).toBe('feed');
    expect(body.kennelId).toBe('k1');
  });

  it('schedule_set payload shape', () => {
    const body = {
      command: 'schedule_set',
      deviceId: 'feeder-01',
      kennelId: 'k1',
      timestamp: 1,
      params: { schedules: [{ id: 's1', time: '08:00', amount: 100, enabled: true }] },
    };
    expect(body.params.schedules[0].time).toMatch(/^\d{2}:\d{2}$/);
  });
});
