/**
 * Smart Pet Backend — feeder command path
 * Port 3000 only. No Mongo. mqttConsumer.ts is quarantined.
 * Collar routes are not mounted (out of scope).
 */
import dotenv from 'dotenv';
dotenv.config();

import { assertJwtSecretOrExit, PORT } from './config.js';
import { initializeDatabase, seedIdentities } from './database/index.js';
import { createApp } from './app.js';
import { startFeederMqttFromEnv } from './services/feederMqtt.js';

assertJwtSecretOrExit();

if (PORT !== 3000 && process.env.ALLOW_NON_DEFAULT_PORT !== '1') {
  console.warn(`[boot] PORT=${PORT} — product path is :3000 only (3002/3003 are not used)`);
}

const app = createApp();

async function boot() {
  await initializeDatabase();
  await seedIdentities();
  startFeederMqttFromEnv();

  app.listen(PORT, () => {
    console.log(`Smart Pet API feeder command path on http://localhost:${PORT}`);
  });
}

boot().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});

export default app;
