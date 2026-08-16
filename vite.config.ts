import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    // `.reasonix/` holds vendored backups (e.g. wt-v34) whose stale test files
    // must not run against the live code. `exclude` replaces vitest's default
    // list, so the standard entries are repeated here.
    exclude: ['**/.reasonix/**', '**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 95,
        functions: 100,
        statements: 95,
        branches: 85,
      },
    },
  },
});
