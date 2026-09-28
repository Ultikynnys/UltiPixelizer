/**
 * Image decode/encode for the CLI, delegated to the installed host (Node
 * `pngjs`/`jpeg-js` in tests, canvas in the webview). Output is always PNG —
 * the app's export format.
 */
import { cliHost, type DecodedImage } from './host';

export type { DecodedImage };

/** Decodes a PNG or JPEG file into straight RGBA pixels. */
export async function decodeImage(path: string): Promise<DecodedImage> {
  const bytes = await cliHost().readFileBytes(path);
  return cliHost().decodeImage(bytes, path);
}

/** Encodes RGBA pixels to a PNG file; returns the byte length written. */
export async function encodePng(path: string, image: DecodedImage): Promise<number> {
  const bytes = await cliHost().encodePng(image);
  await cliHost().writeFileBytes(path, bytes);
  return bytes.length;
}
