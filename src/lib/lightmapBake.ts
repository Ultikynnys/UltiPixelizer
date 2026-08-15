import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Matrix3,
  Mesh,
  Object3D,
  Ray,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { sunDirectionVector } from './sunGizmo';

export type BakeLightmapOptions = {
  sunAzimuth: number;
  sunElevation: number;
  sunColor: string;
  sunIntensity: number;
  sunEnabled?: boolean;
  ambientColor: string;
  ambientIntensity: number;
};

type RGB = [number, number, number];
type UvPair = [number, number];
type UniqueVertex = { position: Vector3; normal: Vector3; light: RGB };
type BakeTriangle = { uv: [UvPair, UvPair, UvPair]; verts: [number, number, number] };

const _ray = new Ray();

function parseColor(color: string): RGB {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) throw new Error(`Invalid light color: ${color}`);
  const value = Number.parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/**
 * Bakes ambient and shadowed directional illumination into UV-space RGBA pixels.
 * Output contains irradiance only (no albedo), with white representing neutral light.
 */
export function bakeMeshLightmap(scene: Object3D, width: number, height: number, options: BakeLightmapOptions): Uint8ClampedArray {
  scene.updateMatrixWorld(true);
  const sunVector = sunDirectionVector(options.sunAzimuth, options.sunElevation);
  const sunDirection = new Vector3(sunVector.x, sunVector.y, sunVector.z).normalize();
  const sunColor = parseColor(options.sunColor);
  const ambientColor = parseColor(options.ambientColor);
  const ambientScale = Math.max(0, options.ambientIntensity) / Math.PI;
  const sunScale = options.sunEnabled === false ? 0 : Math.max(0, options.sunIntensity) / Math.PI;

  const worldPositions: number[] = [];
  const bakeTriangles: BakeTriangle[] = [];
  const uniqueVertices: UniqueVertex[] = [];
  const vertexIndexByKey = new Map<string, number>();
  const normalMatrix = new Matrix3();

  scene.traverse((child) => {
    if (!(child instanceof Mesh) || !child.visible) return;
    const geometry = child.geometry as BufferGeometry;
    const position = geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!position) return;
    const uv = geometry.getAttribute('uv') as BufferAttribute | undefined;
    let normal = geometry.getAttribute('normal') as BufferAttribute | undefined;
    if (uv && !normal) {
      geometry.computeVertexNormals();
      normal = geometry.getAttribute('normal') as BufferAttribute | undefined;
    }
    const world = child.matrixWorld;
    normalMatrix.getNormalMatrix(world);
    const index = geometry.getIndex();
    const triangleCount = index ? index.count / 3 : position.count / 3;
    const v = new Vector3();
    const n = new Vector3();
    for (let tri = 0; tri < triangleCount; tri += 1) {
      const indices = [
        index ? index.getX(tri * 3) : tri * 3,
        index ? index.getX(tri * 3 + 1) : tri * 3 + 1,
        index ? index.getX(tri * 3 + 2) : tri * 3 + 2,
      ];
      for (const vi of indices) {
        v.fromBufferAttribute(position, vi).applyMatrix4(world);
        worldPositions.push(v.x, v.y, v.z);
      }
      if (!uv || !normal) continue;
      const verts = indices.map((vi) => {
        v.fromBufferAttribute(position, vi).applyMatrix4(world);
        n.fromBufferAttribute(normal, vi).applyMatrix3(normalMatrix).normalize();
        const key = [v.x, v.y, v.z, n.x, n.y, n.z].map((value) => value.toFixed(6)).join(',');
        let resolved = vertexIndexByKey.get(key);
        if (resolved === undefined) {
          resolved = uniqueVertices.length;
          uniqueVertices.push({ position: v.clone(), normal: n.clone(), light: [0, 0, 0] });
          vertexIndexByKey.set(key, resolved);
        }
        return resolved;
      }) as [number, number, number];
      bakeTriangles.push({
        uv: indices.map((vi) => [uv.getX(vi), uv.getY(vi)]) as [UvPair, UvPair, UvPair],
        verts,
      });
    }
  });

  const occluder = new BufferGeometry();
  occluder.setAttribute('position', new BufferAttribute(new Float32Array(worldPositions), 3));
  occluder.computeBoundingSphere();
  const radius = occluder.boundingSphere?.radius ?? 1;
  const epsilon = Math.max(radius * 1e-3, 1e-4);
  const bvh = worldPositions.length ? new MeshBVH(occluder) : null;

  for (const vertex of uniqueVertices) {
    const lambert = Math.max(0, vertex.normal.dot(sunDirection));
    let sunVisibility = lambert > 0 && sunScale > 0 ? 1 : 0;
    if (sunVisibility && bvh) {
      _ray.origin.copy(vertex.position).addScaledVector(vertex.normal, epsilon);
      _ray.direction.copy(sunDirection);
      if (bvh.raycastFirst(_ray, DoubleSide, epsilon)) sunVisibility = 0;
    }
    vertex.light = [0, 1, 2].map((channel) => Math.min(1,
      ambientColor[channel] * ambientScale + sunColor[channel] * sunScale * lambert * sunVisibility,
    )) as RGB;
  }

  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const triangle of bakeTriangles) {
    const [[uax, uay], [ubx, uby], [ucx, ucy]] = triangle.uv;
    const ax = uax * width; const ay = (1 - uay) * height;
    const bx = ubx * width; const by = (1 - uby) * height;
    const cx = ucx * width; const cy = (1 - ucy) * height;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (denominator === 0) continue;
    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const x = px + 0.5; const y = py + 0.5;
        const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
        const w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const offset = (py * width + px) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const value = w0 * uniqueVertices[triangle.verts[0]].light[channel]
            + w1 * uniqueVertices[triangle.verts[1]].light[channel]
            + w2 * uniqueVertices[triangle.verts[2]].light[channel];
          pixels[offset + channel] = Math.round(value * 255);
        }
      }
    }
  }
  return pixels;
}
