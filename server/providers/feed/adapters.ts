import { XMLParser } from 'fast-xml-parser';

import type { FeedConfig } from '../../config/feed.js';
import { findOperation } from './catalog.js';
import { htmlToText, mapLimit, truncate } from './text.js';
import {
  AdapterError,
  type CollectRequest,
  type CollectResult,
  type CollectedItem,
  type CommentEntry,
  type EnrichRequest,
  type EnrichResult,
  type ItemCoverage,
} from './types.js';

/** Adapters fetch and normalize; they never write, schedule or decide what is worth reading. */
export interface Adapters {
  collect(request: CollectRequest): Promise<CollectResult>;
  enrich(request: EnrichRequest): Promise<EnrichResult>;
  collectorConfigured(): boolean;
  /**
   * How many replies the thread the person posted in has now: the replies to their comment when the link points at a
   * comment, the whole discussion when it points at the post. `null` when the platform or link is not supported.
   */
  replyCount(url: string, signal: AbortSignal): Promise<number | null>;
}

/** Whether `replyCount` can follow this link. */
export function followableUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'news.ycombinator.com')
      return /^\d+$/.test(parsed.searchParams.get('id') ?? '');
    return (
      /(^|\.)reddit\.com$/.test(parsed.hostname) &&
      /\/comments\//.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

const BODY_LIMIT = 20_000;
const COMMENT_LIMIT = 20;

export function createAdapters(config: () => FeedConfig): Adapters {
  const http = createHttp(config);
  const collector = createCollectorClient(config, http);

  const native: Record<
    string,
    (request: CollectRequest) => Promise<CollectResult>
  > = {
    'hn:new': (request) => collectHackerNews(http, 'newstories', request),
    'hn:ask': (request) => collectHackerNews(http, 'askstories', request),
    'hn:show': (request) => collectHackerNews(http, 'showstories', request),
    'reddit:community': (request) => collectReddit(http, request),
    'rss:feed': (request) => collectFeed(http, request),
    'youtube:channel': (request) => collectYouTubeChannel(http, request),
    'youtube:video': (request) => collectYouTubeVideo(http, request),
    'bilibili:video': (request) => collectBilibiliVideo(http, request),
  };

  return {
    collectorConfigured: () => Boolean(config().collector.url),

    async replyCount(url, signal) {
      if (!followableUrl(url)) return null;
      const parsed = new URL(url);
      if (parsed.hostname === 'news.ycombinator.com') {
        const item = await http.json<HnItem | null>(
          `${HN}/item/${parsed.searchParams.get('id')}.json`,
          signal,
        );
        if (!item) return null;
        return item.type === 'comment'
          ? (item.kids?.length ?? 0)
          : (item.descendants ?? 0);
      }
      const path = parsed.pathname.replace(/\/$/, '');
      const [post, listing] = await http.json<[RedditListing, RedditListing]>(
        `https://www.reddit.com${path}.json?limit=1&depth=2&raw_json=1`,
        signal,
      );
      // `/comments/<post>/<slug>/<comment>` points at one comment; shorter paths at the post.
      if (path.split('/').filter(Boolean).length >= 6) {
        const comment = listing?.data?.children?.find(
          (child) => child.kind === 't1',
        );
        const replies = (comment?.data.replies as RedditListing | undefined)
          ?.data?.children;
        return (replies ?? []).reduce(
          (sum, child) =>
            sum +
            (child.kind === 't1'
              ? 1
              : child.kind === 'more'
                ? Number(child.data.count ?? 0)
                : 0),
          0,
        );
      }
      const count = post?.data?.children?.[0]?.data.num_comments;
      return typeof count === 'number' ? count : null;
    },

    async collect(request) {
      const spec = findOperation(request.platform, request.operation);
      if (!spec) {
        return {
          status: 'unsupported',
          message: `${request.platform}/${request.operation}`,
          items: [],
        };
      }
      try {
        if (spec.operation.implementation === 'collector') {
          return await collector.collect(request);
        }
        const handler = native[`${request.platform}:${request.operation}`];
        if (!handler) return { status: 'unsupported', items: [] };
        return await handler(request);
      } catch (error) {
        return failure(error);
      }
    },

    async enrich(request) {
      try {
        const wantsTranscript = request.want.includes('transcript');
        const wantsText = request.want.some(
          (part) => part === 'comments' || part === 'body',
        );
        const results: EnrichResult[] = [];
        if (wantsText && request.platform === 'hn') {
          results.push(await enrichHackerNews(http, request));
        } else if (wantsText && request.platform === 'reddit') {
          results.push(await enrichReddit(http, request));
        } else if (
          wantsText &&
          ['xiaohongshu', 'x'].includes(request.platform)
        ) {
          results.push(
            await collector.enrich({
              ...request,
              want: request.want.filter((part) => part !== 'transcript'),
            }),
          );
        }
        if (wantsTranscript) {
          results.push(
            await collector.enrich({ ...request, want: ['transcript'] }),
          );
        }
        if (!results.length) {
          return { status: 'unsupported', coverage: {} };
        }
        return results.reduce<EnrichResult>(
          (merged, next) => ({
            status: merged.status === 'ok' ? next.status : merged.status,
            // One code, so the browser can still translate it.
            message: merged.message || next.message,
            body: next.body ?? merged.body,
            comments: next.comments ?? merged.comments,
            transcript: next.transcript ?? merged.transcript,
            coverage: { ...merged.coverage, ...next.coverage },
          }),
          { status: 'ok', coverage: {} },
        );
      } catch (error) {
        const result = failure(error);
        return {
          status: result.status,
          message: result.message,
          coverage: {},
        };
      }
    },
  };
}

function failure(error: unknown): CollectResult {
  if (error instanceof AdapterError) {
    return { status: error.status, message: error.message, items: [] };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 'failed', message: truncate(message, 500), items: [] };
}

interface Http {
  json<T>(
    url: string,
    signal: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<T>;
  text(
    url: string,
    signal: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<string>;
  post<T>(
    url: string,
    body: unknown,
    signal: AbortSignal,
    headers?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<T>;
}

interface RequestOptions {
  /** Overrides the 30 s limit for public platforms; the caller's signal still applies. */
  timeoutMs?: number;
  /** A 401/403 means this server's own credentials were refused (the Collector token), not a platform sign-in. */
  service?: boolean;
}

function createHttp(config: () => FeedConfig): Http {
  const request = async (
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    options: RequestOptions = {},
  ): Promise<Response> => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          'user-agent': config().userAgent,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.any([signal, timeout]),
        redirect: 'follow',
      });
    } catch (error) {
      throw new AdapterError(
        'failed',
        `${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      options.service &&
      (response.status === 401 || response.status === 403)
    ) {
      throw new AdapterError('unconfigured', 'collectorUnauthorized');
    }
    if (response.status === 401 || response.status === 403) {
      throw new AdapterError(
        response.status === 401 ? 'needsLogin' : 'blocked',
        `${new URL(url).host} answered ${response.status}`,
      );
    }
    if (response.status === 429) {
      throw new AdapterError(
        'rateLimited',
        `${new URL(url).host} answered 429`,
      );
    }
    if (!response.ok) {
      throw new AdapterError(
        'failed',
        `${new URL(url).host} answered ${response.status}`,
      );
    }
    return response;
  };
  return {
    async json<T>(
      url: string,
      signal: AbortSignal,
      headers?: Record<string, string>,
    ) {
      const response = await request(url, { headers }, signal);
      return (await response.json()) as T;
    },
    async text(
      url: string,
      signal: AbortSignal,
      headers?: Record<string, string>,
    ) {
      const response = await request(url, { headers }, signal);
      return response.text();
    },
    async post<T>(
      url: string,
      body: unknown,
      signal: AbortSignal,
      headers?: Record<string, string>,
      options?: RequestOptions,
    ) {
      const response = await request(
        url,
        {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', ...headers },
        },
        signal,
        options,
      );
      return (await response.json()) as T;
    },
  };
}

function coverage(
  body: ItemCoverage['body'],
  comments: ItemCoverage['comments'],
  extra: Partial<ItemCoverage> = {},
): ItemCoverage {
  return { body, comments, ...extra };
}

/**
 * Takes the newest-first ids a list returned and keeps those not stored yet. When the window reaches an id seen
 * before, the gap since the last run is closed; when it does not, items in between may have been missed.
 */
function windowed(
  ids: readonly string[],
  request: CollectRequest,
): { fresh: string[]; truncated: boolean } {
  const window = ids.slice(0, request.limit);
  const fresh = window.filter((id) => !request.knownIds.has(id));
  const reachedKnown = window.some((id) => request.knownIds.has(id));
  return {
    fresh,
    truncated: request.knownIds.size > 0 && !reachedKnown,
  };
}

// Hacker News: the official Firebase API.

interface HnItem {
  id: number;
  type?: string;
  by?: string;
  time?: number;
  title?: string;
  text?: string;
  url?: string;
  score?: number;
  descendants?: number;
  kids?: number[];
  deleted?: boolean;
  dead?: boolean;
}

const HN = 'https://hacker-news.firebaseio.com/v0';

async function collectHackerNews(
  http: Http,
  list: string,
  request: CollectRequest,
): Promise<CollectResult> {
  const ids = (
    await http.json<number[]>(`${HN}/${list}.json`, request.signal)
  ).map(String);
  const { fresh, truncated } = windowed(ids, request);
  const items = await mapLimit(fresh, 6, (id) =>
    http.json<HnItem | null>(`${HN}/item/${id}.json`, request.signal),
  );
  return {
    status: 'ok',
    truncated,
    items: items
      .filter((item): item is HnItem =>
        Boolean(item && !item.deleted && !item.dead && item.title),
      )
      .map((item) => {
        const text = htmlToText(item.text);
        return {
          externalId: String(item.id),
          url: `https://news.ycombinator.com/item?id=${item.id}`,
          title: item.title!,
          author: item.by,
          summary: item.url ? item.url : undefined,
          body: text || undefined,
          metrics: compact({
            points: item.score,
            comments: item.descendants,
          }),
          publishedAt: item.time
            ? new Date(item.time * 1000).toISOString()
            : undefined,
          coverage: coverage(
            text
              ? { status: 'available' }
              : item.url
                ? { status: 'missing', note: 'linkedArticleNotFetched' }
                : { status: 'missing' },
            item.descendants
              ? { status: 'notRequested' }
              : { status: 'available', note: 'noComments' },
          ),
        } satisfies CollectedItem;
      }),
  };
}

