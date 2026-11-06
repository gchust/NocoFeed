import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FeedConfig } from '../../server/config/feed.js';
import {
  createAdapters,
  type Adapters,
} from '../../server/providers/feed/adapters.js';
import {
  ASK_PREPARE_MS,
  askSystemPrompt,
  createFeedAsk,
  originalRoute,
  type FeedAskDeps,
} from '../../server/providers/feed/ask.js';
import { readPageText } from '../../server/providers/feed/page.js';
import {
  createFeedService,
  type FeedItemDetail,
} from '../../server/providers/feed/service.js';
import {
  AdapterError,
  type EnrichRequest,
  type EnrichResult,
} from '../../server/providers/feed/types.js';
import { createStandaloneServer } from '../../server/standalone.js';

const OWNER = 'owner-1';
const PROFILE = { interests: 'Security', expertise: '', avoid: '' };

function item(values: Partial<FeedItemDetail>): FeedItemDetail {
  return {
    id: 1,
    title: 'A post',
    platform: 'rss',
    author: null,
    url: 'https://example.com/post',
    publishedAt: null,
    summary: null,
    body: null,
    comments: [],
    transcript: [],
    media: [],
    metrics: {},
    brief: null,
    analysis: null,
    enrichable: [],
    coverage: {
      body: { status: 'missing' },
      comments: { status: 'notRequested' },
    },
    ...values,
  } as FeedItemDetail;
}

