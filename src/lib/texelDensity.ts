import { BufferAttribute, Object3D, Vector3 } from 'three';
import { forEachMeshIndexed, forEachTriangle, triangleNormal } from './modelScene';

const AREA_EPSILON = 1e-12;
const MAX_DISPLAY_DISTORTION = 2;

type Point2 = readonly [number, number];
type Point3 = readonly [number, number, number];
export type UVStretchColor = readonly [number, number, number];

export type UVStretchFace = {
  meshIndex: number;
  triangleIndex: number;
  uv: readonly [Point2, Point2, Point2];
  world: readonly [Point3, Point3, Point3];
  worldArea: number;
  uvArea: number;
  /** Absolute base-2 log of relative UV area versus relative world area. */
  distortion: number;
  color: UVStretchColor;
};

export type UVStretchData = {
  faces: UVStretchFace[];
  worldAreaSum: number;
  uvAreaSum: number;
};

type MeasuredFace = Omit<UVStretchFace, 'distortion' | 'color'>;

/** Blue → cyan → yellow → red heatmap. Inputs above two octaves are clamped
 * for display, while the face data retains the unbounded finite metric.
 * `sensitivity` is a gain on the distortion (octaves) before mapping: higher
 * values make small distortions push the color further off blue, lower values
 * keep them near the blue end. 1 is the identity. */
export function uvStretchColor(distortion: number, sensitivity = 1): UVStretchColor {
  const stops: readonly UVStretchColor[] = [
    [38, 93, 171],
    [65, 182, 196],
    [255, 230, 85],
    [215, 48, 39],
  ];
  const scaled = Math.min(Math.max(distortion * sensitivity, 0), MAX_DISPLAY_DISTORTION) / MAX_DISPLAY_DISTORTION * (stops.length - 1);
  const index = Math.min(Math.floor(scaled), stops.length - 2);
  const mix = scaled - index;
  const from = stops[index];
  const to = stops[index + 1];
  return [
    Math.round(from[0] + (to[0] - from[0]) * mix),
    Math.round(from[1] + (to[1] - from[1]) * mix),
    Math.round(from[2] + (to[2] - from[2]) * mix),
  ];
}

/** Re-colors an already-measured UVStretchData for a new heatmap sensitivity,
 * preserving the expensive per-face distortion walk. Colors are a pure
 * function of each face's stored distortion, so this is O(faces) and returns a
 * fresh data object (callers that cache identity, e.g. the 3D overlay, rebuild
 * only when the returned reference changes). */
export function recolorUVStretchData(data: UVStretchData, sensitivity: number): UVStretchData {
  return {
    ...data,
    faces: data.faces.map((face) => ({ ...face, color: uvStretchColor(face.distortion, sensitivity) })),
  };
}

/**
 * Measures mapped triangles in world and UV space. Distortion is normalized by
 * the total mapped area in each space, so uniformly scaling the entire model
 * or UV layout does not create a false stretch signal. Missing, invisible, or
 * degenerate triangles are unavailable and are excluded explicitly.
 */
export function computeUVStretchData(scene: Object3D): UVStretchData | null {
  scene.updateMatrixWorld(true);
  const pa = new Vector3();
  const pb = new Vector3();
  const pc = new Vector3();
  const faceNormal = new Vector3();
  const measured: MeasuredFace[] = [];
  let worldAreaSum = 0;
  let uvAreaSum = 0;

  forEachMeshIndexed(scene, (child, meshIndex) => {
    if (!child.visible) return;
    const position = child.geometry.getAttribute('position') as BufferAttribute | undefined;
    const uv = child.geometry.getAttribute('uv') as BufferAttribute | undefined;
    if (!position || !uv) return;
    let triangleIndex = 0;
    forEachTriangle(child.geometry, (ia, ib, ic) => {
      const currentTriangleIndex = triangleIndex;
      triangleIndex += 1;
      pa.fromBufferAttribute(position, ia).applyMatrix4(child.matrixWorld);
      pb.fromBufferAttribute(position, ib).applyMatrix4(child.matrixWorld);
      pc.fromBufferAttribute(position, ic).applyMatrix4(child.matrixWorld);
      const worldArea = 0.5 * triangleNormal(pa, pb, pc, faceNormal).length();
      const uvPoints = [
        [uv.getX(ia), uv.getY(ia)],
        [uv.getX(ib), uv.getY(ib)],
        [uv.getX(ic), uv.getY(ic)],
      ] as const;
      const uvArea = 0.5 * Math.abs(
        (uvPoints[1][0] - uvPoints[0][0]) * (uvPoints[2][1] - uvPoints[0][1])
        - (uvPoints[2][0] - uvPoints[0][0]) * (uvPoints[1][1] - uvPoints[0][1]),
      );
      if (worldArea <= AREA_EPSILON || uvArea <= AREA_EPSILON) return;
      measured.push({
        meshIndex,
        triangleIndex: currentTriangleIndex,
        uv: uvPoints,
        world: [pa.toArray() as [number, number, number], pb.toArray() as [number, number, number], pc.toArray() as [number, number, number]],
        worldArea,
        uvArea,
      });
      worldAreaSum += worldArea;
      uvAreaSum += uvArea;
    });
  });

  if (measured.length === 0 || worldAreaSum <= AREA_EPSILON || uvAreaSum <= AREA_EPSILON) return null;
  const faces = measured.map((face): UVStretchFace => {
    const ratio = (face.uvArea / uvAreaSum) / (face.worldArea / worldAreaSum);
    const distortion = Math.abs(Math.log2(ratio));
    return { ...face, distortion, color: uvStretchColor(distortion) };
  });
  return { faces, worldAreaSum, uvAreaSum };
}

/**
 * Model-wide linear texel density:
 * sqrt(summed UV triangle area × texture width × texture height /
 * summed corresponding world-space triangle area).
 */
export function computeAverageTexelDensity(scene: Object3D, width: number, height: number): number | null {
  const data = computeUVStretchData(scene);
  return data === null ? null : Math.sqrt((data.uvAreaSum * width * height) / data.worldAreaSum);
}
