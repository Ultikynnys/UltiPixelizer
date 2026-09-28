/**
 * Node CLI host — the `CliHost` backed by `node:fs`, `pngjs`, and `jpeg-js`.
 *
 * This is **test-only** now that the built-in webview CLI (src/cli/hostWebview.ts)
 * is the shipped host: it powers `tests/cli.test.ts` so the shared orchestration
 * and argument handling stay covered without a GUI/webview. It is never imported
 * by the app bundle, so its codecs do not ship.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { unsupportedImageFormatError, type CliHost, type DecodedImage } from './host';
import { extname } from './path';

function looksLikePng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export const nodeCliHost: CliHost = {
  async readFileBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  },

  async readFileText(path: string): Promise<string> {
    return readFile(path, 'utf8');
  },

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    await writeFile(path, bytes);
  },

  async decodeImage(bytes: Uint8Array, path: string): Promise<DecodedImage> {
    const ext = extname(path).toLowerCase();
    if (ext === '.png' || looksLikePng(bytes)) {
      const png = PNG.sync.read(Buffer.from(bytes));
      return {
        data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
        width: png.width,
        height: png.height,
      };
    }
    if (ext === '.jpg' || ext === '.jpeg' || looksLikeJpeg(bytes)) {
      const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
      return {
        data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
        width: raw.width,
        height: raw.height,
      };
    }
    throw unsupportedImageFormatError(ext);
  },

  async encodePng(image: DecodedImage): Promise<Uint8Array> {
    const png = new PNG({ width: image.width, height: image.height });
    // Uint8ClampedArray -> Buffer view (no copy of the pixel bytes).
    png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    return new Uint8Array(PNG.sync.write(png));
  },

  resolvePath(path: string): string {
    return resolve(path);
  },

  log(text: string): void {
    process.stdout.write(text);
  },

  error(text: string): void {
    process.stderr.write(text);
  },

  async flush(): Promise<void> {
    // Direct writes need no flush.
  },
};
