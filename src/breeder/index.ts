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

export { startBreederEngine, stopBreederEngine, engineTick } from './engine/index.js';
export { initBreederSchema } from './schema.js';

export function mountBreeder(app: Express): void {
  const guard = [auth, withKennel];
  app.use('/api/breeder/animals', ...guard, animals);
  app.use('/api/breeder/litters', ...guard, litters);
  app.use('/api/breeder/medications', ...guard, meds);
  app.use('/api/breeder/inbox', ...guard, inbox);
  app.use('/api/breeder/rules', ...guard, rules);
  app.use('/api/breeder/ops', ...guard, ops);

  app.get('/api/breeder/health', (_req, res) => {
    res.json({ ok: true, module: 'breeder', mountedAt: '/api/breeder' });
  });
}
