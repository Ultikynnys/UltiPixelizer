export type ImageDimensions = { width: number; height: number };

export function lightmapMatchesBaseColor(lightmap: ImageDimensions, baseColor: ImageDimensions): boolean {
  return lightmap.width === baseColor.width && lightmap.height === baseColor.height;
}

/** Multiplies RGB by the lightmap (255 = full brightness). */
export function applyLightmap(data: Uint8ClampedArray, lightmap: Uint8ClampedArray): void {
  const pixels = Math.min(data.length, lightmap.length) / 4;
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4;
    data[offset] *= lightmap[offset] / 255;
    data[offset + 1] *= lightmap[offset + 1] / 255;
    data[offset + 2] *= lightmap[offset + 2] / 255;
  }
}
