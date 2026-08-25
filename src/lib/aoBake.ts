import { Object3D } from 'three';
import { blankBakeBuffers, collectBakeScene, dilateUVBake, type BakeScene } from './bakeGeometry';
import { runBakeWithFallbacks } from './bakePipeline';
import {
  rasterizeAOBand,
  serializeBakeScene,
  type AOBandRequest,
  type AOBandTimings,
  type SerializedBakeScene,
} from './aoRaster';
import { bakeAOWithGpu } from './aoGpu';
import { normalMapPayload, type NormalMapSource } from './normal';
// The worker is inlined into the bundle (blob URL) rather than fetched as a
// module file: desktop shells (Tauri's custom protocol, Electron's file://)
// and restricted CSPs can reject module workers loaded from a URL, whereas a
// blob-backed worker is protocol-agnostic. The browser behavior is identical.
import AOWorker from './aoWorker.worker?worker&inline';

/**
 * Logs an AO bake stage with its elapsed milliseconds, prefixed `[AO bake]` so
 * per-stage timings (and therefore the bottleneck) are greppable in the
 * console. Always-on diagnostics for the bake pipeline.
 */
export function logAOBakeStage(stage: string, start: number): void {
  console.log(`[AO bake] ${stage}: ${(performance.now() - start).toFixed(1)}ms`);
}

/** Logs an AO bake stage with an already-computed millisecond duration. */
function logAOBakeDuration(stage: string, ms: number): void {
  console.log(`[AO bake] ${stage}: ${ms.toFixed(1)}ms`);
}

export type BakeAOMLOptions = {
  /** Hemisphere samples per texel. Odd counts round up for paired symmetry. Default 128. */
  samples?: number;
  /** Occlusion reach as a multiple of the mesh bounding-sphere radius. Default 2. */
  distance?: number;
  /** Tangent-space normal map (pixels at the bake resolution)  the AO
   * hemisphere follows the mapped normals, so normal-map crevices and ridges
   * influence occlusion. */
  normalMap?: NormalMapSource;
  /** Perturbation scale; 0 ignores the map entirely. */
  normalStrength?: number;
  normalFlipY?: boolean;
};

/** Cap on simultaneous workers  beyond ~8 the bake is memory- and BVH-build bound. */
const MAX_AO_WORKERS = 8;
/** Minimum rows per band; a smaller band isn't worth another worker's BVH build. */
const MIN_BAND_ROWS = 16;

function roundedSamples(requested?: number): number {
  const samples = Math.max(2, Math.floor(requested ?? 128));
  return samples + (samples % 2);
}

/**
 * Bakes per-pixel ambient occlusion from a mesh into a `width × height` grayscale
 * factor map (255 = unoccluded/bright, 0 = occluded/dark), sampled at the mesh's
 * UV coordinates so it aligns with the dithered texture.
 *
 * The sample origin and smooth shading normal are interpolated at each texel, so
 * occlusion follows smoothed normals continuously across faces instead of
 * averaging per-vertex occlusion (Gouraud) and showing faceting seams. Every
 * mesh contributes to occlusion; only meshes that carry both a `uv` and a
 * `normal` attribute are baked. Missing normals are recomputed during scene
 * collection, so pass a disposable scene (a clone) if you need to keep the
 * original untouched. Pass a pre-collected {@link BakeScene} as
 * `bakeSceneOverride` to skip scene collection (caller owns freshness).
 */
export function bakeMeshAO(scene: Object3D, width: number, height: number, options: BakeAOMLOptions = {}, bakeSceneOverride?: BakeScene): Uint8ClampedArray {
  const bakeScene = bakeSceneOverride ?? collectBakeScene(scene, options.distance ?? 2);
  const input = serializeBakeScene(bakeScene, roundedSamples(options.samples), normalMapPayload(options));
  return bakeSingleThreaded(bakeScene, input, width, height);
}

/**
 * Async equivalent of `bakeMeshAO` for the browser: rasterizes the texture as
 * row bands across web workers so the main thread stays responsive, then
 * dilates and returns the identical factor map. Falls back to the single-
 * threaded path when workers are unavailable (tests, restricted CSP).
 * `onProgress` receives whole-percent completion (0–100) as bands finish.
 */
export async function bakeMeshAOAsync(
  scene: Object3D,
  width: number,
  height: number,
  options: BakeAOMLOptions = {},
  onProgress?: (percent: number) => void,
  bakeSceneOverride?: BakeScene,
): Promise<Uint8ClampedArray> {
  const start = performance.now();
  const collectStart = performance.now();
  const bakeScene = bakeSceneOverride ?? collectBakeScene(scene, options.distance ?? 2);
  if (!bakeSceneOverride) logAOBakeStage('scene collection', collectStart);
  const serializeStart = performance.now();
  const input = serializeBakeScene(bakeScene, roundedSamples(options.samples), normalMapPayload(options));
  logAOBakeStage('serialize', serializeStart);
  const sync = () => {
    const factors = bakeSingleThreaded(bakeScene, input, width, height);
    logAOBakeStage('single-threaded bake', start);
    return factors;
  };
  const syncFallback = () => {
    const factors = bakeSingleThreaded(bakeScene, input, width, height);
    logAOBakeStage('fallback single-threaded bake', start);
    return factors;
  };
  return runBakeWithFallbacks(
    'AO',
    async () => {
      const factors = await bakeAOWithGpu(input, width, height, onProgress);
      logAOBakeStage('gpu bake total', start);
      return factors;
    },
    async () => {
      const factors = await bakeWithWorkers(input, width, height, onProgress);
      logAOBakeStage('worker bake total', start);
      return factors;
    },
    sync,
    syncFallback,
  );
}

