import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { expect, vi } from 'vitest';

import type { Adapters } from '../../server/providers/feed/adapters.js';
import { createFeedService } from '../../server/providers/feed/service.js';
import type {
  EnrichRequest,
  EnrichResult,
} from '../../server/providers/feed/types.js';
import { createStandaloneServer } from '../../server/standalone.js';

const ORIGIN = 'http://localhost';

const test = createAppTest({
  createServer: createStandaloneServer,
  connections: ['main'],
  config: {
    app: { publicOrigin: ORIGIN },
    auth: {
      secret: 'test-auth-secret-at-least-32-characters',
      trustedOrigins: [ORIGIN],
    },
    users: { initialAdmin: DEFAULT_ADMIN_CREDENTIALS },
  },
});

const CDN = 'https://sns-webpic-qc.xhscdn.com/202611040000/abc';
const titleOnly = {
  body: { status: 'missing', note: 'titleOnly' },
  comments: { status: 'notRequested' },
  media: { status: 'unavailable', note: 'mediaNotAnalyzed' },
};

// The tests share a database, so each run collects notes of its own.
let runs = 0;

/**
 * A Xiaohongshu keyword search that brings `count` title-only notes, and a Collector whose body answers come from
 * `answer` (by the note's position), the way the feed-collector answers `want: ['body']`.
 */
async function setUp(
  testApp: Parameters<typeof signIn>[0],
  {
    count = 2,
    answer = (index: number): EnrichResult => ({
      status: 'ok',
      body: `手冲第 ${index} 篇正文。\n\n第二段：水温 92 度。`,
      media: [
        { type: 'image', url: `${CDN}/${index}-1` },
        { type: 'image', url: `${CDN}/${index}-2` },
      ],
      coverage: { body: { status: 'available' } },
    }),
  }: {
    count?: number;
    answer?: (index: number) => EnrichResult;
  } = {},
) {
  const run = (runs += 1);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const database = (
    testApp as unknown as {
      application: {
        container: { resolve: (token: unknown) => DatabaseManager };
      };
    }
  ).application.container.resolve(databaseManagerToken);
  const externalId = (index: number) =>
    `${String(run).padStart(4, '0')}${String(index).padStart(20, '0')}`;
  const enrich = vi.fn(async (request: EnrichRequest) => {
    const index = Number(request.externalId.slice(4));
    return answer(index);
  });
  const generate = vi.fn(async () => ({
    text: JSON.stringify({
      verdict: 'learn',
      score: 70,
      interestLevel: 'high',
      experienceLevel: 'some',
      quality: {
        contentType: 'howto',
        substance: 7,
        novelty: 7,
        evidence: 7,
        usefulness: 7,
        noise: 'none',
      },
      lead: 'From the model.',
      steps: [],
    }),
  }));
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(async () => ({
        status: 'ok',
        items: Array.from({ length: count }, (_, index) => ({
          externalId: externalId(index + 1),
          url: `https://www.xiaohongshu.com/explore/${externalId(index + 1)}`,
          title: `手冲咖啡 ${index + 1}`,
          coverage: titleOnly,
        })),
        truncated: false,
      })),
      enrich,
      collectorConfigured: () => true,
    } as unknown as Adapters,
    agents: () =>
      ({
        models: {
          gateway: {
            catalog: async () => ({
              defaultModel: { modelService: 's', model: 'm' },
            }),
            generate,
          },
        },
      }) as never,
    config: () => ({
      collector: { timeoutMs: 1_000 },
      tickMinutes: 5,
      userAgent: 'test',
      notificationChannel: 'inbox',
    }),
    notify: async () => true,
    log: () => undefined,
  });
  const ownerId = admin.user.id;
  await service.saveProfile(ownerId, {
    interests: '手冲咖啡',
    expertise: '',
    avoid: '',
    dailyLimit: 100,
    keepLearning: true,
    locale: 'zh-CN',
  });
  const source = await service.createSource(ownerId, {
    platform: 'xiaohongshu',
    operation: 'keyword',
    name: '手冲咖啡',
    target: '手冲咖啡',
    frequency: 60,
    candidateLimit: 20,
    topicIds: [],
  });
  const items = async () =>
    (
      await database
        .query()
        .selectFrom('feedItems as i')
        .innerJoin('feedAnalyses as a', (join) =>
          join.onRef('a.itemId', '=', 'i.id').on('a.current', '=', true),
        )
        .select([
          'i.id as id',
          'i.externalId as externalId',
          'i.coverage as coverage',
          'a.gate as gate',
          'a.engine as engine',
        ])
        .where('i.ownerId', '=', ownerId)
        .where('i.sourceId', '=', source.id)
        .orderBy('i.id', 'asc')
        .execute<Record<string, unknown>>()
    ).map((row) => ({
      ...row,
      coverage:
        typeof row.coverage === 'string'
          ? JSON.parse(row.coverage)
          : row.coverage,
    })) as {
      id: number;
      externalId: string;
      coverage: { body: { status: string } };
      gate: string | null;
      engine: string;
    }[];
  return { service, ownerId, source, enrich, generate, items, externalId };
}

