import { vi } from 'vitest';

export type MessageListener = (event: { data: unknown }) => void;

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
