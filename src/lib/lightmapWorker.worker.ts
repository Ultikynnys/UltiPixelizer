import { computeSunVisibilityCpu, rasterizeLightmapFull, type LightmapBakeError, type LightmapBakeRequest, type LightmapBakeResult } from './lightmapRaster';
import { createWorkerScope, deserializeBakeBvh, postWorkerError } from './workerCommon';

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
 * reached through the shared worker-scope cast in workerCommon.ts.
 */
const workerScope = createWorkerScope<LightmapBakeResult | LightmapBakeError, LightmapBakeRequest>();

workerScope.addEventListener('message', (event) => {
  const request = event.data;
  if (!request || request.type !== 'bake') return;
  const { jobId, width, height } = request;
  try {
    // The occluder BVH was already built once at scene collection and rides in
    // the request serialized — deserialize instead of rebuilding the same tree
    // in the worker (the serialized roots are byte-identical to a fresh build).
    const bvh = deserializeBakeBvh(request);
    const visibility = computeSunVisibilityCpu(request, bvh, request.options.sunDirection, request.options.sunIntensity);
    const { pixels } = rasterizeLightmapFull(visibility, request, width, height, request.options);
    workerScope.postMessage({ type: 'result', jobId, pixels }, [pixels.buffer as ArrayBuffer]);
  } catch (error) {
    postWorkerError(workerScope, jobId, error);
  }
});
