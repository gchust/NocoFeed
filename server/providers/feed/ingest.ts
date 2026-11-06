import type { DatabaseManager } from '@nocobase/db';
import { createHash } from 'node:crypto';

import type { Adapters } from './adapters.js';
import { INBOX_OPERATION, INBOX_PLATFORM } from './catalog.js';
import { heatOf } from './heat.js';
import {
  extractArticle,
  fetchPage,
  type HostLookup,
  type PageArticle,
} from './page.js';
import { storedExternalId, type FeedService } from './service.js';
import { truncate } from './text.js';
import {
  AdapterError,
  type CollectedItem,
  type ItemCoverage,
} from './types.js';

/**
 * The push side of NocoFeed (`POST /feedItems/ingest`): the person, a script or a browser extension sends a link or a
 * post, it lands in the person's own push inbox (one `feedSources` row with `platform` `inbox`, made on the first push)
 * and goes through the same prefilter and analysis as anything collected. Only the caller's own feed is ever written.
 *
 * - A link alone is read here: a video or post on a platform NocoFeed knows (YouTube, Bilibili, Xiaohongshu, X) through
 *   its adapter, anything else as a web page (`page.ts`, public addresses only). A link that cannot be read is still
 *   kept, with the failure on its coverage, so nothing pushed is lost.
 * - A post sends its own title and text, and nothing is fetched.
 * - The same thing pushed twice is stored once: by the caller's `externalId`, else by the link (any platform's item
 *   with the same link counts), else by the hash of title and text.
 */
export interface IngestInput {
  url?: string;
  title?: string;
  content?: string;
  summary?: string;
  author?: string;
  publishedAt?: string;
  externalId?: string;
}

export type IngestFetch = 'none' | 'platform' | 'page' | 'failed';

export interface IngestResult {
  itemId: number;
  title: string;
  url: string | null;
  /** True when it was pushed before: nothing was stored or analysed again. */
  duplicate: boolean;
  /** How the content was obtained: sent with the request, by a platform adapter, as a web page, or not at all. */
  fetched: IngestFetch;
  /** The fetch failure, as a short code, when `fetched` is `failed`. */
  fetchError: string | null;
}

export interface IngestDeps {
  database: DatabaseManager;
  adapters: Adapters;
  feed: () => Pick<FeedService, 'analyzeItems'>;
  userAgent: () => string;
  log: (
    level: 'info' | 'warn' | 'error',
    message: string,
    context?: Record<string, unknown>,
  ) => void;
  /** For tests: how host names resolve and how pages are requested. */
  lookup?: HostLookup;
  fetch?: typeof fetch;
}

const INBOX_NAME = 'Inbox';
const FETCH_MS = 60_000;

/** The link as stored and compared: without its fragment. */
export function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  url.hash = '';
  return url.href;
}

/** A link to a single video or post on a platform NocoFeed reads itself, as that platform's operation and target. */
export function platformOfUrl(
  value: string,
): { platform: string; operation: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '');
  if (
    (host === 'youtube.com' &&
      /^\/(watch|shorts\/|embed\/|live\/)/.test(url.pathname)) ||
    host === 'youtu.be'
  )
    return { platform: 'youtube', operation: 'video' };
  if (
    host === 'bilibili.com' &&
    /\/video\/BV[0-9A-Za-z]{10}/.test(url.pathname)
  )
    return { platform: 'bilibili', operation: 'video' };
  if (
    (host === 'xiaohongshu.com' &&
      /^\/(explore|discovery\/item)\//.test(url.pathname)) ||
    host === 'xhslink.com'
  )
    return { platform: 'xiaohongshu', operation: 'post' };
  if (
    (host === 'x.com' || host === 'twitter.com') &&
    /\/status\/\d+/.test(url.pathname)
  )
    return { platform: 'x', operation: 'post' };
  return null;
}

const contentHash = (title: string, content: string) =>
  `sha256:${createHash('sha256').update(`${title}\n${content}`).digest('hex')}`;

