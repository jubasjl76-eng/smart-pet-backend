import { describe, it, expect } from 'vitest';
import committed from '../../openapi.json';
import { buildOpenApiDoc } from '../openapi/index.js';
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
import '../breeder/routes/litters.js';
import '../breeder/routes/ops.js';
import '../breeder/routes/devices.js';
import '../breeder/routes/website.js';
import '../breeder/routes/public.js'; // keep in sync with src/openapi/dump.ts

describe('openapi.json', () => {
  it('is up to date — run `npm run openapi:dump` if this fails', () => {
    expect(buildOpenApiDoc()).toEqual(committed);
  });
});