async function enrichHackerNews(
  http: Http,
  request: EnrichRequest,
): Promise<EnrichResult> {
  const item = await http.json<HnItem | null>(
    `${HN}/item/${request.externalId}.json`,
    request.signal,
  );
  const kids = item?.kids ?? [];
  const fetched = await mapLimit(kids.slice(0, COMMENT_LIMIT), 6, (id) =>
    http.json<HnItem | null>(`${HN}/item/${id}.json`, request.signal),
  );
  const comments = fetched
    .filter((entry): entry is HnItem =>
      Boolean(entry && !entry.deleted && !entry.dead && entry.text),
    )
    .map((entry) => ({
      author: entry.by,
      text: truncate(htmlToText(entry.text), 2_000),
      depth: 0,
    }));
  const total = item?.descendants ?? 0;
  return {
    status: 'ok',
    comments,
    coverage: {
      comments: {
        status:
          total === 0
            ? 'available'
            : comments.length >= total
              ? 'available'
              : 'partial',
        note:
          total === 0
            ? 'noComments'
            : `topLevel:${comments.length}/${kids.length};total:${total}`,
        fetchedAt: new Date().toISOString(),
      },
    },
  };
}

// Reddit: the public JSON listing. Reddit may refuse anonymous server traffic; that is reported, never hidden.

