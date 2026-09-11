/**
 * Smart Pet Backend - Unified API (port 3000 only)
 * 24 Sep feeder loop: owner JWT + MQTT command/status on kennel/{kennelId}/feeder/{deviceId}/
 * mqttConsumer.ts is quarantined and is not started here.
 */
import './instrument.js'; // Sentry — must be the very first import (patches http/express/pg)
import { config } from './config/index.js'; // loads + validates env, exits on a bad config
import { initializeDatabase, pool } from './database/index.js';
import { closeRedis } from './redis.js';
import { runMigrations } from './database/migrate.js';
import { runSeed } from './database/seed.js';
import { startFeederMqtt, stopFeederMqtt } from './services/feederMqtt.js';
import {
  initBreederSchema,
  startBreederEngine,
  stopBreederEngine,
  closeStreamRedis,
} from './breeder/index.js';
import { VERSION } from './version.js';
import { log } from './log.js';
import { buildApp, logBootConfig } from './app.js';

const PORT = 3000;
let shuttingDown = false;

logBootConfig();
const app = buildApp({ isShuttingDown: () => shuttingDown });

initializeDatabase()
  .then(() => initBreederSchema())
  .then(() => runMigrations(pool, (m) => log.debug(m)))
  .then((applied) => {
    if (applied.length) log.info({ count: applied.length }, 'migrations applied');
  })
  .then(() => runSeed())
  .then(() => startFeederMqtt())
  .then(() => startBreederEngine())
  .catch((e) => {
    log.error({ err: e }, 'database/mqtt boot failed');
  });

const server = app.listen(PORT, () => {
  log.info({ port: PORT, mode: config.BACKEND_MODE, version: VERSION }, 'Smart Pet API listening');
});

async function shutdown(signal?: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true; // /ready → 503
  log.info({ signal: signal ?? 'signal' }, 'shutdown — draining');

  const guard = setTimeout(() => {
    log.error('shutdown drain timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  guard.unref();

  server.close(async () => {
    stopBreederEngine();
    stopFeederMqtt();
    await closeStreamRedis();
    await closeRedis();
    await pool.end().catch(() => {});
    clearTimeout(guard);
    log.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export default app;
