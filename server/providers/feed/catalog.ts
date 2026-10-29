/**
 * What each platform and operation can actually do, declared by the adapter that implements it. The browser shows
 * these declarations as they are; it never infers a capability from a platform appearing in a list.
 *
 * - `native`     fetched by this server from an official API, a public JSON endpoint or a feed
 * - `collector`  needs the Docker Collector (login sessions, browser automation, subtitle tools)
 */
export type Implementation = 'native' | 'collector';

export type Platform =
  'reddit' | 'hn' | 'rss' | 'youtube' | 'bilibili' | 'xiaohongshu' | 'x';

export interface OperationSpec {
  readonly operation: string;
  readonly implementation: Implementation;
  /** How the target is entered. */
  readonly input: 'text' | 'url' | 'none';
  /** Single-item tracking rather than a list that keeps producing new items. */
  readonly single?: boolean;
  /** What a successful run brings back, as stable codes the browser translates. */
  readonly capabilities: readonly string[];
  /** Enrichment the adapter can perform later on one item. */
  readonly enrich: readonly ('body' | 'comments' | 'transcript')[];
}

export interface PlatformSpec {
  readonly platform: Platform;
  readonly experimental?: boolean;
  readonly needsLogin?: boolean;
  readonly operations: readonly OperationSpec[];
}

export const CATALOG: readonly PlatformSpec[] = [
  {
    platform: 'reddit',
    operations: [
      {
        operation: 'community',
        implementation: 'native',
        input: 'text',
        capabilities: ['newPosts', 'selftext', 'counts'],
        enrich: ['comments'],
      },
    ],
  },
  {
    platform: 'hn',
    operations: [
      {
        operation: 'new',
        implementation: 'native',
        input: 'none',
        capabilities: ['newStories', 'text', 'counts'],
        enrich: ['comments'],
      },
      {
        operation: 'ask',
        implementation: 'native',
        input: 'none',
        capabilities: ['askStories', 'text', 'counts'],
        enrich: ['comments'],
      },
      {
        operation: 'show',
        implementation: 'native',
        input: 'none',
        capabilities: ['showStories', 'text', 'counts'],
        enrich: ['comments'],
      },
    ],
  },
  {
    platform: 'rss',
    operations: [
      {
        operation: 'feed',
        implementation: 'native',
        input: 'url',
        capabilities: ['feedEntries', 'summaryOrContent'],
        enrich: [],
      },
    ],
  },
  {
    platform: 'youtube',
    operations: [
      {
        operation: 'channel',
        implementation: 'native',
        input: 'text',
        capabilities: ['channelUploads', 'description'],
        enrich: ['transcript'],
      },
      {
        operation: 'keyword',
        implementation: 'collector',
        input: 'text',
        capabilities: ['searchCandidates', 'transcriptOnDemand'],
        enrich: ['transcript'],
      },
      {
        operation: 'video',
        implementation: 'native',
        input: 'text',
        single: true,
        capabilities: ['videoMetadata', 'transcriptIfAvailable'],
        enrich: ['transcript'],
      },
    ],
  },
  {
    platform: 'bilibili',
    operations: [
      {
        operation: 'keyword',
        implementation: 'collector',
        input: 'text',
        capabilities: ['searchCandidates', 'videoInfo'],
        enrich: ['transcript'],
      },
      {
        operation: 'video',
        implementation: 'native',
        input: 'text',
        single: true,
        capabilities: ['videoMetadata', 'firstPartSubtitles'],
        enrich: ['transcript'],
      },
    ],
  },
  {
    platform: 'xiaohongshu',
    needsLogin: true,
    operations: [
      {
        operation: 'keyword',
        implementation: 'collector',
        input: 'text',
        capabilities: ['searchCandidates', 'noteText'],
        enrich: ['body', 'comments'],
      },
      {
        operation: 'post',
        implementation: 'collector',
        input: 'url',
        single: true,
        capabilities: ['noteText', 'loadedComments'],
        enrich: ['body', 'comments'],
      },
    ],
  },
  {
    platform: 'x',
    experimental: true,
    needsLogin: true,
    operations: [
      {
        operation: 'keyword',
        implementation: 'collector',
        input: 'text',
        capabilities: ['searchCandidates', 'threadOnDemand'],
        enrich: ['comments'],
      },
      {
        operation: 'account',
        implementation: 'collector',
        input: 'text',
        capabilities: ['accountPosts'],
        enrich: ['comments'],
      },
      {
        operation: 'post',
        implementation: 'collector',
        input: 'url',
        single: true,
        capabilities: ['postThread'],
        enrich: ['comments'],
      },
    ],
  },
];

export const PLATFORMS: readonly Platform[] = CATALOG.map(
  (spec) => spec.platform,
);

export function findOperation(
  platform: string,
  operation: string,
): { platform: PlatformSpec; operation: OperationSpec } | undefined {
  const spec = CATALOG.find((entry) => entry.platform === platform);
  const op = spec?.operations.find((entry) => entry.operation === operation);
  return spec && op ? { platform: spec, operation: op } : undefined;
}
