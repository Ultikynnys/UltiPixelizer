import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: {
    // Native fs.watch fails on this filesystem (Z: mount, UNKNOWN error) 
    // polling keeps the dev server alive.
    watch: {
      usePolling: true,
    },
  },
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
      // Worker entry points are served through Vite's worker pipeline
      // (`?worker&inline`), so v8 coverage can't attribute their execution
      // even when tests import and drive them directly (0% on CI). Their
      // logic lives in the instrumented modules they call (aoRaster,
      // lightmapRaster, bakeGeometry), so exclude the thin adapters here
      // instead of fighting the pipeline. The defaults are repeated because
      // setting `exclude` replaces vitest's list.
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/cypress/**',
        '**/.{nyc_output,c8,istanbul}/**',
        '**/*.d.ts',
        '**/test?(s)/**',
        '**/{test,tests,__tests__}/**',
        '**/{vitest,vite}.config.*',
        '**/{karma,rollup,webpack}.config.*',
        '**/.{eslint,mocha,prettier}rc.{js,cjs,ts}',
        'src/lib/**/*.worker.ts',
        // Same adapter class as the workers: wasmLinearMatch is a thin loader
        // over the Rust f64 SIMD palette scan (src-wasm/), and its artifact
        // (src/wasm/dither.wasm) only exists after `npm run build:wasm`. On
        // fresh checkouts/CI the parity test skips and the loader's functions
        // report uncovered (0% on CI); its real logic lives in the Rust crate,
        // which v8 cannot measure either way. The parity test still pins it
        // byte-for-byte when the module is built  this only stops the loader
        // glue from failing the gate.
        'src/lib/wasmLinearMatch.ts',
        // Pure type declarations (interfaces + type-only imports) erase to
        // zero runtime code, so v8 can never attribute coverage to them  no
        // test can execute them, and the report shows a permanent 0% row.
        'src/lib/**/types.ts',
      ],
      thresholds: {
        lines: 95,
        functions: 100,
        statements: 95,
        branches: 85,
      },
    },
  },
});
