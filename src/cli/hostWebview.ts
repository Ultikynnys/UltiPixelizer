/**
 * WebView CLI host — the `CliHost` the shipped built-in CLI runs on.
 *
 * Codecs use the webview's own canvas (`createImageBitmap` to decode PNG/JPEG,
 * `OffscreenCanvas.convertToBlob` to encode PNG), so no image-codec dependency
 * ships. File IO and stdout/stderr go through the Rust `cli_*` commands
 * (src-tauri/src/cli.rs). Path resolution uses the process cwd Rust reports.
 */
import { invoke } from '@tauri-apps/api/core';
import { unsupportedImageFormatError, type CliHost, type DecodedImage } from '../../cli/host';
import { extname, join, normalizeSeparators } from '../../cli/path';

/** True for `/abs`, `C:/abs`, or `C:\abs` (after separator normalization). */
function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function toUint8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error('cli_read_file returned an unexpected payload.');
}

export function createWebviewHost(cwd: string): CliHost {
  let outBuffer = '';
  let errBuffer = '';

  return {
    async readFileBytes(path: string): Promise<Uint8Array> {
      return toUint8(await invoke('cli_read_file', { path }));
    },

    async readFileText(path: string): Promise<string> {
      return new TextDecoder().decode(await this.readFileBytes(path));
    },

    async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
      // Pass a plain number[] so the Rust `Vec<u8>` argument deserializes from
      // the IPC's JSON body.
      await invoke('cli_write_file', { path, data: Array.from(bytes) });
    },

    async decodeImage(bytes: Uint8Array, path: string): Promise<DecodedImage> {
      let bitmap: ImageBitmap;
      try {
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        bitmap = await createImageBitmap(new Blob([buffer]));
      } catch {
        throw unsupportedImageFormatError(extname(path).toLowerCase());
      }
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close();
      return { data: image.data, width: image.width, height: image.height };
    },

    async encodePng(image: DecodedImage): Promise<Uint8Array> {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d')!;
      const rgba = new Uint8ClampedArray(image.data.byteLength);
      rgba.set(image.data);
      context.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return new Uint8Array(await blob.arrayBuffer());
    },

    resolvePath(path: string): string {
      const normalized = normalizeSeparators(path);
      return isAbsolute(normalized) ? normalized : join(cwd, normalized);
    },

    log(text: string): void {
      outBuffer += text;
    },

    error(text: string): void {
      errBuffer += text;
    },

    async flush(): Promise<void> {
      if (outBuffer) {
        const pending = outBuffer;
        outBuffer = '';
        await invoke('cli_log', { text: pending });
      }
      if (errBuffer) {
        const pending = errBuffer;
        errBuffer = '';
        await invoke('cli_error', { text: pending });
      }
    },
  };
}
