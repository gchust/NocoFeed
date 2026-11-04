import type { MediaEntry } from './types.js';

export const MEDIA_LIMIT = 30;
const URL_LIMIT = 1_000;

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > URL_LIMIT) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function dimension(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 100_000
    ? value
    : undefined;
}

/**
 * The images and videos of an item as a Collector reported them, reduced to what the browser may load: https links
 * only, known types, bounded. Anything else is dropped; `undefined` when nothing is left, so an answer without media
 * never replaces what is stored.
 */
export function cleanMedia(value: unknown): MediaEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const result: MediaEntry[] = [];
  for (const entry of value as unknown[]) {
    if (result.length >= MEDIA_LIMIT) break;
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    if (raw.type !== 'image' && raw.type !== 'video') continue;
    const url = httpsUrl(raw.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const width = dimension(raw.width);
    const height = dimension(raw.height);
    const cover = raw.type === 'video' ? httpsUrl(raw.cover) : undefined;
    const duration =
      raw.type === 'video' &&
      typeof raw.duration === 'number' &&
      Number.isFinite(raw.duration) &&
      raw.duration > 0
        ? raw.duration
        : undefined;
    result.push({
      type: raw.type,
      url,
      ...(width && height ? { width, height } : {}),
      ...(cover ? { cover } : {}),
      ...(duration ? { duration } : {}),
    });
  }
  return result.length ? result : undefined;
}

/** The picture a card shows: the first image, or the first video's cover. */
export function coverOf(media: readonly MediaEntry[] | null | undefined) {
  for (const entry of media ?? []) {
    if (entry.type === 'image') return entry.url;
    if (entry.cover) return entry.cover;
  }
  return null;
}
