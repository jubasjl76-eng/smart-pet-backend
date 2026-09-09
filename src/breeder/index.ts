/**
 * Breeder platform — mount point.
 *
 *   mountBreeder(app)        → registers /api/breeder/* routes (behind owner/staff JWT)
 *   startBreederEngine()     → MQTT subscriber + periodic sweeps (call once after DB init)
 *
 * All routes require a valid JWT (auth) and resolve the caller's kennel (withKennel).
 */
import type { Express } from 'express';
import { auth } from '../middleware/auth.js';
import { withKennel } from './http.js';
import animals from './routes/animals.js';
import litters from './routes/litters.js';
import meds from './routes/meds.js';
import inbox from './routes/inbox.js';
import rules from './routes/rules.js';
import ops from './routes/ops.js';
import devices from './routes/devices.js';
import publicRoutes from './routes/public.js';
import vaccinations from './routes/vaccinations.js';
import buyerComms from './routes/buyerComms.js';
import breeding from './routes/breeding.js';
import documents from './routes/documents.js';
import websiteRoutes from './routes/website.js';
import { streamHandler } from './stream.js';

export { startBreederEngine, stopBreederEngine, engineTick } from './engine/index.js';
export { initBreederSchema } from './schema.js';

export function mountBreeder(app: Express): void {
  const guard = [auth, withKennel];

  // Public marketing site — read-only, NO auth. Serves only published rows.
  app.use('/api/public', publicRoutes);

  // Server-Sent Events — live care-inbox + device state for the console.
  app.get('/api/breeder/stream', ...guard, streamHandler);

  app.use('/api/breeder/animals', ...guard, animals);
  app.use('/api/breeder/litters', ...guard, litters);
  app.use('/api/breeder/medications', ...guard, meds);
  app.use('/api/breeder/inbox', ...guard, inbox);
  app.use('/api/breeder/rules', ...guard, rules);
  app.use('/api/breeder/ops/devices', ...guard, devices);
  app.use('/api/breeder/ops', ...guard, ops);
  app.use('/api/breeder/website', ...guard, websiteRoutes);
  app.use('/api/breeder/vaccinations', ...guard, vaccinations);
  app.use('/api/breeder/buyers', ...guard, buyerComms);
  app.use('/api/breeder/breeding', ...guard, breeding);
  app.use('/api/breeder/documents', ...guard, documents);

  app.get('/api/breeder/health', (_req, res) => {
    res.json({ ok: true, module: 'breeder', mountedAt: '/api/breeder' });
  });
}
