import shared from './eslint.shared.mjs';

export default [
  ...shared,
  // k6 scripts run under k6's own JS runtime (goja), not Node — __ENV and
  // the k6/* module imports are its globals, not this repo's (Phase 21,
  // A12 #24 load test).
  {
    files: ['k6/**'],
    languageOptions: {
      globals: { __ENV: 'readonly', __ITER: 'readonly', __VU: 'readonly' },
    },
  },
];
