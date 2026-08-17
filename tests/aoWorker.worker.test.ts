import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mesh, MeshBasicMaterial, PlaneGeometry, Scene } from 'three';
import { collectBakeScene } from '../src/lib/bakeGeometry';
import { serializeBakeScene } from '../src/lib/aoRaster';

type MessageListener = (event: { data: unknown }) => void;

/** Captures the worker's message listener and postMessage calls via a stubbed
 * `self` global, so the module can be imported and driven from a node test. */
function installWorkerScope(): { listeners: MessageListener[]; postMessage: ReturnType<typeof vi.fn> } {
  const listeners: MessageListener[] = [];
  const postMessage = vi.fn();
  vi.stubGlobal('self', {
    postMessage,
    addEventListener: (_type: string, listener: MessageListener) => {
      listeners.push(listener);
    },
  });
  return { listeners, postMessage };
}

/** A valid serialized band request backed by a real plane scene. */
function bandRequest(width = 8, height = 8): Record<string, unknown> {
  const scene = new Scene();
  scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
  const serialized = serializeBakeScene(collectBakeScene(scene), 4);
  return { ...serialized, type: 'band', jobId: 0, width, height, yStart: 0, yEnd: height };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AO worker', () => {
  it('ignores messages that are not band requests', async () => {
    const scope = installWorkerScope();
    await import('../src/lib/aoWorker.worker.ts');
    scope.listeners[0]({ data: { type: 'progress' } });
    scope.listeners[0]({ data: undefined });
    expect(scope.postMessage).not.toHaveBeenCalled();
  });

  it('rasterizes a band request and posts the result', async () => {
    const scope = installWorkerScope();
    await import('../src/lib/aoWorker.worker.ts');
    scope.listeners[0]({ data: bandRequest() });

    const result = scope.postMessage.mock.calls
      .map((call) => call[0])
      .find((message) => message.type === 'result');
    expect(result).toBeDefined();
    expect(result.factors).toHaveLength(64);
    expect(result.written).toHaveLength(64);
  });
});
