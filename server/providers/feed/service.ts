import type { Agents } from '@nocobase/app-plugin-agents/server/tokens';
import type { DatabaseManager } from '@nocobase/db';

import type { FeedConfig } from '../../config/feed.js';
import { followableUrl, type Adapters } from './adapters.js';
import {
  ANALYZE_TRIGGER,
  FEED_ITEM_SUBJECT,
  type AgentResult,
  type AnalyzePayload,
} from './agent-reader.js';
import {
  analyzeWithRules,
  awaitingMaterial,
  blockedByPrefilter,
  buildPrefilterPrompt,
  buildPrompt,
  hasOnlyTitle,
  limitedToTitle,
  LOW_QUALITY,
  needsPrefilter,
  parsePrefilterAnswer,
  localeFor,
  matchTopics,
  parseModelAnswer,
  priorityOf,
  qualityOf,
  TERM_WEIGHT_MAX,
  TERM_WEIGHT_MIN,
  type AnalysisDraft,
  type AnalysisGate,
  type AnalysisItem,
  type AnalysisProfile,
  type AnalysisTopic,
  type Locale,
  type NoiseKind,
  type QualityDetail,
  type Verdict,
} from './analyzer.js';
import {
  BRIEF_TOKENS,
  buildBriefPrompt,
  buildTranslationPrompt,
  cleanMarkdown,
  gistOf,
  parseBriefAnswer,
  readingLanguageOf,
  translatableText,
  TRANSLATION_TOKENS,
  type ReadingLanguage,
} from './brief.js';
import type { GoldCase } from './evaluation.js';
import {
  CATALOG,
  findOperation,
  INBOX_PLATFORM,
  SEARCH_PLATFORMS,
  type Platform,
} from './catalog.js';
import { mailOptions } from './mail.js';
import {
  HEAT_WINDOW_MS,
  HOT_HEAT,
  REFRESHABLE_PLATFORMS,
  heatOf,
  refreshInterval,
} from './heat.js';
import {
  admit,
  DEFAULT_WAIT_HOURS,
  isHoldGate,
  release,
  settleWatch,
} from './admission.js';
import { coverOf } from './media.js';
import { mapLimit, truncate } from './text.js';
import { createHash } from 'node:crypto';
import type {
  CollectResult,
  CollectWindow,
  CommentEntry,
  EnrichResult,
  ItemCoverage,
  MediaEntry,
  RunCoverage,
  TranscriptSegment,
} from './types.js';

export type TopicMode = 'both' | 'participate' | 'learn';
/**
 * `hot` and `solid` are two ways into the recommended items: what is getting attention right now (`heat`), and what the
 * analysis found to be substantial (`quality`), whatever its attention.
 */
export type FeedView =
  | 'all'
  | 'hot'
  | 'solid'
  | 'discuss'
  | 'learn'
  | 'saved'
  | 'later'
  | 'participated'
  /** Left out of the feed (`verdict: ignore`), with the reason in the gate and the uncertainty. */
  | 'filtered';
/** From here a model analysis counts as solid: real substance, new, supported, usable (see `qualityOf`). */
export const SOLID_QUALITY = 60;
/** How far back the feed list reaches, by when an item was published. */
export type FeedPeriod = 'day' | 'week' | 'month';
/** `newest` (publication time, newest first) is the default; `priority` puts what is most worth reading first. */
export type FeedSort = 'priority' | 'newest';
const PERIOD_DAYS: Record<FeedPeriod, number> = { day: 1, week: 7, month: 30 };

export interface Profile {
  interests: string;
  expertise: string;
  avoid: string;
  dailyLimit: number;
  keepLearning: boolean;
  locale: Locale | null;
  configured: boolean;
  /** Words whose weight the person's "useful" / "not relevant" feedback changed, and by how much. */
  termWeights: Record<string, number>;
  digestEnabled: boolean;
  /** Local hour (0–23) after which the daily digest goes out. */
  digestHour: number;
  /** IANA time zone the digest hour is read in; the server's own when unset. */
  timeZone: string | null;
  /** The runner agent "Analyze again" is handed to; null keeps the model gateway and the rules. */
  readerAgentId: string | null;
  /** Collection keeps items published within this many days; 0 keeps everything. */
  maxAgeDays: number;
  /** The language briefs and translations are written in; `original` keeps each item's; null follows the interface. */
  readingLanguage: ReadingLanguage | null;
  /** A new, thin search result waits for its attention before it is decided (`admission.ts`). */
  waitForHeat: boolean;
  /** How long after publication it waits. */
  waitHours: number;
}

export type SourceHealth = 'ok' | 'failing' | 'quiet';

export interface Topic {
  id: number;
  name: string;
  goal: string;
  avoid: string | null;
  mode: TopicMode;
  /** The subscriptions this topic is limited to; empty means it judges what every subscription brings. */
  sourceIds: number[];
  /** Terms the topic searches for itself; empty when it only judges what subscriptions bring. */
  searchTerms: string[];
  /** Platforms to search on; empty means every platform that can search. */
  searchPlatforms: Platform[];
  /** Minutes between runs of each search. */
  searchFrequency: number;
  /** Candidates each search brings back. */
  searchLimit: number;
  /** The searches running for this topic: one per term and platform. */
  searches: Source[];
  createdAt: string;
}

export type TopicInput = Pick<Topic, 'name' | 'goal' | 'avoid' | 'mode'> & {
  sourceIds?: number[];
  searchTerms?: string[];
  searchPlatforms?: Platform[];
  searchFrequency?: number;
  searchLimit?: number;
};

export interface Source {
  id: number;
  /** The topic whose search this is; null for a subscription made directly. */
  topicId: number | null;
  platform: Platform;
  operation: string;
  name: string;
  target: string;
  frequency: number;
  candidateLimit: number;
  active: boolean;
  status: string;
  statusMessage: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  failureStreak: number;
  emptyStreak: number;
  /** `failing` after several failed runs in a row, `quiet` when nothing new has arrived for days. */
  health: SourceHealth;
  /** The platform's own settings (a mail subscription's folder and filters); null when it has none. */
  options: Record<string, unknown> | null;
}

export interface FollowUp {
  /** Replies the thread had at the last check; null until the first check succeeds. */
  replies: number | null;
  /** Replies the person has not seen yet. */
  newReplies: number;
  checkedAt: string | null;
  /** Null once following has ended (two weeks after the person posted). */
  nextCheckAt: string | null;
}

export interface ItemState {
  favorite: boolean;
  later: boolean;
  participated: boolean;
  feedback: 'helpful' | 'irrelevant' | null;
  notes: string | null;
  participationUrl: string | null;
  participationNote: string | null;
  dismissed: boolean;
  /** The person has opened the item or marked it read. */
  read: boolean;
  /** Present while the participation link is one NocoFeed can follow (Hacker News, Reddit). */
  followUp: FollowUp | null;
}

export interface StateChange extends ItemState {
  /** Set when feedback changed the weight of the words that made the item match. */
  adjustment?: {
    direction: 'up' | 'down';
    terms: string[];
    /**
     * Recent rule-based analyses mentioning the terms are scored again with the new weights after the response, in a
     * background job; the list shows the new scores on its next load.
     */
    rescoring: boolean;
  };
}

export interface FeedDigest {
  since: string;
  /** What is getting the most attention among the recommended items published in the last day. */
  hot: FeedListItem[];
  discuss: FeedListItem[];
  learn: FeedListItem[];
}

export interface Notice {
  key: string;
  ownerId: string;
  title: string;
  body: string;
  path: string;
  type: 'digest' | 'followUp' | 'sourceHealth';
  referenceId: string;
}

export interface Analysis {
  id: number;
  topicId: number | null;
  verdict: 'discuss' | 'learn' | 'ignore';
  score: number;
  quality: number | null;
  qualityDetail: QualityDetail | null;
  gate: AnalysisGate | null;
  interestLevel: string;
  interestReason: string | null;
  experienceLevel: string;
  experienceReason: string | null;
  lead: string | null;
  steps: { title: string; detail: string }[];
  evidence: string | null;
  uncertainty: string | null;
  engine: 'rules' | 'model' | 'agent';
  model: string | null;
  contentVersion: number;
  createdAt: string;
}

export interface FeedListItem {
  id: number;
  platform: Platform;
  sourceLabel: string | null;
  title: string;
  summary: string | null;
  url: string | null;
  /** Null when the platform gave no time: `createdAt` is then when it was collected, not when it was published. */
  publishedAt: string | null;
  /** `publishedAt` was worked out from relative text ("3 weeks ago") and is only roughly right. */
  publishedApproximate: boolean;
  createdAt: string;
  verdict: Analysis['verdict'] | null;
  score: number;
  quality: number | null;
  /** Attention on its own platform, 0-100 (`heat.ts`); null when unknown. Never a measure of worth. */
  heat: number | null;
  noise: NoiseKind;
  gate: AnalysisGate | null;
  topicId: number | null;
  lead: string | null;
  /** The start of the post's own text (body, else a summary that is more than the title); null when there is none. */
  excerpt: string | null;
  /** The first image, or a video's cover: the platform's CDN link. */
  cover: string | null;
  /** The post is a video. */
  video: boolean;
  favorite: boolean;
  later: boolean;
  participated: boolean;
  /** The person has opened the item or marked it read. */
  read: boolean;
  /** Replies to the person's post they have not seen yet. */
  newReplies: number;
  /** The model's brief in the reading language; null until one is written. */
  brief: ListBrief | null;
}

export interface ListBrief {
  language: ReadingLanguage;
  /** The title in the reading language; null when it already is in it. */
  title: string | null;
  /** The brief's first paragraph as plain text, for the card. */
  gist: string;
  /** Written from an earlier version of the item. */
  stale: boolean;
}

export interface ItemBrief extends ListBrief {
  sourceLanguage: string | null;
  /** Markdown; images are the item's own, as `media:N` (1-based). */
  brief: string;
  /** The full text translated, when it was asked for; null otherwise. */
  body: string | null;
  /** The translation was made from an earlier version of the item. */
  bodyStale: boolean;
  model: string | null;
  createdAt: string;
}

export interface FeedItemDetail extends Omit<FeedListItem, 'brief'> {
  /** The language a brief or translation of this item is written in. */
  readingLanguage: ReadingLanguage;
  brief: ItemBrief | null;
  externalId: string;
  author: string | null;
  body: string | null;
  comments: CommentEntry[];
  transcript: TranscriptSegment[];
  /** Images and videos in display order; empty when none were read. */
  media: MediaEntry[];
  metrics: Record<string, number>;
  coverage: ItemCoverage;
  contentVersion: number;
  fetchedAt: string;
  analysis: Analysis | null;
  analysisStale: boolean;
  state: ItemState;
  enrichable: ('body' | 'comments' | 'transcript')[];
  /** A runner agent is reading the item for a new analysis; null when none is. */
  agentReading: AgentReading | null;
}

export interface AgentReading {
  /** The `feedRuns` row waiting for it. */
  runId: number;
  agentId: string;
  startedAt: string;
}

export interface Run {
  id: number;
  sourceId: number | null;
  sourceName: string | null;
  platform: string | null;
  itemId: number | null;
  stage: 'collect' | 'enrich' | 'analyze';
  trigger: 'schedule' | 'manual';
  status: string;
  scope: string | null;
  found: number;
  inserted: number;
  analyzed: number;
  coverage: string | null;
  error: string | null;
  /** How the time window was applied (see `CollectWindow`); null when the run had none or nobody said. */
  windowFilter: CollectWindow['filter'] | null;
  windowScanned: number | null;
  /**
   * A first run that could only filter by date locally found fewer items than the subscription asks for: widening
   * "only collect what was published within" is what would bring more.
   */
  windowShort: boolean;
  startedAt: string;
  finishedAt: string | null;
}

export interface FeedSummary {
  all: number;
  hot: number;
  solid: number;
  discuss: number;
  learn: number;
  saved: number;
  later: number;
  participated: number;
  filtered: number;
  /** How many of each view's items are unread, under the same filters. */
  unread: Record<FeedView, number>;
  /** Items whose followed thread has replies the person has not seen. */
  newReplies: number;
  /** Subscriptions that keep failing or have gone quiet. */
  unhealthySources: number;
}

/**
 * The id stored for an item. Ids longer than the column (feeds that use a long URL as guid) become a stable hash, so a
 * later run finds the stored row instead of inserting a truncated duplicate.
 */
export function storedExternalId(id: string): string {
  return id.length <= 191
    ? id
    : `sha256:${createHash('sha256').update(id).digest('hex')}`;
}

/** Stored ids, looked up by the id an adapter sees. */
class KnownIds extends Set<string> {
  override has(id: string): boolean {
    return super.has(storedExternalId(id));
  }
}

/**
 * The time window of one collection run, or null when the person keeps everything (`maxAgeDays` 0).
 *
 * - `cutoff`  items published before it are not stored: older than the person's window
 * - `since`   what the platform is asked for: the cutoff on a first run, afterwards from shortly before the last
 *             successful run (never before the cutoff), so a search does not page through what was read already
 */
export function collectWindow(
  maxAgeDays: number,
  lastSuccessAt: string | null,
  now: Date = new Date(),
): { cutoff: Date; since: Date } | null {
  if (!(maxAgeDays > 0)) return null;
  const cutoff = new Date(now.getTime() - maxAgeDays * DAY_MS);
  const last = lastSuccessAt ? Date.parse(lastSuccessAt) : Number.NaN;
  const since = Number.isFinite(last)
    ? new Date(Math.max(cutoff.getTime(), last - SINCE_OVERLAP_MS))
    : cutoff;
  return { cutoff, since };
}

/**
 * Leaves out items published before `cutoff`; an item whose date is unknown stays. Lists come newest first, so
 * reaching an item older than the window means nothing inside it was cut off: the result is not truncated.
 */
export function withinWindow(
  result: CollectResult,
  cutoff: Date,
): CollectResult {
  const items = result.items.filter((item) => {
    const published = item.publishedAt
      ? Date.parse(item.publishedAt)
      : Number.NaN;
    return !Number.isFinite(published) || published >= cutoff.getTime();
  });
  return items.length === result.items.length
    ? result
    : { ...result, items, truncated: false };
}

export interface CatalogEntry {
  platform: Platform;
  experimental: boolean;
  needsLogin: boolean;
  operations: {
    operation: string;
    implementation: 'native' | 'collector';
    input: 'text' | 'url' | 'none' | 'account';
    single: boolean;
    capabilities: readonly string[];
    targetLength: { min: number; max: number } | null;
    available: boolean;
  }[];
}

export interface CatalogStatus {
  collectorConfigured: boolean;
  model: { available: boolean; name: string | null };
  platforms: CatalogEntry[];
}

export class FeedError extends Error {
  constructor(
    readonly code: 'notFound' | 'invalid' | 'busy' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FeedError';
  }
}

type Row = Record<string, unknown>;
type Connection = Parameters<Parameters<DatabaseManager['transaction']>[0]>[0];

/** A text column's value; anything that is not a scalar reads as empty. */
const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';

const iso = (value: unknown): string | null => {
  if (value == null || value === '') return null;
  const date =
    value instanceof Date
      ? value
      : new Date(typeof value === 'number' ? value : text(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const json = <T>(value: unknown, fallback: T): T => {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
};

const bool = (value: unknown) => value === true || value === 1 || value === '1';

const DEFAULT_COVERAGE: ItemCoverage = {
  body: { status: 'missing' },
  comments: { status: 'notRequested' },
};

const MAX_RUN_MS = 5 * 60_000;
/**
 * Fetching the text of title-only items without being asked (`OperationSpec.prefetch`): a few right after the run
 * that brought them, more on each scheduled tick, only for items collected in the last two days, and never past the
 * time budget. A Collector that needs signing in, is blocked or rate limited stops it until the next tick, so a
 * platform's risk control is not hammered.
 */
const PREFETCH_PER_RUN = 5;
const PREFETCH_PER_TICK = 10;
const PREFETCH_BUDGET_MS = 90_000;
const PREFETCH_WINDOW_MS = 2 * 24 * 60 * 60_000;
const PREFETCH_STOPS = new Set([
  'needsLogin',
  'blocked',
  'rateLimited',
  'unconfigured',
]);
/**
 * Looking up the exact publication time of items whose platform list gave none or only "3 weeks ago" (YouTube search):
 * a few videos per scheduled tick, one Collector call per video for every owner's copy, items collected in the last
 * 30 days, each video at most once a day.
 */
const PUBLISHED_PLATFORMS = ['youtube'];
/** Counts read again per tick, and how long that may take; recent items come first when more are due. */
const HEAT_PER_TICK = 60;
const HEAT_BUDGET_MS = 60_000;
/** Items that just turned hot and still lack a model's view get one, a few per tick (each counts against `dailyLimit`). */
const HOT_ANALYSES_PER_TICK = 5;
const PUBLISHED_PER_TICK = 5;
/** Briefs written per tick, for shown items collected within this window. */
const BRIEF_PER_TICK = 5;
const BRIEF_WINDOW_MS = 3 * 24 * 60 * 60_000;
const PUBLISHED_BUDGET_MS = 60_000;
const PUBLISHED_WINDOW_MS = 30 * 24 * 60 * 60_000;
const PUBLISHED_RECHECK_MS = 24 * 60 * 60_000;
/** A day-only publication time (noon UTC) replaces an approximate one only when they are further apart than this. */
const DAY_TIME_SLACK_MS = 36 * 60 * 60_000;
const EXCERPT_LENGTH = 280;
/** Rows changed per statement by "Mark all as read", well under every database's bound-parameter limit. */
const READ_BATCH = 200;
const HOUR_MS = 3_600_000;

/**
 * Watched items (`admission.ts`) decided per tick, how long reading their counts may take, and how many of those reads
 * go to the Collector (each opens the post's page on X or Xiaohongshu, so they are few). A read that could not be made
 * is retried for `WATCH_GRACE_MS` past the deadline. `MAX_WATCHING` per person keeps watching from piling up.
 */
const WATCH_PER_TICK = 20;
const WATCH_BUDGET_MS = 60_000;
const WATCH_COLLECTOR_PER_TICK = 3;
const WATCH_COLLECTOR_PLATFORMS = ['x', 'xiaohongshu'];
const WATCH_GRACE_MS = 6 * 3_600_000;
export const MAX_WATCHING = 300;

/**
 * The counts after reading a post's discussion through the Collector: the counts it sent with it, or else the stored
 * ones with the replies read as a lower bound for the reply count (X `replies`, Xiaohongshu `comments`). Null when
 * nothing countable came back.
 */
export function countsAfterRead(
  platform: string,
  known: Record<string, number> | null,
  result: Pick<EnrichResult, 'metrics' | 'comments'>,
): Record<string, number> | null {
  const sent = Object.fromEntries(
    Object.entries(result.metrics ?? {}).filter(
      ([, value]) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0,
    ),
  );
  if (Object.keys(sent).length) return { ...(known ?? {}), ...sent };
  if (!result.comments) return null;
  const key = platform === 'x' ? 'replies' : 'comments';
  return {
    ...(known ?? {}),
    [key]: Math.max(known?.[key] ?? 0, result.comments.length),
  };
}

/** Failed runs in a row before a subscription counts as failing. */
export const FAILURE_ALERT = 3;
/** Runs in a row without anything new, spanning at least three days, before a subscription counts as quiet. */
export const EMPTY_ALERT = 5;
const QUIET_MINUTES = 3 * 24 * 60;
/** A followed thread is checked for two weeks after the person posted. */
const FOLLOW_UP_DAYS = 14;
/** How many recent rule-based analyses are scored again when feedback changes a weight. */
/**
 * Output limits for model calls. Reasoning models spend these on thinking before the answer begins, and an answer cut
 * off that way is empty, so they are far above what the JSON itself needs.
 */
const ANALYSIS_TOKENS = 4_000;
const PREFILTER_TOKENS = 3_000;
/** Model analyses per person per day until they choose otherwise. */
const DEFAULT_DAILY_LIMIT = 1_000;
/** A feed is about what is new: collection keeps what was published within this many days unless the person says. */
export const DEFAULT_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * HOUR_MS;
/**
 * How far before the last successful run a search reaches again: platforms index late and round their date filters,
 * so the window overlaps instead of starting at the instant of the last run. What was stored already is dropped by id.
 */
const SINCE_OVERLAP_MS = DAY_MS;
const DEFAULT_SEARCH_FREQUENCY = 360;
const DEFAULT_SEARCH_LIMIT = 20;
/** Each term runs on every chosen platform, so the cap keeps one topic from flooding the Collector. */
const MAX_SEARCH_TERMS = 10;
/** Items asked about in one prefilter call. */
const PREFILTER_BATCH = 20;
const RESCORE_LIMIT = 200;
/** Lets pending I/O (incoming requests) run before the next step of long background work. */
const yieldToRequests = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
/** Statuses that a person has to fix in configuration, already shown on the subscription; not counted as failures. */
const SETUP_STATUSES = new Set(['unconfigured', 'unsupported']);

export function sourceHealth(row: {
  failureStreak: number;
  emptyStreak: number;
  frequency: number;
  single: boolean;
}): SourceHealth {
  if (row.failureStreak >= FAILURE_ALERT) return 'failing';
  if (
    !row.single &&
    row.emptyStreak >= EMPTY_ALERT &&
    row.emptyStreak * row.frequency >= QUIET_MINUTES
  )
    return 'quiet';
  return 'ok';
}

/** The next check of a followed thread: hourly on the first day, every four hours until day three, then twice a day. */
export function nextFollowUp(since: Date, now: Date): Date | null {
  const age = now.getTime() - since.getTime();
  if (age >= FOLLOW_UP_DAYS * 24 * HOUR_MS) return null;
  const gap = age < 24 * HOUR_MS ? 1 : age < 72 * HOUR_MS ? 4 : 12;
  return new Date(now.getTime() + gap * HOUR_MS);
}

/** Calendar date and hour of an instant in a time zone; an unknown zone falls back to the server's. */
export function localClock(
  at: Date,
  timeZone: string | null,
): { date: string; hour: number } {
  const format = (zone: string | undefined) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timeZone ?? undefined);
  } catch {
    parts = format(undefined);
  }
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    hour: Number(part('hour')),
  };
}

