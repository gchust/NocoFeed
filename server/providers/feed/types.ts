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
  metrics?: Record<string, number>;
  publishedAt?: string;
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
}

export interface CollectRequest {
  platform: string;
  operation: string;
  target: string;
  limit: number;
  cursor: Record<string, unknown> | null;
  /** External ids already stored for this owner and platform, newest first; used to stop early. */
  knownIds: ReadonlySet<string>;
  signal: AbortSignal;
}

export interface EnrichRequest {
  platform: string;
  externalId: string;
  url?: string | null;
  want: readonly ('body' | 'comments' | 'transcript')[];
  signal: AbortSignal;
}

export interface EnrichResult {
  status: CollectStatus;
  message?: string;
  body?: string;
  comments?: CommentEntry[];
  transcript?: TranscriptSegment[];
  coverage: Partial<ItemCoverage>;
}

export class AdapterError extends Error {
  constructor(
    readonly status: CollectStatus,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