interface RedditListing {
  data?: {
    children?: {
      kind: string;
      data: Record<string, unknown>;
    }[];
  };
}

function subreddits(target: string): string[] {
  return target
    .split(/[\s,，·+]+/)
    .map((part) => part.replace(/^\/?r\//i, '').trim())
    .filter((part) => /^[A-Za-z0-9_]{2,32}$/.test(part));
}

async function collectReddit(
  http: Http,
  request: CollectRequest,
): Promise<CollectResult> {
  const names = subreddits(request.target);
  if (!names.length) {
    throw new AdapterError('unsupported', 'invalidSubreddit');
  }
  let listing: RedditListing;
  try {
    listing = await http.json<RedditListing>(
      `https://www.reddit.com/r/${names.join('+')}/new.json?limit=${Math.min(request.limit, 100)}&raw_json=1`,
      request.signal,
    );
  } catch (error) {
    // Reddit refuses anonymous JSON from many server addresses but still serves the RSS listing.
    if (error instanceof AdapterError && error.status === 'blocked') {
      return collectRedditFeed(http, names, request);
    }
    throw error;
  }
  const posts = (listing.data?.children ?? [])
    .filter((child) => child.kind === 't3')
    .map((child) => child.data);
  const { fresh, truncated } = windowed(
    posts.map((post) => String(post.id)),
    request,
  );
  const freshSet = new Set(fresh);
  return {
    status: 'ok',
    truncated,
    items: posts
      .filter((post) => freshSet.has(String(post.id)))
      .map((post) => {
        const selftext = typeof post.selftext === 'string' ? post.selftext : '';
        const isSelf = post.is_self === true;
        return {
          externalId: String(post.id),
          url: `https://www.reddit.com${textOf(post.permalink)}`,
          title: textOf(post.title),
          author: typeof post.author === 'string' ? post.author : undefined,
          summary: `r/${textOf(post.subreddit)}`,
          body: selftext ? truncate(selftext, BODY_LIMIT) : undefined,
          metrics: compact({
            points: numberOrUndefined(post.score),
            comments: numberOrUndefined(post.num_comments),
          }),
          publishedAt:
            typeof post.created_utc === 'number'
              ? new Date(post.created_utc * 1000).toISOString()
              : undefined,
          coverage: coverage(
            selftext
              ? { status: 'available' }
              : isSelf
                ? { status: 'available', note: 'titleOnlyPost' }
                : { status: 'missing', note: 'linkedArticleNotFetched' },
            numberOrUndefined(post.num_comments)
              ? { status: 'notRequested' }
              : { status: 'available', note: 'noComments' },
            { media: { status: 'unavailable', note: 'mediaNotAnalyzed' } },
          ),
        } satisfies CollectedItem;
      }),
  };
}

async function collectRedditFeed(
  http: Http,
  names: string[],
  request: CollectRequest,
): Promise<CollectResult> {
  const entries = parseFeed(
    await http.text(
      `https://www.reddit.com/r/${names.join('+')}/new/.rss?limit=${Math.min(request.limit, 100)}`,
      request.signal,
    ),
  ).map((entry) => {
    // The RSS body is the post rendered with Reddit's "submitted by" footer; counts are not in the feed.
    const body = entry.body?.replace(/\s*submitted by[\s\S]*$/i, '').trim();
    return {
      ...entry,
      externalId: entry.externalId.replace(/^t3_/, ''),
      author: entry.author?.replace(/^\/u\//, ''),
      summary: undefined,
      body: body || undefined,
      coverage: coverage(
        body
          ? { status: 'available', note: 'redditRss' }
          : { status: 'missing', note: 'linkedArticleNotFetched' },
        { status: 'notRequested', note: 'countsUnknown' },
        { media: { status: 'unavailable', note: 'mediaNotAnalyzed' } },
      ),
    } satisfies CollectedItem;
  });
  const { fresh, truncated } = windowed(
    entries.map((entry) => entry.externalId),
    request,
  );
  const freshSet = new Set(fresh);
  return {
    status: 'ok',
    message: 'redditRssFallback',
    truncated,
    items: entries.filter((entry) => freshSet.has(entry.externalId)),
  };
}

async function enrichReddit(
  http: Http,
  request: EnrichRequest,
): Promise<EnrichResult> {
  if (!request.url) throw new AdapterError('unsupported', 'missingUrl');
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  const [, listing] = await http.json<[RedditListing, RedditListing]>(
    `https://www.reddit.com${path}.json?limit=${COMMENT_LIMIT}&depth=1&raw_json=1`,
    request.signal,
  );
  const children = listing?.data?.children ?? [];
  const comments: CommentEntry[] = children
    .filter((child) => child.kind === 't1')
    .map((child) => ({
      author:
        typeof child.data.author === 'string' ? child.data.author : undefined,
      text: truncate(textOf(child.data.body), 2_000),
      depth: 0,
    }))
    .filter((comment) => comment.text && comment.text !== '[deleted]');
  const more = children.some((child) => child.kind === 'more');
  return {
    status: 'ok',
    comments,
    coverage: {
      comments: {
        status: more ? 'partial' : 'available',
        note: `topLevel:${comments.length}`,
        fetchedAt: new Date().toISOString(),
      },
    },
  };
}

// RSS 2.0 and Atom.

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  isArray: (name) => ['item', 'entry', 'link'].includes(name),
});

function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number')
    return String(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return textOf(record['#text'] ?? record['@href'] ?? '');
  }
  return '';
}

