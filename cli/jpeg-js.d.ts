/**
 * Minimal ambient types for `jpeg-js` (no official @types package).
 * Only the surface the CLI uses is declared.
 */
declare module 'jpeg-js' {
  export interface DecodeOptions {
    useTArray?: boolean;
    formatAsRGBA?: boolean;
    maxResolutionInMP?: number;
    maxMemoryUsageInMB?: number;
  }
  export interface RawImage {
    width: number;
    height: number;
    data: Uint8Array;
  }
  export function decode(buffer: Buffer | Uint8Array, options?: DecodeOptions): RawImage;
  export function encode(image: RawImage, quality?: number): { data: Buffer; width: number; height: number };
  const _default: { decode: typeof decode; encode: typeof encode };
  export default _default;
}
