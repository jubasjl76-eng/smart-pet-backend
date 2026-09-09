import { describe, it, expect } from 'vitest';
import committed from '../../openapi.json';
import { buildOpenApiDoc } from '../openapi/index.js';
import '../routes/auth.js'; // keep in sync with src/openapi/dump.ts

describe('openapi.json', () => {
  it('is up to date — run `npm run openapi:dump` if this fails', () => {
    expect(buildOpenApiDoc()).toEqual(committed);
  });
});
