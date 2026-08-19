import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { dilateUVBake } from './bakeGeometry';
import { computeSunVisibilityCpu, rasterizeLightmap, type LightmapBakeError, type LightmapBakeRequest, type LightmapBakeResult } from './lightmapRaster';

/**
 * Lightmap bake worker: builds an occluder BVH from the transferred world
 * positions, rasterizes the full UV map (per-texel Phong + shadow), runs the
 * UV dilation, and posts the RGBA pixels back with the buffer transferred
 * (zero-copy). The whole bake happens off the main thread, so the implicit
 * lightmap re-bakes (fired by every sun / quad / resolution change) never
 * freeze the UI — at 1024² on a heavily tessellated fallback grid the sync
 * path is hundreds of ms of main-thread work.
 *
 * The DOM lib is used project-wide, so the dedicated-worker globals are
 * reached through a narrow cast instead of the webworker lib (same pattern as
 * the AO worker).
 */
const workerScope = self as unknown as {
  postMessage: (message: LightmapBakeResult | LightmapBakeError, transfer?: Transferable[]) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent<LightmapBakeRequest>) => void) => void;
};

workerScope.addEventListener('message', (event) => {
  const request = event.data;
  if (!request || request.type !== 'bake') return;
  const { jobId, width, height } = request;
  try {
    const occluder = new BufferGeometry();
    occluder.setAttribute('position', new BufferAttribute(request.occluderPositions, 3));
    // The occluder BVH was already built once at scene collection and rides in
    // the request serialized — deserialize instead of rebuilding the same tree
    // in the worker (the serialized roots are byte-identical to a fresh build).
    const bvh = request.bvh ? MeshBVH.deserialize(request.bvh, occluder) : new MeshBVH(occluder);
    const visibility = computeSunVisibilityCpu(request, bvh, request.options.sunDirection, request.options.sunIntensity);
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    const written = new Uint8Array(width * height);
    rasterizeLightmap(pixels, written, visibility, request, width, height, request.options);
    dilateUVBake(pixels, written, width, height, 4);
    workerScope.postMessage({ type: 'result', jobId, pixels }, [pixels.buffer as ArrayBuffer]);
  } catch (error) {
    workerScope.postMessage({ type: 'error', jobId, message: error instanceof Error ? error.message : String(error) });
  }
});
