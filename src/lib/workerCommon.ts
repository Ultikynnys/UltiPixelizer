import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { SerializedBVH } from './aoRaster';

/** Error payload every bake worker posts on failure — one wire shape shared by
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
