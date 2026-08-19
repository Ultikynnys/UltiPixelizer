import { vi } from 'vitest';

export type MessageListener = (event: { data: unknown }) => void;

/** Fake `Worker` for tests: captures its handler props and every instance so
 * tests can drive the message/error callbacks production code assigns, exactly
 * like a real dedicated worker. Shared by the bake suites that orchestrate
 * worker fallback (aoBakeAsync) instead of each defining its own mock. */
export class MockWorker {
  static instances: MockWorker[] = [];

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor(_url: URL | string, _options?: unknown) {
    MockWorker.instances.push(this);
  }
}

/** Stubs the global `Worker` with {@link MockWorker} (or removes it entirely
 * when `present` is false) and resets the captured instance list. */
export function installWorkerGlobal(present = true): void {
  MockWorker.instances = [];
  vi.stubGlobal('Worker', present ? MockWorker : undefined);
}

/** Captures the worker's message listener and postMessage calls via a stubbed
 * `self` global, so a worker module can be imported and driven from a node
 * test. Shared by the AO and lightmap worker suites. */
export function installWorkerScope(): { listeners: MessageListener[]; postMessage: ReturnType<typeof vi.fn> } {
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
