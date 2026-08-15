import { BufferAttribute, Mesh, Object3D } from 'three';

/** A single triangle's UV coordinates plus the mesh/triangle identity needed to
 * map the triangle back onto the source scene for the 3D highlight. */
export type UVTriangle = {
  /** Depth-first index of the owning mesh — stable across `cloneModelScene` clones. */
  meshIndex: number;
  /** Triangle index within the mesh's index buffer (or sequential for non-indexed). */
  triangleIndex: number;
  uv: [[number, number], [number, number], [number, number]];
};

export type UVOverlapResult = {
  width: number;
  height: number;
  /** Number of triangles covering each texel (saturated at 255). */
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
  let meshIndex = 0;
  scene.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const currentMeshIndex = meshIndex;
    meshIndex += 1;
    if (!child.visible) return;

    const uv = child.geometry.getAttribute('uv') as BufferAttribute | undefined;
    if (!uv) return;
    const index = child.geometry.getIndex();
    const position = child.geometry.getAttribute('position') as BufferAttribute | undefined;
    const triangleCount = index ? index.count / 3 : position ? position.count / 3 : 0;

    for (let tri = 0; tri < triangleCount; tri += 1) {
      const ia = index ? index.getX(tri * 3) : tri * 3;
      const ib = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
      const ic = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;
      triangles.push({
        meshIndex: currentMeshIndex,
        triangleIndex: tri,
        uv: [
          [uv.getX(ia), uv.getY(ia)],
          [uv.getX(ib), uv.getY(ib)],
          [uv.getX(ic), uv.getY(ic)],
        ],
      });
    }
  });
  return triangles;
}

/**
 * Rasterizes triangle UVs into a `width × height` grid, invoking `mark` for
 * every texel whose center falls inside the triangle. UV (0,0) is the texture
 * bottom-left; the canvas is top-left, so V is flipped (mirrors `rasterizeBake`).
 */
export function rasterizeUVCoverage(
  width: number,
  height: number,
  triangles: UVTriangle[],
  mark: (px: number, py: number) => void,
): void {
  for (const triangle of triangles) {
    const [uva, uvb, uvc] = triangle.uv;
    const ax = uva[0] * width;
    const ay = (1 - uva[1]) * height;
    const bx = uvb[0] * width;
    const by = (1 - uvb[1]) * height;
    const cx = uvc[0] * width;
    const cy = (1 - uvc[1]) * height;

    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (denominator === 0) continue;

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const x = px + 0.5;
        const y = py + 0.5;
        const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
        const w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        mark(px, py);
      }
    }
  }
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
  rasterizeUVCoverage(width, height, triangles, (px, py) => {
    const index = py * width + px;
    if (counts[index] < 255) counts[index] += 1;
  });

  const overlapping = new Map<number, number[]>();
  for (const triangle of triangles) {
    let overlaps = false;
    rasterizeUVCoverage(width, height, [triangle], (px, py) => {
      if (counts[py * width + px] >= 2) overlaps = true;
    });
    if (!overlaps) continue;
    const list = overlapping.get(triangle.meshIndex) ?? [];
    list.push(triangle.triangleIndex);
    overlapping.set(triangle.meshIndex, list);
  }
  return { width, height, counts, overlapping };
}
