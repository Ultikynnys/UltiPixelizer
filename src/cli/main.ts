/**
 * Headless CLI entry, loaded by the hidden `cli` webview window in CLI mode
 * (see src-tauri/src/cli.rs).
 *
 * It installs the webview host (canvas codecs + Rust-backed file IO), runs the
 * shared `runCli` orchestration against the arguments Rust captured, prints any
 * diagnostics, and asks Rust to exit with the resulting code. The webview
 * supplies `ImageData`, `OffscreenCanvas`, and `navigator.gpu`, so the AO bake
 * runs on the GPU with no extra dependency.
 */
import { invoke } from '@tauri-apps/api/core';
import { setCliHost } from '../../cli/host';
import { runCli } from '../../cli/main';
import { createWebviewHost } from './hostWebview';

async function run(): Promise<void> {
  const args = await invoke<string[]>('cli_args');
  const cwd = await invoke<string>('cli_cwd');
  const host = createWebviewHost(cwd);
  setCliHost(host);

  let code = 1;
  try {
    code = await runCli(args);
  } catch (error) {
    host.error(`error: ${(error as Error)?.stack ?? String(error)}\n`);
  }
  await host.flush();
  await invoke('cli_exit', { code });
}

run().catch(async (error: unknown) => {
  // The host may not exist yet, so report through the raw command.
  try {
    await invoke('cli_error', { text: `fatal: ${String(error)}\n` });
  } catch {
    // stderr unavailable; nothing more we can do.
  }
  await invoke('cli_exit', { code: 1 });
});
