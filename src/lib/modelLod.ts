import { Mesh, Object3D } from 'three';

const COLLIDER_PATTERN = /UCX_/i;
const LOD_SUFFIX_PATTERN = /_LOD(\d+)$/i;

export function isColliderName(name: string): boolean {
  return COLLIDER_PATTERN.test(name);
}

export function lodIndexFor(name: string): number {
  const match = name.match(LOD_SUFFIX_PATTERN);
  return match ? Number(match[1]) : 0;
}

export type LodPreparation = {
  levels: number[];
  collidersRemoved: number;
};

export function prepareModelLods(scene: Object3D): LodPreparation {
  const colliderRoots: Object3D[] = [];
  scene.traverse((child) => {
    if (isColliderName(child.name) && !(child.parent && isColliderName(child.parent.name))) {
      colliderRoots.push(child);
    }
  });

  for (const root of colliderRoots) {
    root.parent?.remove(root);
    root.traverse((descendant) => {
      if (descendant instanceof Mesh) descendant.geometry?.dispose();
    });
  }

  const levels = new Set<number>();
  scene.traverse((child) => {
    if (child instanceof Mesh) levels.add(lodIndexFor(child.name));
  });

  return { levels: Array.from(levels).sort((left, right) => left - right), collidersRemoved: colliderRoots.length };
}

export function applyLodLevel(scene: Object3D, level: number): number {
  let visibleMeshes = 0;
  scene.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const matches = lodIndexFor(child.name) === level;
    child.visible = matches;
    if (matches) visibleMeshes += 1;
  });
  return visibleMeshes;
}
