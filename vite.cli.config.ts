import { defineConfig } from 'vite';

/**
 * Builds the headless CLI (`cli/index.ts`) into a Node ESM bundle at
 * `dist-cli/ultipixelizer.mjs`.
 *
 * A Vite build (not tsx/esbuild) is required because the shared pipeline pulls
 * in `src/lib/palettes.ts`, which resolves its palette JSON through Vite's
 * `import.meta.glob` at build time. SSR mode + `lib` emits a single Node ESM
 * file; the pure-JS image codecs stay external so Node resolves them at runtime.
 */
export default defineConfig({
  // The CLI is a Node bundle: don't copy the browser `public/` dir (favicons).
  publicDir: false,
  build: {
    ssr: true,
    target: 'node18',
    outDir: 'dist-cli',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: 'cli/index.ts',
      formats: ['es'],
      fileName: () => 'ultipixelizer.mjs',
    },
    rollupOptions: {
      // Keep the codecs and Node built-ins out of the bundle so Node resolves
      // them from node_modules at runtime.
      external: ['pngjs', 'jpeg-js', /^node:/],
      output: {
        // A stable, banner-free ESM file the `bin` entry points at.
        entryFileNames: 'ultipixelizer.mjs',
      },
    },
  },
  ssr: {
    // Bundle our own source + the Vite-only `import.meta.glob`; leave the
    // codecs external.
    noExternal: [],
  },
});
