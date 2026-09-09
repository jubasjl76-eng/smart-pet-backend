import { FEED_ACK_TIMEOUT_MS } from '../config.js';
import {
  buildFeedCommand,
  commandTopic,
  isDeviceOnline,
  lastFeedToMs,
} from '../mqtt/contract.js';
import type { FeederBus } from './feederMqtt.js';
import type { DeviceRow, FeederStatusPayload } from '../types.js';

export async function executeFeedNow(
  device: DeviceRow,
  amount: number,
  bus: FeederBus,
  timeoutMs = FEED_ACK_TIMEOUT_MS
): Promise<FeederStatusPayload> {
  if (!device.kennel_id) {
    throw new Error('Device has no kennelId');
  }
  const timestamp = Date.now();
  const payload = buildFeedCommand({
    deviceId: device.device_id,
    kennelId: device.kennel_id,
    timestamp,
    amount,
  });
  const topic = commandTopic(device.kennel_id, device.device_id);
  const ack = bus.waitForStatus(
    device.device_id,
    (status) => {
      if (!isDeviceOnline(status.status)) return false;
      const last = lastFeedToMs(status.lastFeed);
      return last != null && last >= timestamp;
    },
    timeoutMs
  );
  await bus.publishCommand(topic, payload);
  return ack;
}
