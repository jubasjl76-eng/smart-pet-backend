/**
 * Fill the kennel so the breeder console has something on every screen.
 *
 *   npm run seed
 *
 * Idempotent. Requires Postgres (same env as the API). When you add a console
 * screen, add the rows in src/database/seedConsole.ts.
 */
import { initializeDatabase, pool } from './index.js';
import { initBreederSchema } from '../breeder/schema.js';
import { runMigrations } from './migrate.js';
import { runSeed } from './seed.js';

async function main() {
  await initializeDatabase();
  await initBreederSchema();
  const applied = await runMigrations(pool, (m) => console.log(m));
  if (applied.length) console.log(`[seed] ${applied.length} migration(s) applied`);
  await runSeed({ demo: true, console: true });
  await pool.end();
}

main().catch((e) => {
  console.error('[seed]', (e as Error).message);
  process.exit(1);
});
