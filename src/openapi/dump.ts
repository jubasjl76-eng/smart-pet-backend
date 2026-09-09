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
// + more route files as they migrate onto the zod registry
import { buildOpenApiDoc } from './index.js';

const out = fileURLToPath(new URL('../../openapi.json', import.meta.url));
writeFileSync(out, JSON.stringify(buildOpenApiDoc(), null, 2) + '\n');
console.log(`wrote ${out}`);
