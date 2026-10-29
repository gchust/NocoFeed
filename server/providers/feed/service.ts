import type { Agents } from '@nocobase/app-plugin-agents/server/tokens';
import type { DatabaseManager } from '@nocobase/db';

import type { FeedConfig } from '../../config/feed.js';
import { followableUrl, type Adapters } from './adapters.js';
import {
  analyzeWithRules,
  buildPrompt,
  localeFor,
  matchTopics,
  parseModelAnswer,
  TERM_WEIGHT_MAX,
  TERM_WEIGHT_MIN,
  type AnalysisDraft,
  type AnalysisItem,
  type AnalysisProfile,
  type AnalysisTopic,
  type Locale,
} from './analyzer.js';
import { CATALOG, findOperation, type Platform } from './catalog.js';
import { truncate } from './text.js';
import type {
  CollectResult,
  CommentEntry,
  ItemCoverage,
  RunCoverage,
  TranscriptSegment,
} from './types.js';

export type TopicMode = 'both' | 'participate' | 'learn';
export type FeedView =
  'all' | 'discuss' | 'learn' | 'saved' | 'later' | 'participated';

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
}

export type SourceHealth = 'ok' | 'failing' | 'quiet';

export interface Topic {
  id: number;
  name: string;
  goal: string;
  avoid: string | null;
  mode: TopicMode;
  sourceIds: number[];
  createdAt: string;
}

export interface Source {
  id: number;
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
  /** Present while the participation link is one NocoFeed can follow (Hacker News, Reddit). */
  followUp: FollowUp | null;
}

export interface StateChange extends ItemState {
  /** Set when feedback changed the weight of the words that made the item match. */
  adjustment?: {
    direction: 'up' | 'down';
    terms: string[];
    /** How many recent items were scored again with the new weights. */
    rescored: number;
  };
}

export interface FeedDigest {
  since: string;
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
  interestLevel: string;
  interestReason: string | null;
  experienceLevel: string;
  experienceReason: string | null;
  lead: string | null;
  steps: { title: string; detail: string }[];
  evidence: string | null;
  uncertainty: string | null;
  engine: 'rules' | 'model';
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
  publishedAt: string | null;
  createdAt: string;
  verdict: Analysis['verdict'] | null;
  score: number;
  topicId: number | null;
  lead: string | null;
  favorite: boolean;
  later: boolean;
  participated: boolean;
  /** Replies to the person's post they have not seen yet. */
  newReplies: number;
}

export interface FeedItemDetail extends FeedListItem {
  externalId: string;
  author: string | null;
  body: string | null;
  comments: CommentEntry[];
  transcript: TranscriptSegment[];
  metrics: Record<string, number>;
  coverage: ItemCoverage;
  contentVersion: number;
  fetchedAt: string;
  analysis: Analysis | null;
  analysisStale: boolean;
  state: ItemState;
  enrichable: ('body' | 'comments' | 'transcript')[];
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
  startedAt: string;
  finishedAt: string | null;
}

export interface FeedSummary {
  all: number;
  discuss: number;
  learn: number;
  saved: number;
  later: number;
  participated: number;
  /** Items whose followed thread has replies the person has not seen. */
  newReplies: number;
  /** Subscriptions that keep failing or have gone quiet. */
  unhealthySources: number;
}