/** `createFeedAsk` over one item in memory; `fetchParts` and `readPage` are the doubles the test gives. */
function asker(
  stored: FeedItemDetail,
  overrides: Partial<Pick<FeedAskDeps, 'fetchParts' | 'readPage'>> = {},
) {
  let current = stored;
  const fetchParts = vi.fn(
    overrides.fetchParts ??
      (async (): Promise<EnrichResult> => ({
        status: 'unsupported',
        coverage: {},
      })),
  );
  const readPage = vi.fn(
    overrides.readPage ??
      (async (url: string) => ({ url, title: 'Page', text: 'Page text.' })),
  );
  const ask = createFeedAsk({
    agents: () => undefined,
    getItem: async () => current,
    getProfile: async () => PROFILE as never,
    readPage,
    fetchParts,
    log: () => undefined,
  });
  return {
    ask,
    fetchParts,
    readPage,
    store: (next: Partial<FeedItemDetail>) => {
      current = { ...current, ...next };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the original is read where it can be read', () => {
  it('routes platform posts to their readers and other links to the page reader', () => {
    expect(
      originalRoute({ platform: 'x', url: 'https://x.com/a/status/1' }),
    ).toBe('platform');
    expect(
      originalRoute({
        platform: 'reddit',
        url: 'https://www.reddit.com/r/LocalLLaMA/comments/1xp9jt1/a/',
      }),
    ).toBe('platform');
    expect(
      originalRoute({
        platform: 'hn',
        url: 'https://news.ycombinator.com/item?id=2',
      }),
    ).toBe('platform');
    // A Hacker News story links to an article: that is a web page.
    expect(
      originalRoute({ platform: 'hn', url: 'https://example.com/article' }),
    ).toBe('page');
    expect(
      originalRoute({ platform: 'rss', url: 'https://x.com/a/status/1' }),
    ).toBe('page');
    expect(originalRoute({ platform: 'rss', url: null })).toBe('none');
  });

  it('reads an X post through the Collector and never as a web page', async () => {
    const { ask, fetchParts, readPage, store } = asker(
      item({
        platform: 'x',
        url: 'https://x.com/a/status/1',
        body: 'The post.',
      }),
      {
        fetchParts: async () => {
          store({
            comments: [{ author: 'b', text: 'A reply', depth: 0 }],
            coverage: {
              body: { status: 'available' },
              comments: { status: 'partial', note: 'topLevel:1/4' },
            },
          });
          return {
            status: 'ok',
            coverage: { comments: { status: 'partial' } },
          };
        },
      },
    );
    const result = await ask.readOriginalOf(
      OWNER,
      item({ platform: 'x', url: 'https://x.com/a/status/1' }),
    );
    expect(fetchParts).toHaveBeenCalledWith(OWNER, 1, ['body', 'comments']);
    expect(readPage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'ok',
      via: 'collector',
      text: 'The post.',
      commentCount: 1,
      comments: [{ author: 'b', text: 'A reply' }],
    });
  });

  it('reads a Reddit post natively and a video for its subtitles', async () => {
    const reddit = asker(
      item({
        platform: 'reddit',
        url: 'https://www.reddit.com/r/a/comments/b/c/',
      }),
    );
    const read = await reddit.ask.readOriginalOf(
      OWNER,
      item({
        platform: 'reddit',
        url: 'https://www.reddit.com/r/a/comments/b/c/',
      }),
    );
    expect(read.via).toBe('native');
    expect(reddit.readPage).not.toHaveBeenCalled();

    const video = asker(item({ platform: 'youtube' }));
    await video.ask.readOriginalOf(
      OWNER,
      item({ platform: 'youtube', url: 'https://www.youtube.com/watch?v=abc' }),
    );
    expect(video.fetchParts).toHaveBeenCalledWith(OWNER, 1, ['transcript']);
  });

  it('reads any other link as a web page', async () => {
    const { ask, fetchParts, readPage } = asker(item({}));
    const result = await ask.readOriginalOf(OWNER, item({}));
    expect(readPage).toHaveBeenCalledWith(
      'https://example.com/post',
      expect.any(AbortSignal),
    );
    expect(fetchParts).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'ok',
      via: 'page',
      text: 'Page text.',
    });
  });

  it('says why when it cannot: platform, kind of failure and whether to try again', async () => {
    const x = asker(item({ platform: 'x', url: 'https://x.com/a/status/1' }), {
      fetchParts: async () => ({
        status: 'needsLogin',
        message: 'loginRequired',
        coverage: {},
      }),
    });
    expect(
      await x.ask.readOriginalOf(
        OWNER,
        item({ platform: 'x', url: 'https://x.com/a/status/1' }),
      ),
    ).toMatchObject({
      platform: 'x',
      via: 'collector',
      status: 'unavailable',
      failure: {
        reason: 'needsLogin',
        retryable: false,
        detail: 'loginRequired',
      },
    });

    const page = asker(item({}), {
      readPage: async () => {
        throw new AdapterError('blocked', 'example.com answered 403');
      },
    });
    const blocked = await page.ask.readOriginalOf(OWNER, item({}));
    expect(blocked).toMatchObject({
      via: 'page',
      status: 'unavailable',
      failure: { reason: 'blocked', retryable: false },
    });
    expect(
      (blocked as { failure: { explanation: string } }).failure.explanation,
    ).toContain('refused this server');

    const limited = asker(
      item({
        platform: 'reddit',
        url: 'https://www.reddit.com/r/a/comments/b/',
      }),
      {
        fetchParts: async () => ({
          status: 'rateLimited',
          message: 'www.reddit.com answered 429',
          coverage: {},
        }),
      },
    );
    expect(
      await limited.ask.readCommentsOf(
        OWNER,
        item({
          platform: 'reddit',
          url: 'https://www.reddit.com/r/a/comments/b/',
        }),
      ),
    ).toMatchObject({
      status: 'unavailable',
      failure: { reason: 'rateLimited', retryable: true },
    });
  });

  it('never opens a local or private address', async () => {
    for (const url of [
      'http://localhost:3000/',
      'http://127.0.0.1/',
      'http://10.0.0.8/',
      'http://[::1]/',
      'https://user:pw@example.com/',
    ]) {
      await expect(
        readPageText(url, {
          signal: new AbortController().signal,
          userAgent: 'test',
          lookup: async () => ['93.184.216.34'],
        }),
      ).rejects.toMatchObject({ status: 'unsupported' });
    }
  });
});