test('a search run fetches the text and pictures of its title-only notes and analyses those', async ({
  testApp,
}) => {
  const { service, ownerId, source, enrich, generate, items } =
    await setUp(testApp);

  await service.runSource(ownerId, source.id, 'manual');

  expect(enrich).toHaveBeenCalledTimes(2);
  expect(enrich.mock.calls[0]![0]).toMatchObject({
    platform: 'xiaohongshu',
    want: ['body'],
  });
  const rows = await items();
  expect(rows.map((row) => row.gate)).toEqual([null, null]);
  expect(rows.every((row) => row.engine === 'model')).toBe(true);
  // The model read the body and was told the pictures exist.
  const prompts = generate.mock.calls.map(
    (call) => (call as unknown as [{ prompt: string }])[0].prompt,
  );
  expect(
    prompts.some(
      (prompt) =>
        prompt.includes('第二段：水温 92 度。') &&
        prompt.includes('Media: 2 images'),
    ),
  ).toBe(true);

  const detail = await service.getItem(ownerId, rows[0]!.id);
  expect(detail.body).toBe('手冲第 1 篇正文。\n\n第二段：水温 92 度。');
  expect(detail.media).toEqual([
    { type: 'image', url: `${CDN}/1-1` },
    { type: 'image', url: `${CDN}/1-2` },
  ]);
  expect(detail.analysis?.gate).toBeNull();

  const { items: listed } = await service.listItems(ownerId, {
    view: 'all',
    pageSize: 50,
  } as never);
  const card = listed.find((item) => item.id === rows[0]!.id)!;
  expect(card.excerpt).toBe('手冲第 1 篇正文。\n\n第二段：水温 92 度。');
  expect(card.cover).toBe(`${CDN}/1-1`);
  expect(card.video).toBe(false);
});

test('a run fetches a few notes; the scheduled tick fetches the rest', async ({
  testApp,
}) => {
  const { service, ownerId, source, enrich, items } = await setUp(testApp, {
    count: 7,
  });

  await service.runSource(ownerId, source.id, 'manual');
  expect(enrich).toHaveBeenCalledTimes(5);
  expect(
    (await items()).filter((row) => row.gate === 'awaitingMaterial'),
  ).toHaveLength(2);

  await service.prefetchWaiting({ ownerId });
  expect(enrich).toHaveBeenCalledTimes(7);
  expect(
    (await items()).filter((row) => row.gate === 'awaitingMaterial'),
  ).toHaveLength(0);

  // Nothing is left waiting, so another tick fetches nothing.
  await service.prefetchWaiting({ ownerId });
  expect(enrich).toHaveBeenCalledTimes(7);
});

test('a sign-in wall stops fetching and leaves the notes to try again; a gone note is not retried', async ({
  testApp,
}) => {
  let signedIn = false;
  const { service, ownerId, source, enrich, items } = await setUp(testApp, {
    count: 3,
    answer: (index) =>
      index === 3
        ? { status: 'failed', message: 'notFound', coverage: {} }
        : signedIn
          ? {
              status: 'ok',
              body: `正文 ${index}`,
              coverage: { body: { status: 'available' } },
            }
          : { status: 'needsLogin', message: 'loginRequired', coverage: {} },
  });

  await service.runSource(ownerId, source.id, 'manual');
  // Newest first: the gone note fails on its own, then the wall stops the rest.
  expect(enrich).toHaveBeenCalledTimes(2);
  let rows = await items();
  expect(rows.map((row) => row.coverage.body.status)).toEqual([
    'missing',
    'missing',
    'failed',
  ]);

  signedIn = true;
  await service.prefetchWaiting({ ownerId });
  rows = await items();
  expect(rows.map((row) => row.coverage.body.status)).toEqual([
    'available',
    'available',
    'failed',
  ]);
  // The gone note was not asked for again.
  expect(
    enrich.mock.calls.filter(([request]) => request.externalId.endsWith('3')),
  ).toHaveLength(1);
});

test('a Collector without media keeps the text and stored pictures', async ({
  testApp,
}) => {
  let withMedia = true;
  const { service, ownerId, source, items } = await setUp(testApp, {
    count: 1,
    answer: () => ({
      status: 'ok',
      body: '正文',
      ...(withMedia
        ? { media: [{ type: 'video', url: `${CDN}/v.mp4`, cover: `${CDN}/c` }] }
        : {}),
      coverage: { body: { status: 'available' } },
    }),
  });
  await service.runSource(ownerId, source.id, 'manual');
  const [row] = await items();

  withMedia = false;
  const detail = await service.enrichItem(ownerId, row!.id);
  expect(detail.body).toBe('正文');
  expect(detail.media).toEqual([
    { type: 'video', url: `${CDN}/v.mp4`, cover: `${CDN}/c` },
  ]);
  expect(detail.cover).toBe(`${CDN}/c`);
  expect(detail.video).toBe(true);
});