export function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export interface FeedServiceDeps {
  database: DatabaseManager;
  adapters: Adapters;
  agents: () => Agents | undefined;
  config: () => FeedConfig;
  /** Sends an in-app notice; resolves false when notifications are not available. */
  notify: (notice: Notice) => Promise<boolean>;
  /**
   * The person's connected mail accounts (Mail plugin), to check a mail subscription's target; null when the plugin is
   * not there. Absent means mail subscriptions cannot be made.
   */
  mailAccounts?: (
    ownerId: string,
  ) => Promise<readonly { id: string; status: string }[] | null>;
  log: (
    level: 'info' | 'warn' | 'error',
    message: string,
    context?: Row,
  ) => void;
  /**
   * Hands re-scoring after feedback to a background job (`RescoreJob`), so the request answers without waiting for it.
   * Resolves once the job is accepted; rejects when it cannot be, and the service then runs it detached itself.
   * Without it (tests that build the service alone) the service always runs it detached.
   */
  deferRescore?: (task: RescoreTask) => Promise<void>;
}

/** What a background re-score needs: whose analyses, and the words whose weight changed. */
export interface RescoreTask {
  ownerId: string;
  terms: string[];
}

/** Runs the writes of one state change in a transaction; the route supplies one that also keeps an operation receipt. */
export type StateWriter = <T>(
  write: (connection: Connection) => Promise<T>,
) => Promise<T>;

export type FeedService = ReturnType<typeof createFeedService>;

