/**
 * Monthly partition maintenance (hardening Phase 20, A12 #23) — keeps
 * `access_log` and `exceptions` (src/db/partitions.ts) a couple months ahead
 * on partitions, via a pg-boss cron schedule. Also runs once at boot so a
 * fresh deployment doesn't wait for the 1st of the month to have next
 * month's partition ready.
 */
import { getQueue } from './queue.js';
import { ensureUpcomingPartitions } from '../db/partitions.js';
import { log } from '../log.js';

const QUEUE = 'partition-maintenance';
const CRON = '0 3 1 * *'; // 03:00 UTC on the 1st of every month

async function run(): Promise<void> {
  await ensureUpcomingPartitions('access_log');
  await ensureUpcomingPartitions('exceptions');
}

/** Called once at boot (src/index.ts) — creates the queue, starts the worker, schedules the cron. */
export async function registerPartitionMaintenanceWorker(): Promise<void> {
  const boss = getQueue();
  await boss.createQueue(QUEUE);
  await boss.work(QUEUE, run);
  await boss.schedule(QUEUE, CRON, null, { missed: 'once' });
  await run().catch((err) => log.error({ err }, 'partition maintenance (boot run) failed'));
}
