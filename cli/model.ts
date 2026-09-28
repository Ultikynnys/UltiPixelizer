/**
 * Headless 3D model loading for AO / lighting bakes.
 *
 * three.js loaders are driven through their `parse()` entry points on
 * `fs`-read buffers, so no `File`, `URL`, or fetch is involved. FBX/OBJ/glTF/GLB
 * are supported; USDZ (which needs a WASM reader) errors clearly.
 */
import { ImageLoader, Object3D, Texture } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { applyUVChannel, getFallbackQuadScene } from '../src/lib/modelScene';
import { applyLodLevel, prepareModelLods } from '../src/lib/modelLod';
import type { WorldAxis } from '../src/lib/modelFiles';
import { upAxisRotation, withoutFbxUpAxisWarning } from '../src/lib/modelAxis';
import { cliHost } from './host';
import { extname } from './path';

export type ModelPrepOptions = {
  worldAxis: WorldAxis;
  lod: number;
  uvMap: string;
};

export type ModelPrep = {
  lodLevels: number[];
  collidersRemoved: number;
  uvFallbackMeshes: number;
  uvMissingMeshes: number;
  meshCount: number;
};

/**
 * The bakes need geometry only — never the model's own materials/textures. three's
 * loaders reach for the DOM `document` to decode images, which does not exist in
 * Node, so intercept `ImageLoader` (which `TextureLoader` delegates to) and hand
 * back an empty texture instead of decoding.
 */
let textureStubInstalled = false;
function stubTextureLoading(): void {
  if (textureStubInstalled) return;
  textureStubInstalled = true;
  ImageLoader.prototype.load = function stubLoad(_url: string, onLoad?: (image: HTMLImageElement) => void) {
    const texture = new Texture();
    onLoad?.(texture as unknown as HTMLImageElement);
    return texture as unknown as HTMLImageElement;
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Loads a model file into a three.js scene graph. */
export async function loadModel(path: string): Promise<Object3D> {
  const ext = extname(path).toLowerCase().replace('.', '');
  const buffer = await cliHost().readFileBytes(path);
  const baseDir = path.replace(/\\/g, '/').replace(/[^/]*$/, '');
  stubTextureLoading();

  switch (ext) {
    case 'fbx':
      return withoutFbxUpAxisWarning(async () => new FBXLoader().parse(toArrayBuffer(buffer), baseDir));
    case 'obj':
      return new OBJLoader().parse(new TextDecoder().decode(buffer));
    case 'glb':
    case 'gltf':
      return await new Promise<Object3D>((resolve, reject) => {
        new GLTFLoader().parse(toArrayBuffer(buffer), baseDir, (result) => resolve(result.scene), reject);
      });
    case 'usdz':
      throw new Error('USDZ models need a WASM reader that the headless CLI does not bundle. Convert to GLB/FBX.');
    default:
      throw new Error(`Unsupported model format ".${ext}". Supported: fbx, obj, gltf, glb.`);
  }
}

/** Applies world-axis orientation, LOD selection, and the UV-channel choice,
 * mirroring the app's model-prep order. Returns a short summary. */
export function prepareModel(scene: Object3D, options: ModelPrepOptions): ModelPrep {
  scene.rotation.set(upAxisRotation(options.worldAxis), 0, 0);
  scene.updateMatrixWorld(true);
  const lods = prepareModelLods(scene);
  applyLodLevel(scene, options.lod);
  const uv = applyUVChannel(scene, options.uvMap);
  let meshCount = 0;
  scene.traverse((child) => {
    if ((child as { isMesh?: boolean }).isMesh) meshCount += 1;
  });
  return {
    lodLevels: lods.levels,
    collidersRemoved: lods.collidersRemoved,
    uvFallbackMeshes: uv.fallbackMeshes,
    uvMissingMeshes: uv.missingMeshes,
    meshCount,
  };
}

/** The implicit bake geometry when no model is loaded: a flat quad (optionally a
 * 3×3 grid whose neighbours are occluders) facing up. */
export function fallbackQuad(tessellation: number, grid: boolean): Object3D {
  return getFallbackQuadScene(tessellation, grid);
}
