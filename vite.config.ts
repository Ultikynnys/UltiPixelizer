import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/lib/customPalettes.ts', 'src/lib/dither.ts', 'src/lib/modelFiles.ts', 'src/lib/modelLod.ts', 'src/lib/modelScene.ts', 'src/lib/palettes.ts', 'src/lib/presets.ts', 'src/lib/renderScheduler.ts'],
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
