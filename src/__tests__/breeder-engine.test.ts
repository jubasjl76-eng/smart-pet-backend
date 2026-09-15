import { describe, it, expect } from 'vitest';
import { normaliseMessage } from '../breeder/engine/index.js';

describe('normaliseMessage', () => {
  it('ignores non-kennel topics', () => {
    expect(normaliseMessage('devices/x/telemetry', '{}')).toEqual([]);
    expect(normaliseMessage('kennel/home/feeder/f1', '{}')).toEqual([]); // too short
  });

  it('maps a feeder status message', () => {
    const evs = normaliseMessage(
      'kennel/home/feeder/f1/status',
      JSON.stringify({ status: 'online', rssi: -72, penId: 'p1' })
    );
    expect(evs.find((e) => e.type === 'device_status')?.status).toBe('online');
    const rssi = evs.find((e) => e.type === 'telemetry' && e.metric === 'rssi');
    expect(rssi?.value).toBe(-72);
    expect(rssi?.meta?.penId).toBe('p1');
  });

  it('maps a temperature sensor reading', () => {
    const evs = normaliseMessage(
      'kennel/home/sensor/t1/temperature',
      JSON.stringify({ value: 30.5 })
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: 'telemetry', metric: 'temperature', value: 30.5, deviceType: 'sensor' });
  });

  it('maps a collar location battery into a low_battery event', () => {
    const evs = normaliseMessage(
      'kennel/home/gps/c1/location',
      JSON.stringify({ latitude: 1, longitude: 2, battery: 12 })
    );
    expect(evs[0]).toMatchObject({ type: 'low_battery', value: 12 });
  });

  it('maps device events (feed ack, door open, jam)', () => {
    expect(normaliseMessage('kennel/home/feeder/f1/event', '{"event":"feed"}')[0].type).toBe('feed_acked');
    expect(normaliseMessage('kennel/home/door/d1/event', '{"event":"door_open"}')[0].type).toBe('door_opened');
    expect(normaliseMessage('kennel/home/feeder/f1/event', '{"event":"jam"}')[0].type).toBe('jam');
  });

  it('maps a firmware crash event (fields under `data`, as the SDK sends them)', () => {
    const evs = normaliseMessage(
      'kennel/home/feeder/f1/event',
      JSON.stringify({
        event: 'crash',
        data: { reason: 'brownout', rawReason: 9, fw: '1.2.0', heapFree: 40000, minHeapFree: 12000 },
      })
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: 'device_crash',
      deviceType: 'feeder',
      deviceId: 'f1',
      meta: { reason: 'brownout', rawReason: 9, fw: '1.2.0', heapFree: 40000, minHeapFree: 12000 },
    });
  });

  it('also accepts crash fields at the top level (defensive)', () => {
    const evs = normaliseMessage(
      'kennel/home/feeder/f1/event',
      JSON.stringify({ event: 'crash', reason: 'panic', fw: '1.0.0' })
    );
    expect(evs[0]).toMatchObject({ type: 'device_crash', meta: { reason: 'panic', fw: '1.0.0' } });
  });

  it('tolerates non-JSON payloads', () => {
    expect(() => normaliseMessage('kennel/home/sensor/t1/temperature', 'not json')).not.toThrow();
  });
});