function atomLink(value: unknown): string {
  if (typeof value === 'string') return value;
  const links = elements(value);
  const alternate =
    links.find((link) => (link['@rel'] ?? 'alternate') === 'alternate') ??
    links[0];
  return alternate ? textOf(alternate['@href']) : '';
}

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Walks parsed XML by element names; a missing step yields `undefined`. */
function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const name of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current))
      return undefined;
    current = (current as Record<string, unknown>)[name];
  }
  return current;
}

/** Parsed XML elements of one name: none, one or many become a list. */
function elements(value: unknown): Record<string, unknown>[] {
  const list = Array.isArray(value) ? (value as unknown[]) : [value];
  return list.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === 'object',
  );
}

/** Only http(s) links are stored: a feed or Collector controls this value and it ends up in an `href`. */
function webLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseFeed(source: string): CollectedItem[] {
  const document = xml.parse(source) as unknown;
  const channel = at(document, 'rss', 'channel') ?? at(document, 'rdf:RDF');
  if (channel) {
    const entries = elements(
      at(channel, 'item') ?? at(document, 'rdf:RDF', 'item'),
    );
    return entries.map((entry) => {
      const link = textOf(entry.link);
      const content = htmlToText(textOf(entry['content:encoded']));
      const description = htmlToText(textOf(entry.description));
      return {
        externalId: textOf(entry.guid) || link || textOf(entry.title),
        url: webLink(link),
        title: textOf(entry.title) || truncate(description, 120),
        author:
          textOf(entry['dc:creator']) || textOf(entry.author) || undefined,
        summary: description ? truncate(description, 600) : undefined,
        body: content ? truncate(content, BODY_LIMIT) : undefined,
        publishedAt: isoDate(textOf(entry.pubDate) || textOf(entry['dc:date'])),
        coverage: coverage(
          content
            ? { status: 'available', note: 'feedContent' }
            : description
              ? { status: 'partial', note: 'feedSummaryOnly' }
              : { status: 'missing' },
          { status: 'unavailable', note: 'feedHasNoComments' },
        ),
      } satisfies CollectedItem;
    });
  }
  const feed = at(document, 'feed');
  if (feed) {
    const entries = elements(at(feed, 'entry'));
    return entries.map((entry) => {
      const content = htmlToText(textOf(entry.content));
      const summary = htmlToText(
        textOf(entry.summary) ||
          textOf(at(entry, 'media:group', 'media:description')),
      );
      const views = Number(
        at(
          entry,
          'media:group',
          'media:community',
          'media:statistics',
          '@views',
        ),
      );
      return {
        externalId: textOf(entry['yt:videoId']) || textOf(entry.id),
        url: webLink(atomLink(entry.link)),
        title: textOf(entry.title),
        author: textOf(at(entry, 'author', 'name')) || undefined,
        summary: summary ? truncate(summary, 600) : undefined,
        body: content ? truncate(content, BODY_LIMIT) : summary || undefined,
        metrics: Number.isFinite(views) ? { views } : undefined,
        publishedAt: isoDate(textOf(entry.published) || textOf(entry.updated)),
        coverage: coverage(
          content
            ? { status: 'available', note: 'feedContent' }
            : summary
              ? { status: 'partial', note: 'feedSummaryOnly' }
              : { status: 'missing' },
          { status: 'unavailable', note: 'feedHasNoComments' },
        ),
      } satisfies CollectedItem;
    });
  }
  throw new AdapterError('failed', 'notAFeed');
}