/** Rasterizes the full texture on the calling thread (tests, small maps, worker fallback). */
function bakeSingleThreaded(scene: BakeScene, input: SerializedBakeScene, width: number, height: number): Uint8ClampedArray {
  const { pixels: factors, written } = blankBakeBuffers(width, height, 1);
  if (scene.bvh) {
    rasterizeAOBand(factors, written, scene.bvh, input, { width, height, yStart: 0, yEnd: height });
  }
  dilateUVBake(factors, written, width, height, 1);
  return factors;
}

/**
 * Splits the texture into contiguous row bands, rasterizes each in a worker
 * (each worker builds its own occluder BVH), assembles the band results into
 * the full map, and runs the UV-island dilation on the main thread.
 */
function bakeWithWorkers(
  input: SerializedBakeScene,
  width: number,
  height: number,
  onProgress?: (percent: number) => void,
): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const cores = navigator.hardwareConcurrency || 1;
    const workerCount = Math.min(cores, MAX_AO_WORKERS, Math.max(1, Math.floor(height / MIN_BAND_ROWS)));
    const rowsPerWorker = Math.ceil(height / workerCount);
    const bands: Array<{ yStart: number; yEnd: number }> = [];
    for (let bandIndex = 0; bandIndex < workerCount; bandIndex += 1) {
      const yStart = bandIndex * rowsPerWorker;
      bands.push({ yStart, yEnd: Math.min(height, yStart + rowsPerWorker) });
    }

    const { pixels: factors, written } = blankBakeBuffers(width, height, 1);
    const workers: Worker[] = [];
    const rowsByBand = new Array<number>(bands.length).fill(0);
    const timingsTotal: AOBandTimings = { deserializeMs: 0, rayMs: 0, shadeMs: 0, rasterMs: 0 };
    let firstProgressAt = 0;
    let firstResultAt = 0;
    let pending = bands.length;
    let failed = false;
    let lastReportedPercent = -1;

    const reportProgress = () => {
      if (!onProgress) return;
      const rowsDone = rowsByBand.reduce((sum, rows) => sum + rows, 0);
      const percent = Math.round((rowsDone / height) * 100);
      if (percent !== lastReportedPercent) {
        lastReportedPercent = percent;
        onProgress(percent);
      }
    };

    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      for (const worker of workers) worker.terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    bands.forEach((band, bandIndex) => {
      const worker = new AOWorker();
      workers.push(worker);
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === 'progress') {
          if (!firstProgressAt) firstProgressAt = performance.now();
          rowsByBand[bandIndex] = message.rowsDone;
          reportProgress();
        } else if (message.type === 'result') {
          if (failed) return;
          if (!firstResultAt) firstResultAt = performance.now();
          const bandOffset = band.yStart * width;
          factors.set(message.factors, bandOffset);
          written.set(message.written, bandOffset);
          if (message.timings) {
            timingsTotal.deserializeMs += message.timings.deserializeMs;
            timingsTotal.rayMs += message.timings.rayMs;
            timingsTotal.shadeMs += message.timings.shadeMs;
            timingsTotal.rasterMs += message.timings.rasterMs;
          }
          pending -= 1;
          if (pending === 0) {
            logAOBakeStage('rasterize', dispatchedAt);
            logAOBakeDuration('first progress (from dispatch)', firstProgressAt - dispatchedAt);
            logAOBakeDuration('first result (from dispatch)', firstResultAt - dispatchedAt);
            logAOBakeDuration(`BVH deserialize (sum, ${bands.length} workers)`, timingsTotal.deserializeMs);
            logAOBakeDuration(`occlusion sampling (sum, ${bands.length} workers)`, timingsTotal.rayMs);
            logAOBakeDuration(`shading setup (sum, ${bands.length} workers)`, timingsTotal.shadeMs - timingsTotal.rayMs);
            logAOBakeDuration(`raster loop (sum, ${bands.length} workers)`, timingsTotal.rasterMs - timingsTotal.shadeMs);
            const dilateStart = performance.now();
            for (const done of workers) done.terminate();
            dilateUVBake(factors, written, width, height, 1);
            logAOBakeStage('dilate', dilateStart);
            resolve(factors);
          }
        } else {
          fail(new Error(message.message));
        }
      };
      worker.onerror = (event) => fail(new Error(event.message || 'AO worker failed.'));
      const request: AOBandRequest = {
        ...input,
        type: 'band',
        jobId: bandIndex,
        width,
        height,
        yStart: band.yStart,
        yEnd: band.yEnd,
      };
      worker.postMessage(request);
    });
    const dispatchedAt = performance.now();
    logAOBakeStage(`dispatch ${bands.length} workers`, start);
  });
}
