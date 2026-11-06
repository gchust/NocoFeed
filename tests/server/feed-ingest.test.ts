import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { describe, expect, it, vi } from 'vitest';

import type { Adapters } from '../../server/providers/feed/adapters.js';
import {
  createIngest,
  normalizeUrl,
  platformOfUrl,
} from '../../server/providers/feed/ingest.js';
import {
  assertPublicUrl,
  extractArticle,
  fetchPage,
  internalAddress,
} from '../../server/providers/feed/page.js';
import { createFeedService } from '../../server/providers/feed/service.js';
import type {
  CollectRequest,
  CollectResult,
} from '../../server/providers/feed/types.js';
import { createStandaloneServer } from '../../server/standalone.js';

const ORIGIN = 'http://localhost';

const test = createAppTest({
  createServer: createStandaloneServer,
  connections: ['main'],
  scope: 'test',
  config: {
    app: { publicOrigin: ORIGIN },
    auth: {
      secret: 'test-auth-secret-at-least-32-characters',
      trustedOrigins: [ORIGIN],
    },
    users: { initialAdmin: DEFAULT_ADMIN_CREDENTIALS },
  },
});

const ARTICLE = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Running Postgres on a tiny VPS">
<meta name="description" content="Notes from a year of keeping it alive">
<meta name="author" content="Ada">
<meta property="article:published_time" content="2026-10-30T09:00:00Z">
<meta property="og:image" content="https://cdn.example.com/cover.png">
</head><body>
<nav>Home · About</nav>
<article><h1>Running Postgres</h1><p>Set <b>shared_buffers</b> low.</p><script>track()</script><p>Back up nightly.</p></article>
<footer>© me</footer>
</body></html>`;

describe('reading a pushed page', () => {
  it('extracts the article and leaves the page chrome out', () => {
    const article = extractArticle({
      url: 'https://blog.example.com/post',
      html: ARTICLE,
      contentType: 'text/html',
    });
    expect(article).toEqual({
      title: 'Running Postgres on a tiny VPS',
      author: 'Ada',
      summary: 'Notes from a year of keeping it alive',
      body: 'Running Postgres\n\nSet shared_buffers low.\n\nBack up nightly.',
      publishedAt: '2026-10-30T09:00:00.000Z',
      media: [{ type: 'image', url: 'https://cdn.example.com/cover.png' }],
    });
  });

  it('never reaches an internal address, redirects included', async () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ])
      expect({ address, internal: internalAddress(address) }).toEqual({
        address,
        internal: true,
      });
    expect(internalAddress('93.184.216.34')).toBe(false);
    expect(internalAddress('2606:2800:220:1::1')).toBe(false);

    const lookup = async (host: string) =>
      host === 'internal.example.com' ? ['10.0.0.5'] : ['93.184.216.34'];
    for (const url of [
      'http://localhost/',
      'http://internal.example.com/',
      'http://[::1]/',
      'http://user:pass@example.com/',
      'http://example.com:22/',
      'file:///etc/passwd',
    ])
      await expect(assertPublicUrl(new URL(url), lookup)).rejects.toMatchObject(
        { message: 'pageUrlNotAllowed' },
      );
    await expect(
      assertPublicUrl(new URL('https://blog.example.com/x'), lookup),
    ).resolves.toBeUndefined();

    const fetchStub = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://internal.example.com/admin' },
        }),
    );
    await expect(
      fetchPage('https://blog.example.com/x', {
        signal: AbortSignal.timeout(5_000),
        userAgent: 'test',
        lookup,
        fetch: fetchStub as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ message: 'pageUrlNotAllowed' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('knows the links of platforms it reads itself', () => {
    expect(
      platformOfUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    ).toEqual({ platform: 'youtube', operation: 'video' });
    expect(platformOfUrl('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      platform: 'youtube',
      operation: 'video',
    });
    expect(
      platformOfUrl('https://www.bilibili.com/video/BV1xx411c7mD/'),
    ).toEqual({ platform: 'bilibili', operation: 'video' });
    expect(platformOfUrl('https://x.com/someone/status/12345')).toEqual({
      platform: 'x',
      operation: 'post',
    });
    expect(
      platformOfUrl('https://www.xiaohongshu.com/explore/64f0abc'),
    ).toEqual({ platform: 'xiaohongshu', operation: 'post' });
    expect(platformOfUrl('https://blog.example.com/post')).toBeNull();
    expect(normalizeUrl(' https://blog.example.com/post#comments ')).toBe(
      'https://blog.example.com/post',
    );
  });
});

async function setUp(testApp: Parameters<typeof signIn>[0]) {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const database = (
    testApp as unknown as {
      application: {
        container: { resolve: (token: unknown) => DatabaseManager };
      };
    }
  ).application.container.resolve(databaseManagerToken);
  const collect = vi.fn(
    async (request: CollectRequest): Promise<CollectResult> => ({
      status: 'ok',
      items: [
        {
          externalId: 'dQw4w9WgXcQ',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          title: 'A video about Postgres',
          author: 'A channel',
          coverage: {
            body: { status: 'missing', note: 'titleOnly' },
            comments: { status: 'unavailable' },
          },
        },
      ].filter(() => request.platform === 'youtube'),
    }),
  );
  const adapters = {
    collect,
    enrich: vi.fn(),
    collectorConfigured: () => false,
    replyCount: vi.fn(),
    metrics: vi.fn(),
  } as unknown as Adapters;
  const feed = createFeedService({
    database,
    adapters,
    agents: () => undefined,
    config: () => ({
      collector: { timeoutMs: 1_000 },
      tickMinutes: 5,
      userAgent: 'test',
      notificationChannel: 'inbox',
    }),
    notify: async () => true,
    log: () => undefined,
  });
  await feed.saveProfile(admin.user.id, {
    interests: 'postgres',
    expertise: '',
    avoid: '',
    dailyLimit: 0,
    keepLearning: true,
    locale: 'en-US',
  });
  const pages = vi.fn(
    async (url: URL | string) =>
      new Response(String(url).includes('missing') ? 'gone' : ARTICLE, {
        status: String(url).includes('missing') ? 404 : 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
  );
  const ingest = createIngest({
    database,
    adapters,
    feed: () => feed,
    userAgent: () => 'test',
    log: () => undefined,
    lookup: async () => ['93.184.216.34'],
    fetch: pages as unknown as typeof fetch,
  });
  const stored = async () =>
    (await database
      .query()
      .selectFrom('feedItems')
      .select([
        'id',
        'platform',
        'externalId',
        'url',
        'title',
        'body',
        'coverage',
      ])
      .where('ownerId', '=', admin.user.id)
      .orderBy('id', 'asc')
      .execute()) as Record<string, unknown>[];
  const analyses = async () =>
    (
      await database
        .query()
        .selectFrom('feedAnalyses')
        .select(['itemId'])
        .where('ownerId', '=', admin.user.id)
        .execute()
    ).map((row) => Number(row.itemId));
  return { admin, database, ingest, collect, pages, stored, analyses };
}

test('a link alone is read as an article, analysed, and stored once', async ({
  testApp,
}) => {
  const { admin, ingest, pages, collect, stored, analyses } =
    await setUp(testApp);
  const first = await ingest.ingest(
    admin.user.id,
    { url: 'https://blog.example.com/post#top' },
    { wait: true },
  );
  expect(first).toMatchObject({
    duplicate: false,
    fetched: 'page',
    title: 'Running Postgres on a tiny VPS',
    url: 'https://blog.example.com/post',
  });
  expect(collect).not.toHaveBeenCalled();
  const [row] = await stored();
  expect(row).toMatchObject({
    platform: 'inbox',
    externalId: 'https://blog.example.com/post',
    body: 'Running Postgres\n\nSet shared_buffers low.\n\nBack up nightly.',
  });
  expect(await analyses()).toEqual([first.itemId]);

  // The same link (another fragment) is the same item: nothing is fetched or analysed again.
  const again = await ingest.ingest(
    admin.user.id,
    { url: 'https://blog.example.com/post#comments', title: 'Mine' },
    { wait: true },
  );
  expect(again).toMatchObject({ duplicate: true, itemId: first.itemId });
  expect(pages).toHaveBeenCalledTimes(1);
  expect(await analyses()).toEqual([first.itemId]);
});

test('a link to a known platform goes through its adapter; one that cannot be read is kept', async ({
  testApp,
}) => {
  const { admin, database, ingest, collect, pages, stored } =
    await setUp(testApp);
  const video = await ingest.ingest(
    admin.user.id,
    { url: 'https://youtu.be/dQw4w9WgXcQ' },
    { wait: true },
  );
  expect(video).toMatchObject({
    fetched: 'platform',
    title: 'A video about Postgres',
  });
  expect(collect).toHaveBeenCalledWith(
    expect.objectContaining({
      platform: 'youtube',
      operation: 'video',
      target: 'https://youtu.be/dQw4w9WgXcQ',
    }),
  );
  expect(pages).not.toHaveBeenCalled();

  const missing = await ingest.ingest(
    admin.user.id,
    { url: 'https://blog.example.com/missing', title: 'Read later' },
    { wait: true },
  );
  expect(missing).toMatchObject({
    duplicate: false,
    fetched: 'failed',
    fetchError: 'blog.example.com answered 404',
    title: 'Read later',
  });
  const rows = await stored();
  expect(rows.map((row) => row.platform)).toEqual(['inbox', 'inbox']);
  expect(rows[1].title).toBe('Read later');

  // A link already collected from a subscription is not pushed again.
  const now = new Date();
  await database.repository('feedItems').createOne({
    values: {
      ownerId: admin.user.id,
      platform: 'hn',
      externalId: '42',
      url: 'https://news.example.com/story',
      title: 'Collected story',
      contentVersion: 1,
      timelineAt: now,
      fetchedAt: now,
      createdAt: now,
    },
  } as never);
  const collected = await ingest.ingest(admin.user.id, {
    url: 'https://news.example.com/story',
  });
  expect(collected).toMatchObject({
    duplicate: true,
    title: 'Collected story',
  });
});

test('a post sent with its text is stored as sent, deduplicated by its id or its text', async ({
  testApp,
}) => {
  const { admin, ingest, pages, stored, analyses } = await setUp(testApp);
  const post = await ingest.ingest(
    admin.user.id,
    {
      title: 'A thread about Postgres',
      content: 'First line\n\nMore text',
      url: 'https://forum.example.com/t/1',
      author: 'poster',
      externalId: 'forum-1',
    },
    { wait: true },
  );
  expect(post).toMatchObject({ fetched: 'none', duplicate: false });
  expect(pages).not.toHaveBeenCalled();
  expect(
    (
      await ingest.ingest(admin.user.id, {
        title: 'Changed',
        content: 'Changed',
        externalId: 'forum-1',
      })
    ).duplicate,
  ).toBe(true);

  const bare = { title: 'No link', content: 'Only text about Postgres' };
  const first = await ingest.ingest(admin.user.id, bare, { wait: true });
  expect(first.duplicate).toBe(false);
  expect((await ingest.ingest(admin.user.id, bare)).duplicate).toBe(true);
  const rows = await stored();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    externalId: 'forum-1',
    body: 'First line\n\nMore text',
  });
  expect(String(rows[1].externalId)).toMatch(/^sha256:/);
  expect((await analyses()).sort()).toEqual([post.itemId, first.itemId].sort());
});