async function collectFeed(
  http: Http,
  request: CollectRequest,
): Promise<CollectResult> {
  const source = await http.text(request.target, request.signal, {
    accept:
      'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5',
  });
  const entries = parseFeed(source);
  const { fresh, truncated } = windowed(
    entries.map((entry) => entry.externalId),
    request,
  );
  const freshSet = new Set(fresh);
  return {
    status: 'ok',
    truncated,
    items: entries.filter((entry) => freshSet.has(entry.externalId)),
  };
}

// YouTube: the channel's public upload feed, and oEmbed for a single video's metadata.

async function resolveChannelId(
  http: Http,
  target: string,
  signal: AbortSignal,
): Promise<string> {
  const direct = target.match(/UC[A-Za-z0-9_-]{22}/);
  if (direct) return direct[0];
  const handle = target.match(/@[A-Za-z0-9._-]{3,}/)?.[0];
  if (!handle) throw new AdapterError('unsupported', 'invalidChannel');
  const page = await http.text(`https://www.youtube.com/${handle}`, signal, {
    'accept-language': 'en',
  });
  const found =
    page.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/)?.[1] ??
    page.match(/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1];
  if (!found) throw new AdapterError('failed', 'channelNotResolved');
  return found;
}

async function collectYouTubeChannel(
  http: Http,
  request: CollectRequest,
): Promise<CollectResult> {
  const channelId =
    typeof request.cursor?.channelId === 'string'
      ? request.cursor.channelId
      : await resolveChannelId(http, request.target, request.signal);
  const entries = parseFeed(
    await http.text(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
      request.signal,
    ),
  ).map((entry) => ({
    ...entry,
    // The feed's text is the video description, not what is said in the video.
    body: undefined,
    coverage: coverage(
      { status: 'missing', note: 'descriptionOnly' },
      { status: 'unavailable', note: 'commentsNotSupported' },
      {
        transcript: { status: 'notRequested' },
        media: { status: 'unavailable', note: 'mediaNotAnalyzed' },
      },
    ),
  }));
  const { fresh, truncated } = windowed(
    entries.map((entry) => entry.externalId),
    request,
  );
  const freshSet = new Set(fresh);
  return {
    status: 'ok',
    truncated,
    cursor: { channelId },
    items: entries.filter((entry) => freshSet.has(entry.externalId)),
  };
}