export interface CatalogEntry {
  platform: Platform;
  experimental: boolean;
  needsLogin: boolean;
  operations: {
    operation: string;
    implementation: 'native' | 'collector';
    input: 'text' | 'url' | 'none';
    single: boolean;
    capabilities: readonly string[];
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
const HOUR_MS = 3_600_000;

/** Failed runs in a row before a subscription counts as failing. */
export const FAILURE_ALERT = 3;
/** Runs in a row without anything new, spanning at least three days, before a subscription counts as quiet. */
export const EMPTY_ALERT = 5;
const QUIET_MINUTES = 3 * 24 * 60;
/** A followed thread is checked for two weeks after the person posted. */
const FOLLOW_UP_DAYS = 14;
/** How many recent rule-based analyses are scored again when feedback changes a weight. */
const RESCORE_LIMIT = 200;
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
  log: (
    level: 'info' | 'warn' | 'error',
    message: string,
    context?: Row,
  ) => void;
}

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
      dailyLimit: Number(row?.dailyLimit ?? 20),
      keepLearning: row ? bool(row.keepLearning) : true,
      locale: (row?.locale as Locale | null) ?? null,
      configured: Boolean(row),
      termWeights: json<Record<string, number>>(row?.termWeights, {}),
      digestEnabled: row ? bool(row.digestEnabled) : true,
      digestHour: Number(row?.digestHour ?? 8),
      timeZone: (row?.timeZone as string | null) ?? null,
    };
  }

  async function saveProfile(
    ownerId: string,
    input: Pick<
      Profile,
      'interests' | 'expertise' | 'avoid' | 'dailyLimit' | 'keepLearning'
    > &
      Partial<Pick<Profile, 'digestEnabled' | 'digestHour' | 'timeZone'>> & {
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
        dailyLimit: 20,
        keepLearning: true,
        locale,
        updatedAt: new Date(),
      },
      update: { locale, updatedAt: new Date() },
    } as never);
  }

  // Topics

  const toTopic = (row: Row): Topic => ({
    id: Number(row.id),
    name: String(row.name),
    goal: String(row.goal),
    avoid: (row.avoid as string | null) ?? null,
    mode: (row.mode as TopicMode) ?? 'both',
    sourceIds: json<number[]>(row.sourceIds, []).map(Number),
    createdAt: iso(row.createdAt) ?? '',
  });

  async function listTopics(ownerId: string): Promise<Topic[]> {
    const rows = (await repo('feedTopics').findMany({
      filter: { ownerId },
      sort: (s) => s.field('id').asc(),
    })) as Row[];
    return rows.map(toTopic);
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
      .where('id', 'in', ids)
      .execute();
    const owned = new Set(rows.map((row) => Number(row.id)));
    return ids.filter((id) => owned.has(id));
  }

  async function createTopic(
    ownerId: string,
    input: Omit<Topic, 'id' | 'createdAt'>,
  ): Promise<Topic> {
    const now = new Date();
    const result = await repo('feedTopics').createOne({
      values: {
        ownerId,
        name: input.name.trim(),
        goal: input.goal.trim(),
        avoid: input.avoid?.trim() || null,
        mode: input.mode,
        sourceIds: await ownedSourceIds(ownerId, input.sourceIds),
        createdAt: now,
        updatedAt: now,
      },
    } as never);
    return toTopic((result as { record: Row }).record);
  }

  async function updateTopic(
    ownerId: string,
    id: number,
    input: Partial<Omit<Topic, 'id' | 'createdAt'>>,
  ): Promise<Topic> {
    await requireRow('feedTopics', ownerId, id);
    const values: Row = { updatedAt: new Date() };
    if (input.name !== undefined) values.name = input.name.trim();
    if (input.goal !== undefined) values.goal = input.goal.trim();
    if (input.avoid !== undefined) values.avoid = input.avoid?.trim() || null;
    if (input.mode !== undefined) values.mode = input.mode;
    if (input.sourceIds !== undefined)
      values.sourceIds = await ownedSourceIds(ownerId, input.sourceIds);
    const result = await repo('feedTopics').updateOne({
      filter: { ownerId, id },
      values,
    } as never);
    return toTopic((result as { record: Row }).record);
  }

  async function deleteTopic(ownerId: string, id: number): Promise<void> {
    await requireRow('feedTopics', ownerId, id);
    await repo('feedTopics').deleteOne({ filter: { ownerId, id } } as never);
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

  async function listSources(ownerId: string): Promise<Source[]> {
    const rows = (await repo('feedSources').findMany({
      filter: { ownerId },
      sort: (s) => s.field('id').asc(),
    })) as Row[];
    return rows.map(toSource);
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
    if (spec.operation.input === 'url' && !/^https?:\/\/\S+$/i.test(value))
      throw new FeedError('invalid', 'targetMustBeUrl');
    return value;
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
    },
  ): Promise<Source> {
    const target = validateSource(
      input.platform,
      input.operation,
      input.target,
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
        if (!topic) continue;
        const ids = json<number[]>(topic.sourceIds, []);
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
        'name' | 'target' | 'frequency' | 'candidateLimit' | 'active'
      >
    >,
  ): Promise<Source> {
    const current = toSource(await requireRow('feedSources', ownerId, id));
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
    await requireRow('feedSources', ownerId, id);
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
        path: '/sources',
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
      const knownIds = new Set(knownRows.map((row) => String(row.externalId)));
      const single = findOperation(source.platform, source.operation)?.operation
        .single;
      const firstRun = !source.lastSuccessAt;

      const result = await adapters.collect({
        platform: source.platform,
        operation: source.operation,
        target: source.target,
        limit: source.candidateLimit,
        cursor: json<Record<string, unknown> | null>(sourceRow.cursor, null),
        knownIds,
        signal: AbortSignal.timeout(MAX_RUN_MS),
      });
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
          const exists = await connection.repository('feedItems').findOne({
            filter: {
              ownerId,
              platform: source.platform,
              externalId: item.externalId,
            },
            select: (s) => s.fields('id'),
          });
          if (exists) continue;
          const created = await connection.repository('feedItems').createOne({
            values: {
              ownerId,
              platform: source.platform,
              externalId: truncate(item.externalId, 191),
              sourceId: source.id,
              sourceLabel: truncate(source.name, 200),
              url: item.url ? truncate(item.url, 1000) : null,
              title: truncate(item.title, 500) || item.externalId,
              author: item.author ? truncate(item.author, 200) : null,
              summary: item.summary ?? null,
              body: item.body ?? null,
              comments: item.comments ?? null,
              transcript: item.transcript ?? null,
              metrics: item.metrics ?? null,
              coverage: item.coverage,
              contentVersion: 1,
              publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
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
      startedAt: iso(row.startedAt) ?? '',
      finishedAt: iso(row.finishedAt),
    };
  };

  async function sourceMap(ownerId: string): Promise<Map<number, Source>> {
    return new Map(
      (await listSources(ownerId)).map((source) => [source.id, source]),
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
    coverage: json<ItemCoverage>(row.coverage, DEFAULT_COVERAGE),
  });

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
        const answer = await deps.agents()!.models.gateway.generate({
          model: choice.ref,
          system,
          prompt,
          maxOutputTokens: 1_200,
          source: 'nocofeed.analysis',
          signal: AbortSignal.timeout(90_000),
        });
        return parseModelAnswer(
          answer.text,
          topics,
          item,
          locale,
          `${choice.ref.modelService}/${choice.ref.model}`,
        );
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

  async function topicsFor(
    ownerId: string,
    sourceId: number | null,
  ): Promise<AnalysisTopic[]> {
    const topics = await listTopics(ownerId);
    const linked =
      sourceId == null
        ? []
        : topics.filter((topic) => topic.sourceIds.includes(sourceId));
    return (linked.length ? linked : topics).map((topic) => ({
      id: topic.id,
      name: topic.name,
      goal: topic.goal,
      avoid: topic.avoid,
      mode: topic.mode,
    }));
  }

  /** Writes a new current analysis per item; earlier versions stay as history. Returns how many were analysed. */
  async function analyzeItems(
    ownerId: string,
    itemIds: number[],
    sourceId: number | null,
  ): Promise<number> {
    if (!itemIds.length) return 0;
    const [profile, topics] = await Promise.all([
      getProfile(ownerId),
      topicsFor(ownerId, sourceId),
    ]);
    const rows = await database
      .query()
      .selectFrom('feedItems')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('id', 'in', itemIds)
      .execute<Row>();
    let count = 0;
    for (const row of rows) {
      const locale = localeFor(
        profile.locale,
        `${profile.interests}${text(row.title)}`,
      );
      const draft = await analyzeOne(ownerId, row, topics, profile, locale);
      await writeAnalysis(ownerId, row, draft);
      count += 1;
    }
    return count;
  }

  /** Makes `draft` the item's current analysis; earlier ones stay as history. */
  async function writeAnalysis(
    ownerId: string,
    row: Row,
    draft: AnalysisDraft,
  ) {
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

  async function enrichItem(
    ownerId: string,
    itemId: number,
  ): Promise<FeedItemDetail> {
    const row = await requireRow('feedItems', ownerId, itemId);
    const platform = String(row.platform);
    const source =
      row.sourceId == null
        ? null
        : ((await repo('feedSources').findOne({
            filter: { ownerId, id: Number(row.sourceId) },
          })) as Row | null);
    const want = enrichableFor(
      platform,
      source ? String(source.operation) : null,
    );
    if (!want.length) throw new FeedError('invalid', 'nothingToEnrich');
    const runId = await startRun({
      ownerId,
      itemId,
      sourceId: row.sourceId ?? null,
      stage: 'enrich',
      trigger: 'manual',
      scope: truncate(String(row.title), 300),
    });
    const result = await adapters.enrich({
      platform,
      externalId: String(row.externalId),
      url: (row.url as string | null) ?? null,
      want,
      signal: AbortSignal.timeout(MAX_RUN_MS),
    });
    const ok = result.status === 'ok' || result.status === 'partial';
    const coverage = json<ItemCoverage>(row.coverage, DEFAULT_COVERAGE);
    if (!ok) {
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
          ...(ok && result.comments ? { comments: result.comments } : {}),
          ...(ok && result.transcript ? { transcript: result.transcript } : {}),
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
    if (!ok) throw new FeedError('unavailable', result.status);
    return getItem(ownerId, itemId);
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

  async function getItem(ownerId: string, id: number): Promise<FeedItemDetail> {
    const row = await requireRow('feedItems', ownerId, id);
    const [analysisRow, stateRow, source] = await Promise.all([
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
    ]);
    const analysis = analysisRow ? toAnalysis(analysisRow) : null;
    const state = toState(stateRow);
    return {
      ...toListItem(row, analysisRow, stateRow),
      externalId: String(row.externalId),
      author: (row.author as string | null) ?? null,
      body: (row.body as string | null) ?? null,
      comments: json<CommentEntry[]>(row.comments, []),
      transcript: json<TranscriptSegment[]>(row.transcript, []),
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
    };
  }

  const toAnalysis = (row: Row): Analysis => ({
    id: Number(row.id),
    topicId: row.topicId == null ? null : Number(row.topicId),
    verdict: row.verdict as Analysis['verdict'],
    score: Number(row.score ?? 0),
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

  const toListItem = (
    row: Row,
    analysis: Row | null,
    state: Row | null,
  ): FeedListItem => ({
    id: Number(row.id),
    platform: row.platform as Platform,
    sourceLabel: (row.sourceLabel as string | null) ?? null,
    title: String(row.title),
    summary: (row.summary as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    publishedAt: iso(row.publishedAt),
    createdAt: iso(row.createdAt) ?? '',
    verdict: (analysis?.verdict as FeedListItem['verdict']) ?? null,
    score: Number(analysis?.score ?? 0),
    topicId: analysis?.topicId == null ? null : Number(analysis.topicId),
    lead: (analysis?.lead as string | null) ?? null,
    favorite: bool(state?.favorite),
    later: bool(state?.later),
    participated: bool(state?.participated),
    newReplies: Number(state?.followUpNew ?? 0),
  });

  /**
   * One page of the feed: items with their current analysis and the person's state, filtered in SQL, sorted by
   * value then recency, paged by offset behind an opaque token. Three queries regardless of the page size.
   */
  async function listItems(
    ownerId: string,
    query: {
      view: FeedView;
      platform?: string;
      topicId?: number;
      q?: string;
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
    let builder = database
      .query()
      .selectFrom('feedItems as i')
      .leftJoin('feedAnalyses as a', (join) =>
        join.onRef('a.itemId', '=', 'i.id').on('a.current', '=', true),
      )
      .leftJoin('feedItemStates as s', (join) =>
        join.onRef('s.itemId', '=', 'i.id').on('s.ownerId', '=', ownerId),
      )
      .select(['i.id as id', 'a.score as score'])
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
      default:
        builder = builder.where('a.verdict', 'in', ['discuss', 'learn']);
    }
    // Dismissed items leave the feed; what the person kept on purpose stays in its own view.
    if (['all', 'discuss', 'learn'].includes(query.view))
      builder = builder.where((eb) =>
        eb.or([eb('s.dismissed', 'is', null), eb('s.dismissed', '=', false)]),
      );
    if (query.since) builder = builder.where('i.createdAt', '>=', query.since);
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
    const page = await builder
      .orderBy('a.score', 'desc')
      .orderBy('i.id', 'desc')
      .limit(query.pageSize + 1)
      .offset(offset)
      .execute<Row>();
    const ids = page.slice(0, query.pageSize).map((row) => Number(row.id));
    if (!ids.length) return { items: [] };

    const [items, analyses, states] = (await Promise.all([
      database
        .query()
        .selectFrom('feedItems')
        .select([
          'id',
          'platform',
          'sourceLabel',
          'title',
          'summary',
          'url',
          'publishedAt',
          'createdAt',
        ])
        .where('ownerId', '=', ownerId)
        .where('id', 'in', ids)
        .execute(),
      database
        .query()
        .selectFrom('feedAnalyses')
        .select(['itemId', 'verdict', 'score', 'topicId', 'lead'])
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
    ])) as [Row[], Row[], Row[]];
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
          ),
        ),
      nextPageToken:
        page.length > query.pageSize
          ? Buffer.from(String(offset + query.pageSize)).toString('base64url')
          : undefined,
    };
  }

  async function summary(ownerId: string): Promise<FeedSummary> {
    const countStates = async (
      field: 'favorite' | 'later' | 'participated',
    ) => {
      const [row] = await database
        .query()
        .selectFrom('feedItemStates')
        .select((eb) => [eb.fn.count('id').as('n')])
        .where('ownerId', '=', ownerId)
        .where(field, '=', true)
        .execute();
      return Number((row as Row | undefined)?.n ?? 0);
    };
    const [verdicts, saved, later, participated, replies, sources] =
      await Promise.all([
        database
          .query()
          .selectFrom('feedAnalyses as a')
          .leftJoin('feedItemStates as s', (join) =>
            join
              .onRef('s.itemId', '=', 'a.itemId')
              .on('s.ownerId', '=', ownerId),
          )
          .select((eb) => ['a.verdict as verdict', eb.fn.count('a.id').as('n')])
          .where('a.ownerId', '=', ownerId)
          .where('a.current', '=', true)
          .where((eb) =>
            eb.or([
              eb('s.dismissed', 'is', null),
              eb('s.dismissed', '=', false),
            ]),
          )
          .groupBy('a.verdict')
          .execute(),
        countStates('favorite'),
        countStates('later'),
        countStates('participated'),
        database
          .query()
          .selectFrom('feedItemStates')
          .select((eb) => [eb.fn.count('id').as('n')])
          .where('ownerId', '=', ownerId)
          .where('followUpNew', '>', 0)
          .execute(),
        listSources(ownerId),
      ]);
    const byVerdict = new Map(
      (verdicts as Row[]).map((row) => [String(row.verdict), Number(row.n)]),
    );
    const discuss = byVerdict.get('discuss') ?? 0;
    const learn = byVerdict.get('learn') ?? 0;
    return {
      all: discuss + learn,
      discuss,
      learn,
      saved,
      later,
      participated,
      newReplies: Number((replies[0] as Row | undefined)?.n ?? 0),
      unhealthySources: sources.filter(
        (source) => source.active && source.health !== 'ok',
      ).length,
    };
  }

  async function updateState(
    ownerId: string,
    itemId: number,
    input: Partial<
      Omit<ItemState, 'followUp'> & {
        /** The person has seen the new replies to their post. */
        followUpSeen: boolean;
      }
    >,
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
    await repo('feedItemStates').upsertOne({
      filter: { ownerId, itemId },
      create: { ownerId, itemId, ...values },
      update: values,
    } as never);

    let adjustment: StateChange['adjustment'];
    if (input.feedback !== undefined) {
      adjustment = await learnFromFeedback(
        ownerId,
        item,
        (before?.feedback as ItemState['feedback']) ?? null,
        input.feedback,
      );
    }
    const state = toState(
      (await repo('feedItemStates').findOne({
        filter: { ownerId, itemId },
      })) as Row | null,
    );
    return adjustment ? { ...state, adjustment } : state;
  }

  /**
   * Feedback moves the weight of the words that made the item match: "useful" up by one, "not relevant" down by one,
   * within bounds. Changing or withdrawing feedback undoes the earlier step, so clicking back and forth never drifts.
   * Recent rule-based analyses are scored again so the feed reflects it at once; model analyses pick it up next time.
   */
  async function learnFromFeedback(
    ownerId: string,
    item: Row,
    previous: ItemState['feedback'],
    next: ItemState['feedback'],
  ): Promise<StateChange['adjustment']> {
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
    await repo('feedProfiles').upsertOne({
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
    const rescored = await rescoreWithRules(ownerId, hits);
    return { direction: delta > 0 ? 'up' : 'down', terms: hits, rescored };
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
      .select(['a.score as currentScore', 'a.verdict as currentVerdict'])
      .where('i.ownerId', '=', ownerId)
      .where('a.engine', '=', 'rules')
      .orderBy('i.id', 'desc')
      .limit(RESCORE_LIMIT)
      .execute<Row>();
    const profile = await getProfile(ownerId);
    const topicCache = new Map<string, AnalysisTopic[]>();
    let count = 0;
    for (const row of rows) {
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
      const draft = analyzeWithRules(analysisItem, topics, profile, locale);
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

  /** The daily digest: the best discussions and the best learning item collected in the last 24 hours. */
  async function digest(
    ownerId: string,
    now = new Date(),
  ): Promise<FeedDigest> {
    const since = new Date(now.getTime() - 24 * HOUR_MS);
    const [discuss, learn] = await Promise.all([
      listItems(ownerId, { view: 'discuss', pageSize: 3, since }),
      listItems(ownerId, { view: 'learn', pageSize: 1, since }),
    ]);
    return {
      since: since.toISOString(),
      discuss: discuss.items,
      learn: learn.items,
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
        const picks = [...content.discuss, ...content.learn];
        if (picks.length) {
          const zh = row.locale === 'zh-CN';
          const delivered = await deps.notify({
            key: `feed-digest:${ownerId}:${today.date}`,
            ownerId,
            type: 'digest',
            referenceId: today.date,
            path: '/?view=digest',
            title: zh
              ? `今日简报：${content.discuss.length} 条值得参与，${content.learn.length} 条值得学习`
              : `Today: ${content.discuss.length} to join, ${content.learn.length} to learn from`,
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
          available: op.implementation === 'native' || collector,
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
    listSources,
    createSource,
    updateSource,
    deleteSource,
    runSource,
    runDue,
    listRuns,
    listItems,
    getItem,
    updateState,
    enrichItem,
    reanalyzeItem,
    summary,
    digest,
    sendDigests,
    checkFollowUps,
    catalogStatus,
  };
}
