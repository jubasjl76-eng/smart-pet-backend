/**
 * Monthly partition maintenance job registration (Phase 20, A12 #23).
 */
import { describe, it, expect, vi } from 'vitest';

const ensureUpcomingPartitions = vi.fn(async () => {});
vi.mock('../db/partitions.js', () => ({ ensureUpcomingPartitions }));

const boss = {
  createQueue: vi.fn(async () => {}),
  work: vi.fn(async () => 'sub-id'),
  schedule: vi.fn(async () => {}),
};
vi.mock('../jobs/queue.js', () => ({ getQueue: () => boss }));

const { registerPartitionMaintenanceWorker } = await import('../jobs/partitionMaintenance.js');

describe('registerPartitionMaintenanceWorker', () => {
  it('creates the queue, registers a worker, schedules the monthly cron, and runs once at boot', async () => {
    await registerPartitionMaintenanceWorker();

    expect(boss.createQueue).toHaveBeenCalledWith('partition-maintenance');
    expect(boss.work).toHaveBeenCalledWith('partition-maintenance', expect.any(Function));
    expect(boss.schedule).toHaveBeenCalledWith(
      'partition-maintenance',
      expect.stringMatching(/^0 3 1 \* \*$/),
      null,
      expect.objectContaining({ missed: 'once' }),
    );
    // the boot-time run (not the scheduled worker, which never fires without a
    // real pg-boss) — proves both tables get their upcoming partitions.
    expect(ensureUpcomingPartitions).toHaveBeenCalledWith('access_log');
    expect(ensureUpcomingPartitions).toHaveBeenCalledWith('exceptions');
  });
});
