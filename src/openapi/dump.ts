/**
 * Writes the current OpenAPI doc to `openapi.json` at the repo root.
 *   npm run openapi:dump
 * The committed file is what the Phase 14 codegen (@jubasjl76-eng/api-client)
 * reads. A vitest check fails if it drifts from the registered routes.
 *
 * Import every route file that uses `apiRoute()` here so its routes register.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../routes/auth.js';
import '../breeder/routes/rules.js';
import '../breeder/routes/inbox.js';
import '../breeder/routes/meds.js';
import '../breeder/routes/geo.js';
import '../breeder/routes/fleet.js';
import '../breeder/routes/documents.js';
import '../breeder/routes/privacy.js';
import '../breeder/routes/vaccinations.js';
import '../breeder/routes/breeding.js';
import '../breeder/routes/buyerComms.js';
import '../breeder/routes/animals.js';
// + more route files as they migrate onto the zod registry
import { buildOpenApiDoc } from './index.js';

const out = fileURLToPath(new URL('../../openapi.json', import.meta.url));
writeFileSync(out, JSON.stringify(buildOpenApiDoc(), null, 2) + '\n');
console.log(`wrote ${out}`);
