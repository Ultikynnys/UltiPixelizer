import { Object3D, Vector3 } from 'three';
import { hexToRgb, isHexColor } from './palettes';
import { directionToSun, type DirectionVector } from './sunDirection';
import { castBakeRay, collectBakeScene, rasterizeBakedPixels, type BakeTriangle, type UvPair } from './bakeGeometry';
import { AMBIENT_FLOOR } from './defaults';
import { clamp01, type RGB } from './math';
import { triangleNormal } from './modelScene';
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

function parseColor(color: string): RGB {
  if (!isHexColor(color)) throw new Error(`Invalid light color: ${color}`);
  const [red, green, blue] = hexToRgb(color);
  return [red / 255, green / 255, blue / 255];
}

function lambertFactor(normal: Vector3, towardSun: Vector3): number {
  return Math.max(0, normal.dot(towardSun));
}

/**
 * Combines ambient and directional illumination additively. Each term is clamped
 * to [0, 1] before summing so a single light can never exceed full intensity;
 * the total is clamped again to keep white as the ceiling.
 */
function combineLight(
  ambientColor: RGB,
  sunColor: RGB,
  ambientScale: number,
  sunScale: number,
  lambert: number,
  sunVisibility: number,
): RGB {
  return [0, 1, 2].map((channel) => {
    const ambient = clamp01(ambientColor[channel] * ambientScale);
    const sun = clamp01(sunColor[channel] * sunScale * lambert * sunVisibility);
    return clamp01(ambient + sun);
  }) as RGB;
}

/**
 * Builds an orthonormal tangent/bitangent basis for a triangle from its
 * world-space positions and UVs (MikkTSpace-style). Tangent and bitangent follow
 * the UV gradients and are re-orthogonalized against the triangle face normal;
 * the shading normal is interpolated from per-vertex normals by the caller, so
 * the sun respects source / smoothed normals rather than the flat face normal.
 * Throws for degenerate triangles — callers skip those before reaching here.
 */
function computeTangentBasis(
  p0: Vector3,
  p1: Vector3,
  p2: Vector3,
  uv0: UvPair,
  uv1: UvPair,
  uv2: UvPair,
): [Vector3, Vector3] {
  const e1 = new Vector3().subVectors(p1, p0);
  const e2 = new Vector3().subVectors(p2, p0);
  const normal = triangleNormal(p0, p1, p2, new Vector3());
  const du1 = uv1[0] - uv0[0];
  const dv1 = uv1[1] - uv0[1];
  const du2 = uv2[0] - uv0[0];
  const dv2 = uv2[1] - uv0[1];
  const det = du1 * dv2 - du2 * dv1;
  if (normal.lengthSq() === 0 || Math.abs(det) <= 1e-12) {
    throw new Error('Cannot build a tangent basis for a degenerate triangle.');
  }
  normal.normalize();
  const f = 1 / det;
  const tangent = new Vector3(
    f * (dv2 * e1.x - dv1 * e2.x),
    f * (dv2 * e1.y - dv1 * e2.y),
    f * (dv2 * e1.z - dv1 * e2.z),
  );
  const bitangent = new Vector3(
    f * (-du2 * e1.x + du1 * e2.x),
    f * (-du2 * e1.y + du1 * e2.y),
    f * (-du2 * e1.z + du1 * e2.z),
  );
  tangent.addScaledVector(normal, -tangent.dot(normal)).normalize();
  bitangent.addScaledVector(normal, -bitangent.dot(normal)).normalize();
  return [tangent, bitangent];
}

/**
 * Bakes ambient and shadowed directional illumination into UV-space RGBA pixels.
 * Output contains irradiance only (no albedo), with white representing neutral light.
 *
 * Lighting is evaluated per pixel (Phong), not per vertex: the smooth vertex
 * normal is interpolated at each texel and the Lambert term is taken from that
 * shading normal, so the sun follows smoothed normals continuously across faces
 * instead of averaging per-vertex light (Gouraud) and showing faceting seams.
 */
