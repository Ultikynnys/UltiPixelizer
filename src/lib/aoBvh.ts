/**
 * A flat, GPU-friendly binary BVH over the occluder triangles.
 *
 * The CPU bake uses `three-mesh-bvh`'s shapecast (`castBakeRay`); that tree is
 * a binned n-ary structure whose serialized form is awkward to traverse in a
 * compute shader. For the WebGPU bake we instead build a plain median-split
 * binary BVH and flatten it into two typed arrays that a WGSL stack traversal
 * can walk directly:
 *
 * - `bounds`: 6 floats per node  `[min.x, min.y, min.z, max.x, max.y, max.z]`.
 * - `links`:  2 u32 per node  `[leftFirst, count]`.
 *   - leaf:     `count > 0`, `leftFirst` = first triangle in `triangles`.
 *   - interior: `count == 0`, left child is the NEXT node (`node + 1`, DFS
 *               left-first), `leftFirst` = the right child's node index.
 * - `triangles`: reordered 9-float-per-triangle vertex data so each leaf
 *   references a contiguous `[leftFirst, leftFirst + count)` range.
 *
 * The build is a pure function of the flat positions (9 floats per triangle),
 * so it is unit-testable in Node without any WebGPU.
 */

/** Maximum triangles per leaf. Below this the traversal cost of more nodes
 * outweighs the win of fewer triangle tests. */
const LEAF_SIZE = 4;

/** Flattened binary BVH ready to upload to a compute shader. */
export type LinearBVH = {
  /** 6 floats per node: [min.xyz, max.xyz]. */
  bounds: Float32Array;
  /** 2 u32 per node: [leftFirst, count]. */
  links: Uint32Array;
  /** 9 floats per triangle, reordered into leaf order. */
  triangles: Float32Array;
  /** Number of nodes. */
  nodeCount: number;
};

/**
 * Builds a median-split binary BVH over `positions` (9 floats per triangle:
 * three world-space vertices). Returns an empty BVH for an empty input. The
 * longest centroid axis is split at its median at each interior node, so the
 * tree is balanced and the traversal stack depth stays logarithmic.
 */
export function buildLinearBVH(positions: Float32Array): LinearBVH {
  const triangleCount = Math.floor(positions.length / 9);
  const bounds: number[] = [];
  const links: number[] = [];
  const reordered: number[] = [];

  if (triangleCount === 0) {
    return { bounds: new Float32Array(0), links: new Uint32Array(0), triangles: new Float32Array(0), nodeCount: 0 };
  }

  // Per-triangle AABB and centroid.
  const aabbMin = new Float32Array(triangleCount * 3);
  const aabbMax = new Float32Array(triangleCount * 3);
  const centroid = new Float32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t += 1) {
    const base = t * 9;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let v = 0; v < 3; v += 1) {
      const x = positions[base + v * 3];
      const y = positions[base + v * 3 + 1];
      const z = positions[base + v * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const o = t * 3;
    aabbMin[o] = minX;
    aabbMin[o + 1] = minY;
    aabbMin[o + 2] = minZ;
    aabbMax[o] = maxX;
    aabbMax[o + 1] = maxY;
    aabbMax[o + 2] = maxZ;
    centroid[o] = (minX + maxX) / 2;
    centroid[o + 1] = (minY + maxY) / 2;
    centroid[o + 2] = (minZ + maxZ) / 2;
  }

  const primIds = new Uint32Array(triangleCount);
  for (let i = 0; i < triangleCount; i += 1) primIds[i] = i;

  // Reorders primIds[start..end) in place by centroid along `axis` (ascending),
  // so the caller can split at the midpoint into balanced halves.
  const partition = (start: number, end: number, axis: number): void => {
    const length = end - start;
    const keys = new Float32Array(length);
    for (let i = 0; i < length; i += 1) keys[i] = centroid[primIds[start + i] * 3 + axis];
    const order = Array.from({ length }, (_, k) => k).sort((a, b) => keys[a] - keys[b]);
    const sorted = new Uint32Array(length);
    for (let k = 0; k < length; k += 1) sorted[k] = primIds[start + order[k]];
    primIds.set(sorted, start);
  };

  const build = (start: number, end: number): number => {
    let bMinX = Infinity;
    let bMinY = Infinity;
    let bMinZ = Infinity;
    let bMaxX = -Infinity;
    let bMaxY = -Infinity;
    let bMaxZ = -Infinity;
    let cMinX = Infinity;
    let cMinY = Infinity;
    let cMinZ = Infinity;
    let cMaxX = -Infinity;
    let cMaxY = -Infinity;
    let cMaxZ = -Infinity;
    for (let i = start; i < end; i += 1) {
      const t = primIds[i];
      const o = t * 3;
      const minX = aabbMin[o];
      const minY = aabbMin[o + 1];
      const minZ = aabbMin[o + 2];
      const maxX = aabbMax[o];
      const maxY = aabbMax[o + 1];
      const maxZ = aabbMax[o + 2];
      if (minX < bMinX) bMinX = minX;
      if (minY < bMinY) bMinY = minY;
      if (minZ < bMinZ) bMinZ = minZ;
      if (maxX > bMaxX) bMaxX = maxX;
      if (maxY > bMaxY) bMaxY = maxY;
      if (maxZ > bMaxZ) bMaxZ = maxZ;
      const cx = centroid[o];
      const cy = centroid[o + 1];
      const cz = centroid[o + 2];
      if (cx < cMinX) cMinX = cx;
      if (cy < cMinY) cMinY = cy;
      if (cz < cMinZ) cMinZ = cz;
      if (cx > cMaxX) cMaxX = cx;
      if (cy > cMaxY) cMaxY = cy;
      if (cz > cMaxZ) cMaxZ = cz;
    }

    const nodeIndex = bounds.length / 6;
    bounds.push(bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ);

    const count = end - start;
    if (count <= LEAF_SIZE) {
      const triBase = reordered.length / 9;
      for (let i = start; i < end; i += 1) {
        const base = primIds[i] * 9;
        for (let k = 0; k < 9; k += 1) reordered.push(positions[base + k]);
      }
      links.push(triBase, count);
      return nodeIndex;
    }

    // Interior node: split the longest centroid extent at its median. The left
    // child is implicitly the next node (left-first DFS); the right child's
    // index is recorded once its subtree begins.
    const extX = cMaxX - cMinX;
    const extY = cMaxY - cMinY;
    const extZ = cMaxZ - cMinZ;
    let axis = 0;
    if (extY > extX && extY > extZ) axis = 1;
    else if (extZ > extX) axis = 2;

    const mid = (start + end) >> 1;
    partition(start, end, axis);

    links.push(0, 0); // placeholder [rightChild, 0]
    build(start, mid); // left subtree occupies nodeIndex + 1 …
    const rightChild = bounds.length / 6;
    links[nodeIndex * 2] = rightChild;
    links[nodeIndex * 2 + 1] = 0;
    build(mid, end); // … then the right subtree follows.
    return nodeIndex;
  };

  build(0, triangleCount);

  return {
    bounds: Float32Array.from(bounds),
    links: Uint32Array.from(links),
    triangles: Float32Array.from(reordered),
    nodeCount: links.length / 2,
  };
}
