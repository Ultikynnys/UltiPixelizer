/**
 * Headless 3D model loading for AO / lighting bakes.
 *
 * three.js loaders are driven through their `parse()` entry points on
 * `fs`-read buffers, so no `File`, `URL`, or fetch is involved. FBX/OBJ/glTF/GLB
 * are supported; USDZ (which needs a WASM reader) errors clearly.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { ImageLoader, Object3D, Texture } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { applyUVChannel, getFallbackQuadScene } from '../src/lib/modelScene';
import { applyLodLevel, prepareModelLods } from '../src/lib/modelLod';
import type { WorldAxis } from '../src/lib/modelFiles';

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

/** up-axis correction: Blender is Z-up (rotate -90° about X), Maya is Y-up. */
function upAxisRotation(worldAxis: WorldAxis): number {
  return worldAxis === 'blender' ? -Math.PI / 2 : 0;
}

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

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/** Runs `parse` with the FBXLoader's Z-up notice filtered: it describes a
 * rotation `prepareModel` immediately overwrites via the world-axis setting. */
function withoutFbxUpAxisWarning<T>(work: () => T): T {
  const original = console.warn;
  console.warn = ((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('Z-UP coordinate system')) return;
    original(...args);
  }) as typeof console.warn;
  try {
    return work();
  } finally {
    console.warn = original;
  }
}

/** Loads a model file into a three.js scene graph. */
export async function loadModel(path: string): Promise<Object3D> {
  const ext = extname(path).toLowerCase().replace('.', '');
  const buffer = readFileSync(path);
  const baseDir = path.replace(/\\/g, '/').replace(/[^/]*$/, '');
  stubTextureLoading();

  switch (ext) {
    case 'fbx':
      return withoutFbxUpAxisWarning(() => new FBXLoader().parse(toArrayBuffer(buffer), baseDir));
    case 'obj':
      return new OBJLoader().parse(buffer.toString('utf8'));
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