export function bakeMeshLightmap(scene: Object3D, width: number, height: number, options: BakeLightmapOptions): Uint8ClampedArray {
  const sun = directionToSun(options.sunDirection);
  const towardSun = new Vector3(sun.x, sun.y, sun.z);
  const sunColor = parseColor(options.sunColor);
  const ambientColor: RGB = parseColor(options.ambientColor);
  const ambientScale = options.ambientEnabled === false ? 0 : Math.max(AMBIENT_FLOOR, clamp01(options.ambientIntensity));
  const sunScale = options.sunEnabled === false ? 0 : clamp01(options.sunIntensity);
  const normalMap = options.normalMap;
  const normalStrength = clamp01(options.normalStrength ?? 1);
  const normalFlipY = options.normalFlipY ?? false;

  const { vertices, triangles, bvh, epsilon } = collectBakeScene(scene);

  // Shadow is sampled per vertex (binary occluder test) and interpolated per
  // pixel so shadow edges stay soft rather than snapping to face boundaries.
  const visibility = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 1) {
    const vertex = vertices[i];
    const lit = lambertFactor(vertex.normal, towardSun) > 0;
    let sunVisibility = lit && sunScale > 0 ? 1 : 0;
    if (sunVisibility && bvh && castBakeRay(bvh, vertex.position, vertex.normal, towardSun, epsilon, epsilon)) sunVisibility = 0;
    visibility[i] = sunVisibility;
  }

  const tangentBases = normalMap
    ? new Map<BakeTriangle, [Vector3, Vector3]>(triangles.map((triangle) => [triangle, computeTangentBasis(
      vertices[triangle.verts[0]].position,
      vertices[triangle.verts[1]].position,
      vertices[triangle.verts[2]].position,
      triangle.uv[0], triangle.uv[1], triangle.uv[2],
    )]))
    : null;

  const mapped = new Vector3();
  const pixels = rasterizeBakedPixels(width, height, triangles, 4, (pixels, _px, _py, w0, w1, w2, triangle, offset) => {
    // Interpolate the smooth vertex normal at this texel, then light that
    // shading normal per pixel so smoothed normals stay continuous across faces.
    const na = vertices[triangle.verts[0]].normal;
    const nb = vertices[triangle.verts[1]].normal;
    const nc = vertices[triangle.verts[2]].normal;
    const nx = w0 * na.x + w1 * nb.x + w2 * nc.x;
    const ny = w0 * na.y + w1 * nb.y + w2 * nc.y;
    const nz = w0 * na.z + w1 * nb.z + w2 * nc.z;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    mapped.set(nx / length, ny / length, nz / length);

    const basis = tangentBases?.get(triangle);
    if (normalMap && basis) {
      const [uva, uvb, uvc] = triangle.uv;
      const u = w0 * uva[0] + w1 * uvb[0] + w2 * uvc[0];
      const v = w0 * uva[1] + w1 * uvb[1] + w2 * uvc[1];
      const [tx, ty, tz] = sampleNormalMap(normalMap, u, v, normalStrength, normalFlipY);
      const [tangent, bitangent] = basis;
      mapped.set(
        tangent.x * tx + bitangent.x * ty + (nx / length) * tz,
        tangent.y * tx + bitangent.y * ty + (ny / length) * tz,
        tangent.z * tx + bitangent.z * ty + (nz / length) * tz,
      ).normalize();
    }

    const lambert = lambertFactor(mapped, towardSun);
    const sunVisibility = w0 * visibility[triangle.verts[0]]
      + w1 * visibility[triangle.verts[1]]
      + w2 * visibility[triangle.verts[2]];
    const light = combineLight(ambientColor, sunColor, ambientScale, sunScale, lambert, sunVisibility);
    pixels[offset] = Math.round(light[0] * 255);
    pixels[offset + 1] = Math.round(light[1] * 255);
    pixels[offset + 2] = Math.round(light[2] * 255);
  });
  return pixels;
}
