import { imagePixels, type PixelSource } from './canvas';
import { clamp01 } from './math';

export type NormalFormat = 'opengl' | 'directx';

export type NormalMapSource = PixelSource;

/** Normal-map payload for the serialized bake scene: the decoded pixels plus
 * the strength / flipY decode flags. Shared by the AO and lightmap bakes so
 * both pipelines perturb shading normals through one payload shape. */
export type SerializedNormalMap = {
  map: NormalMapSource;
  strength: number;
  flipY: boolean;
};

/** Bundles an optional normal map into the serialized payload. The strength is
 * clamped to [0, 1]: values above 1 over-perturb the tangent plane and push
 * the reconstructed normal off the unit sphere (the decode zeroes the Z
 * component), so every pipeline agrees on the bounded range. */
export function normalMapPayload(options: {
  normalMap?: NormalMapSource;
  normalStrength?: number;
  normalFlipY?: boolean;
}): SerializedNormalMap | undefined {
  if (!options.normalMap) return undefined;
  return {
    map: options.normalMap,
    strength: clamp01(options.normalStrength ?? 1),
    flipY: options.normalFlipY ?? false,
  };
}

/**
 * Extracts a normal map's RGBA pixels at its native resolution. The blue channel
 * is preserved so `sampleNormalMap` can reconstruct the tangent-space Z, but the
 * convention difference between OpenGL (+Y) and DirectX (-Y) is only applied at
 * decode time via the `flipY` flag.
 */
export function imageNormalMapPixels(image: CanvasImageSource & { width: number; height: number }): NormalMapSource {
  return {
    data: imagePixels(image, image.width, image.height),
    width: image.width,
    height: image.height,
  };
}

/**
 * Decodes a tangent-space normal from a normal map at normalized UV coordinates.
 * `v` uses the standard texture convention (0 = bottom, 1 = top) and is flipped
 * to image space internally so it lines up with the lightmap bake.
 *
 * - `flipY` inverts the green channel for the DirectX convention (green = −Y).
 * - `strength` scales the tangent-plane perturbation; 0 returns the flat
 *   geometric normal (0, 0, 1), 1 returns the full map.
 *
 * Returns a unit-length tangent-space normal.
 */
export function sampleNormalMap(
  source: NormalMapSource,
  u: number,
  v: number,
  strength: number,
  flipY: boolean,
): [number, number, number] {
  const ux = Math.min(Math.max(u, 0), 1) * source.width - 0.5;
  const vy = (1 - Math.min(Math.max(v, 0), 1)) * source.height - 0.5;
  const px = Math.min(source.width - 1, Math.max(0, Math.floor(ux)));
  const py = Math.min(source.height - 1, Math.max(0, Math.floor(vy)));
  const offset = (py * source.width + px) * 4;
  let nx = source.data[offset] / 127.5 - 1;
  let ny = source.data[offset + 1] / 127.5 - 1;
  if (flipY) ny = -ny;
  const tx = nx * strength;
  const ty = ny * strength;
  const tz = Math.sqrt(Math.max(0, 1 - tx * tx - ty * ty));
  return [tx, ty, tz];
}

export type HeightmapSource = PixelSource;

/**
 * Extracts a heightmap's RGBA pixels at its native resolution. The red channel
 * carries the height for a grayscale map (R = G = B); `sampleHeightmap` reads
 * just that channel.
 */
export function imageHeightmapPixels(image: CanvasImageSource & { width: number; height: number }): HeightmapSource {
  return {
    data: imagePixels(image, image.width, image.height),
    width: image.width,
    height: image.height,
  };
}

/**
 * Samples a grayscale heightmap at normalized UV coordinates, returning the
 * height in 0..1 (black = 0, white = 1). `v` uses the standard texture
 * convention (0 = bottom, 1 = top) and is flipped to image space internally,
 * matching `sampleNormalMap` and the lightmap bake.
 */
export function sampleHeightmap(source: HeightmapSource, u: number, v: number): number {
  const ux = Math.min(Math.max(u, 0), 1) * source.width - 0.5;
  const vy = (1 - Math.min(Math.max(v, 0), 1)) * source.height - 0.5;
  const px = Math.min(source.width - 1, Math.max(0, Math.floor(ux)));
  const py = Math.min(source.height - 1, Math.max(0, Math.floor(vy)));
  const offset = (py * source.width + px) * 4;
  return source.data[offset] / 255;
}
