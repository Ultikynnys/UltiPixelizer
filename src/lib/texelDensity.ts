import { BufferAttribute, Object3D, Vector3 } from 'three';
import { forEachMeshIndexed, forEachTriangle, triangleNormal } from './modelScene';

/**
 * Average texel density of a model, expressed as texels per world unit. Each
 * measurable triangle contributes its linear density in proportion to its
 * world-space surface area. World-area weighting keeps the result independent
 * of tessellation without giving small, unusually dense UV regions the squared
 * influence they receive from a root-mean-square aggregation. Degenerate world
 * triangles and collapsed UVs are skipped. Returns null when no measurable
 * face exists (no model, or nothing with usable UVs).
 */
export function computeAverageTexelDensity(scene: Object3D, width: number, height: number): number | null {
  scene.updateMatrixWorld(true);
  const pa = new Vector3();
  const pb = new Vector3();
  const pc = new Vector3();
  const faceNormal = new Vector3();

  let densityAreaSum = 0;
  let worldAreaSum = 0;
  forEachMeshIndexed(scene, (child) => {
    if (!child.visible) return;
    const position = child.geometry.getAttribute('position') as BufferAttribute | undefined;
    const uv = child.geometry.getAttribute('uv') as BufferAttribute | undefined;
    if (!position || !uv) return;
    const world = child.matrixWorld;
    forEachTriangle(child.geometry, (ia, ib, ic) => {
      // World-space corners — a zero-area triangle has no surface to map.
      pa.fromBufferAttribute(position, ia).applyMatrix4(world);
      pb.fromBufferAttribute(position, ib).applyMatrix4(world);
      pc.fromBufferAttribute(position, ic).applyMatrix4(world);
      const worldArea = 0.5 * triangleNormal(pa, pb, pc, faceNormal).length();
      if (worldArea <= 1e-12) return;

      // UV footprint scaled to texels at the target texture resolution.
      const ua = uv.getX(ia);
      const ub = uv.getX(ib);
      const uc = uv.getX(ic);
      const va = uv.getY(ia);
      const vb = uv.getY(ib);
      const vc = uv.getY(ic);
      const uvArea = 0.5 * Math.abs((ub - ua) * (vc - va) - (uc - ua) * (vb - va));
      if (uvArea <= 1e-12) return;

      const density = Math.sqrt((uvArea * width * height) / worldArea);
      densityAreaSum += density * worldArea;
      worldAreaSum += worldArea;
    });
  });
  return worldAreaSum === 0 ? null : densityAreaSum / worldAreaSum;
}
