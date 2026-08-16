import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  rasterizeAOBand,
  type AOBandError,
  type AOBandProgress,
  type AOBandRequest,
  type AOBandResult,
} from './aoRaster';

/**
 * AO bake worker: builds an occluder BVH from the transferred world positions,
 * rasterizes one row band of the UV map, and posts the band's factor + written
 * slices back with their buffers transferred (zero-copy). Progress posts keep
 * the main thread informed as bands complete.
 *
 * The DOM lib is used project-wide, so the dedicated-worker globals are
 * reached through a narrow cast instead of the webworker lib.
 */
const workerScope = self as unknown as {
  postMessage: (message: AOBandProgress | AOBandResult | AOBandError, transfer?: Transferable[]) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent<AOBandRequest>) => void) => void;
};

workerScope.addEventListener('message', (event) => {
  const request = event.data;
  if (!request || request.type !== 'band') return;
  const { jobId, width, height, yStart, yEnd } = request;
  try {
    const occluder = new BufferGeometry();
    occluder.setAttribute('position', new BufferAttribute(request.occluderPositions, 3));
    const bvh = new MeshBVH(occluder);
    const bandHeight = yEnd - yStart;
    const factors = new Uint8ClampedArray(bandHeight * width).fill(255);
    const written = new Uint8Array(bandHeight * width);
    rasterizeAOBand(factors, written, bvh, request, {
      width,
      height,
      yStart,
      yEnd,
      onRowsComplete: (rowsDone) => {
        workerScope.postMessage({ type: 'progress', jobId, rowsDone });
      },
    });
    workerScope.postMessage(
      { type: 'result', jobId, factors, written },
      [factors.buffer as ArrayBuffer, written.buffer as ArrayBuffer],
    );
  } catch (error) {
    workerScope.postMessage({ type: 'error', jobId, message: error instanceof Error ? error.message : String(error) });
  }
});
