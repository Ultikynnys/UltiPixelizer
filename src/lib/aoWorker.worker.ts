import { blankBakeBuffers } from './bakeGeometry';
import {
  rasterizeAOBand,
  type AOBandError,
  type AOBandProgress,
  type AOBandRequest,
  type AOBandResult,
  type AOBandTimings,
} from './aoRaster';
import { createWorkerScope, deserializeBakeBvh, postWorkerError } from './workerCommon';

/**
 * AO bake worker: builds an occluder BVH from the transferred world positions,
 * rasterizes one row band of the UV map, and posts the band's factor + written
 * slices back with their buffers transferred (zero-copy). Progress posts keep
 * the main thread informed as bands complete.
 *
 * The DOM lib is used project-wide, so the dedicated-worker globals are
 * reached through the shared worker-scope cast in workerCommon.ts.
 */
const workerScope = createWorkerScope<AOBandProgress | AOBandResult | AOBandError, AOBandRequest>();

workerScope.addEventListener('message', (event) => {
  const request = event.data;
  if (!request || request.type !== 'band') return;
  const { jobId, width, height, yStart, yEnd } = request;
  try {
    const timings: AOBandTimings = { deserializeMs: 0, rayMs: 0, shadeMs: 0, rasterMs: 0 };
    // The occluder BVH was already built once at scene collection and rides in
    // the request serialized — deserialize instead of rebuilding the same tree
    // per worker (the serialized roots are byte-identical to a fresh build).
    const deserializeStart = performance.now();
    const bvh = deserializeBakeBvh(request);
    timings.deserializeMs = performance.now() - deserializeStart;
    const bandHeight = yEnd - yStart;
    const { pixels: factors, written } = blankBakeBuffers(bandHeight, width, 1);
    rasterizeAOBand(factors, written, bvh, request, {
      width,
      height,
      yStart,
      yEnd,
      timings,
      onRowsComplete: (rowsDone) => {
        workerScope.postMessage({ type: 'progress', jobId, rowsDone });
      },
    });
    workerScope.postMessage(
      { type: 'result', jobId, factors, written, timings },
      [factors.buffer as ArrayBuffer, written.buffer as ArrayBuffer],
    );
  } catch (error) {
    postWorkerError(workerScope, jobId, error);
  }
});
