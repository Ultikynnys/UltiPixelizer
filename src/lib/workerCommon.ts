import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { SerializedBVH } from './aoRaster';

/** Error payload every bake worker posts on failure  one wire shape shared by
 * the AO and lightmap workers, so `AOBandError` / `LightmapBakeError` and the
 * test expectations all agree on the format. */
export type BakeWorkerError = {
  type: 'error';
  jobId: number;
  message: string;
};

/** Typed `self` cast for dedicated workers: the project compiles against the
 * DOM lib, so worker globals are reached through a narrow cast instead of the
 * webworker lib. `TPost` is the union of messages the worker posts; `TRequest`
 * is the message shape its `message` listener receives. */
export function createWorkerScope<TPost, TRequest>(): {
  postMessage: (message: TPost, transfer?: Transferable[]) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent<TRequest>) => void) => void;
} {
  return self as unknown as {
    postMessage: (message: TPost, transfer?: Transferable[]) => void;
    addEventListener: (type: 'message', listener: (event: MessageEvent<TRequest>) => void) => void;
  };
}

/** Rebuilds the occluder BVH inside a worker: geometry from the transferred
 * world positions, then deserialize the tree built once at scene collection
 * (its serialized roots are byte-identical to a fresh build) instead of
 * rebuilding it per worker. */
export function deserializeBakeBvh(request: { occluderPositions: Float32Array; bvh?: SerializedBVH | null }): MeshBVH {
  const occluder = new BufferGeometry();
  occluder.setAttribute('position', new BufferAttribute(request.occluderPositions, 3));
  return request.bvh ? MeshBVH.deserialize(request.bvh, occluder) : new MeshBVH(occluder);
}

/** Posts the canonical bake-worker failure message for a job. */
export function postWorkerError(
  scope: { postMessage: (message: BakeWorkerError, transfer?: Transferable[]) => void },
  jobId: number,
  error: unknown,
): void {
  scope.postMessage({ type: 'error', jobId, message: error instanceof Error ? error.message : String(error) });
}

/** Runs one worker job to completion: posts `message` (transferring
 * `transfer`), resolves with the worker's first posted message, and terminates
 * the worker. Rejects when the worker errors or posts the shared error wire
 * shape (`{ type: 'error', ... }`, see `BakeWorkerError`). The AO bake's
 * banded fan-out orchestrates its workers directly (per-band progress, batch
 * termination); single-shot callers like the lightmap bake go through here. */
export class WorkerJobCancelledError extends Error {
  constructor(label: string) {
    super(`${label} worker job was cancelled.`);
    this.name = 'WorkerJobCancelledError';
  }
}

export type WorkerJobOptions = {
  signal?: AbortSignal;
  /** Final liveness guard for a worker that exits without posting an error. */
  timeoutMs?: number;
};

export function runSingleWorker<TResult extends { type: string }>(
  worker: Worker,
  label: string,
  message: unknown,
  transfer?: Transferable[],
  options: WorkerJobOptions = {},
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      worker.terminate();
      action();
    };
    const abort = (): void => finish(() => reject(new WorkerJobCancelledError(label)));
    const timeout = globalThis.setTimeout(
      () => finish(() => reject(new Error(`${label} worker timed out.`))),
      options.timeoutMs ?? 120_000,
    );
    worker.onmessage = (event) => {
      const result = event.data as TResult;
      if (result.type === 'error') {
        const error = result as unknown as { message?: string };
        finish(() => reject(new Error(error.message ?? `${label} worker failed.`)));
      } else {
        finish(() => resolve(result));
      }
    };
    worker.onerror = (event) => finish(() => reject(new Error(event.message || `${label} worker failed.`)));
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.postMessage(message, transfer ?? []);
  });
}
