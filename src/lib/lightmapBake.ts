import { DoubleSide, Object3D, Ray, Vector3 } from 'three';
import { hexToRgb, isHexColor } from './palettes';
import { normalizeDirection, type DirectionVector } from './sunDirection';
import { collectBakeScene, rasterizeBake, type BakeTriangle, type UvPair } from './bakeGeometry';
import { sampleNormalMap, type NormalMapSource } from './normal';

export type BakeLightmapOptions = {
  sunDirection: DirectionVector;
  sunColor: string;
  sunIntensity: number;
  sunEnabled?: boolean;
  ambientColor: string;
  ambientIntensity: number;
  ambientEnabled?: boolean;
  normalMap?: NormalMapSource;
  normalStrength?: number;
  normalFlipY?: boolean;
};

type RGB = [number, number, number];

const _ray = new Ray();

function parseColor(color: string): RGB {
  if (!isHexColor(color)) throw new Error(`Invalid light color: ${color}`);
  const [red, green, blue] = hexToRgb(color);
  return [red / 255, green / 255, blue / 255];
}

/**
 * Builds an orthonormal tangent/bitangent/normal basis for a triangle from its
 * world-space positions and UVs (MikkTSpace-style). The geometric normal is the
 * triangle face normal; tangent and bitangent follow the UV gradients and are
 * re-orthogonalized against the normal.
 */
function computeTangentBasis(
  p0: Vector3,
  p1: Vector3,
  p2: Vector3,
  uv0: UvPair,
  uv1: UvPair,
  uv2: UvPair,
): [Vector3, Vector3, Vector3] {
  const e1 = new Vector3().subVectors(p1, p0);
  const e2 = new Vector3().subVectors(p2, p0);
  const normal = new Vector3().crossVectors(e1, e2);
  const du1 = uv1[0] - uv0[0];
  const dv1 = uv1[1] - uv0[1];
  const du2 = uv2[0] - uv0[0];
  const dv2 = uv2[1] - uv0[1];
  const det = du1 * dv2 - du2 * dv1;
  const tangent = new Vector3();
  const bitangent = new Vector3();
  if (Math.abs(det) > 1e-12) {
    const f = 1 / det;
    tangent.set(
      f * (dv2 * e1.x - dv1 * e2.x),
      f * (dv2 * e1.y - dv1 * e2.y),
      f * (dv2 * e1.z - dv1 * e2.z),
    );
    bitangent.set(
      f * (-du2 * e1.x + du1 * e2.x),
      f * (-du2 * e1.y + du1 * e2.y),
      f * (-du2 * e1.z + du1 * e2.z),
    );
  }
  if (normal.lengthSq() === 0) normal.set(0, 0, 1);
  normal.normalize();
  tangent.addScaledVector(normal, -tangent.dot(normal));
  if (tangent.lengthSq() === 0) tangent.set(1, 0, 0);
  tangent.normalize();
  bitangent.addScaledVector(normal, -bitangent.dot(normal));
  if (bitangent.lengthSq() === 0) bitangent.set(0, 1, 0);
  bitangent.normalize();
  return [tangent, bitangent, normal];
}

/**
 * Bakes ambient and shadowed directional illumination into UV-space RGBA pixels.
 * Output contains irradiance only (no albedo), with white representing neutral light.
 */
export function bakeMeshLightmap(scene: Object3D, width: number, height: number, options: BakeLightmapOptions): Uint8ClampedArray {
  const rayDirection = normalizeDirection(options.sunDirection);
  const directionToSun = new Vector3(-rayDirection.x, -rayDirection.y, -rayDirection.z);
  const sunColor = parseColor(options.sunColor);
  const ambientColor = options.ambientEnabled === false ? [1, 1, 1] : parseColor(options.ambientColor);
  const ambientScale = options.ambientEnabled === false ? 1 : Math.max(0, options.ambientIntensity) / Math.PI;
  const sunScale = options.sunEnabled === false ? 0 : Math.max(0, options.sunIntensity) / Math.PI;
  const normalMap = options.normalMap;
  const normalStrength = Math.min(1, Math.max(0, options.normalStrength ?? 1));
  const normalFlipY = options.normalFlipY ?? false;

  const { vertices, triangles, bvh, epsilon } = collectBakeScene(scene);

  const lights: RGB[] = new Array(vertices.length);
  const visibility = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 1) {
    const vertex = vertices[i];
    const lambert = Math.max(0, vertex.normal.dot(directionToSun));
    let sunVisibility = lambert > 0 && sunScale > 0 ? 1 : 0;
    if (sunVisibility && bvh) {
      _ray.origin.copy(vertex.position).addScaledVector(vertex.normal, epsilon);
      _ray.direction.copy(directionToSun);
      if (bvh.raycastFirst(_ray, DoubleSide, epsilon)) sunVisibility = 0;
    }
    visibility[i] = sunVisibility;
    lights[i] = [0, 1, 2].map((channel) => Math.min(1,
      ambientColor[channel] * ambientScale + sunColor[channel] * sunScale * lambert * sunVisibility,
    )) as RGB;
  }

  const tangentBases = normalMap
    ? new Map<BakeTriangle, [Vector3, Vector3, Vector3]>(triangles.map((triangle) => [triangle, computeTangentBasis(
      vertices[triangle.verts[0]].position,
      vertices[triangle.verts[1]].position,
      vertices[triangle.verts[2]].position,
      triangle.uv[0], triangle.uv[1], triangle.uv[2],
    )]))
    : null;

  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const mapped = new Vector3();
  rasterizeBake(width, height, triangles, (px, py, w0, w1, w2, triangle) => {
    const offset = (py * width + px) * 4;
    const basis = tangentBases?.get(triangle);
    if (normalMap && basis) {
      const [uva, uvb, uvc] = triangle.uv;
      const u = w0 * uva[0] + w1 * uvb[0] + w2 * uvc[0];
      const v = w0 * uva[1] + w1 * uvb[1] + w2 * uvc[1];
      const [tx, ty, tz] = sampleNormalMap(normalMap, u, v, normalStrength, normalFlipY);
      const [tangent, bitangent, normal] = basis;
      mapped.set(
        tangent.x * tx + bitangent.x * ty + normal.x * tz,
        tangent.y * tx + bitangent.y * ty + normal.y * tz,
        tangent.z * tx + bitangent.z * ty + normal.z * tz,
      ).normalize();
      const lambert = Math.max(0, mapped.dot(directionToSun));
      const sunVisibility = w0 * visibility[triangle.verts[0]]
        + w1 * visibility[triangle.verts[1]]
        + w2 * visibility[triangle.verts[2]];
      for (let channel = 0; channel < 3; channel += 1) {
        const value = Math.min(1, ambientColor[channel] * ambientScale + sunColor[channel] * sunScale * lambert * sunVisibility);
        pixels[offset + channel] = Math.round(value * 255);
      }
    } else {
      for (let channel = 0; channel < 3; channel += 1) {
        const value = w0 * lights[triangle.verts[0]][channel]
          + w1 * lights[triangle.verts[1]][channel]
          + w2 * lights[triangle.verts[2]][channel];
        pixels[offset + channel] = Math.round(value * 255);
      }
    }
  });
  return pixels;
}
