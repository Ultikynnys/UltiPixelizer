/**
 * Headless image decode/encode for the CLI. Pure-JS (no native deps):
 *  - PNG  via `pngjs`
 *  - JPEG via `jpeg-js`
 *
 * Output is always PNG (the app's export format).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

export interface DecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Decodes a PNG or JPEG file into straight RGBA pixels. */
export async function decodeImage(path: string): Promise<DecodedImage> {
  const buffer = await readFile(path);
  const ext = extname(path).toLowerCase();

  const isPng = ext === '.png' || looksLikePng(buffer);
  if (isPng) {
    const png = PNG.sync.read(buffer);
    return {
      data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
      width: png.width,
      height: png.height,
    };
  }

  if (ext === '.jpg' || ext === '.jpeg' || looksLikeJpeg(buffer)) {
    const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
    return {
      data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
      width: raw.width,
      height: raw.height,
    };
  }

  throw new Error(
    `Unsupported input format "${ext || '(none)'}". Supported: .png, .jpg/.jpeg. ` +
    'Convert other formats (WebP/GIF/TGA) to PNG first.',
  );
}

/** Encodes RGBA pixels to a PNG file. */
export async function encodePng(path: string, image: DecodedImage): Promise<number> {
  const png = new PNG({ width: image.width, height: image.height });
  // Uint8ClampedArray -> Buffer view (no copy of the pixel bytes).
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const out = PNG.sync.write(png);
  await writeFile(path, out);
  return out.length;
}

function looksLikePng(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

function looksLikeJpeg(buffer: Buffer): boolean {
  return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}
