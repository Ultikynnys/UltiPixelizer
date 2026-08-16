export function slugify(value: string, fallback = 'item', maxLength = Number.POSITIVE_INFINITY): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, maxLength) || fallback;
}

export function safeFileName(name: string, fallback = 'file'): string {
  return name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '') || fallback;
}

/** Extracts a user-facing message from a caught error. `Error` instances and
 * non-empty thrown strings are surfaced as-is; `fallback` covers throws with no
 * usable message (null, undefined, numbers, empty strings). Every `catch`
 * handler that surfaces an error through a toast goes through this. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}
