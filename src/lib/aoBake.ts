import { Object3D, Vector3 } from 'three';
import { castBakeRay, collectBakeScene, rasterizeBakedPixels } from './bakeGeometry';

export type BakeAOMLOptions = {
  /** Hemisphere samples per texel. Odd counts round up for paired symmetry. Default 128. */
  samples?: number;
  /** Occlusion reach as a multiple of the mesh bounding-sphere radius. Default 2. */
  distance?: number;
};

const _direction = new Vector3();
const _origin = new Vector3();
const _normal = new Vector3();
const _reference = new Vector3();
const _tangent = new Vector3();
const _bitangent = new Vector3();

function symmetricHemisphereKernel(samples: number): Vector3[] {
  const pairCount = Math.ceil(samples / 2);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const kernel: Vector3[] = [];

  for (let pair = 0; pair < pairCount; pair += 1) {
    // One cosine-weighted radial stratum per opposite-azimuth pair. Pairing
    // removes directional bias from the finite kernel without random jitter.
    const radius = Math.sqrt((pair + 0.5) / pairCount);
    const height = Math.sqrt(1 - radius * radius);
    const phi = pair * goldenAngle;
    const x = radius * Math.cos(phi);
    const y = radius * Math.sin(phi);
    kernel.push(new Vector3(x, y, height));
    if (kernel.length < samples) kernel.push(new Vector3(-x, -y, height));
  }

  return kernel;
}

/**
 * Bakes per-pixel ambient occlusion from a mesh into a `width × height` grayscale
 * factor map (255 = unoccluded/bright, 0 = occluded/dark), sampled at the mesh's
 * UV coordinates so it aligns with the dithered texture.
 *
 * The sample origin and smooth shading normal are interpolated at each texel, so
 * occlusion follows smoothed normals continuously across faces instead of
 * averaging per-vertex occlusion (Gouraud) and showing faceting seams. Every mesh
 * contributes to occlusion; only meshes that carry both a `uv` and a `normal`
 * attribute are baked. Missing normals are recomputed during scene collection, so
 * pass a disposable scene (a clone) if you need to keep the original untouched.
 */
export function bakeMeshAO(scene: Object3D, width: number, height: number, options: BakeAOMLOptions = {}): Uint8ClampedArray {
  const requestedSamples = Math.max(2, Math.floor(options.samples ?? 128));
  const samples = requestedSamples + (requestedSamples % 2);
  const sampleKernel = symmetricHemisphereKernel(samples);

  const { vertices, triangles, bvh, epsilon, maxDistance } = collectBakeScene(scene, options.distance ?? 2);

  return rasterizeBakedPixels(width, height, triangles, 1, (factors, _px, _py, w0, w1, w2, triangle, offset) => {
    if (!bvh) {
      factors[offset] = 255;
      return;
    }

    // Interpolate the sample origin and smooth shading normal at this texel.
    const p0 = vertices[triangle.verts[0]].position;
    const p1 = vertices[triangle.verts[1]].position;
    const p2 = vertices[triangle.verts[2]].position;
    _origin.set(
      w0 * p0.x + w1 * p1.x + w2 * p2.x,
      w0 * p0.y + w1 * p1.y + w2 * p2.y,
      w0 * p0.z + w1 * p1.z + w2 * p2.z,
    );
    const n0 = vertices[triangle.verts[0]].normal;
    const n1 = vertices[triangle.verts[1]].normal;
    const n2 = vertices[triangle.verts[2]].normal;
    const nx = w0 * n0.x + w1 * n1.x + w2 * n2.x;
    const ny = w0 * n0.y + w1 * n1.y + w2 * n2.y;
    const nz = w0 * n0.z + w1 * n1.z + w2 * n2.z;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    _normal.set(nx / length, ny / length, nz / length);

    // Orthonormal basis around the shading normal for the hemisphere kernel.
    if (Math.abs(_normal.z) < 0.999) _reference.set(0, 0, 1);
    else _reference.set(1, 0, 0);
    _tangent.crossVectors(_normal, _reference).normalize();
    _bitangent.crossVectors(_normal, _tangent).normalize();

    let occluded = 0;
    for (const sample of sampleKernel) {
      _direction.set(0, 0, 0)
        .addScaledVector(_tangent, sample.x)
        .addScaledVector(_bitangent, sample.y)
        .addScaledVector(_normal, sample.z)
        .normalize();
      if (castBakeRay(bvh, _origin, _normal, _direction, epsilon, 0, maxDistance)) occluded += 1;
    }
    factors[offset] = Math.round(((samples - occluded) / samples) * 255);
  });
}
