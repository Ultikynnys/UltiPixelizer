import { BufferAttribute, Object3D } from 'three';
import { createTileCoverage, rasterizeBake, type BakeRasterOptions } from './bakeGeometry';
import { forEachMeshIndexed, forEachTriangle } from './modelScene';

/** Shared label text for the UV-overlap highlight in both the 2D and 3D views. */
export const UV_OVERLAP_LABEL = 'UV OVERLAP';

/** A single triangle's UV coordinates plus the mesh/triangle identity needed to
 * map the triangle back onto the source scene for the 3D highlight. */
export type UVTriangle = {
  /** Depth-first index of the owning mesh  stable across `cloneModelScene` clones. */
  meshIndex: number;
  /** Triangle index within the mesh's index buffer (or sequential for non-indexed). */
  triangleIndex: number;
  uv: [[number, number], [number, number], [number, number]];
};

export type UVOverlapResult = {
  width: number;
  height: number;
  /** Per-texel triangle count, saturated at 2: 0 = uncovered, 1 = covered by a
   * single triangle, 2 = covered by two or more (the only distinction the mask
   * and the highlight need, and what lets the counting raster skip tiles). */
  counts: Uint8Array;
  /** mesh traversal index -> overlapping triangle indices. */
  overlapping: Map<number, number[]>;
};

/**
 * Collects every triangle that carries a `uv` attribute from visible meshes.
 * The mesh index counts *all* meshes (visible or not) in depth-first order, so
 * indices stay stable across identical-topology clones and between the bake
 * scene and the viewports.
 */
export function collectUVTriangles(scene: Object3D): UVTriangle[] {
  const triangles: UVTriangle[] = [];
  forEachMeshIndexed(scene, (child, meshIndex) => {
    if (!child.visible) return;

    const uv = child.geometry.getAttribute('uv') as BufferAttribute | undefined;
    if (!uv) return;
    forEachTriangle(child.geometry, (ia, ib, ic, tri) => {
      triangles.push({
        meshIndex,
        triangleIndex: tri,
        uv: [
          [uv.getX(ia), uv.getY(ia)],
          [uv.getX(ib), uv.getY(ib)],
          [uv.getX(ic), uv.getY(ic)],
        ],
      });
    });
  });
  return triangles;
}

/**
 * Rasterizes triangle UVs into a `width × height` grid, invoking `mark` for
 * every texel whose center falls inside the triangle. Thin wrapper over the
 * shared barycentric rasterizer  the overlap detector only needs the covered
 * texel coordinates, not the barycentric weights. `options` pass straight
 * through to the shared rasterizer (the detector uses only `coverage`); returns
 * false when `mark` stopped the walk.
 */
export function rasterizeUVCoverage(
  width: number,
  height: number,
  triangles: UVTriangle[],
  mark: (px: number, py: number) => boolean | void,
  options?: BakeRasterOptions,
): boolean {
  return rasterizeBake(width, height, triangles, (px, py) => mark(px, py), options);
}

/**
 * Detects UV overlap: texels covered by two or more triangles. `counts` is a
 * per-texel coverage map (for the 2D mask); `overlapping` lists, per mesh,
 * every triangle that shares at least one texel with another triangle (for the
 * 3D highlight).
 */
export function computeUVOverlap(scene: Object3D, width: number, height: number): UVOverlapResult {
  const triangles = collectUVTriangles(scene);
  const counts = new Uint8Array(width * height);
  // A texel stops changing once two triangles cover it, so the counting pass
  // can skip a tile whose texels all reached 2. A UV layout that stacks its
  // islands costs one texel visit per (triangle, texel) without this, which is
  // what made a large overlapping map freeze the UI for half a minute.
  const coverage = createTileCoverage(width, height);
  rasterizeUVCoverage(width, height, triangles, (px, py) => {
    const index = py * width + px;
    if (counts[index] >= 2) return;
    counts[index] += 1;
    if (counts[index] === 2) coverage.resolve(px, py);
  }, { coverage });

  const overlapping = new Map<number, number[]>();
  for (const triangle of triangles) {
    // The first shared texel decides the triangle, so stop scanning there.
    const completed = rasterizeUVCoverage(width, height, [triangle], (px, py) => counts[py * width + px] < 2);
    if (completed) continue;
    const list = overlapping.get(triangle.meshIndex) ?? [];
    list.push(triangle.triangleIndex);
    overlapping.set(triangle.meshIndex, list);
  }
  return { width, height, counts, overlapping };
}
