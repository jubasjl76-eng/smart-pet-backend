/**
 * Monthly range-partition maintenance (hardening Phase 20, A12 #23) for
 * `access_log` and `exceptions` — see the `015_partition_*`/`016_partition_*`
 * migrations for how they got partitioned in the first place.
 *
 * Two jobs:
 *   - keep future months' partitions created ahead of time (the monthly
 *     pg-boss schedule in src/jobs/partitionMaintenance.ts calls this)
 *   - let the retention sweep (src/breeder/routes/privacy.ts) DROP TABLE a
 *     whole expired month in one fast statement instead of a bloat-causing
 *     row-by-row DELETE, falling back to that same DELETE for whatever a
 *     month-granularity drop can't cover (a partial boundary month, the
 *     catch-all default partition, or — this deployment is one kennel per
 *     instance, but the code stays correct if that ever changes — a month
 *     another kennel still has live, un-expired data in).
 */
import { query, queryOne, execute } from '../database/index.js';

/** The only tables this module is allowed to touch — never build a name from anything else. */
const PARTITIONED_TABLES = ['access_log', 'exceptions'] as const;
export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];

function assertKnownTable(table: string): asserts table is PartitionedTable {
  if (!(PARTITIONED_TABLES as readonly string[]).includes(table)) {
    throw new Error(`partitions: unknown table "${table}"`);
  }
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function partitionName(table: PartitionedTable, monthStartDate: Date): string {
  const y = monthStartDate.getUTCFullYear();
  const m = String(monthStartDate.getUTCMonth() + 1).padStart(2, '0');
  return `${table}_${y}_${m}`;
}

/** Creates `table`'s partition for the calendar month containing `month`, if missing. */
export async function ensureMonthPartition(table: PartitionedTable, month: Date): Promise<string> {
  assertKnownTable(table);
  const from = monthStart(month);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const name = partitionName(table, from);
  // Bounds are machine-computed ISO timestamps (never user input) — safe to
  // inline; partition bound literals aren't valid as bind parameters.
  await execute(
    `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${table}
       FOR VALUES FROM ('${from.toISOString()}') TO ('${to.toISOString()}')`,
  );
  return name;
}

/** Ensures a partition exists for the current month plus the next `aheadMonths`. */
export async function ensureUpcomingPartitions(
  table: PartitionedTable,
  aheadMonths = 2,
): Promise<void> {
  const now = new Date();
  for (let i = 0; i <= aheadMonths; i++) {
    await ensureMonthPartition(
      table,
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)),
    );
  }
}

/** This table's dedicated monthly partitions (not the default catch-all), oldest first. */
export async function listMonthlyPartitions(table: PartitionedTable): Promise<string[]> {
  assertKnownTable(table);
  const rows = await query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1 AND c.relname ~ ('^' || $1 || '_[0-9]{4}_[0-9]{2}$')
      ORDER BY c.relname`,
    [table],
  );
  return rows.map((r) => r.relname);
}

function monthOf(table: PartitionedTable, name: string): Date | null {
  // Strip the known-safe prefix with a plain string op, then match the
  // remainder against a fixed literal regex — no dynamic RegExp() built
  // from a variable, which a partition name (however unlikely) could abuse.
  const prefix = `${table}_`;
  if (!name.startsWith(prefix)) return null;
  const m = name.slice(prefix.length).match(/^(\d{4})_(\d{2})$/);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)) : null;
}

/**
 * Drops `table`'s partition for `month` when it's a whole calendar month at
 * or before `cutoff`, has no row from a kennel other than `kennelId` (given
 * this deployment's one-kennel-per-instance model), and — when
 * `notSafeWhere` is given, a trusted SQL fragment identifying rows the
 * caller doesn't consider safe to remove yet (e.g. `"status <> 'resolved'"`
 * for exceptions, so a still-open alert never disappears just because it's
 * old) — has no row matching it either. Returns the row count dropped, or
 * null if nothing was dropped; the caller's row-level DELETE covers
 * whatever that leaves behind.
 */
async function dropMonthIfSafe(
  table: PartitionedTable,
  name: string,
  month: Date,
  cutoff: Date,
  kennelId: string,
  notSafeWhere?: string,
): Promise<number | null> {
  const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
  if (monthEnd > cutoff) return null;
  const other = await queryOne(`SELECT 1 FROM ${name} WHERE kennel_id <> $1 LIMIT 1`, [kennelId]);
  if (other) return null;
  if (notSafeWhere) {
    const blocked = await queryOne(`SELECT 1 FROM ${name} WHERE ${notSafeWhere} LIMIT 1`);
    if (blocked) return null;
  }
  const count = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${name}`);
  await execute(`DROP TABLE IF EXISTS ${name}`);
  return Number(count?.n ?? 0);
}

/**
 * Drops every fully-expired, single-kennel month partition of `table`.
 * `notSafeWhere` — see dropMonthIfSafe — is an optional trusted SQL fragment
 * for a domain-specific "don't drop this row yet" condition. Returns rows
 * dropped.
 */
export async function dropExpiredMonthPartitions(
  table: PartitionedTable,
  cutoff: Date,
  kennelId: string,
  notSafeWhere?: string,
): Promise<number> {
  assertKnownTable(table);
  let dropped = 0;
  for (const name of await listMonthlyPartitions(table)) {
    const month = monthOf(table, name);
    if (!month) continue;
    const n = await dropMonthIfSafe(table, name, month, cutoff, kennelId, notSafeWhere);
    if (n != null) dropped += n;
  }
  return dropped;
}
