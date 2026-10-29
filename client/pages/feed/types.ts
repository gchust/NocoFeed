// The API contract of the NocoFeed endpoints (`server/routes/feed-schemas.ts`), as the pages read it.

export const PLATFORMS = [
  'reddit',
  'hn',
  'rss',
  'youtube',
  'bilibili',
  'xiaohongshu',
  'x',
] as const;
export type Platform = (typeof PLATFORMS)[number];

// `digest` is shown by the page itself (from `feedDigest`); the others are views of `feedItems`.
export const VIEWS = [
  'digest',
  'all',
  'discuss',
  'learn',
  'saved',
  'later',
  'participated',
] as const;
export type FeedView = (typeof VIEWS)[number];
export type ListView = Exclude<FeedView, 'digest'>;

export const TOPIC_MODES = ['both', 'participate', 'learn'] as const;
export type TopicMode = (typeof TOPIC_MODES)[number];

export type Verdict = 'discuss' | 'learn' | 'ignore';

export interface Profile {
  readonly interests: string;
  readonly expertise: string;
  readonly avoid: string;
  readonly dailyLimit: number;
  readonly keepLearning: boolean;
  readonly locale: 'zh-CN' | 'en-US' | null;
  readonly configured: boolean;
  readonly termWeights: Readonly<Record<string, number>>;
  readonly digestEnabled: boolean;
  readonly digestHour: number;
  readonly timeZone: string | null;
}

export interface Topic {
  readonly id: number;
  readonly name: string;
  readonly goal: string;
  readonly avoid: string | null;
  readonly mode: TopicMode;
  readonly sourceIds: readonly number[];
  readonly createdAt: string;
}

export interface Source {
  readonly id: number;
  readonly platform: Platform;
  readonly operation: string;
  readonly name: string;
  readonly target: string;
  readonly frequency: number;
  readonly candidateLimit: number;
  readonly active: boolean;
  readonly status: string;
  readonly statusMessage: string | null;
  readonly lastRunAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly nextRunAt: string | null;
  readonly failureStreak: number;
  readonly emptyStreak: number;
  readonly health: 'ok' | 'failing' | 'quiet';
}

export interface CatalogOperation {
  readonly operation: string;
  readonly implementation: 'native' | 'collector';
  readonly input: 'text' | 'url' | 'none';
  readonly single: boolean;
  readonly capabilities: readonly string[];
  readonly targetLength: { readonly min: number; readonly max: number } | null;
  readonly available: boolean;
}

export interface Catalog {
  readonly collectorConfigured: boolean;
  readonly model: { readonly available: boolean; readonly name: string | null };
  readonly platforms: readonly {
    readonly platform: Platform;
    readonly experimental: boolean;
    readonly needsLogin: boolean;
    readonly operations: readonly CatalogOperation[];
  }[];
}

export interface Run {
  readonly id: number;
  readonly sourceId: number | null;
  readonly sourceName: string | null;
  readonly platform: Platform | null;
  readonly itemId: number | null;
  readonly stage: 'collect' | 'enrich' | 'analyze';
  readonly trigger: 'schedule' | 'manual';
  readonly status: string;
  readonly scope: string | null;
  readonly found: number;
  readonly inserted: number;
  readonly analyzed: number;
  readonly coverage: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface RunStats {
  readonly found: number;
  readonly inserted: number;
  readonly analyzed: number;
  readonly failed: number;
}

export interface FeedListItem {
  readonly id: number;
  readonly platform: Platform;
  readonly sourceLabel: string | null;
  readonly title: string;
  readonly summary: string | null;
  readonly url: string | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly verdict: Verdict | null;
  readonly score: number;
  readonly topicId: number | null;
  readonly lead: string | null;
  readonly favorite: boolean;
  readonly later: boolean;
  readonly participated: boolean;
  readonly newReplies: number;
}

export interface PartCoverage {
  readonly status: string;
  readonly note?: string;
  readonly fetchedAt?: string;
}

export interface ItemState {
  readonly favorite: boolean;
  readonly later: boolean;
  readonly participated: boolean;
  readonly feedback: 'helpful' | 'irrelevant' | null;
  readonly notes: string | null;
  readonly participationUrl: string | null;
  readonly participationNote: string | null;
  readonly dismissed: boolean;
  readonly followUp: {
    readonly replies: number | null;
    readonly newReplies: number;
    readonly checkedAt: string | null;
    readonly nextCheckAt: string | null;
  } | null;
}

export interface StateChange extends ItemState {
  readonly adjustment?: {
    readonly direction: 'up' | 'down';
    readonly terms: readonly string[];
    readonly rescored: number;
  };
}

export interface Analysis {
  readonly id: number;
  readonly topicId: number | null;
  readonly verdict: Verdict;
  readonly score: number;
  readonly interestLevel: string;
  readonly interestReason: string | null;
  readonly experienceLevel: string;
  readonly experienceReason: string | null;
  readonly lead: string | null;
  readonly steps: readonly {
    readonly title: string;
    readonly detail: string;
  }[];
  readonly evidence: string | null;
  readonly uncertainty: string | null;
  readonly engine: 'rules' | 'model';
  readonly model: string | null;
  readonly contentVersion: number;
  readonly createdAt: string;
}

export type EnrichPart = 'body' | 'comments' | 'transcript';

export interface FeedItem extends FeedListItem {
  readonly externalId: string;
  readonly author: string | null;
  readonly body: string | null;
  readonly comments: readonly {
    readonly author?: string;
    readonly text: string;
    readonly depth?: number;
  }[];
  readonly transcript: readonly {
    readonly start: number;
    readonly end?: number;
    readonly text: string;
  }[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly coverage: {
    readonly body: PartCoverage;
    readonly comments: PartCoverage;
    readonly transcript?: PartCoverage;
    readonly media?: PartCoverage;
  };
  readonly contentVersion: number;
  readonly fetchedAt: string;
  readonly analysis: Analysis | null;
  readonly analysisStale: boolean;
  readonly state: ItemState;
  readonly enrichable: readonly EnrichPart[];
}

export interface FeedSummary extends Readonly<Record<ListView, number>> {
  readonly newReplies: number;
  readonly unhealthySources: number;
}

export interface FeedDigest {
  readonly since: string;
  readonly discuss: readonly FeedListItem[];
  readonly learn: readonly FeedListItem[];
}