function youTubeId(target: string): string | undefined {
  return (
    target.match(
      /(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/,
    )?.[1] ?? target.match(/^[A-Za-z0-9_-]{11}$/)?.[0]
  );
}

async function collectYouTubeVideo(
  http: Http,
  request: CollectRequest,
): Promise<CollectResult> {
  const id = youTubeId(request.target.trim());
  if (!id) throw new AdapterError('unsupported', 'invalidVideo');
  const url = `https://www.youtube.com/watch?v=${id}`;
  const meta = await http.json<{ title?: string; author_name?: string }>(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
    request.signal,
  );
  return {
    status: 'ok',
    items: request.knownIds.has(id)
      ? []
      : [
          {
            externalId: id,
            url,
            title: meta.title ?? id,
            author: meta.author_name,
            coverage: coverage(
              { status: 'missing', note: 'titleOnly' },
              { status: 'unavailable', note: 'commentsNotSupported' },
              {
                transcript: { status: 'notRequested' },
                media: { status: 'unavailable', note: 'mediaNotAnalyzed' },
              },
            ),
          },
        ],
  };
}

// Bilibili: the public video view API. Subtitles need a logged-in session and go through the Collector.

async function collectBilibiliVideo(
  http: Http,
  request: CollectRequest,
): Promise<CollectResult> {
  const bvid = request.target.match(/BV[0-9A-Za-z]{10}/)?.[0];
  if (!bvid) throw new AdapterError('unsupported', 'invalidVideo');
  const response = await http.json<{
    code: number;
    message?: string;
    data?: {
      title: string;
      desc?: string;
      pubdate?: number;
      videos?: number;
      owner?: { name?: string };
      stat?: { view?: number; like?: number; reply?: number };
    };
  }>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    request.signal,
    { referer: 'https://www.bilibili.com/' },
  );
  if (response.code !== 0 || !response.data) {
    throw new AdapterError(
      response.code === -352 || response.code === -412
        ? 'rateLimited'
        : 'failed',
      `bilibili ${response.code}: ${response.message ?? ''}`,
    );
  }
  const data = response.data;
  return {
    status: 'ok',
    items: request.knownIds.has(bvid)
      ? []
      : [
          {
            externalId: bvid,
            url: `https://www.bilibili.com/video/${bvid}`,
            title: data.title,
            author: data.owner?.name,
            summary: data.desc ? truncate(data.desc, 600) : undefined,
            metrics: compact({
              views: data.stat?.view,
              likes: data.stat?.like,
              comments: data.stat?.reply,
              parts: data.videos,
            }),
            publishedAt: data.pubdate
              ? new Date(data.pubdate * 1000).toISOString()
              : undefined,
            coverage: coverage(
              { status: 'missing', note: 'descriptionOnly' },
              { status: 'unavailable', note: 'commentsNotSupported' },
              {
                transcript: { status: 'notRequested' },
                media: { status: 'unavailable', note: 'mediaNotAnalyzed' },
              },
            ),
          },
        ],
  };
}