describe('before the first question', () => {
  const thread = item({
    platform: 'reddit',
    url: 'https://www.reddit.com/r/LocalLLaMA/comments/1xp9jt1/a/',
    body: 'Kimi K3.1 and Hy4 are gutting security data.',
    coverage: {
      body: { status: 'available', note: 'redditRss' },
      comments: { status: 'notRequested', note: 'countsUnknown' },
    },
  });

  it('fetches the missing comments and the prompt carries them and says so', async () => {
    const { ask, fetchParts, store } = asker(thread, {
      fetchParts: async () => {
        store({
          comments: [
            { author: 'into_devoid', text: 'Governments want exploits.' },
            { author: 'someone', text: 'Use an abliterated model.' },
          ],
          coverage: {
            body: { status: 'available', note: 'redditRss' },
            comments: { status: 'partial', note: 'redditRss' },
          },
        });
        return { status: 'ok', coverage: {} };
      },
    });
    const prepared = await ask.prepare(OWNER, thread);
    expect(fetchParts).toHaveBeenCalledWith(OWNER, 1, ['comments']);
    expect(prepared.report.parts).toEqual([
      { part: 'comments', state: 'fetched' },
    ]);
    const prompt = askSystemPrompt(prepared.item, PROFILE, {
      tools: true,
      material: prepared.report,
    });
    expect(prompt).toContain('Governments want exploits.');
    expect(prompt).toContain('Comments: fetched just now, 2');
    expect(prompt).toContain('no web search');
  });

  it('does not fetch again what is stored', async () => {
    const { ask, fetchParts } = asker(thread);
    await ask.prepare(OWNER, {
      ...thread,
      coverage: {
        body: { status: 'available' },
        comments: { status: 'partial' },
      },
    });
    expect(fetchParts).not.toHaveBeenCalled();
  });

  it('waits at most a while, then starts without it and says it timed out', async () => {
    vi.useFakeTimers();
    const { ask } = asker(thread, {
      fetchParts: () => new Promise<EnrichResult>(() => undefined),
    });
    const pending = ask.prepare(OWNER, thread);
    await vi.advanceTimersByTimeAsync(ASK_PREPARE_MS);
    const prepared = await pending;
    expect(prepared.report.parts).toEqual([
      {
        part: 'comments',
        state: 'missing',
        failure: expect.objectContaining({
          reason: 'timeout',
          retryable: true,
        }),
      },
    ]);
    expect(
      askSystemPrompt(prepared.item, PROFILE, {
        tools: true,
        material: prepared.report,
      }),
    ).toMatch(/Comments: not read: timeout/);
  });

  it('a failing fetch does not stop the conversation', async () => {
    const { ask } = asker(thread, {
      fetchParts: async () => {
        throw new Error('database is gone');
      },
    });
    const prepared = await ask.prepare(OWNER, thread);
    expect(prepared.report.parts[0]).toMatchObject({
      state: 'missing',
      failure: { reason: 'failed' },
    });
  });

  it('reads the page of a link with no text stored and puts it in the prompt', async () => {
    const link = item({
      platform: 'rss',
      url: 'https://www.infoq.cn/article/abc',
      summary: 'Hy4 hands-on',
      coverage: {
        body: { status: 'partial', note: 'feedSummaryOnly' },
        comments: { status: 'unavailable', note: 'feedHasNoComments' },
      },
    });
    const { ask, readPage } = asker(link, {
      readPage: async (url) => ({
        url,
        title: 'Hy4',
        text: 'Hy4 scores well on agent benchmarks.',
      }),
    });
    const prepared = await ask.prepare(OWNER, link);
    expect(readPage).toHaveBeenCalledOnce();
    const prompt = askSystemPrompt(prepared.item, PROFILE, {
      tools: true,
      webSearch: true,
      material: prepared.report,
    });
    expect(prompt).toContain('Hy4 scores well on agent benchmarks.');
    expect(prompt).toContain('read when the conversation started');
    expect(prompt).not.toContain('no web search');
  });

  it('a page that refuses this server is reported with its reason', async () => {
    const link = item({ url: 'https://example.com/post' });
    const { ask } = asker(link, {
      readPage: async () => {
        throw new AdapterError('blocked', 'example.com answered 403');
      },
    });
    const prepared = await ask.prepare(OWNER, link);
    expect(
      askSystemPrompt(prepared.item, PROFILE, {
        tools: true,
        material: prepared.report,
      }),
    ).toContain(
      'Original page https://example.com/post: not read: blocked, the site refused this server',
    );
  });
});

