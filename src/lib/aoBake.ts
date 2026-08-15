import { DoubleSide, Object3D, Ray, Vector3 } from 'three';
import { collectBakeScene, rasterizeBake } from './bakeGeometry';

export type BakeAOMLOptions = {
  /** Hemisphere samples per vertex. Odd counts round up for paired symmetry. Default 128. */
  samples?: number;
  /** Occlusion reach as a multiple of the mesh bounding-sphere radius. Default 2. */
  distance?: number;
};

const _ray = new Ray();
const _direction = new Vector3();

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

function orthonormalBasis(normal: Vector3): [Vector3, Vector3] {
  const reference = Math.abs(normal.z) < 0.999 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
  const tangent = new Vector3().crossVectors(normal, reference).normalize();
  const bitangent = new Vector3().crossVectors(normal, tangent).normalize();
  return [tangent, bitangent];
}

/**
 * Bakes per-vertex ambient occlusion from a mesh into a `width × height`
 * grayscale factor map (255 = unoccluded/bright, 0 = occluded/dark), sampled at
 * the mesh's UV coordinates so it aligns with the dithered texture.
 *
 * Every mesh contributes to occlusion; only meshes that carry both a `uv` and a
 * `normal` attribute are baked. May call `computeVertexNormals` on geometries
 * missing normals, so pass a disposable scene (a clone) if you need to keep the
 * original untouched.
 */
export function bakeMeshAO(scene: Object3D, width: number, height: number, options: BakeAOMLOptions = {}): Uint8ClampedArray {
  const requestedSamples = Math.max(2, Math.floor(options.samples ?? 128));
  const samples = requestedSamples + (requestedSamples % 2);
  const sampleKernel = symmetricHemisphereKernel(samples);

  const { vertices, triangles, bvh, epsilon, maxDistance } = collectBakeScene(scene, options.distance ?? 2);

  const ao = new Float32Array(vertices.length).fill(1);
  if (bvh) {
    for (let i = 0; i < vertices.length; i += 1) {
      const vertex = vertices[i];
      const [tangent, bitangent] = orthonormalBasis(vertex.normal);
      let occluded = 0;
      for (const sample of sampleKernel) {
        _direction.set(0, 0, 0)
          .addScaledVector(tangent, sample.x)
          .addScaledVector(bitangent, sample.y)
          .addScaledVector(vertex.normal, sample.z)
          .normalize();
        _ray.origin.copy(vertex.position).addScaledVector(vertex.normal, epsilon);
        _ray.direction.copy(_direction);
        if (bvh.raycastFirst(_ray, DoubleSide, 0, maxDistance)) occluded += 1;
      }
      ao[i] = (samples - occluded) / samples;
    }
  }

  const factors = new Uint8ClampedArray(width * height).fill(255);
  rasterizeBake(width, height, triangles, (px, py, w0, w1, w2, triangle) => {
    const value = w0 * ao[triangle.verts[0]] + w1 * ao[triangle.verts[1]] + w2 * ao[triangle.verts[2]];
    factors[py * width + px] = Math.round(value * 255);
  });
  return factors;
}
