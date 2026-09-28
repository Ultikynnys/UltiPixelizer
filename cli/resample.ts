/**
 * CLI resample entry — re-exports the shared pure resample core
 * (src/lib/pipeline/pixel.ts) so the CLI and the app resample identically.
 */
export {
  computeOutputDimensions,
  pixelate,
  resampleAndPixelate,
  resize,
  resizeNearest,
  type PixelBuffer,
  type UpscaleMethod,
} from '../src/lib/pipeline/pixel';