export function createFeedService(deps: FeedServiceDeps) {
  const { database, adapters } = deps;
  const repo = (name: string) => database.repository(name);
  const running = new Set<number>();

  // Profile

  async function getProfile(ownerId: string): Promise<Profile> {
    const row = (await repo('feedProfiles').findOne({
      filter: { ownerId },
    })) as Row | null;
    return {
      interests: text(row?.interests),
      expertise: text(row?.expertise),
      avoid: text(row?.avoid),
      dailyLimit: Number(row?.dailyLimit ?? DEFAULT_DAILY_LIMIT),
      keepLearning: row ? bool(row.keepLearning) : true,
      locale: (row?.locale as Locale | null) ?? null,
      configured: Boolean(row),
      termWeights: json<Record<string, number>>(row?.termWeights, {}),
      digestEnabled: row ? bool(row.digestEnabled) : true,
      digestHour: Number(row?.digestHour ?? 8),
      timeZone: (row?.timeZone as string | null) ?? null,
      readerAgentId: (row?.readerAgentId as string | null) ?? null,
      maxAgeDays: Number(row?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS),
      readingLanguage:
        (row?.readingLanguage as ReadingLanguage | null | undefined) ?? null,
      waitForHeat: row?.waitForHeat == null ? true : bool(row.waitForHeat),
      waitHours: Number(row?.waitHours ?? DEFAULT_WAIT_HOURS),
    };
  }

  async function saveProfile(
    ownerId: string,
    input: Pick<
      Profile,
      'interests' | 'expertise' | 'avoid' | 'dailyLimit' | 'keepLearning'
    > &
      Partial<
        Pick<
          Profile,
          | 'digestEnabled'
          | 'digestHour'
          | 'timeZone'
          | 'readerAgentId'
          | 'maxAgeDays'
          | 'readingLanguage'
          | 'waitForHeat'
          | 'waitHours'
        >
      > & {
        locale?: Locale;
        resetLearning?: boolean;
      },
  ): Promise<Profile> {
    if (input.timeZone && !validTimeZone(input.timeZone))
      throw new FeedError('invalid', 'unknownTimeZone');
    const values = {
      interests: input.interests.trim(),
      expertise: input.expertise.trim(),
      avoid: input.avoid.trim(),
      dailyLimit: input.dailyLimit,
      keepLearning: input.keepLearning,
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.digestEnabled !== undefined
        ? { digestEnabled: input.digestEnabled }
        : {}),
      ...(input.digestHour !== undefined
        ? { digestHour: input.digestHour }
        : {}),
      ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
      ...(input.readerAgentId !== undefined
        ? { readerAgentId: input.readerAgentId?.trim() || null }
        : {}),
      ...(input.maxAgeDays !== undefined
        ? { maxAgeDays: input.maxAgeDays }
        : {}),
      ...(input.readingLanguage !== undefined
        ? { readingLanguage: input.readingLanguage }
        : {}),
      ...(input.waitForHeat !== undefined
        ? { waitForHeat: input.waitForHeat }
        : {}),
      ...(input.waitHours !== undefined ? { waitHours: input.waitHours } : {}),
      ...(input.resetLearning ? { termWeights: null } : {}),
      updatedAt: new Date(),
    };
    await repo('feedProfiles').upsertOne({
      filter: { ownerId },
      create: { ownerId, ...values },
      update: values,
    } as never);
    return getProfile(ownerId);
  }

  async function rememberLocale(
    ownerId: string,
    locale: Locale,
  ): Promise<void> {
    const profile = await getProfile(ownerId);
    if (profile.locale === locale) return;
    await repo('feedProfiles').upsertOne({
      filter: { ownerId },
      create: {
        ownerId,
        dailyLimit: DEFAULT_DAILY_LIMIT,
        keepLearning: true,
        locale,
        updatedAt: new Date(),
      },
      update: { locale, updatedAt: new Date() },
    } as never);
  }

  // Topics

  const toTopic = (row: Row, searches: Source[] = []): Topic => ({
    id: Number(row.id),
    name: String(row.name),
    goal: String(row.goal),
    avoid: (row.avoid as string | null) ?? null,
    mode: (row.mode as TopicMode) ?? 'both',
    sourceIds: json<number[]>(row.sourceIds, []).map(Number),
    searchTerms: json<unknown[]>(row.searchTerms, []).map(String),
    searchPlatforms: json<unknown[]>(row.searchPlatforms, []).filter(
      (value): value is Platform =>
        SEARCH_PLATFORMS.includes(value as Platform),
    ),
    searchFrequency: Number(row.searchFrequency ?? DEFAULT_SEARCH_FREQUENCY),
    searchLimit: Number(row.searchLimit ?? DEFAULT_SEARCH_LIMIT),
    searches,
    createdAt: iso(row.createdAt) ?? '',
  });

  async function topicRows(ownerId: string): Promise<Row[]> {
    return await repo('feedTopics').findMany({
      filter: { ownerId },
      sort: (s) => s.field('id').asc(),
    });
  }

  /** Every topic with the searches it runs, in two queries. */
  async function listTopics(ownerId: string): Promise<Topic[]> {
    const [rows, searchRows] = await Promise.all([
      topicRows(ownerId),
      database
        .query()
        .selectFrom('feedSources')
        .selectAll()
        .where('ownerId', '=', ownerId)
        .where('topicId', 'is not', null)
        .orderBy('id', 'asc')
        .execute<Row>(),
    ]);
    const byTopic = new Map<number, Source[]>();
    for (const row of searchRows) {
      const search = toSource(row);
      const list = byTopic.get(Number(row.topicId)) ?? [];
      list.push(search);
      byTopic.set(Number(row.topicId), list);
    }
    return rows.map((row) => toTopic(row, byTopic.get(Number(row.id)) ?? []));
  }

  async function getTopic(ownerId: string, id: number): Promise<Topic> {
    const topic = (await listTopics(ownerId)).find((entry) => entry.id === id);
    if (!topic) throw new FeedError('notFound', `feedTopics ${id}`);
    return topic;
  }

  async function ownedSourceIds(
    ownerId: string,
    ids: number[],
  ): Promise<number[]> {
    if (!ids.length) return [];
    const rows = await database
      .query()
      .selectFrom('feedSources')
      .select(['id'])
      .where('ownerId', '=', ownerId)
      .where('topicId', 'is', null)
      .where('id', 'in', ids)
      .execute();
    const owned = new Set(rows.map((row) => Number(row.id)));
    return ids.filter((id) => owned.has(id));
  }

  /**
   * The terms as they will be searched: trimmed, without repeats, each one a target every chosen platform accepts. A
   * term one platform refuses fails the whole save, so the topic never silently searches fewer places than it shows.
   */
  function searchPlan(
    terms: string[],
    platforms: Platform[],
  ): { terms: string[]; platforms: Platform[] } {
    const cleaned = [
      ...new Set(terms.map((term) => term.trim()).filter(Boolean)),
    ];
    if (cleaned.length > MAX_SEARCH_TERMS)
      throw new FeedError('invalid', 'tooManySearchTerms');
    if (platforms.some((platform) => !SEARCH_PLATFORMS.includes(platform)))
      throw new FeedError('invalid', 'notASearchPlatform');
    const chosen = SEARCH_PLATFORMS.filter((platform) =>
      platforms.length ? platforms.includes(platform) : true,
    );
    for (const term of cleaned)
      for (const platform of cleaned.length ? chosen : []) {
        try {
          validateSource(platform, 'keyword', term);
        } catch {
          throw new FeedError('invalid', 'searchTermLength');
        }
      }
    return { terms: cleaned, platforms: chosen };
  }

  /**
   * Makes the topic's search rows match its terms × platforms: missing pairs start at once, settings follow the topic,
   * and pairs no longer wanted are removed. Collected items stay, like a deleted subscription's.
   */
  async function syncSearches(
    connection: Connection,
    ownerId: string,
    topicRow: Row,
  ): Promise<void> {
    const topic = toTopic(topicRow);
    const plan = searchPlan(topic.searchTerms, topic.searchPlatforms);
    const key = (platform: string, term: string) => `${platform}\u0000${term}`;
    const wanted = new Map<string, { platform: Platform; term: string }>();
    for (const term of plan.terms)
      for (const platform of plan.platforms)
        wanted.set(key(platform, term), { platform, term });
    const existing = (await connection.repository('feedSources').findMany({
      filter: { ownerId, topicId: topic.id },
    })) as Row[];
    const now = new Date();
    const kept = new Set<string>();
    for (const row of existing) {
      const id = key(text(row.platform), text(row.target));
      const pair = wanted.get(id);
      if (!pair || kept.has(id)) {
        await connection
          .repository('feedSources')
          .deleteOne({ filter: { ownerId, id: Number(row.id) } } as never);
        continue;
      }
      kept.add(id);
      const values: Row = {};
      const name = truncate(`${topic.name} · ${pair.term}`, 120);
      if (row.name !== name) values.name = name;
      if (Number(row.frequency) !== topic.searchFrequency)
        values.frequency = topic.searchFrequency;
      if (Number(row.candidateLimit) !== topic.searchLimit)
        values.candidateLimit = topic.searchLimit;
      if (Object.keys(values).length)
        await connection.repository('feedSources').updateOne({
          filter: { ownerId, id: Number(row.id) },
          values: { ...values, updatedAt: now },
        } as never);
    }
    for (const [id, pair] of wanted) {
      if (kept.has(id)) continue;
      await connection.repository('feedSources').createOne({
        values: {
          ownerId,
          topicId: topic.id,
          platform: pair.platform,
          operation: 'keyword',
          name: truncate(`${topic.name} · ${pair.term}`, 120),
          target: pair.term,
          frequency: topic.searchFrequency,
          candidateLimit: topic.searchLimit,
          active: true,
          status: 'pending',
          nextRunAt: now,
          createdAt: now,
          updatedAt: now,
        },
      } as never);
    }
  }

  async function createTopic(
    ownerId: string,
    input: TopicInput,
  ): Promise<Topic> {
    const plan = searchPlan(
      input.searchTerms ?? [],
      input.searchPlatforms ?? [],
    );
    const now = new Date();
    // Read before the transaction: on SQLite it holds the only connection.
    const sourceIds = await ownedSourceIds(ownerId, input.sourceIds ?? []);
    const id = await database.transaction(async (connection) => {
      const result = await connection.repository('feedTopics').createOne({
        values: {
          ownerId,
          name: input.name.trim(),
          goal: input.goal.trim(),
          avoid: input.avoid?.trim() || null,
          mode: input.mode,
          sourceIds,
          searchTerms: plan.terms,
          searchPlatforms: input.searchPlatforms?.length ? plan.platforms : [],
          searchFrequency: input.searchFrequency ?? DEFAULT_SEARCH_FREQUENCY,
          searchLimit: input.searchLimit ?? DEFAULT_SEARCH_LIMIT,
          createdAt: now,
          updatedAt: now,
        },
      } as never);
      const record = (result as { record: Row }).record;
      await syncSearches(connection, ownerId, record);
      return Number(record.id);
    });
    return getTopic(ownerId, id);
  }

  async function updateTopic(
    ownerId: string,
    id: number,
    input: Partial<TopicInput>,
  ): Promise<Topic> {
    const current = toTopic(await requireRow('feedTopics', ownerId, id));
    const values: Row = { updatedAt: new Date() };
    if (input.name !== undefined) values.name = input.name.trim();
    if (input.goal !== undefined) values.goal = input.goal.trim();
    if (input.avoid !== undefined) values.avoid = input.avoid?.trim() || null;
    if (input.mode !== undefined) values.mode = input.mode;
    if (input.sourceIds !== undefined)
      values.sourceIds = await ownedSourceIds(ownerId, input.sourceIds);
    const plan = searchPlan(
      input.searchTerms ?? current.searchTerms,
      input.searchPlatforms ?? current.searchPlatforms,
    );
    if (input.searchTerms !== undefined) values.searchTerms = plan.terms;
    if (input.searchPlatforms !== undefined)
      values.searchPlatforms = input.searchPlatforms.length
        ? plan.platforms
        : [];
    if (input.searchFrequency !== undefined)
      values.searchFrequency = input.searchFrequency;
    if (input.searchLimit !== undefined) values.searchLimit = input.searchLimit;
    await database.transaction(async (connection) => {
      const result = await connection.repository('feedTopics').updateOne({
        filter: { ownerId, id },
        values,
      } as never);
      await syncSearches(
        connection,
        ownerId,
        (result as { record: Row }).record,
      );
    });
    return getTopic(ownerId, id);
  }

  /** Deletes the topic and its searches; what they collected stays in the feed. */
  async function deleteTopic(ownerId: string, id: number): Promise<void> {
    await requireRow('feedTopics', ownerId, id);
    await database.transaction(async (connection) => {
      await connection.query
        .deleteFrom('feedSources')
        .where('ownerId', '=', ownerId)
        .where('topicId', '=', id)
        .execute();
      await connection
        .repository('feedTopics')
        .deleteOne({ filter: { ownerId, id } } as never);
    });
  }

  /**
   * Starts every active search of the topic now, one after another, without waiting for them: a run can take minutes and
   * the request must not. A search already running is left to finish. `wait` is for tests.
   */
  async function runTopicSearches(
    ownerId: string,
    topicId: number,
    { wait = false }: { wait?: boolean } = {},
  ): Promise<{ started: number }> {
    await requireRow('feedTopics', ownerId, topicId);
    const rows = await database
      .query()
      .selectFrom('feedSources')
      .select(['id'])
      .where('ownerId', '=', ownerId)
      .where('topicId', '=', topicId)
      .where('active', '=', true)
      .orderBy('id', 'asc')
      .execute();
    const ids = rows
      .map((row) => Number(row.id))
      .filter((id) => !running.has(id));
    const work = (async () => {
      for (const id of ids) {
        try {
          await runSource(ownerId, id, 'manual');
        } catch (error) {
          if (!(error instanceof FeedError && error.code === 'busy'))
            deps.log('warn', 'topic search failed', {
              sourceId: id,
              error: error instanceof Error ? error.message : String(error),
            });
        }
      }
    })();
    if (wait) await work;
    return { started: ids.length };
  }

  async function requireRow(
    collection: string,
    ownerId: string,
    id: number,
  ): Promise<Row> {
    const row = (await repo(collection).findOne({
      filter: { ownerId, id },
    })) as Row | null;
    if (!row) throw new FeedError('notFound', `${collection} ${id}`);
    return row;
  }

  // Sources

  const toSource = (row: Row): Source => ({
    id: Number(row.id),
    topicId: row.topicId == null ? null : Number(row.topicId),
    platform: row.platform as Platform,
    operation: String(row.operation),
    name: String(row.name),
    target: String(row.target),
    frequency: Number(row.frequency),
    candidateLimit: Number(row.candidateLimit),
    active: bool(row.active),
    status: String(row.status),
    statusMessage: (row.statusMessage as string | null) ?? null,
    lastRunAt: iso(row.lastRunAt),
    lastSuccessAt: iso(row.lastSuccessAt),
    nextRunAt: iso(row.nextRunAt),
    failureStreak: Number(row.failureStreak ?? 0),
    emptyStreak: Number(row.emptyStreak ?? 0),
    options: json<Record<string, unknown> | null>(row.options, null),
    health: sourceHealth({
      failureStreak: Number(row.failureStreak ?? 0),
      emptyStreak: Number(row.emptyStreak ?? 0),
      frequency: Number(row.frequency),
      single: Boolean(
        findOperation(text(row.platform), text(row.operation))?.operation
          .single,
      ),
    }),
  });

  /** The subscriptions the person made; a topic's searches are listed with the topic. */
  async function listSources(ownerId: string): Promise<Source[]> {
    // The push inbox is not a subscription: it is described with the ingest API instead.
    return (await allSources(ownerId)).filter(
      (source) => source.topicId == null && source.platform !== INBOX_PLATFORM,
    );
  }

  async function allSources(ownerId: string): Promise<Source[]> {
    const rows = (await repo('feedSources').findMany({
      filter: { ownerId },
      sort: (s) => s.field('id').asc(),
    })) as Row[];
    return rows.map(toSource);
  }

  /** A topic's search is changed through its topic, so the two never disagree. */
  async function requireDirectSource(ownerId: string, id: number) {
    const row = await requireRow('feedSources', ownerId, id);
    if (row.topicId != null) throw new FeedError('invalid', 'managedByTopic');
    if (row.platform === INBOX_PLATFORM)
      throw new FeedError('invalid', 'pushSource');
    return row;
  }

  function validateSource(
    platform: string,
    operation: string,
    target: string,
  ): string {
    const spec = findOperation(platform, operation);
    if (!spec) throw new FeedError('invalid', 'unsupportedOperation');
    const value = target.trim();
    if (spec.operation.input === 'none')
      return value || `${platform}:${operation}`;
    if (!value) throw new FeedError('invalid', 'targetRequired');
    if (spec.operation.input === 'account' && value.length > 191)
      throw new FeedError('invalid', 'targetLength');
    if (spec.operation.input === 'url' && !/^https?:\/\/\S+$/i.test(value))
      throw new FeedError('invalid', 'targetMustBeUrl');
    const length = spec.operation.targetLength;
    if (
      length &&
      (value.length < length.min ||
        value.length > length.max ||
        value.startsWith('-'))
    )
      throw new FeedError('invalid', 'targetLength');
    return value;
  }

  /**
   * The options stored with a subscription: a mail subscription's folder and filters, after checking that its target is
   * one of the person's own connected accounts; nothing for every other platform.
   */
  async function sourceOptions(
    ownerId: string,
    platform: string,
    target: string,
    options: Record<string, unknown> | null | undefined,
  ): Promise<Record<string, unknown> | null> {
    if (platform !== 'mail') return null;
    const accounts = await deps.mailAccounts?.(ownerId);
    if (!accounts) throw new FeedError('invalid', 'mailUnavailable');
    const account = accounts.find((entry) => entry.id === target);
    if (!account || account.status === 'removing')
      throw new FeedError('invalid', 'mailAccountMissing');
    return { ...mailOptions(options) };
  }

  async function createSource(
    ownerId: string,
    input: Pick<
      Source,
      | 'platform'
      | 'operation'
      | 'name'
      | 'target'
      | 'frequency'
      | 'candidateLimit'
    > & {
      topicIds?: number[];
      options?: Record<string, unknown> | null;
    },
  ): Promise<Source> {
    const target = validateSource(
      input.platform,
      input.operation,
      input.target,
    );
    const options = await sourceOptions(
      ownerId,
      input.platform,
      target,
      input.options,
    );
    const now = new Date();
    const created = await database.transaction(async (connection) => {
      const result = await connection.repository('feedSources').createOne({
        values: {
          ownerId,
          platform: input.platform,
          operation: input.operation,
          name: input.name.trim(),
          target,
          frequency: input.frequency,
          candidateLimit: input.candidateLimit,
          options,
          active: true,
          status: 'pending',
          nextRunAt: now,
          createdAt: now,
          updatedAt: now,
        },
      } as never);
      const record = (result as { record: Row }).record;
      for (const topicId of input.topicIds ?? []) {
        const topic = (await connection.repository('feedTopics').findOne({
          filter: { ownerId, id: topicId },
        })) as Row | null;
        // A topic without a list already judges every subscription; adding one would limit it to this one.
        const ids = json<number[]>(topic?.sourceIds, []);
        if (!topic || !ids.length) continue;
        await connection.repository('feedTopics').updateOne({
          filter: { ownerId, id: topicId },
          values: {
            sourceIds: [...new Set([...ids, Number(record.id)])],
            updatedAt: now,
          },
        } as never);
      }
      return record;
    });
    return toSource(created);
  }

  async function updateSource(
    ownerId: string,
    id: number,
    input: Partial<
      Pick<
        Source,
        | 'name'
        | 'target'
        | 'frequency'
        | 'candidateLimit'
        | 'active'
        | 'options'
      >
    >,
  ): Promise<Source> {
    const current = toSource(await requireDirectSource(ownerId, id));
    const values: Row = { updatedAt: new Date() };
    if (input.name !== undefined) values.name = input.name.trim();
    if (input.target !== undefined) {
      values.target = validateSource(
        current.platform,
        current.operation,
        input.target,
      );
      if (values.target !== current.target) values.cursor = null;
    }
    if (
      current.platform === 'mail' &&
      (input.target !== undefined || input.options !== undefined)
    )
      values.options = await sourceOptions(
        ownerId,
        current.platform,
        (values.target as string | undefined) ?? current.target,
        input.options === undefined ? current.options : input.options,
      );
    if (input.frequency !== undefined) values.frequency = input.frequency;
    if (input.candidateLimit !== undefined)
      values.candidateLimit = input.candidateLimit;
    if (input.active !== undefined) {
      values.active = input.active;
      if (input.active && !current.active) values.nextRunAt = new Date();
    }
    const result = await repo('feedSources').updateOne({
      filter: { ownerId, id },
      values,
    } as never);
    return toSource((result as { record: Row }).record);
  }

  async function deleteSource(ownerId: string, id: number): Promise<void> {
    await requireDirectSource(ownerId, id);
    await database.transaction(async (connection) => {
      await connection
        .repository('feedSources')
        .deleteOne({ filter: { ownerId, id } } as never);
      // Keep collected items and the person's notes; only detach topic links.
      const topics = (await connection.repository('feedTopics').findMany({
        filter: { ownerId },
      })) as Row[];
      for (const topic of topics) {
        const ids = json<number[]>(topic.sourceIds, []);
        if (!ids.includes(id)) continue;
        await connection.repository('feedTopics').updateOne({
          filter: { ownerId, id: Number(topic.id) },
          values: {
            sourceIds: ids.filter((value) => value !== id),
            updatedAt: new Date(),
          },
        } as never);
      }
    });
  }

  // Runs

  async function startRun(values: Row): Promise<number> {
    const result = await repo('feedRuns').createOne({
      values: { ...values, status: 'running', startedAt: new Date() },
    } as never);
    return Number((result as { record: Row }).record.id);
  }

  async function finishRun(id: number, values: Row): Promise<void> {
    await repo('feedRuns').updateOne({
      filter: { id },
      values: { ...values, finishedAt: new Date() },
    } as never);
  }

  /** Back-off after a failure: login and configuration problems wait for a person, rate limits double the wait. */
  function nextRunAfter(source: Source, status: CollectResult['status']): Date {
    const minutes =
      status === 'needsLogin' ||
      status === 'unconfigured' ||
      status === 'unsupported'
        ? 6 * 60
        : status === 'rateLimited'
          ? source.frequency * 2
          : status === 'failed' || status === 'blocked'
            ? Math.max(15, source.frequency)
            : source.frequency;
    return new Date(Date.now() + minutes * 60_000);
  }

  /** The streak counters after a run that inserted `outcome` items, or ended with the status `outcome`. */
  function streaksAfter(
    source: Source,
    outcome: number | string,
  ): { failureStreak: number; emptyStreak: number } {
    if (typeof outcome === 'number')
      return {
        failureStreak: 0,
        emptyStreak: outcome === 0 ? source.emptyStreak + 1 : 0,
      };
    if (SETUP_STATUSES.has(outcome))
      return { failureStreak: 0, emptyStreak: source.emptyStreak };
    return {
      failureStreak: source.failureStreak + 1,
      emptyStreak: source.emptyStreak,
    };
  }

  /**
   * Tells the person once when a subscription starts failing or goes quiet, and forgets that it did once it recovers, so
   * the next problem is reported again.
   */
  async function reportHealth(ownerId: string, sourceId: number) {
    try {
      const row = await requireRow('feedSources', ownerId, sourceId);
      const source = toSource(row);
      const notified = row.healthNotifiedAt != null;
      if (source.health === 'ok') {
        if (notified)
          await repo('feedSources').updateOne({
            filter: { id: sourceId },
            values: { healthNotifiedAt: null },
          } as never);
        return;
      }
      if (notified) return;
      const { locale } = await getProfile(ownerId);
      const zh = locale === 'zh-CN';
      const sent = await deps.notify({
        key: `feed-source-health:${sourceId}:${source.health}:${Date.now()}`,
        ownerId,
        type: 'sourceHealth',
        referenceId: String(sourceId),
        path: source.topicId == null ? '/sources' : '/topics',
        title:
          source.health === 'failing'
            ? zh
              ? `订阅「${source.name}」连续 ${source.failureStreak} 次抓取失败`
              : `"${source.name}" failed ${source.failureStreak} times in a row`
            : zh
              ? `订阅「${source.name}」已连续 ${source.emptyStreak} 次没有新内容`
              : `"${source.name}" has found nothing new ${source.emptyStreak} times in a row`,
        body:
          source.health === 'failing'
            ? zh
              ? `最近一次的原因：${source.statusMessage ?? source.status}。请检查订阅目标或稍后重试。`
              : `Latest reason: ${source.statusMessage ?? source.status}. Check the target or try again later.`
            : zh
              ? '目标可能已停止更新或地址已变化，可以检查一下这个订阅是否仍然需要。'
              : 'The target may have stopped updating or moved; check whether you still need this subscription.',
      });
      if (sent)
        await repo('feedSources').updateOne({
          filter: { id: sourceId },
          values: { healthNotifiedAt: new Date() },
        } as never);
    } catch (error) {
      deps.log('warn', 'source health notice failed', {
        sourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function runSource(
    ownerId: string,
    sourceId: number,
    trigger: 'schedule' | 'manual',
  ): Promise<Run> {
    const sourceRow = await requireRow('feedSources', ownerId, sourceId);
    const source = toSource(sourceRow);
    if (source.platform === INBOX_PLATFORM)
      throw new FeedError('invalid', 'pushSource');
    if (running.has(sourceId)) throw new FeedError('busy', 'sourceRunning');
    running.add(sourceId);
    const runId = await startRun({
      ownerId,
      sourceId,
      stage: 'collect',
      trigger,
      scope: truncate(
        `${source.platform}/${source.operation} · ${source.target}`,
        300,
      ),
    });
    try {
      const knownRows = await database
        .query()
        .selectFrom('feedItems')
        .select(['externalId'])
        .where('ownerId', '=', ownerId)
        .where('platform', '=', source.platform)
        .orderBy('id', 'desc')
        .limit(2_000)
        .execute();
      const knownIds = new KnownIds(
        knownRows.map((row) => String(row.externalId)),
      );
      const single = findOperation(source.platform, source.operation)?.operation
        .single;
      const firstRun = !source.lastSuccessAt;
      // A tracked single item is read whatever its age; lists keep only what is new.
      const window = single
        ? null
        : collectWindow(
            (await getProfile(ownerId)).maxAgeDays,
            source.lastSuccessAt,
          );

      const collected = await adapters.collect({
        platform: source.platform,
        operation: source.operation,
        target: source.target,
        limit: source.candidateLimit,
        cursor: json<Record<string, unknown> | null>(sourceRow.cursor, null),
        knownIds,
        since: window?.since ?? null,
        ownerId,
        options: source.options,
        signal: AbortSignal.timeout(MAX_RUN_MS),
      });
      const result = window
        ? withinWindow(collected, window.cutoff)
        : collected;
      const succeeded = result.status === 'ok' || result.status === 'partial';
      const runCoverage: RunCoverage | null = succeeded
        ? single
          ? 'single'
          : firstRun
            ? 'baseline'
            : result.truncated || result.status === 'partial'
              ? 'partial'
              : 'complete'
        : null;

      const now = new Date();
      // Content, the subscription's checkpoint and the run record commit together, so a retry never re-inserts.
      const insertedIds = await database.transaction(async (connection) => {
        const ids: number[] = [];
        for (const item of succeeded ? result.items : []) {
          const externalId = storedExternalId(item.externalId);
          const exists = await connection.repository('feedItems').findOne({
            filter: {
              ownerId,
              platform: source.platform,
              externalId,
            },
            select: (s) => s.fields('id'),
          });
          if (exists) continue;
          const created = await connection.repository('feedItems').createOne({
            values: {
              ownerId,
              platform: source.platform,
              externalId,
              sourceId: source.id,
              sourceLabel: truncate(source.name, 200),
              url: item.url ? truncate(item.url, 1000) : null,
              title: truncate(item.title, 500) || item.externalId,
              author: item.author ? truncate(item.author, 200) : null,
              summary: item.summary ?? null,
              body: item.body ?? null,
              comments: item.comments ?? null,
              transcript: item.transcript ?? null,
              media: item.media?.length ? item.media : null,
              metrics: item.metrics ?? null,
              heat: heatOf(source.platform, item.metrics),
              heatAtCollection: heatOf(source.platform, item.metrics),
              metricsCheckedAt: now,
              coverage: item.coverage,
              contentVersion: 1,
              publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
              publishedApproximate: Boolean(
                item.publishedAt && item.publishedAtApproximate,
              ),
              // Where it sits in time: when published, else now (see the time-window migration). A time that is
              // missing or approximate is replaced by the exact one later (`resolvePublishedTimes`).
              timelineAt: item.publishedAt ? new Date(item.publishedAt) : now,
              fetchedAt: now,
              createdAt: now,
            },
          } as never);
          ids.push(Number((created as { record: Row }).record.id));
        }
        await connection.repository('feedSources').updateOne({
          filter: { id: source.id },
          values: {
            status: succeeded
              ? runCoverage === 'partial'
                ? 'partial'
                : 'ok'
              : result.status,
            statusMessage: result.message
              ? truncate(result.message, 1_000)
              : null,
            cursor: result.cursor ?? json(sourceRow.cursor, null),
            lastRunAt: now,
            ...(succeeded ? { lastSuccessAt: now } : {}),
            ...streaksAfter(source, succeeded ? ids.length : result.status),
            nextRunAt: nextRunAfter(source, result.status),
            updatedAt: now,
          },
        } as never);
        await connection.repository('feedRuns').updateOne({
          filter: { id: runId },
          values: {
            status: succeeded
              ? runCoverage === 'partial'
                ? 'partial'
                : 'succeeded'
              : result.status,
            found: result.items.length,
            inserted: ids.length,
            coverage: runCoverage,
            windowFilter: window && result.window ? result.window.filter : null,
            windowScanned:
              window && result.window?.scanned != null
                ? result.window.scanned
                : null,
            error: succeeded
              ? null
              : truncate(result.message ?? result.status, 2_000),
          },
        } as never);
        return ids;
      });

      await reportHealth(ownerId, source.id);
      // Content is already committed; an analysis failure is reported on the run without undoing the collection.
      try {
        const analyzed = await analyzeItems(ownerId, insertedIds, source.id);
        await finishRun(runId, { analyzed });
      } catch (error) {
        deps.log('error', 'feed analysis failed', {
          sourceId,
          error: error instanceof Error ? error.message : String(error),
        });
        await finishRun(runId, {
          status: 'analysisFailed',
          error: truncate(
            error instanceof Error ? error.message : String(error),
            2_000,
          ),
        });
      }
      // Title-only items wait for their text; the first few get it now, which runs the analysis they waited for.
      // Each fetch is its own `enrich` run; none of it changes how this collection ended.
      try {
        await prefetchWaiting({
          ownerId,
          itemIds: insertedIds,
          limit: PREFETCH_PER_RUN,
          trigger,
        });
      } catch (error) {
        deps.log('warn', 'feed prefetch failed', {
          sourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return await getRun(ownerId, runId);
    } catch (error) {
      deps.log('error', 'feed source run failed', {
        sourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      await finishRun(runId, {
        status: 'failed',
        error: truncate(
          error instanceof Error ? error.message : String(error),
          2_000,
        ),
      });
      await repo('feedSources').updateOne({
        filter: { id: sourceId },
        values: {
          status: 'failed',
          statusMessage: truncate(
            error instanceof Error ? error.message : String(error),
            1_000,
          ),
          lastRunAt: new Date(),
          ...streaksAfter(source, 'failed'),
          nextRunAt: nextRunAfter(source, 'failed'),
          updatedAt: new Date(),
        },
      } as never);
      await reportHealth(ownerId, sourceId);
      return getRun(ownerId, runId);
    } finally {
      running.delete(sourceId);
    }
  }

  /** Called by the schedule: runs every active subscription whose time has come, a few at a time. */
  async function runDue(): Promise<number> {
    const due = await database
      .query()
      .selectFrom('feedSources')
      .select(['id', 'ownerId'])
      .where('active', '=', true)
      .where('nextRunAt', '<=', new Date())
      .orderBy('nextRunAt', 'asc')
      .limit(20)
      .execute();
    let count = 0;
    for (const row of due as Row[]) {
      const id = Number(row.id);
      if (running.has(id)) continue;
      try {
        await runSource(String(row.ownerId), id, 'schedule');
        count += 1;
      } catch (error) {
        if (!(error instanceof FeedError && error.code === 'busy')) {
          deps.log('warn', 'scheduled feed run failed', {
            sourceId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return count;
  }

  const toRun = (row: Row, sources: Map<number, Source>): Run => {
    const source =
      row.sourceId != null ? sources.get(Number(row.sourceId)) : undefined;
    const windowFilter =
      row.windowFilter === 'platform' || row.windowFilter === 'local'
        ? row.windowFilter
        : null;
    return {
      id: Number(row.id),
      sourceId: row.sourceId == null ? null : Number(row.sourceId),
      sourceName: source?.name ?? null,
      platform: source?.platform ?? null,
      itemId: row.itemId == null ? null : Number(row.itemId),
      stage: row.stage as Run['stage'],
      trigger: row.trigger as Run['trigger'],
      status: String(row.status),
      scope: (row.scope as string | null) ?? null,
      found: Number(row.found ?? 0),
      inserted: Number(row.inserted ?? 0),
      analyzed: Number(row.analyzed ?? 0),
      coverage: (row.coverage as string | null) ?? null,
      error: (row.error as string | null) ?? null,
      windowFilter,
      windowScanned:
        row.windowScanned == null ? null : Number(row.windowScanned),
      windowShort:
        windowFilter === 'local' &&
        row.coverage === 'baseline' &&
        source != null &&
        Number(row.found ?? 0) < source.candidateLimit,
      startedAt: iso(row.startedAt) ?? '',
      finishedAt: iso(row.finishedAt),
    };
  };

  async function sourceMap(ownerId: string): Promise<Map<number, Source>> {
    return new Map(
      (await allSources(ownerId)).map((source) => [source.id, source]),
    );
  }

  async function getRun(ownerId: string, id: number): Promise<Run> {
    return toRun(
      await requireRow('feedRuns', ownerId, id),
      await sourceMap(ownerId),
    );
  }

  async function listRuns(
    ownerId: string,
    limit: number,
  ): Promise<{
    runs: Run[];
    stats: {
      found: number;
      inserted: number;
      analyzed: number;
      failed: number;
    };
  }> {
    const rows = (await repo('feedRuns').findMany({
      filter: { ownerId },
      sort: (s) => s.field('id').desc(),
      limit,
    })) as Row[];
    const sources = await sourceMap(ownerId);
    const since = new Date(Date.now() - 24 * 3600_000);
    const recent = () =>
      database
        .query()
        .selectFrom('feedRuns')
        .where('ownerId', '=', ownerId)
        .where('startedAt', '>=', since);
    const [[totals], [failures]] = await Promise.all([
      recent()
        .select((eb) => [
          eb.fn.sum('found').as('found'),
          eb.fn.sum('inserted').as('inserted'),
          eb.fn.sum('analyzed').as('analyzed'),
        ])
        .execute(),
      recent()
        .select((eb) => [eb.fn.count('id').as('failed')])
        .where('status', 'in', [
          'failed',
          'needsLogin',
          'rateLimited',
          'unconfigured',
        ])
        .execute(),
    ]);
    const stats = { ...totals, ...failures };
    const row = stats ?? {};
    return {
      runs: rows.map((entry) => toRun(entry, sources)),
      stats: {
        found: Number(row.found ?? 0),
        inserted: Number(row.inserted ?? 0),
        analyzed: Number(row.analyzed ?? 0),
        failed: Number(row.failed ?? 0),
      },
    };
  }

  // Analysis

  async function modelChoice(ownerId: string, profile: Profile) {
    const agents = deps.agents();
    if (!agents) return { ref: null, reason: 'noModel' as const };
    let ref: { modelService: string; model: string } | null;
    try {
      ref = (await agents.models.gateway.catalog('chat')).defaultModel ?? null;
    } catch {
      ref = null;
    }
    if (!ref) return { ref: null, reason: 'noModel' as const };
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [usage] = await database
      .query()
      .selectFrom('feedAnalyses')
      .select((eb) => [eb.fn.count('id').as('used')])
      .where('ownerId', '=', ownerId)
      .where('engine', '=', 'model')
      .where('createdAt', '>=', startOfDay)
      .execute();
    if (Number((usage as Row | undefined)?.used ?? 0) >= profile.dailyLimit)
      return { ref: null, reason: 'budget' as const };
    return { ref, reason: null };
  }

  const toAnalysisItem = (row: Row): AnalysisItem => ({
    platform: String(row.platform),
    title: String(row.title),
    author: (row.author as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    comments: json<CommentEntry[] | null>(row.comments, null),
    transcript: json<TranscriptSegment[] | null>(row.transcript, null),
    media: json<MediaEntry[] | null>(row.media, null),
    metrics: json<Record<string, number> | null>(row.metrics, null),
    coverage: json<ItemCoverage>(row.coverage, DEFAULT_COVERAGE),
  });

  const limitedToTitleIfBare = (
    item: AnalysisItem,
    draft: AnalysisDraft,
    profile: Profile,
    locale: Locale,
  ) => (hasOnlyTitle(item) ? limitedToTitle(draft, profile, locale) : draft);

  async function analyzeOne(
    ownerId: string,
    row: Row,
    topics: AnalysisTopic[],
    profile: Profile,
    locale: Locale,
  ): Promise<AnalysisDraft> {
    const item = toAnalysisItem(row);
    const analysisProfile: AnalysisProfile = profile;
    const choice = await modelChoice(ownerId, profile);
    if (choice.ref) {
      const { system, prompt } = buildPrompt(
        item,
        topics,
        analysisProfile,
        locale,
      );
      try {
        const ask = () =>
          deps.agents()!.models.gateway.generate({
            model: choice.ref,
            system,
            prompt,
            maxOutputTokens: ANALYSIS_TOKENS,
            source: 'nocofeed.analysis',
            signal: AbortSignal.timeout(90_000),
          });
        const parse = (text: string) =>
          parseModelAnswer(
            text,
            topics,
            item,
            locale,
            `${choice.ref.modelService}/${choice.ref.model}`,
          );
        const answer = await ask();
        try {
          return parse(answer.text);
        } catch {
          // Answers vary between calls and a cut-off one is common, so one more is cheaper than losing the analysis.
          return parse((await ask()).text);
        }
      } catch (error) {
        deps.log('warn', 'model analysis failed; using rules', {
          itemId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
        const draft = analyzeWithRules(item, topics, analysisProfile, locale);
        draft.uncertainty = `${draft.uncertainty} ${locale === 'zh-CN' ? '模型调用失败，已回退到规则分析。' : 'The model call failed; fell back to rules.'}`;
        return draft;
      }
    }
    const draft = analyzeWithRules(item, topics, analysisProfile, locale);
    if (choice.reason === 'budget') {
      draft.uncertainty = `${draft.uncertainty} ${locale === 'zh-CN' ? '今日模型分析额度已用完。' : "Today's model analysis budget is used up."}`;
    }
    return draft;
  }

  /**
   * Which rows to leave out of the full analysis, asked in batches. Rows with a keyword match do not ask. It fails open:
   * a call that fails or answers nonsense stops nothing. Does not count against `dailyLimit`, which counts analyses.
   */
  async function prefilter(
    ownerId: string,
    rows: Row[],
    topics: AnalysisTopic[],
    profile: Profile,
  ): Promise<Set<number>> {
    const blocked = new Set<number>();
    const choice = await modelChoice(ownerId, profile);
    if (!choice.ref) return blocked;
    const asked = rows.filter((row) =>
      needsPrefilter(toAnalysisItem(row), topics, profile),
    );
    for (let start = 0; start < asked.length; start += PREFILTER_BATCH) {
      const batch = asked.slice(start, start + PREFILTER_BATCH);
      const items = batch.map(toAnalysisItem);
      const { system, prompt } = buildPrefilterPrompt(items, topics, profile);
      try {
        const answer = await deps.agents()!.models.gateway.generate({
          model: choice.ref,
          system,
          prompt,
          maxOutputTokens: PREFILTER_TOKENS,
          source: 'nocofeed.prefilter',
          signal: AbortSignal.timeout(60_000),
        });
        for (const index of parsePrefilterAnswer(answer.text, batch.length))
          blocked.add(Number(batch[index].id));
      } catch (error) {
        deps.log('warn', 'prefilter failed; analysing the batch', {
          ownerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return blocked;
  }

  async function topicsFor(
    ownerId: string,
    sourceId: number | null,
  ): Promise<AnalysisTopic[]> {
    const [rows, source] = await Promise.all([
      topicRows(ownerId),
      sourceId == null
        ? null
        : (repo('feedSources').findOne({
            filter: { ownerId, id: sourceId },
          }) as Promise<Row | null>),
    ]);
    const topics = rows.map((row) => toTopic(row));
    // Without a known subscription every topic applies. Otherwise: the topics that judge every subscription, those
    // limited to this one, and the topic whose search brought the item.
    const applies = (topic: Topic) =>
      sourceId == null ||
      !topic.sourceIds.length ||
      topic.sourceIds.includes(sourceId) ||
      (source?.topicId != null && Number(source.topicId) === topic.id);
    return topics.filter(applies).map((topic) => ({
      id: topic.id,
      name: topic.name,
      goal: topic.goal,
      avoid: topic.avoid,
      mode: topic.mode,
    }));
  }

  /**
   * Writes a new current analysis per item; earlier versions stay as history. Returns how many were analysed. `asked`
   * means the person asked for this item, so neither gate applies: they have seen it and want the model's view.
   */
  async function analyzeItems(
    ownerId: string,
    itemIds: number[],
    sourceId: number | null,
    { asked = false }: { asked?: boolean } = {},
  ): Promise<number> {
    if (!itemIds.length) return 0;
    const [profile, topics, source] = await Promise.all([
      getProfile(ownerId),
      topicsFor(ownerId, sourceId),
      sourceId == null
        ? null
        : (repo('feedSources').findOne({
            filter: { ownerId, id: sourceId },
          }) as Promise<Row | null>),
    ]);
    const rows = await database
      .query()
      .selectFrom('feedItems')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('id', 'in', itemIds)
      .execute<Row>();
    // A bare title waits only where fetching more is possible; elsewhere nothing would ever release it.
    const awaits = (row: Row) =>
      !asked &&
      hasOnlyTitle(toAnalysisItem(row)) &&
      enrichableFor(
        String(row.platform),
        source ? String(source.operation) : null,
      ).length > 0;
    const blocked = asked
      ? new Set<number>()
      : await prefilter(
          ownerId,
          rows.filter((row) => !awaits(row)),
          topics,
          profile,
        );
    let count = 0;
    for (const row of rows) {
      const locale = localeFor(
        profile.locale,
        `${profile.interests}${text(row.title)}`,
      );
      const item = toAnalysisItem(row);
      let draft: AnalysisDraft;
      if (awaits(row))
        draft = awaitingMaterial(
          analyzeWithRules(item, topics, profile, locale),
          profile,
          locale,
        );
      else if (blocked.has(Number(row.id)))
        draft = blockedByPrefilter(
          analyzeWithRules(item, topics, profile, locale),
          locale,
        );
      else {
        draft = limitedToTitleIfBare(
          item,
          await analyzeOne(ownerId, row, topics, profile, locale),
          profile,
          locale,
        );
      }
      await writeAnalysis(ownerId, row, draft, { asked });
      count += 1;
    }
    return count;
  }

  /**
   * What the admission rules (`admission.ts`) need beyond the analysis: whether the item came from a topic search,
   * whether the person kept it, and how long they let new posts wait.
   */
  async function admissionContext(
    ownerId: string,
    row: Row,
    { asked = false, now = new Date() }: { asked?: boolean; now?: Date } = {},
  ) {
    const [profile, source, state] = await Promise.all([
      getProfile(ownerId),
      row.sourceId == null
        ? null
        : (repo('feedSources').findOne({
            filter: { ownerId, id: Number(row.sourceId) },
          }) as Promise<Row | null>),
      repo('feedItemStates').findOne({
        filter: { ownerId, itemId: Number(row.id) },
      }) as Promise<Row | null>,
    ]);
    return {
      fromSearch: source?.topicId != null,
      kept: Boolean(
        state &&
        (bool(state.favorite) ||
          bool(state.later) ||
          bool(state.participated) ||
          text(state.notes).trim()),
      ),
      asked,
      heat: row.heat == null ? null : Number(row.heat),
      publishedAt: new Date(
        (row.publishedAt ?? row.timelineAt ?? row.createdAt ?? now) as Date,
      ),
      waitForHeat: profile.waitForHeat,
      waitHours: profile.waitHours,
      now,
      locale: localeFor(
        profile.locale,
        `${profile.interests}${text(row.title)}`,
      ),
    };
  }

  /**
   * Makes `draft` the item's current analysis; earlier ones stay as history. A search result passes the admission
   * rules first, so a thin, unnoticed one is held back with the reason (`asked`: the person asked, so it never waits).
   */
  async function writeAnalysis(
    ownerId: string,
    row: Row,
    analysed: AnalysisDraft,
    { asked = false }: { asked?: boolean } = {},
  ) {
    const draft = admit(
      toAnalysisItem(row),
      analysed,
      await admissionContext(ownerId, row, { asked }),
    );
    await database.transaction(async (connection) => {
      await connection.query
        .updateTable('feedAnalyses')
        .set({ current: false })
        .where('itemId', '=', Number(row.id))
        .where('current', '=', true)
        .execute();
      await connection.repository('feedAnalyses').createOne({
        values: {
          ownerId,
          itemId: Number(row.id),
          current: true,
          contentVersion: Number(row.contentVersion ?? 1),
          ...draft,
          steps: draft.steps,
          createdAt: new Date(),
        },
      } as never);
    });
  }

  async function reanalyzeItem(
    ownerId: string,
    itemId: number,
  ): Promise<FeedItemDetail> {
    const row = await requireRow('feedItems', ownerId, itemId);
    if (await handToAgent(ownerId, row)) return getItem(ownerId, itemId);
    const runId = await startRun({
      ownerId,
      itemId,
      sourceId: row.sourceId ?? null,
      stage: 'analyze',
      trigger: 'manual',
      scope: truncate(String(row.title), 300),
    });
    try {
      const analyzed = await analyzeItems(
        ownerId,
        [itemId],
        row.sourceId == null ? null : Number(row.sourceId),
        { asked: true },
      );
      await finishRun(runId, { status: 'succeeded', found: 1, analyzed });
    } catch (error) {
      await finishRun(runId, {
        status: 'failed',
        error: truncate(
          error instanceof Error ? error.message : String(error),
          2_000,
        ),
      });
      throw error;
    }
    return getItem(ownerId, itemId);
  }

  // Runner agents

  /** The agent run still reading the item, if one is. */
  async function readingAgent(
    ownerId: string,
    itemId: number,
  ): Promise<AgentReading | null> {
    const [row] = await database
      .query()
      .selectFrom('feedRuns')
      .select(['id', 'agentResult', 'startedAt'])
      .where('ownerId', '=', ownerId)
      .where('itemId', '=', itemId)
      .where('agentRunId', 'is not', null)
      .where('status', 'in', ['running', 'settling'])
      .orderBy('id', 'desc')
      .limit(1)
      .execute<Row>();
    if (!row) return null;
    const profile = await getProfile(ownerId);
    return {
      runId: Number(row.id),
      agentId: profile.readerAgentId ?? '',
      startedAt: iso(row.startedAt) ?? '',
    };
  }

  /**
   * Hands "Analyze again" to the person's runner agent, with the brief the model gateway would get. Answers false when
   * there is no agent to hand it to, so the caller analyses as before: no agent chosen, the plugin missing, the agent
   * disabled or removed, or the queue refusing the work. An item already being read is not queued twice.
   */
  async function handToAgent(ownerId: string, row: Row): Promise<boolean> {
    const agents = deps.agents();
    if (!agents) return false;
    const profile = await getProfile(ownerId);
    const agentId = profile.readerAgentId;
    if (!agentId) return false;
    const itemId = Number(row.id);
    if (await readingAgent(ownerId, itemId)) return true;
    try {
      const agent = await agents.agents.findWorkable(agents.tx.read(), agentId);
      if (!agent) {
        deps.log('info', 'reader agent is not workable; analysing here', {
          itemId,
          agentId,
        });
        return false;
      }
      const sourceId = row.sourceId == null ? null : Number(row.sourceId);
      const topics = await topicsFor(ownerId, sourceId);
      const locale = localeFor(
        profile.locale,
        `${profile.interests}${text(row.title)}`,
      );
      const { system, prompt } = buildPrompt(
        toAnalysisItem(row),
        topics,
        profile,
        locale,
      );
      await agents.tx.run(async (tx) => {
        const created = await tx.conn.repository('feedRuns').createOne({
          values: {
            ownerId,
            itemId,
            sourceId,
            stage: 'analyze',
            trigger: 'manual',
            status: 'running',
            scope: truncate(String(row.title), 300),
            startedAt: new Date(),
          },
        } as never);
        const feedRunId = Number((created as { record: Row }).record.id);
        const payload: AnalyzePayload = {
          trigger: ANALYZE_TRIGGER,
          feedRunId,
          itemId,
          system,
          prompt,
        };
        const result = await agents.runs.enqueue(
          {
            agentId,
            subject: { kind: FEED_ITEM_SUBJECT, id: String(itemId) },
            actorUserId: ownerId,
            input: {
              type: 'custom',
              actor: { kind: 'system', id: 'nocofeed', name: 'NocoFeed' },
              text: `Analyse "${truncate(String(row.title), 200)}" again.`,
              payload,
            },
          },
          tx,
        );
        // Nobody else answers for a person's own item, so the work is always queued, never a run request.
        if (result.outcome === 'pending' || !result.runId)
          throw new Error('agent run was not queued');
        await tx.conn.repository('feedRuns').updateMany({
          filter: { id: feedRunId },
          values: { agentRunId: result.runId },
        } as never);
      });
      return true;
    } catch (error) {
      deps.log('warn', 'could not hand the analysis to the agent', {
        itemId,
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Settles the agent runs that ended: a readable answer becomes the item's analysis (engine `agent`); a failed,
   * cancelled or unreadable one falls back to the model gateway and the rules, as "Analyze again" did before. Each row
   * is claimed with a guarded update, so the hook after a run and the schedule never settle one twice.
   */
  async function settleAgentReads(): Promise<number> {
    const rows = await database
      .query()
      .selectFrom('feedRuns')
      .selectAll()
      .where('agentRunId', 'is not', null)
      .where('agentResult', 'is not', null)
      .where('status', '=', 'running')
      .orderBy('id')
      .limit(50)
      .execute<Row>();
    let settled = 0;
    for (const run of rows) {
      const { updatedCount } = await repo('feedRuns').updateMany({
        filter: { id: Number(run.id), status: 'running' },
        values: { status: 'settling' },
      } as never);
      if (!updatedCount) continue;
      const ownerId = String(run.ownerId);
      const itemId = Number(run.itemId);
      const result = json<AgentResult | null>(run.agentResult, null);
      try {
        const item = (await repo('feedItems').findOne({
          filter: { ownerId, id: itemId },
        })) as Row | null;
        if (!item) {
          await finishRun(Number(run.id), {
            status: 'failed',
            error: 'itemGone',
          });
          continue;
        }
        const draft =
          result?.status === 'completed' && result.summary
            ? await agentDraft(ownerId, item, result)
            : null;
        if (draft) {
          await writeAnalysis(ownerId, item, draft, { asked: true });
          await finishRun(Number(run.id), {
            status: 'succeeded',
            found: 1,
            analyzed: 1,
          });
        } else {
          const analyzed = await analyzeItems(
            ownerId,
            [itemId],
            item.sourceId == null ? null : Number(item.sourceId),
            { asked: true },
          );
          await finishRun(Number(run.id), {
            status: 'fellBack',
            found: 1,
            analyzed,
            error:
              result?.status === 'completed'
                ? 'agentAnswerUnreadable'
                : result?.status === 'cancelled'
                  ? 'agentCancelled'
                  : 'agentFailed',
          });
        }
        settled += 1;
      } catch (error) {
        await finishRun(Number(run.id), {
          status: 'failed',
          error: truncate(
            error instanceof Error ? error.message : String(error),
            2_000,
          ),
        });
      }
    }
    return settled;
  }

  /** The agent's answer as an analysis, or null when it is not the JSON the brief asked for. */
  async function agentDraft(
    ownerId: string,
    item: Row,
    result: AgentResult,
  ): Promise<AnalysisDraft | null> {
    const [profile, topics] = await Promise.all([
      getProfile(ownerId),
      topicsFor(ownerId, item.sourceId == null ? null : Number(item.sourceId)),
    ]);
    const locale = localeFor(
      profile.locale,
      `${profile.interests}${text(item.title)}`,
    );
    try {
      const draft = parseModelAnswer(
        result.summary ?? '',
        topics,
        toAnalysisItem(item),
        locale,
        result.model ? `${result.agentId} (${result.model})` : result.agentId,
      );
      return { ...draft, engine: 'agent' };
    } catch {
      return null;
    }
  }

  /**
   * Fetches `want` for one item and stores what came back. `asked` is the person pressing the button: every failure
   * is recorded on the item's coverage. Unasked, a failure that says nothing about the item (sign-in, a block, a rate
   * limit, no Collector) leaves the coverage as it was, so it is tried again later.
   */
  async function fetchMaterial(
    ownerId: string,
    row: Row,
    want: ('body' | 'comments' | 'transcript')[],
    {
      trigger,
      asked,
      signal,
      deferAnalysis = false,
    }: {
      trigger: 'schedule' | 'manual';
      asked: boolean;
      /** Stops the fetch early; the run's own limit applies either way. */
      signal?: AbortSignal;
      /** Start the analysis the item waited for without waiting for it (a conversation is waiting instead). */
      deferAnalysis?: boolean;
    },
  ): Promise<EnrichResult> {
    const itemId = Number(row.id);
    const runId = await startRun({
      ownerId,
      itemId,
      sourceId: row.sourceId ?? null,
      stage: 'enrich',
      trigger,
      scope: truncate(String(row.title), 300),
    });
    const result = await adapters.enrich({
      platform: String(row.platform),
      externalId: String(row.externalId),
      url: (row.url as string | null) ?? null,
      want,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(MAX_RUN_MS)])
        : AbortSignal.timeout(MAX_RUN_MS),
    });
    const ok = result.status === 'ok' || result.status === 'partial';
    const coverage = json<ItemCoverage>(row.coverage, DEFAULT_COVERAGE);
    if (!ok && (asked || !PREFETCH_STOPS.has(result.status))) {
      // Record why each wanted part is still missing, without discarding what was obtained before.
      for (const part of want) {
        const current = coverage[part];
        if (!current || !['available', 'partial'].includes(current.status)) {
          coverage[part] = {
            status: 'failed',
            note: result.status,
            fetchedAt: new Date().toISOString(),
          };
        }
      }
    }
    await database.transaction(async (connection) => {
      await connection.repository('feedItems').updateOne({
        filter: { ownerId, id: itemId },
        values: {
          ...(ok && result.body ? { body: truncate(result.body, 20_000) } : {}),
          // An empty list replaces stored comments only when the Collector says the thread was read and has none.
          ...(ok &&
          result.comments &&
          (result.comments.length > 0 ||
            result.coverage.comments?.status === 'available')
            ? { comments: result.comments }
            : {}),
          ...(ok && result.transcript ? { transcript: result.transcript } : {}),
          // Media comes with the body; an answer without any keeps what is stored.
          ...(ok && result.media?.length ? { media: result.media } : {}),
          coverage: ok ? { ...coverage, ...result.coverage } : coverage,
          ...(ok
            ? {
                contentVersion: Number(row.contentVersion ?? 1) + 1,
                fetchedAt: new Date(),
              }
            : {}),
        },
      } as never);
      await connection.repository('feedRuns').updateOne({
        filter: { id: runId },
        values: {
          status: ok ? 'succeeded' : result.status,
          found: ok ? 1 : 0,
          error: ok ? null : truncate(result.message || result.status, 2_000),
          finishedAt: new Date(),
        },
      } as never);
    });
    if (!ok) return result;
    // An item waiting for material has had no real analysis yet, so this is the analysis it was waiting for rather than
    // a rewrite; any other analysis is left to go stale until the person asks again.
    const current = (await repo('feedAnalyses').findOne({
      filter: { itemId, current: true },
    })) as Row | null;
    if (current?.gate === 'awaitingMaterial') {
      const analysis = analyzeItems(
        ownerId,
        [itemId],
        row.sourceId == null ? null : Number(row.sourceId),
      );
      if (deferAnalysis) void analysis.catch(() => undefined);
      else await analysis;
    }
    return result;
  }

  /**
   * Fetches parts of one item for a conversation about it ("Ask about this item") and stores them on the item, the way
   * the person's "Fetch" does, so the next question finds them stored. Only parts the item's platform can give are
   * asked for; with none left the answer is `unsupported` (or `unconfigured` when only the Collector could give them).
   * Failures follow the unasked rules: a sign-in, block, rate limit or missing Collector leaves the coverage alone.
   */
  async function fetchParts(
    ownerId: string,
    itemId: number,
    want: readonly ('body' | 'comments' | 'transcript')[],
    signal?: AbortSignal,
  ): Promise<EnrichResult> {
    const row = await requireRow('feedItems', ownerId, itemId);
    const source =
      row.sourceId == null
        ? null
        : ((await repo('feedSources').findOne({
            filter: { ownerId, id: Number(row.sourceId) },
          })) as Row | null);
    const operation = source ? String(source.operation) : null;
    const allowed = enrichableFor(String(row.platform), operation);
    const parts = want.filter((part) => allowed.includes(part));
    if (!parts.length) {
      const spec = CATALOG.find((entry) => entry.platform === row.platform);
      const possible = (
        spec?.operations.find((entry) => entry.operation === operation) ??
        spec?.operations[0]
      )?.enrich;
      const needsCollector =
        !adapters.collectorConfigured() &&
        want.some((part) => possible?.includes(part));
      return {
        status: needsCollector ? 'unconfigured' : 'unsupported',
        message: needsCollector ? 'collectorMissing' : 'unsupportedPart',
        coverage: {},
      };
    }
    return fetchMaterial(ownerId, row, parts, {
      trigger: 'manual',
      asked: false,
      signal,
      deferAnalysis: true,
    });
  }

  async function enrichItem(
    ownerId: string,
    itemId: number,
  ): Promise<FeedItemDetail> {
    const row = await requireRow('feedItems', ownerId, itemId);
    const source =
      row.sourceId == null
        ? null
        : ((await repo('feedSources').findOne({
            filter: { ownerId, id: Number(row.sourceId) },
          })) as Row | null);
    const want = enrichableFor(
      String(row.platform),
      source ? String(source.operation) : null,
    );
    if (!want.length) throw new FeedError('invalid', 'nothingToEnrich');
    const result = await fetchMaterial(ownerId, row, want, {
      trigger: 'manual',
      asked: true,
    });
    if (result.status !== 'ok' && result.status !== 'partial')
      throw new FeedError('unavailable', result.status);
    return getItem(ownerId, itemId);
  }

  /**
   * Fetches the text of recent title-only items that are waiting for it, where the operation that found them declares
   * `prefetch`; enriching runs the analysis they were waiting for. Called after a run (its new items) and on every
   * scheduled tick (anything still waiting). Returns how many items were fetched.
   */
  async function prefetchWaiting({
    ownerId,
    itemIds,
    limit = PREFETCH_PER_TICK,
    trigger = 'schedule',
    now = new Date(),
  }: {
    ownerId?: string;
    itemIds?: number[];
    limit?: number;
    trigger?: 'schedule' | 'manual';
    now?: Date;
  } = {}): Promise<number> {
    if (!adapters.collectorConfigured()) return 0;
    const platforms = CATALOG.filter((spec) =>
      spec.operations.some((op) => op.prefetch?.length),
    ).map((spec) => spec.platform);
    let query = database
      .query()
      .selectFrom('feedItems as i')
      .innerJoin('feedAnalyses as a', (join) =>
        join.onRef('a.itemId', '=', 'i.id').on('a.current', '=', true),
      )
      .leftJoin('feedSources as s', 's.id', 'i.sourceId')
      .selectAll('i')
      .select(['s.operation as sourceOperation'])
      .where('a.gate', '=', 'awaitingMaterial')
      .where('i.platform', 'in', platforms)
      .where('i.createdAt', '>=', new Date(now.getTime() - PREFETCH_WINDOW_MS));
    if (ownerId) query = query.where('i.ownerId', '=', ownerId);
    if (itemIds) {
      if (!itemIds.length) return 0;
      query = query.where('i.id', 'in', itemIds);
    }
    // Over-fetch: rows whose body was already tried, or whose operation does not prefetch, are skipped below.
    const rows = await query
      .orderBy('i.id', 'desc')
      .limit(limit * 5)
      .execute<Row>();
    const deadline = Date.now() + PREFETCH_BUDGET_MS;
    let fetched = 0;
    for (const row of rows) {
      if (fetched >= limit || Date.now() >= deadline) break;
      const spec = CATALOG.find((entry) => entry.platform === row.platform);
      const op =
        spec?.operations.find(
          (entry) => entry.operation === row.sourceOperation,
        ) ?? spec?.operations[0];
      const want = [...(op?.prefetch ?? [])];
      if (!want.length) continue;
      const coverage = json<ItemCoverage>(row.coverage, DEFAULT_COVERAGE);
      // Only parts never tried: a recorded failure waits for the person to ask.
      if (want.some((part) => coverage[part]?.status !== 'missing')) continue;
      try {
        const result = await fetchMaterial(String(row.ownerId), row, want, {
          trigger,
          asked: false,
        });
        fetched += 1;
        if (PREFETCH_STOPS.has(result.status)) break;
      } catch (error) {
        deps.log('warn', 'feed prefetch failed', {
          itemId: Number(row.id),
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    return fetched;
  }

  /**
   * Reads again the counts of recent items on platforms this server can read without the Collector, as often as their
   * age calls for (`refreshInterval`), and updates their heat. One lookup serves every owner's copy. An item that turned
   * hot here and was only judged by the rules or stopped at a gate gets the full analysis it skipped: attention is a
   * reason to look properly, not a verdict. Returns how many items were read.
   */
  async function refreshHeat({
    limit = HEAT_PER_TICK,
    now = new Date(),
  }: { limit?: number; now?: Date } = {}): Promise<number> {
    const rows = await database
      .query()
      .selectFrom('feedItems')
      .select([
        'id',
        'ownerId',
        'platform',
        'externalId',
        'sourceId',
        'timelineAt',
        'heat',
        'metricsCheckedAt',
      ])
      .where('platform', 'in', [...REFRESHABLE_PLATFORMS])
      .where('timelineAt', '>=', new Date(now.getTime() - HEAT_WINDOW_MS))
      .execute<Row>();
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const age = now.getTime() - new Date(row.timelineAt as Date).getTime();
      const interval = refreshInterval(Math.max(0, age));
      if (interval == null) continue;
      const checked = row.metricsCheckedAt
        ? new Date(row.metricsCheckedAt as Date).getTime()
        : null;
      if (checked != null && now.getTime() - checked < interval) continue;
      const key = `${String(row.platform)}:${String(row.externalId)}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    // The youngest first: their attention moves fastest.
    const due = [...groups.values()]
      .sort(
        (a, b) =>
          new Date(b[0].timelineAt as Date).getTime() -
          new Date(a[0].timelineAt as Date).getTime(),
      )
      .slice(0, limit);
    const deadline = Date.now() + HEAT_BUDGET_MS;
    const turnedHot: Row[] = [];
    let read = 0;
    await mapLimit(due, 6, async (group) => {
      if (Date.now() >= deadline) return;
      const first = group[0];
      let metrics: Record<string, number> | null = null;
      try {
        metrics = await adapters.metrics(
          String(first.platform),
          String(first.externalId),
          AbortSignal.timeout(15_000),
        );
      } catch (error) {
        deps.log('warn', 'feed heat refresh failed', {
          platform: first.platform,
          externalId: first.externalId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Checked either way, so an item that cannot be read waits its turn instead of being asked every tick.
      const heat = metrics ? heatOf(String(first.platform), metrics) : null;
      for (const row of group)
        await repo('feedItems').updateOne({
          filter: { id: Number(row.id) },
          values: {
            metricsCheckedAt: now,
            ...(metrics ? { metrics, heat } : {}),
          },
        } as never);
      if (!metrics) return;
      read += 1;
      for (const row of group)
        if (
          heat != null &&
          heat >= HOT_HEAT &&
          Number(row.heat ?? -1) < HOT_HEAT
        )
          turnedHot.push(row);
    });
    let analysed = 0;
    for (const row of turnedHot) {
      if (analysed >= HOT_ANALYSES_PER_TICK) break;
      try {
        if (await lookAtHotItem(String(row.ownerId), Number(row.id)))
          analysed += 1;
      } catch (error) {
        deps.log('warn', 'feed hot analysis failed', {
          itemId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return read;
  }

  /**
   * Gives an item that just turned hot the analysis it skipped: its discussion first where the platform has one, then
   * the model past both gates. An item a model already judged keeps that judgement. Returns whether it analysed.
   */
  async function lookAtHotItem(
    ownerId: string,
    itemId: number,
  ): Promise<boolean> {
    const current = (await repo('feedAnalyses').findOne({
      filter: { itemId, current: true },
    })) as Row | null;
    if (current && current.engine === 'model' && current.gate == null)
      return false;
    // Held back by the admission rules for being thin and unnoticed: a model that judged it already said what it is
    // worth, so the attention lets it in without asking again.
    if (current && current.engine !== 'rules' && isHoldGate(current.gate)) {
      await releaseHeld(Number(current.id), current);
      return false;
    }
    const row = await requireRow('feedItems', ownerId, itemId);
    const sourceId = row.sourceId == null ? null : Number(row.sourceId);
    const source =
      sourceId == null
        ? null
        : ((await repo('feedSources').findOne({
            filter: { ownerId, id: sourceId },
          })) as Row | null);
    const coverage = json<ItemCoverage>(row.coverage, DEFAULT_COVERAGE);
    const canRead = enrichableFor(
      String(row.platform),
      source ? String(source.operation) : null,
    );
    // The discussion is what made it hot; read it before judging whether to join in.
    if (
      canRead.includes('comments') &&
      !['available', 'partial'].includes(coverage.comments?.status ?? '')
    ) {
      await fetchMaterial(ownerId, row, ['comments'], {
        trigger: 'schedule',
        asked: false,
      });
    }
    await analyzeItems(ownerId, [itemId], sourceId, { asked: true });
    return true;
  }

  /** Lets an item the admission rules held back into the feed, with the verdict it would have had. */
  async function releaseHeld(analysisId: number, current: Row) {
    const released = release({
      verdict: current.verdict as Verdict,
      gate: current.gate as AnalysisGate,
      heldVerdict: (current.heldVerdict as Verdict | null) ?? 'learn',
    } as AnalysisDraft);
    await database
      .query()
      .updateTable('feedAnalyses')
      .set({
        verdict: released.verdict,
        gate: null,
        heldVerdict: null,
        watchUntil: null,
      })
      .where('id', '=', analysisId)
      .execute();
  }

  /**
   * Watched items whose time is up (`watchUntil`): their counts are read again — natively where the platform allows
   * (`REFRESHABLE_PLATFORMS`), through the Collector's discussion for X and Xiaohongshu, a few per tick — and they come
   * in when hot or stay out as thin. A read the Collector could not make is tried again on later ticks for
   * `WATCH_GRACE_MS`, then the item is decided on the counts it has. Beyond `MAX_WATCHING` per person the oldest are
   * decided at once on what is known, so watching never piles up. Calls no model. Returns how many were decided.
   */
  async function settleWatching({
    now = new Date(),
    limit = WATCH_PER_TICK,
    maxWatching = MAX_WATCHING,
  }: {
    now?: Date;
    limit?: number;
    maxWatching?: number;
  } = {}): Promise<number> {
    const select = () =>
      database
        .query()
        .selectFrom('feedAnalyses as a')
        .innerJoin('feedItems as i', 'i.id', 'a.itemId')
        .select([
          'a.id as analysisId',
          'a.heldVerdict',
          'a.uncertainty',
          'a.watchUntil',
          'i.id',
          'i.ownerId',
          'i.platform',
          'i.externalId',
          'i.url',
          'i.title',
          'i.metrics',
          'i.heat',
          'i.comments',
        ])
        .where('a.current', '=', true)
        .where('a.gate', '=', 'watching');
    const decide = async (row: Row, heat: number | null) => {
      const profile = await getProfile(String(row.ownerId));
      const locale = localeFor(
        profile.locale,
        `${profile.interests}${text(row.title)}`,
      );
      const outcome = settleWatch(
        {
          heldVerdict: (row.heldVerdict as Verdict | null) ?? null,
          uncertainty: (row.uncertainty as string | null) ?? null,
        },
        heat,
        locale,
      );
      await database
        .query()
        .updateTable('feedAnalyses')
        .set({
          ...outcome,
          heldVerdict: outcome.gate ? (row.heldVerdict ?? null) : null,
          watchUntil: null,
        })
        .where('id', '=', Number(row.analysisId))
        .execute();
    };
    let decided = 0;
    // Over the cap: the oldest are decided on what is known.
    const watching = await select()
      .orderBy('a.watchUntil', 'desc')
      .execute<Row>();
    const perOwner = new Map<string, number>();
    for (const row of watching) {
      const owner = String(row.ownerId);
      const seen = (perOwner.get(owner) ?? 0) + 1;
      perOwner.set(owner, seen);
      if (seen <= maxWatching) continue;
      await decide(row, row.heat == null ? null : Number(row.heat));
      decided += 1;
    }
    const due = await select()
      .where('a.watchUntil', '<=', now)
      .orderBy('a.watchUntil', 'asc')
      .limit(limit)
      .execute<Row>();
    const deadline = Date.now() + WATCH_BUDGET_MS;
    let collectorReads = 0;
    let collectorStopped = false;
    for (const row of due) {
      if (Date.now() >= deadline) break;
      const platform = String(row.platform);
      const known = json<Record<string, number> | null>(row.metrics, null);
      let metrics: Record<string, number> | null = null;
      let tried = false;
      try {
        if ((REFRESHABLE_PLATFORMS as readonly string[]).includes(platform)) {
          tried = true;
          metrics = await adapters.metrics(
            platform,
            String(row.externalId),
            AbortSignal.timeout(15_000),
          );
        } else if (
          WATCH_COLLECTOR_PLATFORMS.includes(platform) &&
          adapters.collectorConfigured() &&
          !collectorStopped &&
          collectorReads < WATCH_COLLECTOR_PER_TICK
        ) {
          tried = true;
          collectorReads += 1;
          const result = await adapters.enrich({
            platform,
            externalId: String(row.externalId),
            url: (row.url as string | null) ?? null,
            want: ['comments'],
            signal: AbortSignal.timeout(MAX_RUN_MS),
          });
          if (PREFETCH_STOPS.has(result.status)) collectorStopped = true;
          if (result.status === 'ok' || result.status === 'partial')
            metrics = countsAfterRead(platform, known, result);
        }
      } catch (error) {
        deps.log('warn', 'feed watch refresh failed', {
          itemId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const overdue =
        now.getTime() - new Date(row.watchUntil as Date).getTime() >=
        WATCH_GRACE_MS;
      // Could have been read but was not (failed, or the Collector's share of this tick is used up): try again on a
      // later tick, unless it has waited long enough.
      const later =
        !tried &&
        WATCH_COLLECTOR_PLATFORMS.includes(platform) &&
        adapters.collectorConfigured();
      if (!overdue && ((tried && !metrics) || later)) continue;
      let heat = row.heat == null ? null : Number(row.heat);
      if (metrics) {
        heat = heatOf(platform, metrics);
        await repo('feedItems').updateOne({
          filter: { id: Number(row.id) },
          values: { metrics, heat, metricsCheckedAt: now },
        } as never);
      }
      await decide(row, heat);
      decided += 1;
    }
    return decided;
  }

  /**
   * Replaces a missing or approximate publication time with the exact one the Collector reads from the item's page, and
   * moves the item to that time in the feed. Every owner's copy of a video is updated by one lookup. A lookup that
   * found nothing is not repeated for a day; one the Collector could not make (sign-in, rate limit, no Collector) is
   * tried again on the next tick. When the page gives only the day (YouTube asking its viewer to sign in), the time
   * stays approximate, set to that day unless the stored one already agrees, and is looked up again a day later.
   * Returns how many videos got an exact time.
   */
  async function resolvePublishedTimes({
    limit = PUBLISHED_PER_TICK,
    now = new Date(),
  }: { limit?: number; now?: Date } = {}): Promise<number> {
    if (!adapters.collectorConfigured()) return 0;
    const rows = await database
      .query()
      .selectFrom('feedItems')
      .select(['id', 'platform', 'externalId', 'url', 'publishedAt'])
      .where('platform', 'in', PUBLISHED_PLATFORMS)
      .where((eb) =>
        eb.or([
          eb('publishedAt', 'is', null),
          eb('publishedApproximate', '=', true),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb('publishedCheckedAt', 'is', null),
          eb(
            'publishedCheckedAt',
            '<',
            new Date(now.getTime() - PUBLISHED_RECHECK_MS),
          ),
        ]),
      )
      .where('createdAt', '>=', new Date(now.getTime() - PUBLISHED_WINDOW_MS))
      .orderBy('id', 'desc')
      .limit(limit * 5)
      .execute<Row>();
    const deadline = Date.now() + PUBLISHED_BUDGET_MS;
    const seen = new Set<string>();
    let asked = 0;
    let resolved = 0;
    for (const row of rows) {
      if (asked >= limit || Date.now() >= deadline) break;
      const platform = String(row.platform);
      const externalId = String(row.externalId);
      if (seen.has(`${platform}:${externalId}`)) continue;
      seen.add(`${platform}:${externalId}`);
      asked += 1;
      let result: EnrichResult;
      try {
        result = await adapters.enrich({
          platform,
          externalId,
          url: (row.url as string | null) ?? null,
          want: ['published'],
          signal: AbortSignal.timeout(MAX_RUN_MS),
        });
      } catch (error) {
        deps.log('warn', 'feed published time lookup failed', {
          itemId: Number(row.id),
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      // Nothing about the item: leave it to be tried again on the next tick, and spare the platform until then.
      if (PREFETCH_STOPS.has(result.status)) break;
      const ok = result.status === 'ok' || result.status === 'partial';
      const published =
        ok && result.publishedAt ? new Date(result.publishedAt) : null;
      const usable =
        published && Number.isFinite(published.getTime()) ? published : null;
      const exact = usable && !result.publishedAtApproximate ? usable : null;
      // Only the day (the page asked its viewer to sign in): better than "3 weeks ago", but a relative time from the
      // last day or so ("5 hours ago") is closer, so it is kept when the two agree.
      const stored = row.publishedAt
        ? new Date(row.publishedAt as string | Date)
        : null;
      const day =
        usable &&
        !exact &&
        (!stored ||
          !Number.isFinite(stored.getTime()) ||
          Math.abs(stored.getTime() - usable.getTime()) > DAY_TIME_SLACK_MS)
          ? usable
          : null;
      await database
        .query()
        .updateTable('feedItems')
        .set(
          exact
            ? {
                publishedAt: exact,
                publishedApproximate: false,
                timelineAt: exact,
                publishedCheckedAt: now,
              }
            : day
              ? {
                  publishedAt: day,
                  publishedApproximate: true,
                  timelineAt: day,
                  publishedCheckedAt: now,
                }
              : { publishedCheckedAt: now },
        )
        .where('platform', '=', platform)
        .where('externalId', '=', externalId)
        .where((eb) =>
          eb.or([
            eb('publishedAt', 'is', null),
            eb('publishedApproximate', '=', true),
          ]),
        )
        .execute();
      if (exact) resolved += 1;
    }
    return resolved;
  }

  function enrichableFor(
    platform: string,
    operation: string | null,
  ): ('body' | 'comments' | 'transcript')[] {
    const spec = CATALOG.find((entry) => entry.platform === platform);
    const op =
      spec?.operations.find((entry) => entry.operation === operation) ??
      spec?.operations[0];
    const parts = [...(op?.enrich ?? [])];
    // Transcript and login-bound text only come from the Collector.
    return parts.filter(
      (part) =>
        adapters.collectorConfigured() ||
        (part === 'comments' && ['hn', 'reddit'].includes(platform)),
    );
  }

  // Items

  // Briefs and translations

  /**
   * The model a brief or translation uses: the same default chat model as the analysis. Scheduled briefs count against
   * `dailyLimit` on their own (briefs written today); what the person asks for on one item does not.
   */
  async function briefModel(
    ownerId: string,
    profile: Profile,
    counted: boolean,
  ): Promise<{ modelService: string; model: string } | null> {
    const agents = deps.agents();
    if (!agents) return null;
    let ref: { modelService: string; model: string } | null;
    try {
      ref = (await agents.models.gateway.catalog('chat')).defaultModel ?? null;
    } catch {
      ref = null;
    }
    if (!ref || !counted) return ref;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [usage] = await database
      .query()
      .selectFrom('feedBriefs')
      .select((eb) => [eb.fn.count('id').as('used')])
      .where('ownerId', '=', ownerId)
      .where('updatedAt', '>=', startOfDay)
      .execute();
    return Number((usage as Row | undefined)?.used ?? 0) >= profile.dailyLimit
      ? null
      : ref;
  }

  async function saveBrief(
    ownerId: string,
    row: Row,
    language: ReadingLanguage,
    values: Row,
  ): Promise<void> {
    const now = new Date();
    await repo('feedBriefs').upsertOne({
      filter: { ownerId, itemId: Number(row.id), language },
      create: {
        ownerId,
        itemId: Number(row.id),
        language,
        createdAt: now,
        updatedAt: now,
        ...values,
      },
      update: { ...values, updatedAt: now },
    } as never);
  }

  /** Writes the item's brief in the reading language. Answers false, having changed nothing, when no model could. */
  async function writeBrief(
    ownerId: string,
    row: Row,
    profile: Profile,
    counted: boolean,
  ): Promise<boolean> {
    const ref = await briefModel(ownerId, profile, counted);
    if (!ref) return false;
    const language = readingLanguageOf(profile.readingLanguage, profile.locale);
    const item = toAnalysisItem(row);
    const { system, prompt } = buildBriefPrompt(item, language);
    const ask = async () =>
      (
        await deps.agents()!.models.gateway.generate({
          model: ref,
          system,
          prompt,
          maxOutputTokens: BRIEF_TOKENS,
          source: 'nocofeed.brief',
          signal: AbortSignal.timeout(90_000),
        })
      ).text;
    try {
      let draft;
      try {
        draft = parseBriefAnswer(await ask(), item, language);
      } catch {
        // A cut-off or malformed answer is common enough that one more try is cheaper than no brief.
        draft = parseBriefAnswer(await ask(), item, language);
      }
      await saveBrief(ownerId, row, language, {
        contentVersion: Number(row.contentVersion ?? 1),
        sourceLanguage: draft.sourceLanguage,
        title: draft.title,
        brief: draft.brief,
        model: `${ref.modelService}/${ref.model}`,
      });
      return true;
    } catch (error) {
      deps.log('warn', 'feed brief failed', {
        itemId: Number(row.id),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Writes (or rewrites) one item's brief because the person asked; does not count against the daily limit. */
  async function briefItem(
    ownerId: string,
    id: number,
  ): Promise<FeedItemDetail> {
    const row = await requireRow('feedItems', ownerId, id);
    const profile = await getProfile(ownerId);
    if (!(await writeBrief(ownerId, row, profile, false)))
      throw new FeedError('unavailable', 'briefFailed');
    return getItem(ownerId, id);
  }

  /** Translates the item's full text into the reading language, because the person asked. */
  async function translateItem(
    ownerId: string,
    id: number,
  ): Promise<FeedItemDetail> {
    const row = await requireRow('feedItems', ownerId, id);
    const profile = await getProfile(ownerId);
    const language = readingLanguageOf(profile.readingLanguage, profile.locale);
    if (language === 'original')
      throw new FeedError('invalid', 'noReadingLanguage');
    const item = toAnalysisItem(row);
    if (!translatableText(item))
      throw new FeedError('invalid', 'nothingToTranslate');
    const ref = await briefModel(ownerId, profile, false);
    if (!ref) throw new FeedError('unavailable', 'noModel');
    // A translation lives beside a brief; write the brief first when there is none in this language yet.
    const existing = (await repo('feedBriefs').findOne({
      filter: { ownerId, itemId: id, language },
    })) as Row | null;
    if (!existing && !(await writeBrief(ownerId, row, profile, false)))
      throw new FeedError('unavailable', 'briefFailed');
    const { system, prompt } = buildTranslationPrompt(item, language);
    let text: string;
    try {
      text = (
        await deps.agents()!.models.gateway.generate({
          model: ref,
          system,
          prompt,
          maxOutputTokens: TRANSLATION_TOKENS,
          source: 'nocofeed.translation',
          signal: AbortSignal.timeout(180_000),
        })
      ).text;
    } catch (error) {
      deps.log('warn', 'feed translation failed', {
        itemId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new FeedError('unavailable', 'translationFailed');
    }
    const body = cleanMarkdown(text, 0);
    if (!body) throw new FeedError('unavailable', 'translationFailed');
    await repo('feedBriefs').updateOne({
      filter: { ownerId, itemId: id, language },
      values: {
        body,
        bodyVersion: Number(row.contentVersion ?? 1),
        updatedAt: new Date(),
      },
    } as never);
    return getItem(ownerId, id);
  }

  /**
   * Writes briefs for recently collected items the feed shows, best first, a few per tick: those without one in the
   * person's reading language, or with one written from an earlier version. A bare title waiting for its text waits
   * here too. Stops for a person when the model is missing or their daily limit is reached.
   */
  async function briefPending({
    limit = BRIEF_PER_TICK,
    now = new Date(),
  }: { limit?: number; now?: Date } = {}): Promise<number> {
    let written = 0;
    for (const ownerId of await itemOwners()) {
      if (written >= limit) break;
      const profile = await getProfile(ownerId);
      const language = readingLanguageOf(
        profile.readingLanguage,
        profile.locale,
      );
      const rows = await database
        .query()
        .selectFrom('feedItems as i')
        .innerJoin('feedAnalyses as a', (join) =>
          join.onRef('a.itemId', '=', 'i.id').on('a.current', '=', true),
        )
        .leftJoin('feedBriefs as b', (join) =>
          join
            .onRef('b.itemId', '=', 'i.id')
            .on('b.ownerId', '=', ownerId)
            .on('b.language', '=', language),
        )
        .leftJoin('feedItemStates as s', (join) =>
          join.onRef('s.itemId', '=', 'i.id').on('s.ownerId', '=', ownerId),
        )
        .selectAll('i')
        .where('i.ownerId', '=', ownerId)
        .where('a.verdict', 'in', ['discuss', 'learn'])
        .where((eb) =>
          eb.or([
            eb('a.gate', 'is', null),
            eb('a.gate', '!=', 'awaitingMaterial'),
          ]),
        )
        .where((eb) =>
          eb.or([eb('s.dismissed', 'is', null), eb('s.dismissed', '=', false)]),
        )
        .where('i.createdAt', '>=', new Date(now.getTime() - BRIEF_WINDOW_MS))
        .where((eb) =>
          eb.or([
            eb('b.id', 'is', null),
            eb('b.contentVersion', '<', eb.ref('i.contentVersion')),
          ]),
        )
        .orderBy('a.priority', 'desc')
        .orderBy('i.id', 'desc')
        .limit(limit - written)
        .execute<Row>();
      for (const row of rows) {
        if (!(await writeBrief(ownerId, row, profile, true))) break;
        written += 1;
      }
    }
    return written;
  }

  async function getItem(ownerId: string, id: number): Promise<FeedItemDetail> {
    const row = await requireRow('feedItems', ownerId, id);
    const profile = await getProfile(ownerId);
    const readingLanguage = readingLanguageOf(
      profile.readingLanguage,
      profile.locale,
    );
    const [analysisRow, stateRow, source, agentReading, briefRow] =
      await Promise.all([
        repo('feedAnalyses').findOne({
          filter: { itemId: id, current: true },
        }) as Promise<Row | null>,
        repo('feedItemStates').findOne({
          filter: { ownerId, itemId: id },
        }) as Promise<Row | null>,
        row.sourceId == null
          ? Promise.resolve(null)
          : (repo('feedSources').findOne({
              filter: { ownerId, id: Number(row.sourceId) },
            }) as Promise<Row | null>),
        readingAgent(ownerId, id),
        repo('feedBriefs').findOne({
          filter: { ownerId, itemId: id, language: readingLanguage },
        }) as Promise<Row | null>,
      ]);
    const analysis = analysisRow ? toAnalysis(analysisRow) : null;
    const state = toState(stateRow);
    return {
      ...toListItem(row, analysisRow, stateRow),
      readingLanguage,
      brief: toItemBrief(row, briefRow),
      externalId: String(row.externalId),
      author: (row.author as string | null) ?? null,
      body: (row.body as string | null) ?? null,
      comments: json<CommentEntry[]>(row.comments, []),
      transcript: json<TranscriptSegment[]>(row.transcript, []),
      media: json<MediaEntry[]>(row.media, []),
      metrics: json<Record<string, number>>(row.metrics, {}),
      coverage: json<ItemCoverage>(row.coverage, DEFAULT_COVERAGE),
      contentVersion: Number(row.contentVersion ?? 1),
      fetchedAt: iso(row.fetchedAt) ?? '',
      analysis,
      analysisStale: Boolean(
        analysis && analysis.contentVersion < Number(row.contentVersion ?? 1),
      ),
      state,
      enrichable: enrichableFor(
        String(row.platform),
        source ? String(source.operation) : null,
      ),
      agentReading,
    };
  }

  const toAnalysis = (row: Row): Analysis => ({
    id: Number(row.id),
    topicId: row.topicId == null ? null : Number(row.topicId),
    verdict: row.verdict as Analysis['verdict'],
    score: Number(row.score ?? 0),
    quality: row.quality == null ? null : Number(row.quality),
    qualityDetail: json<QualityDetail | null>(row.qualityDetail, null),
    gate: (row.gate as AnalysisGate | null) ?? null,
    interestLevel: String(row.interestLevel),
    interestReason: (row.interestReason as string | null) ?? null,
    experienceLevel: String(row.experienceLevel),
    experienceReason: (row.experienceReason as string | null) ?? null,
    lead: (row.lead as string | null) ?? null,
    steps: json<Analysis['steps']>(row.steps, []),
    evidence: (row.evidence as string | null) ?? null,
    uncertainty: (row.uncertainty as string | null) ?? null,
    engine: row.engine as Analysis['engine'],
    model: (row.model as string | null) ?? null,
    contentVersion: Number(row.contentVersion ?? 1),
    createdAt: iso(row.createdAt) ?? '',
  });

  const toState = (row: Row | null): ItemState => ({
    favorite: bool(row?.favorite),
    later: bool(row?.later),
    participated: bool(row?.participated),
    feedback: (row?.feedback as ItemState['feedback']) ?? null,
    notes: (row?.notes as string | null) ?? null,
    participationUrl: (row?.participationUrl as string | null) ?? null,
    participationNote: (row?.participationNote as string | null) ?? null,
    dismissed: bool(row?.dismissed),
    read: row?.readAt != null,
    followUp:
      row?.followUpSince == null
        ? null
        : {
            replies:
              row.followUpReplies == null ? null : Number(row.followUpReplies),
            newReplies: Number(row.followUpNew ?? 0),
            checkedAt: iso(row.followUpCheckedAt),
            nextCheckAt: iso(row.followUpAt),
          },
  });

  /** The opening of the post's own words, for the card: the body, else a summary that says more than the title. */
  const excerptOf = (row: Row): string | null => {
    const body = typeof row.body === 'string' ? row.body.trim() : '';
    const summary = typeof row.summary === 'string' ? row.summary.trim() : '';
    const text =
      body || (summary && summary !== String(row.title).trim() ? summary : '');
    return text ? truncate(text, EXCERPT_LENGTH) : null;
  };

  const toListBrief = (row: Row, brief: Row | null): ListBrief | null =>
    brief
      ? {
          language: brief.language as ReadingLanguage,
          title: (brief.title as string | null) ?? null,
          gist: gistOf(text(brief.brief)),
          stale:
            Number(brief.contentVersion ?? 1) < Number(row.contentVersion ?? 1),
        }
      : null;

  const toItemBrief = (row: Row, brief: Row | null): ItemBrief | null => {
    const list = toListBrief(row, brief);
    if (!list || !brief) return null;
    return {
      ...list,
      sourceLanguage: (brief.sourceLanguage as string | null) ?? null,
      brief: text(brief.brief),
      body: (brief.body as string | null) ?? null,
      bodyStale:
        brief.body != null &&
        Number(brief.bodyVersion ?? 0) < Number(row.contentVersion ?? 1),
      model: (brief.model as string | null) ?? null,
      createdAt: iso(brief.updatedAt ?? brief.createdAt) ?? '',
    };
  };

  const toListItem = (
    row: Row,
    analysis: Row | null,
    state: Row | null,
    brief: Row | null = null,
  ): FeedListItem => ({
    id: Number(row.id),
    platform: row.platform as Platform,
    sourceLabel: (row.sourceLabel as string | null) ?? null,
    title: String(row.title),
    summary: (row.summary as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    publishedAt: iso(row.publishedAt),
    publishedApproximate: Boolean(row.publishedAt && row.publishedApproximate),
    createdAt: iso(row.createdAt) ?? '',
    verdict: (analysis?.verdict as FeedListItem['verdict']) ?? null,
    score: Number(analysis?.score ?? 0),
    quality: analysis?.quality == null ? null : Number(analysis.quality),
    heat: row.heat == null ? null : Number(row.heat),
    noise:
      json<QualityDetail | null>(analysis?.qualityDetail, null)?.noise ??
      'none',
    gate: (analysis?.gate as AnalysisGate | null) ?? null,
    topicId: analysis?.topicId == null ? null : Number(analysis.topicId),
    lead: (analysis?.lead as string | null) ?? null,
    excerpt: excerptOf(row),
    cover: coverOf(json<MediaEntry[] | null>(row.media, null)),
    video: json<MediaEntry[] | null>(row.media, null)?.[0]?.type === 'video',
    favorite: bool(state?.favorite),
    later: bool(state?.later),
    participated: bool(state?.participated),
    read: state?.readAt != null,
    newReplies: Number(state?.followUpNew ?? 0),
    brief: toListBrief(row, brief),
  });

  /**
   * The items one view shows under the given filters, without a selection. The list and its counts share it, so a
   * count is always the number of items the same filters list.
   */
  function feedQuery(
    ownerId: string,
    query: {
      /** Omitted: every item the filters match, whatever its verdict or state. */
      view?: FeedView;
      platform?: string;
      topicId?: number;
      q?: string;
      since?: Date;
      period?: FeedPeriod;
      /** Only items the person has not read. */
      unread?: boolean;
    },
  ) {
    let builder = database
      .query()
      .selectFrom('feedItems as i')
      .leftJoin('feedAnalyses as a', (join) =>
        join.onRef('a.itemId', '=', 'i.id').on('a.current', '=', true),
      )
      .leftJoin('feedItemStates as s', (join) =>
        join.onRef('s.itemId', '=', 'i.id').on('s.ownerId', '=', ownerId),
      )
      .where('i.ownerId', '=', ownerId);

    switch (query.view) {
      case 'discuss':
      case 'learn':
        builder = builder.where('a.verdict', '=', query.view);
        break;
      case 'saved':
        builder = builder.where('s.favorite', '=', true);
        break;
      case 'later':
        builder = builder.where('s.later', '=', true);
        break;
      case 'participated':
        builder = builder.where('s.participated', '=', true);
        break;
      case 'all':
        builder = builder.where('a.verdict', 'in', ['discuss', 'learn']);
        break;
      case 'filtered':
        builder = builder.where('a.verdict', '=', 'ignore');
        break;
      // Attention alone recommends nothing: a hot item still has to concern the person and be worth something.
      case 'hot':
        builder = builder
          .where('a.verdict', 'in', ['discuss', 'learn'])
          .where('i.heat', '>=', HOT_HEAT)
          .where('i.timelineAt', '>=', new Date(Date.now() - HEAT_WINDOW_MS));
        break;
      case 'solid':
        builder = builder
          .where('a.verdict', 'in', ['discuss', 'learn'])
          .where('a.quality', '>=', SOLID_QUALITY);
        break;
      default:
        break;
    }
    // Dismissed items leave the feed; what the person kept on purpose stays in its own view.
    if (
      query.view &&
      ['all', 'hot', 'solid', 'discuss', 'learn', 'filtered'].includes(
        query.view,
      )
    )
      builder = builder.where((eb) =>
        eb.or([eb('s.dismissed', 'is', null), eb('s.dismissed', '=', false)]),
      );
    // No state row, or one without `readAt`: the person has not read it.
    if (query.unread) builder = builder.where('s.readAt', 'is', null);
    if (query.since) builder = builder.where('i.createdAt', '>=', query.since);
    // When it was published; when that is unknown, when it was collected.
    if (query.period)
      builder = builder.where(
        'i.timelineAt',
        '>=',
        new Date(Date.now() - PERIOD_DAYS[query.period] * DAY_MS),
      );
    if (query.platform)
      builder = builder.where('i.platform', '=', query.platform);
    if (query.topicId) builder = builder.where('a.topicId', '=', query.topicId);
    if (query.q?.trim()) {
      const pattern = `%${query.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      builder = builder.where((eb) =>
        eb.or([
          eb('i.title', 'like', pattern),
          eb('i.summary', 'like', pattern),
          eb('i.sourceLabel', 'like', pattern),
        ]),
      );
    }
    return builder;
  }

  /**
   * One page of the feed: items with their current analysis and the person's state, filtered in SQL, sorted by
   * publication time (the default) or by value then recency, paged by offset behind an opaque token. Three queries
   * regardless of the page size.
   */
  async function listItems(
    ownerId: string,
    query: {
      view: FeedView;
      platform?: string;
      topicId?: number;
      q?: string;
      period?: FeedPeriod;
      unread?: boolean;
      sort?: FeedSort;
      pageSize: number;
      pageToken?: string;
      /** Only items collected after this instant. */
      since?: Date;
    },
  ): Promise<{ items: FeedListItem[]; nextPageToken?: string }> {
    const offset = query.pageToken
      ? Math.max(
          0,
          Number(Buffer.from(query.pageToken, 'base64url').toString()) || 0,
        )
      : 0;
    // "Most worth seeing" means what each view is about: attention for `hot`, substance for `solid`, else priority.
    const ordered =
      query.sort !== 'priority'
        ? feedQuery(ownerId, query)
            // Publication time where known, else collection time; the id keeps equal times in a stable order.
            .select(['i.id as id', 'i.timelineAt as timelineAt'])
            .orderBy('i.timelineAt', 'desc')
            .orderBy('i.id', 'desc')
        : query.view === 'hot'
          ? feedQuery(ownerId, query)
              .select(['i.id as id', 'i.heat as heat'])
              .orderBy('i.heat', 'desc')
              .orderBy('a.priority', 'desc')
              .orderBy('i.id', 'desc')
          : query.view === 'solid'
            ? feedQuery(ownerId, query)
                .select(['i.id as id', 'a.quality as quality'])
                .orderBy('a.quality', 'desc')
                .orderBy('a.priority', 'desc')
                .orderBy('i.id', 'desc')
            : feedQuery(ownerId, query)
                .select(['i.id as id', 'a.priority as priority'])
                .orderBy('a.priority', 'desc')
                .orderBy('i.id', 'desc');
    const page = await ordered
      .limit(query.pageSize + 1)
      .offset(offset)
      .execute<Row>();
    const ids = page.slice(0, query.pageSize).map((row) => Number(row.id));
    if (!ids.length) return { items: [] };
    const profile = await getProfile(ownerId);
    const readingLanguage = readingLanguageOf(
      profile.readingLanguage,
      profile.locale,
    );

    const [items, analyses, states, briefs] = (await Promise.all([
      database
        .query()
        .selectFrom('feedItems')
        .select([
          'id',
          'platform',
          'sourceLabel',
          'title',
          'summary',
          'body',
          'media',
          'url',
          'publishedAt',
          'publishedApproximate',
          'createdAt',
          'contentVersion',
          'heat',
        ])
        .where('ownerId', '=', ownerId)
        .where('id', 'in', ids)
        .execute(),
      database
        .query()
        .selectFrom('feedAnalyses')
        .select([
          'itemId',
          'verdict',
          'score',
          'quality',
          'qualityDetail',
          'gate',
          'topicId',
          'lead',
        ])
        .where('ownerId', '=', ownerId)
        .where('itemId', 'in', ids)
        .where('current', '=', true)
        .execute(),
      database
        .query()
        .selectFrom('feedItemStates')
        .selectAll()
        .where('ownerId', '=', ownerId)
        .where('itemId', 'in', ids)
        .execute(),
      database
        .query()
        .selectFrom('feedBriefs')
        .select(['itemId', 'language', 'title', 'brief', 'contentVersion'])
        .where('ownerId', '=', ownerId)
        .where('itemId', 'in', ids)
        .where('language', '=', readingLanguage)
        .execute(),
    ])) as [Row[], Row[], Row[], Row[]];
    const briefBy = new Map(briefs.map((row) => [Number(row.itemId), row]));
    const byId = new Map(items.map((row) => [Number(row.id), row]));
    const analysisBy = new Map(
      analyses.map((row) => [Number(row.itemId), row]),
    );
    const stateBy = new Map(states.map((row) => [Number(row.itemId), row]));
    return {
      items: ids
        .filter((id) => byId.has(id))
        .map((id) =>
          toListItem(
            byId.get(id)!,
            analysisBy.get(id) ?? null,
            stateBy.get(id) ?? null,
            briefBy.get(id) ?? null,
          ),
        ),
      nextPageToken:
        page.length > query.pageSize
          ? Buffer.from(String(offset + query.pageSize)).toString('base64url')
          : undefined,
    };
  }

  /**
   * How many items each view shows under the same platform, topic and search filters as the list, so the rail
   * counts what the person can actually see.
   */
  async function summary(
    ownerId: string,
    filters: {
      platform?: string;
      topicId?: number;
      q?: string;
      period?: FeedPeriod;
      /** Count only unread items, as the list does under "Unread only". */
      unread?: boolean;
    } = {},
  ): Promise<FeedSummary> {
    const count = async (view: FeedView, unread = filters.unread) => {
      const [row] = await feedQuery(ownerId, { ...filters, view, unread })
        .select((eb) => [eb.fn.count('i.id').as('n')])
        .execute();
      return Number((row as Row | undefined)?.n ?? 0);
    };
    const views = [
      'all',
      'hot',
      'solid',
      'discuss',
      'learn',
      'saved',
      'later',
      'participated',
      'filtered',
    ] as const;
    const [counts, unreadCounts, replies, sources] = await Promise.all([
      Promise.all(views.map((view) => count(view))),
      Promise.all(views.map((view) => count(view, true))),
      // A followed thread counts wherever the item sits, as it did before the filters applied.
      feedQuery(ownerId, { ...filters, unread: undefined })
        .select((eb) => [eb.fn.count('i.id').as('n')])
        .where('s.followUpNew', '>', 0)
        .execute(),
      listSources(ownerId),
    ]);
    const [
      all,
      hot,
      solid,
      discuss,
      learn,
      saved,
      later,
      participated,
      filtered,
    ] = counts;
    return {
      all,
      hot,
      solid,
      discuss,
      learn,
      saved,
      later,
      participated,
      filtered,
      unread: Object.fromEntries(
        views.map((view, index) => [view, unreadCounts[index]]),
      ) as FeedSummary['unread'],
      newReplies: Number((replies[0] as Row | undefined)?.n ?? 0),
      unhealthySources: sources.filter(
        (source) => source.active && source.health !== 'ok',
      ).length,
    };
  }

  /**
   * Saves the person's marks. Reads come first, then every write runs in one transaction (`inTransaction`, which the
   * route wraps in an operation receipt), so a retried request never applies feedback twice. Feedback moves the word
   * weights inside that transaction; re-scoring the recent analyses is slow (hundreds of rows) and runs afterwards in a
   * background job, so the request stays fast.
   */
  async function updateState(
    ownerId: string,
    itemId: number,
    input: Partial<
      Omit<ItemState, 'followUp'> & {
        /** The person has seen the new replies to their post. */
        followUpSeen: boolean;
      }
    >,
    inTransaction: StateWriter = (write) => database.transaction(write),
  ): Promise<StateChange> {
    const item = await requireRow('feedItems', ownerId, itemId);
    const before = (await repo('feedItemStates').findOne({
      filter: { ownerId, itemId },
    })) as Row | null;
    const values: Row = { updatedAt: new Date() };
    for (const key of [
      'favorite',
      'later',
      'participated',
      'feedback',
      'notes',
      'participationUrl',
      'participationNote',
      'dismissed',
    ] as const) {
      if (input[key] !== undefined) values[key] = input[key];
    }
    // Reading again keeps when it was first read; marking unread forgets it.
    if (input.read !== undefined)
      values.readAt = input.read ? (before?.readAt ?? new Date()) : null;
    if (input.participationUrl !== undefined) {
      const url = input.participationUrl?.trim() || null;
      values.participationUrl = url;
      if (url !== (before?.participationUrl ?? null)) {
        // A new link starts following from scratch; the first check records the baseline without notifying.
        const follow = followableUrl(url);
        Object.assign(values, {
          followUpSince: follow ? new Date() : null,
          followUpAt: follow ? new Date() : null,
          followUpBaseline: null,
          followUpReplies: null,
          followUpNew: 0,
          followUpCheckedAt: null,
        });
      }
    }
    if (input.followUpSeen) {
      values.followUpNew = 0;
      values.followUpBaseline = before?.followUpReplies ?? null;
    }
    const learning =
      input.feedback === undefined
        ? undefined
        : await planFeedback(
            ownerId,
            item,
            (before?.feedback as ItemState['feedback']) ?? null,
            input.feedback,
          );

    const change = await inTransaction<StateChange>(async (connection) => {
      await connection.repository('feedItemStates').upsertOne({
        filter: { ownerId, itemId },
        create: { ownerId, itemId, ...values },
        update: values,
      } as never);
      if (learning) await learning.save(connection);
      const state = toState(
        (await connection.repository('feedItemStates').findOne({
          filter: { ownerId, itemId },
        })) as Row | null,
      );
      return learning ? { ...state, adjustment: learning.adjustment } : state;
    });
    // After the commit, so the job reads the new weights. A replayed request schedules it again, which is harmless.
    if (change.adjustment)
      await scheduleRescore(ownerId, change.adjustment.terms);
    return change;
  }

  /**
   * Marks every unread item one view lists under the given filters as read, the same items `listItems` would show
   * (`feedQuery`), so "Mark all as read" never reaches past what the person sees. Answers how many changed.
   */
  async function markAllRead(
    ownerId: string,
    filters: {
      view: FeedView;
      platform?: string;
      topicId?: number;
      q?: string;
      period?: FeedPeriod;
    },
  ): Promise<number> {
    const rows = await feedQuery(ownerId, { ...filters, unread: true })
      .select(['i.id as id', 's.id as stateId'])
      .execute<Row>();
    if (!rows.length) return 0;
    const now = new Date();
    const existing = rows
      .filter((row) => row.stateId != null)
      .map((row) => Number(row.stateId));
    const missing = rows
      .filter((row) => row.stateId == null)
      .map((row) => Number(row.id));
    for (let start = 0; start < existing.length; start += READ_BATCH) {
      await database
        .query()
        .updateTable('feedItemStates')
        .set({ readAt: now, updatedAt: now })
        .where('ownerId', '=', ownerId)
        .where('id', 'in', existing.slice(start, start + READ_BATCH))
        .execute();
    }
    for (let start = 0; start < missing.length; start += READ_BATCH) {
      await database
        .query()
        .insertInto('feedItemStates')
        .values(
          missing.slice(start, start + READ_BATCH).map((itemId) => ({
            ownerId,
            itemId,
            favorite: false,
            later: false,
            participated: false,
            dismissed: false,
            followUpNew: 0,
            readAt: now,
            updatedAt: now,
          })),
        )
        .execute();
    }
    return rows.length;
  }

  /**
   * Feedback moves the weight of the words that made the item match: "useful" up by one, "not relevant" down by one,
   * within bounds. Changing or withdrawing feedback undoes the earlier step, so clicking back and forth never drifts.
   * Answers the new weights to save with the state; the recent rule-based analyses are scored again afterwards
   * (`scheduleRescore`), model analyses pick the weights up next time.
   */
  async function planFeedback(
    ownerId: string,
    item: Row,
    previous: ItemState['feedback'],
    next: ItemState['feedback'],
  ): Promise<
    | {
        adjustment: NonNullable<StateChange['adjustment']>;
        save: (connection: Connection) => Promise<void>;
      }
    | undefined
  > {
    const value = (feedback: ItemState['feedback']) =>
      feedback === 'helpful' ? 1 : feedback === 'irrelevant' ? -1 : 0;
    const delta = value(next) - value(previous);
    if (!delta) return undefined;
    const [profile, topics] = await Promise.all([
      getProfile(ownerId),
      topicsFor(ownerId, item.sourceId == null ? null : Number(item.sourceId)),
    ]);
    // Matched without the learned weights, so the words are the same ones the person judged.
    const { hits } = matchTopics(toAnalysisItem(item), topics, {
      ...profile,
      termWeights: {},
    });
    if (!hits.length) return undefined;
    const weights = { ...profile.termWeights };
    for (const term of hits) {
      const weight = Math.min(
        TERM_WEIGHT_MAX,
        Math.max(TERM_WEIGHT_MIN, (weights[term] ?? 0) + delta),
      );
      if (weight) weights[term] = weight;
      else delete weights[term];
    }
    return {
      adjustment: {
        direction: delta > 0 ? 'up' : 'down',
        terms: hits,
        rescoring: true,
      },
      save: async (connection) => {
        await connection.repository('feedProfiles').upsertOne({
          filter: { ownerId },
          create: {
            ownerId,
            dailyLimit: profile.dailyLimit,
            keepLearning: profile.keepLearning,
            termWeights: weights,
            updatedAt: new Date(),
          },
          update: { termWeights: weights, updatedAt: new Date() },
        } as never);
      },
    };
  }

  /** Hands the re-score to the background job; when it cannot be queued, runs it detached here. Never waits for it. */
  async function scheduleRescore(
    ownerId: string,
    terms: string[],
  ): Promise<void> {
    if (deps.deferRescore) {
      try {
        await deps.deferRescore({ ownerId, terms });
        return;
      } catch (error) {
        deps.log('warn', 'could not queue the re-score; running it here', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    void rescoreTerms(ownerId, terms).catch((error: unknown) =>
      deps.log('warn', 're-score after feedback failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /**
   * One person's re-scores run one after another: each replaces the current analyses it changes, so two at once could
   * leave an item with two current analyses. Each reads the weights when it starts, so the last one leaves the scores
   * of the latest weights.
   */
  const rescoreQueues = new Map<string, Promise<unknown>>();
  function rescoreTerms(ownerId: string, terms: string[]): Promise<number> {
    const previous = rescoreQueues.get(ownerId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => rescoreWithRules(ownerId, terms));
    const tail = run.catch(() => undefined);
    rescoreQueues.set(ownerId, tail);
    void tail.then(() => {
      if (rescoreQueues.get(ownerId) === tail) rescoreQueues.delete(ownerId);
    });
    return run;
  }

  /** Scores the recent rule-based analyses that mention any of `terms` again; never spends model budget. */
  async function rescoreWithRules(
    ownerId: string,
    terms: string[],
  ): Promise<number> {
    const rows = await database
      .query()
      .selectFrom('feedItems as i')
      .innerJoin('feedAnalyses as a', (join) =>
        join.onRef('a.itemId', '=', 'i.id').on('a.current', '=', true),
      )
      .selectAll('i')
      .select([
        'a.score as currentScore',
        'a.verdict as currentVerdict',
        'a.gate as currentGate',
      ])
      .where('i.ownerId', '=', ownerId)
      .where('a.engine', '=', 'rules')
      .orderBy('i.id', 'desc')
      .limit(RESCORE_LIMIT)
      .execute<Row>();
    const profile = await getProfile(ownerId);
    const topicCache = new Map<string, AnalysisTopic[]>();
    let count = 0;
    for (const row of rows) {
      // SQLite answers synchronously, so without a pause this loop never lets a waiting request in: a person who keeps
      // clicking would wait for all of it. One macrotask per item lets requests go first.
      await yieldToRequests();
      const analysisItem = toAnalysisItem(row);
      const haystack =
        `${analysisItem.title} ${analysisItem.summary ?? ''} ${analysisItem.body ?? ''}`.toLowerCase();
      if (!terms.some((term) => haystack.includes(term))) continue;
      const key = text(row.sourceId);
      let topics = topicCache.get(key);
      if (!topics) {
        topics = await topicsFor(
          ownerId,
          row.sourceId == null ? null : Number(row.sourceId),
        );
        topicCache.set(key, topics);
      }
      const locale = localeFor(
        profile.locale,
        `${profile.interests}${text(row.title)}`,
      );
      const rescored = analyzeWithRules(analysisItem, topics, profile, locale);
      // Still waiting: enriching it must still find it waiting.
      const draft =
        row.currentGate === 'awaitingMaterial'
          ? awaitingMaterial(rescored, profile, locale)
          : rescored;
      if (
        draft.score === Number(row.currentScore) &&
        draft.verdict === row.currentVerdict
      )
        continue;
      await writeAnalysis(ownerId, row, draft);
      count += 1;
    }
    return count;
  }

  /**
   * Applies the current worth rules to analyses already stored: quality is recomputed from the model's axes (so a
   * changed noise cap counts), priority follows, and what now falls below `LOW_QUALITY` is hidden. Only hides, never
   * shows: a model may have ignored an item for its relevance. Spends no model budget; `dryRun` changes nothing.
   */
  async function reapplyWorth(
    options: { dryRun?: boolean } = {},
  ): Promise<{ checked: number; requalified: number; hidden: string[] }> {
    const rows = await database
      .query()
      .selectFrom('feedAnalyses as a')
      .innerJoin('feedItems as i', 'i.id', 'a.itemId')
      .select([
        'a.id',
        'a.verdict',
        'a.score',
        'a.quality',
        'a.qualityDetail',
        'a.priority',
        'i.title',
      ])
      .where('a.current', '=', true)
      .where('a.engine', '=', 'model')
      .where('a.qualityDetail', 'is not', null)
      .execute<Row>();
    let requalified = 0;
    const hidden: string[] = [];
    for (const row of rows) {
      const detail = json<QualityDetail | null>(row.qualityDetail, null);
      if (!detail) continue;
      const quality = qualityOf(detail);
      const priority = priorityOf(Number(row.score), quality);
      const verdict =
        quality < LOW_QUALITY ? 'ignore' : (text(row.verdict) as Verdict);
      if (
        quality === Number(row.quality) &&
        priority === Number(row.priority) &&
        verdict === row.verdict
      )
        continue;
      requalified += 1;
      if (verdict !== row.verdict) hidden.push(text(row.title));
      if (options.dryRun) continue;
      await database
        .query()
        .updateTable('feedAnalyses')
        .set({ quality, priority, verdict })
        .where('id', '=', Number(row.id))
        .execute();
    }
    return { checked: rows.length, requalified, hidden };
  }

  /**
   * Applies the admission rules (`admission.ts`) to search results already in the feed: a thin one nobody noticed is
   * left out (`thin`, `reply`), or watched when still new. Only hides, and never what the person kept (favourite,
   * later, participated, notes) or dismissed; an item the person reads later comes back the moment it turns hot.
   * Calls no model; `dryRun` changes nothing.
   */
  async function reapplyAdmission(
    options: { dryRun?: boolean; now?: Date } = {},
  ): Promise<{ checked: number; hidden: string[]; watching: string[] }> {
    const now = options.now ?? new Date();
    const rows = await database
      .query()
      .selectFrom('feedAnalyses as a')
      .innerJoin('feedItems as i', 'i.id', 'a.itemId')
      .innerJoin('feedSources as src', 'src.id', 'i.sourceId')
      .selectAll('i')
      .select([
        'a.id as analysisId',
        'a.verdict as currentVerdict',
        'a.quality as currentQuality',
        'a.qualityDetail as currentQualityDetail',
        'a.uncertainty as currentUncertainty',
      ])
      .where('a.current', '=', true)
      .where('a.verdict', 'in', ['discuss', 'learn'])
      .where('a.gate', 'is', null)
      .where('src.topicId', 'is not', null)
      .execute<Row>();
    const hidden: string[] = [];
    const watching: string[] = [];
    for (const row of rows) {
      await yieldToRequests();
      const ownerId = String(row.ownerId);
      const context = await admissionContext(ownerId, row, { now });
      const state = (await repo('feedItemStates').findOne({
        filter: { ownerId, itemId: Number(row.id) },
      })) as Row | null;
      if (state && bool(state.dismissed)) continue;
      const draft = admit(
        toAnalysisItem(row),
        {
          verdict: row.currentVerdict as Verdict,
          quality:
            row.currentQuality == null ? null : Number(row.currentQuality),
          qualityDetail: json<QualityDetail | null>(
            row.currentQualityDetail,
            null,
          ),
          gate: null,
          uncertainty: text(row.currentUncertainty),
        } as AnalysisDraft,
        context,
      );
      if (draft.verdict !== 'ignore') continue;
      (draft.gate === 'watching' ? watching : hidden).push(text(row.title));
      if (options.dryRun) continue;
      await database
        .query()
        .updateTable('feedAnalyses')
        .set({
          verdict: 'ignore',
          gate: draft.gate,
          heldVerdict: draft.heldVerdict ?? null,
          watchUntil: draft.watchUntil ?? null,
          uncertainty: draft.uncertainty,
        })
        .where('id', '=', Number(row.analysisId))
        .execute();
    }
    return { checked: rows.length, hidden, watching };
  }

  /** Everyone with items, for commands that act on one person's feed. */
  async function itemOwners(): Promise<string[]> {
    const rows = await database
      .query()
      .selectFrom('feedItems')
      .select('ownerId')
      .distinct()
      .execute<Row>();
    return rows.map((row) => String(row.ownerId));
  }

  /** The person's "Useful" and "Not relevant" feedback, as cases for `feed evaluate`. */
  async function labelledCases(ownerId: string): Promise<GoldCase[]> {
    const rows = await database
      .query()
      .selectFrom('feedItems as i')
      .innerJoin('feedItemStates as s', 's.itemId', 'i.id')
      .selectAll('i')
      .select('s.feedback as feedback')
      .where('i.ownerId', '=', ownerId)
      .where('s.feedback', 'is not', null)
      .orderBy('i.id', 'asc')
      .execute<Row>();
    return rows.map((row) => ({
      caseId: `item-${String(row.id)}`,
      label: row.feedback === 'helpful' ? 'keep' : 'drop',
      item: toAnalysisItem(row),
    }));
  }

  /**
   * What the feed would do with an item, with the keyword rules beside it, writing nothing. The gate for fetching more
   * is left out because a case has no subscription to fetch through.
   */
  async function judgeCase(ownerId: string, item: AnalysisItem) {
    const [profile, topics] = await Promise.all([
      getProfile(ownerId),
      topicsFor(ownerId, null),
    ]);
    const locale = localeFor(
      profile.locale,
      `${profile.interests}${item.title}`,
    );
    const row = {
      id: 0,
      ...item,
      comments: item.comments ?? null,
      transcript: item.transcript ?? null,
    } as Row;
    const blocked = await prefilter(ownerId, [row], topics, profile);
    const rules = analyzeWithRules(item, topics, profile, locale);
    const draft = blocked.size
      ? blockedByPrefilter(rules, locale)
      : limitedToTitleIfBare(
          item,
          await analyzeOne(ownerId, row, topics, profile, locale),
          profile,
          locale,
        );
    const verdictOf = (entry: AnalysisDraft) => ({
      kept: entry.verdict !== 'ignore',
      verdict: entry.verdict,
      priority: entry.priority,
      quality: entry.quality,
      noise: entry.qualityDetail?.noise ?? null,
      gate: entry.gate,
      engine: entry.engine,
    });
    return { model: verdictOf(draft), rules: verdictOf(rules) };
  }

  /**
   * The daily digest: the best discussions and the best learning item collected in the last 24 hours. Picked by
   * priority, shown newest first like the rest of the feed.
   */
  async function digest(
    ownerId: string,
    now = new Date(),
  ): Promise<FeedDigest> {
    const since = new Date(now.getTime() - 24 * HOUR_MS);
    const [hot, discuss, learn] = await Promise.all([
      // Published in the last day, wherever it was collected: an item can turn hot after it came in.
      listItems(ownerId, {
        view: 'hot',
        sort: 'priority',
        period: 'day',
        pageSize: 3,
      }),
      listItems(ownerId, {
        view: 'discuss',
        sort: 'priority',
        pageSize: 3,
        since,
      }),
      listItems(ownerId, {
        view: 'learn',
        sort: 'priority',
        pageSize: 1,
        since,
      }),
    ]);
    // An item shows once: the hot list keeps it.
    const hotIds = new Set(hot.items.map((item) => item.id));
    const newestFirst = (items: FeedListItem[]) =>
      [...items].sort(
        (a, b) =>
          Date.parse(b.publishedAt ?? b.createdAt) -
            Date.parse(a.publishedAt ?? a.createdAt) || b.id - a.id,
      );
    return {
      since: since.toISOString(),
      hot: hot.items,
      discuss: newestFirst(
        discuss.items.filter((item) => !hotIds.has(item.id)),
      ),
      learn: newestFirst(learn.items.filter((item) => !hotIds.has(item.id))),
    };
  }

  /**
   * Called by the schedule: sends each person their digest once a day, after their chosen local hour. A day with
   * nothing worth reading sends nothing but still counts as done.
   */
  async function sendDigests(now = new Date()): Promise<number> {
    const rows = (await repo('feedProfiles').findMany({
      filter: { digestEnabled: true },
    })) as Row[];
    let sent = 0;
    for (const row of rows) {
      const ownerId = String(row.ownerId);
      const timeZone = (row.timeZone as string | null) ?? null;
      const today = localClock(now, timeZone);
      if (today.hour < Number(row.digestHour ?? 8)) continue;
      const last = row.lastDigestAt
        ? localClock(new Date(iso(row.lastDigestAt)!), timeZone).date
        : null;
      if (last === today.date) continue;
      try {
        const content = await digest(ownerId, now);
        const picks = [...content.hot, ...content.discuss, ...content.learn];
        if (picks.length) {
          const zh = row.locale === 'zh-CN';
          const delivered = await deps.notify({
            key: `feed-digest:${ownerId}:${today.date}`,
            ownerId,
            type: 'digest',
            referenceId: today.date,
            path: '/?view=digest',
            title: zh
              ? `今日简报：${content.hot.length} 条热点，${content.discuss.length} 条值得参与，${content.learn.length} 条值得学习`
              : `Today: ${content.hot.length} trending, ${content.discuss.length} to join, ${content.learn.length} to learn from`,
            body: picks
              .map((item, index) => `${index + 1}. ${truncate(item.title, 90)}`)
              .join('\n'),
          });
          if (delivered) sent += 1;
        }
        await repo('feedProfiles').updateOne({
          filter: { ownerId },
          values: { lastDigestAt: now },
        } as never);
      } catch (error) {
        deps.log('warn', 'feed digest failed', {
          ownerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return sent;
  }

  /**
   * Called by the schedule: re-reads the reply count of threads people posted in and tells them when new replies came.
   * The first successful check only records the baseline.
   */
  async function checkFollowUps(now = new Date()): Promise<number> {
    const due = await database
      .query()
      .selectFrom('feedItemStates')
      .selectAll()
      .where('followUpAt', '<=', now)
      .orderBy('followUpAt', 'asc')
      .limit(50)
      .execute<Row>();
    let notified = 0;
    for (const row of due) {
      const ownerId = String(row.ownerId);
      const itemId = Number(row.itemId);
      const since = new Date(iso(row.followUpSince) ?? now.toISOString());
      const values: Row = {
        followUpAt: nextFollowUp(since, now),
        followUpCheckedAt: now,
      };
      try {
        const count = await adapters.replyCount(
          text(row.participationUrl),
          AbortSignal.timeout(30_000),
        );
        if (count == null) {
          values.followUpAt = null;
        } else {
          const baseline =
            row.followUpBaseline == null ? count : Number(row.followUpBaseline);
          const fresh = Math.max(0, count - baseline);
          const previous = Number(row.followUpNew ?? 0);
          Object.assign(values, {
            followUpBaseline: baseline,
            followUpReplies: count,
            followUpNew: fresh,
          });
          if (fresh > previous) {
            const [item, profile] = await Promise.all([
              repo('feedItems').findOne({
                filter: { ownerId, id: itemId },
              }) as Promise<Row | null>,
              getProfile(ownerId),
            ]);
            const zh = profile.locale === 'zh-CN';
            const title = truncate(text(item?.title), 80);
            const sent = await deps.notify({
              key: `feed-follow-up:${itemId}:${count}`,
              ownerId,
              type: 'followUp',
              referenceId: String(itemId),
              path: `/?view=participated&item=${itemId}`,
              title: zh
                ? `你参与的讨论有 ${fresh} 条新回复`
                : `${fresh} new ${fresh === 1 ? 'reply' : 'replies'} where you posted`,
              body: title,
            });
            if (sent) notified += 1;
          }
        }
      } catch (error) {
        // Unreachable for now; try again at the next interval.
        deps.log('warn', 'follow-up check failed', {
          itemId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await repo('feedItemStates').updateOne({
        filter: { ownerId, itemId },
        values,
      } as never);
    }
    return notified;
  }

  async function catalogStatus(): Promise<CatalogStatus> {
    const collector = adapters.collectorConfigured();
    let model: CatalogStatus['model'] = { available: false, name: null };
    try {
      const ref = (await deps.agents()?.models.gateway.catalog('chat'))
        ?.defaultModel;
      if (ref)
        model = { available: true, name: `${ref.modelService}/${ref.model}` };
    } catch {
      // The Models page reports the reason; here it is simply not available.
    }
    return {
      collectorConfigured: collector,
      model,
      platforms: CATALOG.map((spec) => ({
        platform: spec.platform,
        experimental: Boolean(spec.experimental),
        needsLogin: Boolean(spec.needsLogin),
        operations: spec.operations.map((op) => ({
          operation: op.operation,
          implementation: op.implementation,
          input: op.input,
          single: Boolean(op.single),
          capabilities: op.capabilities,
          targetLength: op.targetLength ?? null,
          available:
            spec.platform === 'mail'
              ? Boolean(deps.mailAccounts)
              : op.implementation === 'native' || collector,
        })),
      })),
    };
  }

  return {
    getProfile,
    saveProfile,
    rememberLocale,
    listTopics,
    createTopic,
    updateTopic,
    deleteTopic,
    runTopicSearches,
    listSources,
    createSource,
    updateSource,
    deleteSource,
    runSource,
    runDue,
    analyzeItems,
    listRuns,
    listItems,
    getItem,
    updateState,
    rescoreTerms,
    markAllRead,
    enrichItem,
    fetchParts,
    prefetchWaiting,
    refreshHeat,
    resolvePublishedTimes,
    reanalyzeItem,
    settleAgentReads,
    itemOwners,
    labelledCases,
    briefItem,
    translateItem,
    briefPending,
    reapplyWorth,
    reapplyAdmission,
    settleWatching,
    judgeCase,
    summary,
    digest,
    sendDigests,
    checkFollowUps,
    catalogStatus,
  };
}
