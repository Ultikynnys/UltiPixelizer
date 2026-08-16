import { Material, Mesh, Object3D, Texture } from 'three';
import { drawImageToCanvas } from './canvas';
import { materialsOf } from './modelScene';
import type { SourceImage } from './state';

/**
 * Extracted model texture channels mapped to the tool's slots. `base` comes
 * from the material's `map` (basecolor), `normal` from `normalMap`, `ao` from
 * `aoMap`. Channels the model doesn't provide are omitted.
 */
export type ExtractedModelTextures = {
  base?: SourceImage;
  normal?: SourceImage;
  ao?: SourceImage;
};

/**
 * Copies a texture's image into an independent canvas at its native size,
 * returning null when the image can't be drawn (missing, or compressed /
 * KTX2 textures whose image is a mipmap set).
 *
 * The canvas is vertically flipped when `texture.flipY === false` — the glTF
 * convention, where UV (0,0) is the image top-left. The tool's bake pipeline
 * assumes the three.js default convention (v=0 at the image bottom; see
 * `rasterizeBake`), so glTF textures must be flipped to land in the same
 * orientation as FBX/OBJ textures and the baked lightmap/AO.
 */
export function textureSourceImage(texture: Texture): SourceImage | null {
  const image = texture.image as (CanvasImageSource & { width?: number; height?: number }) | null | undefined;
  if (!image) return null;
  const width = image.width;
  const height = image.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return null;
  // A draw failure (closed ImageBitmap, exotic image type) must not abort the
  // whole model import — skip the texture and keep the slot as-is.
  try {
    const { canvas, context } = drawImageToCanvas(image, width, height);
    if (!context) return null;
    if (texture.flipY === false) flipCanvasVertically(canvas, context);
    return canvas;
  } catch {
    return null;
  }
}

function flipCanvasVertically(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  const rowBytes = canvas.width * 4;
  const row = new Uint8ClampedArray(rowBytes);
  for (let y = 0; y < Math.floor(canvas.height / 2); y += 1) {
    const top = y * rowBytes;
    const bottom = (canvas.height - 1 - y) * rowBytes;
    row.set(data.data.subarray(top, top + rowBytes));
    data.data.copyWithin(top, bottom, bottom + rowBytes);
    data.data.set(row, bottom);
  }
  context.putImageData(data, 0, 0);
}

/**
 * Walks a model scene and collects the first `map` / `normalMap` / `aoMap`
 * texture found on any material (material arrays included), converted to
 * independent canvases via {@link textureSourceImage}. Traversal order decides
 * which material wins when several carry the same channel.
 */
export function collectModelTextures(object: Object3D): ExtractedModelTextures {
  const found: ExtractedModelTextures = {};
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    for (const material of materialsOf(child)) {
      const textured = material as Material & { map?: Texture | null; normalMap?: Texture | null; aoMap?: Texture | null };
      if (!found.base && textured.map) {
        const image = textureSourceImage(textured.map);
        if (image) found.base = image;
      }
      if (!found.normal && textured.normalMap) {
        const image = textureSourceImage(textured.normalMap);
        if (image) found.normal = image;
      }
      if (!found.ao && textured.aoMap) {
        const image = textureSourceImage(textured.aoMap);
        if (image) found.ao = image;
      }
    }
  });
  return found;
}
