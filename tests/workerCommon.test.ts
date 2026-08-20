import { describe, expect, it, vi } from 'vitest';
import { postWorkerError, runSingleWorker } from '../src/lib/workerCommon';

describe('postWorkerError', () => {
  it('posts the canonical error wire shape for an Error instance', () => {
    const scope = { postMessage: vi.fn() };
    postWorkerError(scope, 42, new Error('boom'));
    expect(scope.postMessage).toHaveBeenCalledWith({ type: 'error', jobId: 42, message: 'boom' });
  });

  it('coerces non-Error failures to their string form', () => {
    const scope = { postMessage: vi.fn() };
    postWorkerError(scope, 7, 'string failure');
    expect(scope.postMessage).toHaveBeenCalledWith({ type: 'error', jobId: 7, message: 'string failure' });
  });
});

describe('runSingleWorker', () => {
  /** Minimal stand-in for the DOM Worker the helper drives: the node test
   * environment has no real Worker, and the lightmap bake's inline worker
   * path is what `runSingleWorker` replaces, so it is pinned here directly. */
  function createFakeWorker(): {
    worker: {
      onmessage: ((event: { data: unknown }) => void) | null;
      onerror: ((event: { message?: string }) => void) | null;
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    };
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  } {
    const postMessage = vi.fn();
    const terminate = vi.fn();
    return {
      worker: { onmessage: null, onerror: null, postMessage, terminate },
      postMessage,
      terminate,
    };
  }

  it('resolves with the worker message, transfers, and terminates', async () => {
    const { worker, postMessage, terminate } = createFakeWorker();
    const transfer = [new ArrayBuffer(4)];
    const pending = runSingleWorker<{ type: 'result'; value: number }>(worker as unknown as Worker, 'Test', { job: 1 }, transfer);
    expect(postMessage).toHaveBeenCalledWith({ job: 1 }, transfer);
    worker.onmessage!({ data: { type: 'result', value: 42 } });
    await expect(pending).resolves.toEqual({ type: 'result', value: 42 });
    expect(terminate).toHaveBeenCalled();
  });

  it('rejects when the worker posts the shared error wire shape', async () => {
    const { worker, terminate } = createFakeWorker();
    const pending = runSingleWorker(worker as unknown as Worker, 'Test', {});
    worker.onmessage!({ data: { type: 'error', message: 'boom' } });
    await expect(pending).rejects.toThrow('boom');
    expect(terminate).toHaveBeenCalled();
  });

  it('rejects with the label fallback when the error message is missing', async () => {
    const { worker } = createFakeWorker();
    const pending = runSingleWorker(worker as unknown as Worker, 'Lightmap', {});
    worker.onmessage!({ data: { type: 'error' } });
    await expect(pending).rejects.toThrow('Lightmap worker failed.');
  });

  it('rejects when the worker errors out-of-band', async () => {
    const { worker, terminate } = createFakeWorker();
    const pending = runSingleWorker(worker as unknown as Worker, 'Test', {});
    worker.onerror!({ message: 'worker exploded' });
    await expect(pending).rejects.toThrow('worker exploded');
    expect(terminate).toHaveBeenCalled();
  });
});