describe('Reddit comments when the JSON is refused', () => {
  const config = (): FeedConfig => ({
    collector: { url: '', token: '', timeoutMs: 1_000 },
    tickMinutes: 5,
    userAgent: 'NocoFeed-test',
    notificationChannel: 'inbox',
  });
  const entry = (id: string, author: string, html: string) =>
    `<entry><author><name>/u/${author}</name></author><content type="html">${html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(
        />/g,
        '&gt;',
      )}</content><id>${id}</id><link href="https://www.reddit.com/r/LocalLLaMA/comments/1xp9jt1/x/${id}/"/><updated>2026-11-06T10:37:13+00:00</updated><title>${author} on the post</title></entry>`;
  const atom = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>The post : LocalLLaMA</title>${entry(
    't3_1xp9jt1',
    'Fresh_Sun_1017',
    '<div class="md"><p>Kimi K3.1 and Hy4 are gutting security data.</p></div> submitted by <a>/u/Fresh_Sun_1017</a>',
  )}${entry(
    't1_19s81ksvhpgch',
    'changing_who_i_am',
    '<!-- SC_OFF --><div class="md"><p>Is this the companies, or the government?</p></div><!-- SC_ON -->',
  )}${entry(
    't1_19s81p90w3hmo',
    'into_devoid',
    '<div class="md"><p>Governments want to find vulnerabilities.</p><p>Simple</p></div>',
  )}</feed>`;

  it('reads the post RSS: every comment, flat, marked partial', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.includes('.json'))
          return new Response('<html>blocked</html>', { status: 403 });
        if (url.includes('/.rss'))
          return new Response(atom, {
            headers: { 'content-type': 'application/atom+xml' },
          });
        return new Response('not found', { status: 404 });
      }),
    );
    const result = await createAdapters(config).enrich({
      platform: 'reddit',
      externalId: '1xp9jt1',
      url: 'https://www.reddit.com/r/LocalLLaMA/comments/1xp9jt1/latest_opensource_labs/',
      want: ['comments'],
      signal: new AbortController().signal,
    });
    expect(requested[1]).toBe(
      'https://www.reddit.com/r/LocalLLaMA/comments/1xp9jt1/.rss?limit=100',
    );
    expect(result.status).toBe('ok');
    expect(result.comments).toEqual([
      {
        author: 'changing_who_i_am',
        text: 'Is this the companies, or the government?',
        depth: 0,
      },
      {
        author: 'into_devoid',
        text: 'Governments want to find vulnerabilities.\n\nSimple',
        depth: 0,
      },
    ]);
    expect(result.coverage.comments).toMatchObject({
      status: 'partial',
      note: 'redditRss',
    });
    // Only what was asked for: the post's body is not replaced.
    expect(result.body).toBeUndefined();
  });
});

const test = createAppTest({
  createServer: createStandaloneServer,
  connections: ['main'],
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: {
      secret: 'test-auth-secret-at-least-32-characters',
      trustedOrigins: ['http://localhost'],
    },
    users: { initialAdmin: DEFAULT_ADMIN_CREDENTIALS },
  },
});

test('fetched comments are stored on the item, so the next conversation does not fetch them again', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const database = (
    testApp as unknown as {
      application: {
        container: { resolve: (token: unknown) => DatabaseManager };
      };
    }
  ).application.container.resolve(databaseManagerToken);
  const enrich = vi.fn(
    async (request: EnrichRequest): Promise<EnrichResult> => ({
      status: 'ok',
      message: 'redditRssFallback',
      comments: [{ author: 'into_devoid', text: 'Simple.', depth: 0 }],
      coverage: {
        comments: {
          status: 'partial',
          note: 'redditRss',
          fetchedAt: new Date().toISOString(),
        },
      },
      ...(request.want.includes('body') ? { body: 'never asked' } : {}),
    }),
  );
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(),
      enrich,
      collectorConfigured: () => false,
    } as unknown as Adapters,
    agents: () => undefined,
    config: () => ({
      collector: { url: '', token: '', timeoutMs: 1_000 },
      tickMinutes: 5,
      userAgent: 'test',
      notificationChannel: 'inbox',
    }),
    notify: async () => true,
    log: () => undefined,
  });
  const ownerId = admin.user.id;
  const now = new Date();
  const create = async (values: Record<string, unknown>) =>
    Number(
      (
        (await database.repository('feedItems').createOne({
          values: {
            ownerId,
            externalId: `material-${Math.random()}`,
            title: 'Latest open-source labs are gutting security',
            body: 'Kimi K3.1 and Hy4.',
            contentVersion: 1,
            fetchedAt: now,
            createdAt: now,
            ...values,
          },
        } as never)) as { record: { id: number } }
      ).record.id,
    );
  const redditId = await create({
    platform: 'reddit',
    url: 'https://www.reddit.com/r/LocalLLaMA/comments/1xp9jt1/a/',
    coverage: {
      body: { status: 'available', note: 'redditRss' },
      comments: { status: 'notRequested', note: 'countsUnknown' },
    },
  });
  const ask = createFeedAsk({
    agents: () => undefined,
    getItem: (owner, id) => service.getItem(owner, id),
    getProfile: (owner) => service.getProfile(owner),
    readPage: vi.fn(),
    fetchParts: (owner, id, want) => service.fetchParts(owner, id, want),
    log: () => undefined,
  });

  const first = await ask.prepare(
    ownerId,
    await service.getItem(ownerId, redditId),
  );
  expect(first.report.parts).toEqual([{ part: 'comments', state: 'fetched' }]);
  expect(enrich).toHaveBeenCalledOnce();
  const stored = await service.getItem(ownerId, redditId);
  expect(stored.comments).toEqual([
    { author: 'into_devoid', text: 'Simple.', depth: 0 },
  ]);
  expect(stored.coverage.comments).toMatchObject({ status: 'partial' });
  expect(stored.body).toBe('Kimi K3.1 and Hy4.');

  // The next conversation finds them stored; the comments tool does not fetch them again within half an hour.
  await ask.prepare(ownerId, stored);
  const read = await ask.readCommentsOf(ownerId, stored);
  expect(enrich).toHaveBeenCalledOnce();
  expect(read).toMatchObject({ status: 'ok', commentCount: 1 });

  // An X post without a Collector: nothing is fetched, and the reason says the Collector is missing.
  const xId = await create({
    platform: 'x',
    url: 'https://x.com/a/status/1',
    coverage: {
      body: { status: 'available' },
      comments: { status: 'notRequested' },
    },
  });
  const x = await ask.prepare(ownerId, await service.getItem(ownerId, xId));
  expect(enrich).toHaveBeenCalledOnce();
  expect(x.report.parts).toEqual([
    {
      part: 'comments',
      state: 'missing',
      failure: expect.objectContaining({
        reason: 'unconfigured',
        retryable: false,
      }),
    },
  ]);
});