// The Docker Collector: fixed, registered actions behind one HTTP contract (see docs/collector.md).

interface CollectorResponse {
  status?: CollectResult['status'];
  message?: string;
  truncated?: boolean;
  cursor?: Record<string, unknown> | null;
  items?: CollectedItem[];
  item?: Omit<EnrichResult, 'status' | 'message'>;
}

function createCollectorClient(config: () => FeedConfig, http: Http) {
  const endpoint = (path: string) => {
    const base = config().collector.url;
    if (!base) throw new AdapterError('unconfigured', 'collectorNotConfigured');
    return `${base.replace(/\/$/, '')}${path}`;
  };
  const headers = (): Record<string, string> => {
    const token = config().collector.token;
    return token ? { authorization: `Bearer ${token}` } : {};
  };
  const options = (): RequestOptions => ({
    timeoutMs: config().collector.timeoutMs,
    service: true,
  });

  return {
    async collect(request: CollectRequest): Promise<CollectResult> {
      const response = await http.post<CollectorResponse>(
        endpoint('/v1/collect'),
        {
          platform: request.platform,
          operation: request.operation,
          target: request.target,
          limit: request.limit,
          cursor: request.cursor,
        },
        request.signal,
        headers(),
        options(),
      );
      const listed = (response.items ?? []).filter(
        (item) =>
          item &&
          typeof item.externalId === 'string' &&
          typeof item.title === 'string',
      );
      const items = listed.filter(
        (item) => !request.knownIds.has(item.externalId),
      );
      // A full page (the Collector says so, or it filled the limit) with nothing seen before may have skipped items
      // published since the last run; reaching a stored item closes the gap.
      const fullPageOfNew =
        request.knownIds.size > 0 &&
        items.length === listed.length &&
        (Boolean(response.truncated) || listed.length >= request.limit);
      return {
        status: response.status ?? 'ok',
        message: response.message,
        truncated: fullPageOfNew,
        cursor: response.cursor ?? request.cursor,
        items: items.map((item) => ({
          ...item,
          url: webLink(item.url),
          coverage: item.coverage ?? {
            body: { status: item.body ? 'available' : 'missing' },
            comments: { status: 'notRequested' },
          },
        })),
      };
    },
    async enrich(request: EnrichRequest): Promise<EnrichResult> {
      const response = await http.post<CollectorResponse>(
        endpoint('/v1/enrich'),
        {
          platform: request.platform,
          externalId: request.externalId,
          url: request.url,
          want: request.want,
        },
        request.signal,
        headers(),
        options(),
      );
      return {
        status: response.status ?? 'ok',
        message: response.message,
        ...(response.item ?? { coverage: {} }),
        coverage: response.item?.coverage ?? {},
      };
    },
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function compact(
  values: Record<string, number | undefined>,
): Record<string, number> | undefined {
  const entries = Object.entries(values).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number',
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}
