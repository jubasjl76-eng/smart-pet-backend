import { describe, it, expect } from 'vitest';
import {
  COMMAND_QOS,
  STATUS_QOS,
  buildFeedCommand,
  buildLwtPayload,
  buildScheduleSet,
  commandTopic,
  isForbiddenTopic,
  mqttUsername,
  parseStatusTopic,
  statusTopic,
} from '../mqtt/contract.js';
import { executeFeedNow } from '../services/feedNow.js';
import { createMemoryBus, notifyStatus, setFeederBus } from '../services/feederMqtt.js';
import type { DeviceRow } from '../types.js';

describe('MQTT command contract', () => {
  it('uses kennel/{kennelId}/feeder/{deviceId}/command at QoS 2', () => {
    expect(commandTopic('home', 'feeder-sim-001')).toBe(
      'kennel/home/feeder/feeder-sim-001/command'
    );
    expect(COMMAND_QOS).toBe(2);
  });

  it('does not fork to devices/<id>/telemetry or /commands', () => {
    expect(isForbiddenTopic('devices/feeder-sim-001/telemetry')).toBe(true);
    expect(isForbiddenTopic('devices/feeder-sim-001/commands')).toBe(true);
    expect(isForbiddenTopic('kennel/home/feeder/feeder-sim-001/command')).toBe(false);
  });

  it('builds feed payload', () => {
    expect(
      buildFeedCommand({
        deviceId: 'feeder-sim-001',
        kennelId: 'home',
        timestamp: 1700000000000,
        amount: 50,
      })
    ).toEqual({
      command: 'feed',
      deviceId: 'feeder-sim-001',
      kennelId: 'home',
      timestamp: 1700000000000,
      params: { amount: 50 },
    });
  });

  it('builds schedule_set payload', () => {
    expect(
      buildScheduleSet({
        deviceId: 'feeder-sim-001',
        kennelId: 'home',
        timestamp: 1,
        schedules: [{ id: 's1', time: '08:00', amount: 40, enabled: true }],
      })
    ).toEqual({
      command: 'schedule_set',
      deviceId: 'feeder-sim-001',
      kennelId: 'home',
      timestamp: 1,
      params: {
        schedules: [{ id: 's1', time: '08:00', amount: 40, enabled: true }],
      },
    });
  });

  it('mints MQTT username device:<deviceId>', () => {
    expect(mqttUsername('feeder-sim-001')).toBe('device:feeder-sim-001');
  });

  it('LWT is on the same status topic, retained, no foodLevel', () => {
    expect(statusTopic('home', 'feeder-sim-001')).toBe(
      'kennel/home/feeder/feeder-sim-001/status'
    );
    expect(STATUS_QOS).toBe(1);
    const lwt = buildLwtPayload('feeder-sim-001', 'home');
    expect(lwt).toEqual({
      deviceId: 'feeder-sim-001',
      kennelId: 'home',
      timestamp: 0,
      status: 'offline',
    });
    expect('foodLevel' in lwt).toBe(false);
  });

  it('parses locked status topic', () => {
    expect(parseStatusTopic('kennel/home/feeder/feeder-sim-001/status')).toEqual({
      kennelId: 'home',
      deviceId: 'feeder-sim-001',
    });
    expect(parseStatusTopic('devices/feeder-sim-001/telemetry')).toBeNull();
  });
});

describe('Feed Now command path', () => {
  const device: DeviceRow = {
    id: 'uuid-1',
    user_id: 'owner-1',
    device_id: 'feeder-sim-001',
    device_type: 'feeder',
    name: 'Sim',
    kennel_id: 'home',
    mqtt_username: 'device:feeder-sim-001',
    mqtt_password_hash: 'hash',
    is_online: true,
    last_seen: null,
    food_level: 80,
    last_feed: null,
    status: 'online',
    claimed_at: null,
    last_status_at: null,
  };

  it('succeeds on device ack + status, without inserting device_events', async () => {
    const bus = createMemoryBus() as ReturnType<typeof createMemoryBus> & {
      published: Array<{ topic: string; payload: any; qos: number }>;
    };
    setFeederBus(bus);

    const pending = executeFeedNow(device, 25, bus, 500);
    setTimeout(() => {
      notifyStatus({
        deviceId: 'feeder-sim-001',
        kennelId: 'home',
        timestamp: Date.now(),
        status: 'online',
        foodLevel: 75,
        lastFeed: Date.now(),
      });
    }, 10);

    const status = await pending;
    expect(status.status).toBe('online');
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].topic).toBe('kennel/home/feeder/feeder-sim-001/command');
    expect(bus.published[0].qos).toBe(2);
    expect(bus.published[0].payload.command).toBe('feed');
    expect(bus.published[0].payload.params.amount).toBe(25);
  });

  it('times out if status never acks', async () => {
    const bus = createMemoryBus();
    await expect(executeFeedNow(device, 10, bus, 30)).rejects.toThrow(/did not ack/);
  });
});
