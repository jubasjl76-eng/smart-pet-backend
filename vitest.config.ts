import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    // The app refuses to boot without JWT_SECRET; give the suite a throwaway one
    // so `npm test` runs clean without every dev exporting it first.
    env: { JWT_SECRET: process.env.JWT_SECRET ?? 'test-secret-not-for-production' },
  },
});
