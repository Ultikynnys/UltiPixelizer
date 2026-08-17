import { BufferAttribute, Object3D, Vector3 } from 'three';
import { forEachMeshIndexed, forEachTriangle, triangleNormal } from './modelScene';

/**
 * Average texel density of a model: for every triangle that carries a `uv`
 * attribute, the square root of (UV texel area ÷ world-space area) — texels
 * per world unit, the classic texture-density metric. The UV texel area is the
 * triangle's footprint in UV space times the texture resolution, so a face
 * whose UV shell fills the whole map but spans a tiny world surface reports a
 * high density. Degenerate world triangles and collapsed UVs are skipped, and
 * per-face densities are averaged weighted by each face's UV footprint — the
 * same UV-area-weighted mean the Blender Texel Density Checker addon applies,
 * so small faces with extreme density don't skew the average. Returns null
 * when no measurable face exists (no model, or nothing with usable UVs).
 */
export function computeAverageTexelDensity(scene: Object3D, width: number, height: number): number | null {
  scene.updateMatrixWorld(true);
  const pa = new Vector3();
  const pb = new Vector3();
  const pc = new Vector3();
  const faceNormal = new Vector3();

  // UV-area-weighted mean: each face's density contributes in proportion to
  // its UV footprint, so one tiny shell can't dominate the average.
  let weightedDensitySum = 0;
  let uvAreaSum = 0;
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
      weightedDensitySum += density * uvArea;
      uvAreaSum += uvArea;
    });
  });
  return uvAreaSum === 0 ? null : weightedDensitySum / uvAreaSum;
}
