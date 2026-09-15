// Shared ESLint 9 flat config for the TS repos. In a repo:
//   import shared from './config/eslint.config.mjs'  (after sync-dev-config.sh)
//   export default shared
// Needs devDeps: eslint, typescript-eslint, globals
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'build/**', 'coverage/**', 'node_modules/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['**/*.test.ts', '**/__tests__/**', 'test/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
