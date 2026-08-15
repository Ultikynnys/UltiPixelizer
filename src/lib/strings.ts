export function slugify(value: string, fallback = 'item', maxLength = Number.POSITIVE_INFINITY): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, maxLength) || fallback;
}

export function safeFileName(name: string, fallback = 'file'): string {
  return name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '') || fallback;
}