type Row = Record<string, unknown>;

export function createIngest(deps: IngestDeps) {
  const { database } = deps;

  /** The person's push inbox, made on the first push. */
  async function inbox(ownerId: string): Promise<Row> {
    const found = (await database.repository('feedSources').findOne({
      filter: { ownerId, platform: INBOX_PLATFORM },
    })) as Row | null;
    if (found) return found;
    const now = new Date();
    const created = await database.repository('feedSources').createOne({
      values: {
        ownerId,
        platform: INBOX_PLATFORM,
        operation: INBOX_OPERATION,
        name: INBOX_NAME,
        target: `${INBOX_PLATFORM}:${INBOX_OPERATION}`,
        frequency: 10_080,
        candidateLimit: 1,
        // Never collected: nothing is due, and the schedule only runs active subscriptions.
        active: false,
        status: 'ok',
        nextRunAt: null,
        createdAt: now,
        updatedAt: now,
      },
    } as never);
    return (created as { record: Row }).record;
  }

  async function existing(
    ownerId: string,
    externalId: string,
    url: string | null,
  ): Promise<Row | null> {
    const same = (await database.repository('feedItems').findOne({
      filter: { ownerId, platform: INBOX_PLATFORM, externalId },
    })) as Row | null;
    if (same || !url) return same;
    return (await database.repository('feedItems').findOne({
      filter: { ownerId, url },
    })) as Row | null;
  }

  /** Reads a pushed link: through the platform's adapter when it is one NocoFeed knows, else as a web page. */
  async function read(
    url: string,
  ): Promise<
    | { fetched: 'platform'; item: CollectedItem }
    | { fetched: 'page'; article: PageArticle }
    | { fetched: 'failed'; error: string }
  > {
    const signal = AbortSignal.timeout(FETCH_MS);
    const known = platformOfUrl(url);
    if (known) {
      const result = await deps.adapters.collect({
        ...known,
        target: url,
        limit: 1,
        cursor: null,
        knownIds: new Set(),
        since: null,
        signal,
      });
      const item = result.items[0];
      if ((result.status === 'ok' || result.status === 'partial') && item)
        return { fetched: 'platform', item };
    }
    try {
      const page = await fetchPage(url, {
        signal,
        userAgent: deps.userAgent(),
        lookup: deps.lookup,
        fetch: deps.fetch,
      });
      return { fetched: 'page', article: extractArticle(page) };
    } catch (error) {
      return {
        fetched: 'failed',
        error:
          error instanceof AdapterError
            ? truncate(error.message, 200)
            : 'pageFailed',
      };
    }
  }

  async function ingest(
    ownerId: string,
    input: IngestInput,
    { wait = false }: { wait?: boolean } = {},
  ): Promise<IngestResult> {
    const url = input.url ? normalizeUrl(input.url) : null;
    const content = input.content?.trim() ?? '';
    const givenTitle = input.title?.trim() ?? '';
    const externalId = storedExternalId(
      input.externalId?.trim() || url || contentHash(givenTitle, content),
    );

    const before = await existing(ownerId, externalId, url);
    if (before)
      return {
        itemId: Number(before.id),
        title: String(before.title),
        url: (before.url as string | null) ?? null,
        duplicate: true,
        fetched: 'none',
        fetchError: null,
      };

    let fetched: IngestFetch = 'none';
    let fetchError: string | null = null;
    let item: CollectedItem;
    if (content || !url) {
      item = {
        externalId,
        url: url ?? undefined,
        title:
          givenTitle || truncate(content.split('\n', 1)[0]?.trim(), 200) || '',
        author: input.author,
        summary: input.summary,
        body: content || undefined,
        publishedAt: input.publishedAt,
        coverage: {
          body: content ? { status: 'available' } : { status: 'missing' },
          comments: { status: 'unavailable', note: 'commentsNotSupported' },
        },
      };
    } else {
      const outcome = await read(url);
      fetched = outcome.fetched;
      if (outcome.fetched === 'platform') {
        item = { ...outcome.item, url: outcome.item.url ?? url };
      } else if (outcome.fetched === 'page') {
        const article = outcome.article;
        item = {
          externalId,
          url,
          title: article.title,
          author: article.author,
          summary: article.summary,
          body: article.body,
          media: article.media,
          publishedAt: article.publishedAt,
          coverage: {
            body: article.body
              ? { status: 'available' }
              : { status: 'missing', note: 'pageWithoutText' },
            comments: { status: 'unavailable', note: 'commentsNotSupported' },
            ...(article.media
              ? { media: { status: 'unavailable', note: 'mediaNotAnalyzed' } }
              : {}),
          } satisfies ItemCoverage,
        };
      } else {
        fetchError = outcome.error;
        item = {
          externalId,
          url,
          title: url,
          coverage: {
            body: { status: 'failed', note: outcome.error },
            comments: { status: 'notRequested' },
          },
        };
      }
      // What the caller said wins over what the page says.
      item = {
        ...item,
        title: givenTitle || item.title,
        author: input.author ?? item.author,
        summary: input.summary ?? item.summary,
        publishedAt: input.publishedAt ?? item.publishedAt,
      };
    }

    const source = await inbox(ownerId);
    const now = new Date();
    const published = item.publishedAt ? new Date(item.publishedAt) : null;
    const publishedAt =
      published && Number.isFinite(published.getTime()) ? published : null;
    const storedUrl = item.url ? truncate(item.url, 1000) : null;
    let itemId: number;
    try {
      const created = await database.repository('feedItems').createOne({
        values: {
          ownerId,
          platform: INBOX_PLATFORM,
          externalId,
          sourceId: Number(source.id),
          sourceLabel: truncate(String(source.name), 200),
          url: storedUrl,
          title: truncate(item.title, 500) || storedUrl || externalId,
          author: item.author ? truncate(item.author, 200) : null,
          summary: item.summary ?? null,
          body: item.body ?? null,
          comments: item.comments ?? null,
          transcript: item.transcript ?? null,
          media: item.media?.length ? item.media : null,
          metrics: item.metrics ?? null,
          heat: heatOf(INBOX_PLATFORM, item.metrics),
          heatAtCollection: heatOf(INBOX_PLATFORM, item.metrics),
          metricsCheckedAt: now,
          coverage: item.coverage,
          contentVersion: 1,
          publishedAt,
          publishedApproximate: Boolean(
            publishedAt && item.publishedAtApproximate,
          ),
          timelineAt: publishedAt ?? now,
          fetchedAt: now,
          createdAt: now,
        },
      } as never);
      itemId = Number((created as { record: Row }).record.id);
    } catch (error) {
      // Pushed twice at the same moment: the other request stored it.
      const raced = await existing(ownerId, externalId, storedUrl);
      if (!raced) throw error;
      return {
        itemId: Number(raced.id),
        title: String(raced.title),
        url: (raced.url as string | null) ?? null,
        duplicate: true,
        fetched: 'none',
        fetchError: null,
      };
    }
    await database.repository('feedSources').updateOne({
      filter: { id: Number(source.id) },
      values: { lastRunAt: now, lastSuccessAt: now, updatedAt: now },
    } as never);

    // The prefilter and the analysis may wait for a model; a push answers at once and they follow.
    const analysis = deps
      .feed()
      .analyzeItems(ownerId, [itemId], Number(source.id))
      .catch((error: unknown) => {
        deps.log('error', 'pushed item analysis failed', {
          itemId,
          error: error instanceof Error ? error.message : String(error),
        });
        return 0;
      });
    if (wait) await analysis;

    return {
      itemId,
      title: truncate(item.title, 500) || storedUrl || externalId,
      url: storedUrl,
      duplicate: false,
      fetched,
      fetchError,
    };
  }

  return { ingest };
}

export type FeedIngest = ReturnType<typeof createIngest>;
