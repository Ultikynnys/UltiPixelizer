/**
 * Minimal `ImageData` shim so the browser pipeline (`dither.ts`,
 * `wasmLinearMatch.ts`) runs unchanged under Node. Only the constructor and the
 * `.data/.width/.height/.colorSpace` surface the pipeline touches is provided.
 *
 * Import this module *before* any `../src/lib/*` module so the global exists by
 * the time the dither functions run.
 */

interface ImageDataSettings {
  colorSpace?: string;
}

class NodeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace: string;

  constructor(
    a: Uint8ClampedArray | number,
    b: number,
    c?: number | ImageDataSettings,
    d?: ImageDataSettings,
  ) {
    if (typeof a === 'number') {
      // new ImageData(width, height [, settings])
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
      const settings = c as ImageDataSettings | undefined;
      this.colorSpace = settings?.colorSpace ?? 'srgb';
    } else {
      // new ImageData(data, width, height [, settings])
      this.data = a;
      this.width = b;
      this.height = c as number;
      this.colorSpace = d?.colorSpace ?? 'srgb';
    }
  }
}

const g = globalThis as unknown as { ImageData?: unknown };
if (!g.ImageData) g.ImageData = NodeImageData;

export { NodeImageData };
