#!/usr/bin/env node
/** UltiPixelizer CLI entry point. Wires process.argv into runCli. */
import { runCli } from './main';

runCli(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    process.stderr.write(`error: ${(error as Error)?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
