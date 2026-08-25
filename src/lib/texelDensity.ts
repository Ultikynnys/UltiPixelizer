import { BufferAttribute, Object3D, Vector3 } from 'three';
import { forEachMeshIndexed, forEachTriangle, triangleNormal } from './modelScene';

/**
 * Model-wide linear texel density:
 * sqrt(summed UV triangle area × texture width × texture height /
 * summed corresponding world-space triangle area).
 *
 * UV area is not clipped to the 0–1 square and overlapping or stacked shells
 * count once per mapped triangle, so the sum may exceed 1. Only triangles with
 * measurable world and UV area contribute to either sum. Returns null when no
 * measurable mapped surface exists.
 */
export function computeAverageTexelDensity(scene: Object3D, width: number, height: number): number | null {
  scene.updateMatrixWorld(true);
  const pa = new Vector3();
  const pb = new Vector3();
  const pc = new Vector3();
  const faceNormal = new Vector3();

  let worldAreaSum = 0;
  let uvAreaSum = 0;
  forEachMeshIndexed(scene, (child) => {
    if (!child.visible) return;
    const position = child.geometry.getAttribute('position') as BufferAttribute | undefined;
    const uv = child.geometry.getAttribute('uv') as BufferAttribute | undefined;
    if (!position || !uv) return;
    const world = child.matrixWorld;
    forEachTriangle(child.geometry, (ia, ib, ic) => {
      pa.fromBufferAttribute(position, ia).applyMatrix4(world);
      pb.fromBufferAttribute(position, ib).applyMatrix4(world);
      pc.fromBufferAttribute(position, ic).applyMatrix4(world);
      const worldArea = 0.5 * triangleNormal(pa, pb, pc, faceNormal).length();
      if (worldArea <= 1e-12) return;

      const ua = uv.getX(ia);
      const ub = uv.getX(ib);
      const uc = uv.getX(ic);
      const va = uv.getY(ia);
      const vb = uv.getY(ib);
      const vc = uv.getY(ic);
      const uvArea = 0.5 * Math.abs((ub - ua) * (vc - va) - (uc - ua) * (vb - va));
      if (uvArea <= 1e-12) return;

      worldAreaSum += worldArea;
      uvAreaSum += uvArea;
    });
  });
  return worldAreaSum === 0 ? null : Math.sqrt((uvAreaSum * width * height) / worldAreaSum);
}
