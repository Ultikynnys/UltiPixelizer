import {
  Box3,
  BufferAttribute,
  CanvasTexture,
  Color,
  DoubleSide,
  Material,
  Mesh,
  NearestFilter,
  Object3D,
  PerspectiveCamera,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

const uvPattern = /^uv(\d*)$/;

export function uvChannelIndex(name: string): number {
  if (name === 'uv') return 0;
  const match = name.match(uvPattern);
  return match?.[1] ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function geometryUVChannels(object: Object3D): string[] {
  const channels = new Set<string>();
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    Object.keys(child.geometry.attributes).filter((name) => uvPattern.test(name)).forEach((name) => channels.add(name));
  });
  return Array.from(channels).sort((left, right) => uvChannelIndex(left) - uvChannelIndex(right));
}

function storedUVAttributes(mesh: Mesh): Record<string, BufferAttribute> {
  const stored = mesh.geometry.userData.ultiPixelizerUVs as Record<string, BufferAttribute> | undefined;
  if (stored) return stored;
  const attributes = Object.fromEntries(
    Object.entries(mesh.geometry.attributes).filter(([name]) => uvPattern.test(name)),
  ) as Record<string, BufferAttribute>;
  mesh.geometry.userData.ultiPixelizerUVs = attributes;
  return attributes;
}

export function applyUVChannel(object: Object3D, requested: string): { fallbackMeshes: number; missingMeshes: number } {
  let fallbackMeshes = 0;
  let missingMeshes = 0;
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const attributes = storedUVAttributes(child);
    const available = Object.keys(attributes).sort((left, right) => uvChannelIndex(left) - uvChannelIndex(right));
    const selected = attributes[requested] ?? attributes[available[0]];
    if (!selected) {
      child.geometry.deleteAttribute('uv');
      missingMeshes += 1;
      return;
    }
    if (!attributes[requested]) fallbackMeshes += 1;
    child.geometry.setAttribute('uv', selected);
  });
  return { fallbackMeshes, missingMeshes };
}

export function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** Rebuilds vertex normals from triangle winding for every mesh, replacing
 * potentially-broken exporter normals (e.g. FBX). Returns the mesh count. */
export function recomputeVertexNormals(object: Object3D): number {
  let meshCount = 0;
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry.computeVertexNormals();
    meshCount += 1;
  });
  return meshCount;
}

export function cloneModelScene(source: Object3D): Object3D {
  const clone = cloneSkeleton(source);
  const textures = new Map<Texture, Texture>();
  const cloneMaterial = (sourceMaterial: Material): Material => {
    const material = sourceMaterial.clone();
    for (const [property, value] of Object.entries(material)) {
      if (!(value instanceof Texture)) continue;
      let texture = textures.get(value);
      if (!texture) {
        texture = value.clone();
        textures.set(value, texture);
      }
      (material as unknown as Record<string, unknown>)[property] = texture;
    }
    return material;
  };
  clone.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry = child.geometry.clone();
    child.material = Array.isArray(child.material)
      ? child.material.map(cloneMaterial)
      : cloneMaterial(child.material);
  });
  return clone;
}

function createNearestCanvasTexture(image: CanvasImageSource): CanvasTexture<CanvasImageSource> {
  const texture = new CanvasTexture(image);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function createPixelTexture(image: CanvasImageSource): CanvasTexture<CanvasImageSource> {
  const texture = createNearestCanvasTexture(image);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function applyTextureToMaterial(material: Material, texture: Texture): void {
  const textured = material as Material & {
    map?: Texture | null;
    color?: Color;
    transparent?: boolean;
    specular?: Color;
    shininess?: number;
    metalness?: number;
    roughness?: number;
    clearcoat?: number;
    specularIntensity?: number;
  };
  if (!('map' in textured)) return;
  textured.map = texture;
  textured.color?.set(0xffffff);
  textured.transparent = true;
  textured.side = DoubleSide;
  if ('specular' in textured) textured.specular?.set(0x000000);
  if ('shininess' in textured) textured.shininess = 0;
  if ('metalness' in textured) textured.metalness = 0;
  if ('roughness' in textured) textured.roughness = 1;
  if ('clearcoat' in textured) textured.clearcoat = 0;
  if ('specularIntensity' in textured) textured.specularIntensity = 0;
  textured.needsUpdate = true;
}

export function applyTextureToModel(object: Object3D, texture: Texture): number {
  let materialCount = 0;
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    materialsOf(child).forEach((material) => {
      applyTextureToMaterial(material, texture);
      materialCount += 1;
    });
  });
  return materialCount;
}

export function fitCameraToObject(camera: PerspectiveCamera, object: Object3D, aspect: number): Vector3 {
  const bounds = new Box3().setFromObject(object);
  const center = bounds.isEmpty() ? new Vector3() : bounds.getCenter(new Vector3());
  const size = bounds.isEmpty() ? new Vector3(1, 1, 1) : bounds.getSize(new Vector3());
  const radius = Math.max(size.length() * 0.5, 0.01);
  camera.aspect = aspect || 1;
  camera.near = Math.max(radius / 100, 0.001);
  camera.far = Math.max(radius * 100, 100);
  camera.position.copy(center).add(new Vector3(radius * 1.1, radius * 0.65, radius * 1.6));
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return center;
}

export function disposeModel(object: Object3D): void {
  const textures = new Set<Texture>();
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry.dispose();
    materialsOf(child).forEach((material) => {
      Object.values(material).forEach((value) => { if (value instanceof Texture) textures.add(value); });
      material.dispose();
    });
  });
  textures.forEach((texture) => texture.dispose());
}
