import { describe, expect, it, vi } from 'vitest';
import { postWorkerError } from '../src/lib/workerCommon';

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
