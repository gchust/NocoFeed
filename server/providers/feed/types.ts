/** Whether one part of an item (body, comments, transcript) was obtained, and how much of it. */
export type PartStatus =
  | 'available'
  | 'partial'
  | 'missing'
  | 'unavailable'
  | 'notRequested'
  | 'failed';

export interface PartCoverage {
  status: PartStatus;
  /** A short, user-readable explanation of the scope or the reason it is missing. */
  note?: string;
  fetchedAt?: string;
}

export interface ItemCoverage {
  body: PartCoverage;
  comments: PartCoverage;
  transcript?: PartCoverage;
  /** Images and video frames are never analysed in V1. */
  media?: PartCoverage;
}

export interface CommentEntry {
  author?: string;
  text: string;
  depth?: number;
}

export interface TranscriptSegment {
  /** Seconds from the start. */
  start: number;
  end?: number;
  text: string;
}

/**
 * One image or video of a post, in display order: the platform's own (often signed) CDN link, never downloaded. Images
 * and video frames are shown, not analysed.
 */
export interface MediaEntry {
  type: 'image' | 'video';
  /** https only. */
  url: string;
  width?: number;
  height?: number;
  /** A video's poster image (https). */
  cover?: string;
  /** A video's length in seconds. */
  duration?: number;
}

/** One normalized item as an adapter returns it. Counts that are unknown stay absent; they are never 0. */
export interface CollectedItem {
  externalId: string;
  url?: string;
  title: string;
  author?: string;
  summary?: string;
  body?: string;
  comments?: CommentEntry[];
  transcript?: TranscriptSegment[];
  /** Absent when the source gives none (and from Collectors that predate it). */
  media?: MediaEntry[];
  metrics?: Record<string, number>;
  publishedAt?: string;
  /**
   * `publishedAt` was worked out from relative text such as "3 weeks ago" (YouTube search) rather than read as a date:
   * the latest moment the text allows. Absent means exact.
   */
  publishedAtApproximate?: boolean;
  coverage: ItemCoverage;
}

/**
 * How a run's result relates to what the subscription has seen before:
 * - `baseline`  the first run; nothing earlier to compare with
 * - `complete`  the result reached an item seen before, so nothing in between was skipped
 * - `partial`   the result was cut off before reaching a seen item; something may have been missed
 * - `single`    one tracked item, re-read
 */
export type RunCoverage = 'baseline' | 'complete' | 'partial' | 'single';

export type CollectStatus =
  | 'ok'
  | 'partial'
  | 'needsLogin'
  | 'blocked'
  | 'rateLimited'
  | 'unconfigured'
  | 'unsupported'
  | 'failed';

export interface CollectResult {
  status: CollectStatus;
  message?: string;
  items: CollectedItem[];
  /** The result hit the adapter's or the upstream's limit. */
  truncated?: boolean;
  cursor?: Record<string, unknown> | null;
  /** How the Collector applied `since`, when it says (see `CollectWindow`). */
  window?: CollectWindow;
}

/**
 * How a Collector applied the time window: `platform` when the platform's own sort or date filter did it, `local`
 * when the platform could not and the Collector read `scanned` items to keep those published inside the window.
 */
export interface CollectWindow {
  filter: 'platform' | 'local';
  scanned?: number;
}

export interface CollectRequest {
  platform: string;
  operation: string;
  target: string;
  limit: number;
  cursor: Record<string, unknown> | null;
  /** External ids already stored for this owner and platform, newest first; used to stop early. */
  knownIds: ReadonlySet<string>;
  /**
   * Only items published from this instant on are wanted; null for no window. The Collector narrows its searches with
   * it where the platform can; native lists are newest first and NocoFeed filters every answer by `publishedAt`.
   */
  since?: Date | null;
  /**
   * Whose subscription this is. Adapters reading the person's own data (mail, through the Mail plugin) read as this
   * user only; public platforms ignore it.
   */
  ownerId?: string;
  /** The subscription's own settings (`feedSources.options`), null when the platform has none. */
  options?: Record<string, unknown> | null;
  signal: AbortSignal;
}

export interface EnrichRequest {
  platform: string;
  externalId: string;
  url?: string | null;
  /** `published` asks for the exact publication time of an item stored without one or with an approximate one. */
  want: readonly ('body' | 'comments' | 'transcript' | 'published')[];
  signal: AbortSignal;
}

export interface EnrichResult {
  status: CollectStatus;
  message?: string;
  body?: string;
  comments?: CommentEntry[];
  transcript?: TranscriptSegment[];
  /** Read along with the body; absent when nothing was read, which keeps what is stored. */
  media?: MediaEntry[];
  /** The publication time, when `published` was asked for and the page gave one. */
  publishedAt?: string;
  /**
   * The page gave only the day (YouTube asking its viewer to sign in): `publishedAt` is noon UTC of that day, better
   * than "3 weeks ago" but not the exact time.
   */
  publishedAtApproximate?: boolean;
  /** The post's counts as read with it; absent from Collectors that do not send them. */
  metrics?: Record<string, number>;
  coverage: Partial<ItemCoverage>;
}

export class AdapterError extends Error {
  constructor(
    readonly status: CollectStatus,
    message: string,
    /** The HTTP status that caused it, when an upstream answered with an error. */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
