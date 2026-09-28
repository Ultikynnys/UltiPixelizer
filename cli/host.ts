/**
 * Host abstraction for the shared CLI core.
 *
 * The CLI orchestration (main.ts) and its helpers run unchanged in two hosts:
 *  - Node  (`cli/hostNode.ts`): `node:fs` + `pngjs`/`jpeg-js`, used only by the
 *    test suite now — it is not shipped.
 *  - Tauri webview (`src/cli/hostWebview.ts`): canvas codecs + Rust-backed file
 *    IO via the `cli_*` commands, which is what the desktop binary runs.
 *
 * Everything environment-specific (file IO, image codecs, stdout/stderr, cwd)
 * goes through this interface so the pipeline and argument handling stay in one
 * place and nothing in `src/lib` is duplicated.
 */

/** Straight RGBA pixels — the shape the pipeline and codecs exchange. */
export interface DecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface CliHost {
  /** Reads a file's raw bytes. */
  readFileBytes(path: string): Promise<Uint8Array>;
  /** Reads a file as UTF-8 text. */
  readFileText(path: string): Promise<string>;
  /** Writes raw bytes to a file (creating parents as needed). */
  writeFileBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Decodes PNG/JPEG bytes to RGBA. `path` only steers the extension check
   * and the error message. */
  decodeImage(bytes: Uint8Array, path: string): Promise<DecodedImage>;
  /** Encodes RGBA to PNG bytes. */
  encodePng(image: DecodedImage): Promise<Uint8Array>;
  /** Absolute path, resolving relative input against the process cwd. */
  resolvePath(path: string): string;
  /** Writes one chunk of CLI output (stdout). */
  log(text: string): void;
  /** Writes one chunk of CLI diagnostics (stderr). */
  error(text: string): void;
  /** Flushes buffered log/error output. No-op for hosts that write directly. */
  flush(): Promise<void>;
}

let current: CliHost | null = null;

/** The shared "unreadable image" error both hosts raise when a file is neither
 * PNG nor JPEG, so the user-facing message stays identical across hosts. */
export function unsupportedImageFormatError(extension: string): Error {
  return new Error(
    `Unsupported input format "${extension || '(none)'}". Supported: .png, .jpg/.jpeg. ` +
      'Convert other formats (WebP/GIF/TGA) to PNG first.',
  );
}

/** Installs the host. Must be called once at startup, before `runCli`. */
export function setCliHost(host: CliHost): void {
  current = host;
}

/** The installed host; throws when `setCliHost` has not run. */
export function cliHost(): CliHost {
  if (!current) throw new Error('CLI host has not been installed.');
  return current;
}
