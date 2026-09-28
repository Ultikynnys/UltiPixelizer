/**
 * Model axis + FBX-warning helpers — shared by the app (`modelPreview.ts`) and
 * the CLI (`cli/model.ts`) so both orient loaded models and silence the FBX
 * Z-up notice identically.
 */
import type { WorldAxis } from './modelFiles';

/** Up-axis correction: Blender is Z-up (rotate -90° about X), Maya is Y-up. */
export function upAxisRotation(worldAxis: WorldAxis): number {
  return worldAxis === 'blender' ? -Math.PI / 2 : 0;
}

/**
 * Runs `load` with the three.js FBXLoader's Z-up notice suppressed: the loader
 * warns (and rotates the root to Y-up) whenever an FBX declares a Z-up axis, and
 * callers immediately overwrite that rotation via `upAxisRotation`, so the
 * notice describes conversion work that is undone. Only that one message is
 * filtered; `console.warn` is restored when the load settles.
 */
export async function withoutFbxUpAxisWarning<T>(load: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = ((...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.includes('Z-UP coordinate system')) return;
    original(...args);
  }) as typeof console.warn;
  try {
    return await load();
  } finally {
    console.warn = original;
  }
}
