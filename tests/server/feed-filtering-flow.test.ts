import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { expect, vi } from 'vitest';

import type { Adapters } from '../../server/providers/feed/adapters.js';
import { createFeedService } from '../../server/providers/feed/service.js';
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

const coverage = {
  body: { status: 'missing' },
  comments: { status: 'notRequested' },
};
const collected = [
  {
    externalId: 'solid',
    title: 'Postgres backups restored in minutes',
    summary: 'Measurements.',
    coverage,
  },
  {
    externalId: 'advert',
    title: 'Postgres backups course, half price',
    summary: 'Sign up now.',
    coverage,
  },
  {
    externalId: 'unrelated',
    title: 'Growing tomatoes indoors',
    summary: 'Soil and light.',
    coverage,
  },
  { externalId: 'bare', title: 'Postgres backups', coverage },
];

const axes = {
  contentType: 'howto',
  substance: 8,
  novelty: 8,
  evidence: 8,
  usefulness: 8,
};

/** Answers by what the prompt carries, the way the real model would be given it. */
function fakeModel(prompt: string, prefilterFails: boolean): string {
  if (prompt.includes('"results"')) {
    if (prefilterFails) throw new Error('down');
    const index = prompt
      .split('\n')
      .find((line) => line.includes('tomatoes'))
      ?.match(/^\[(\d+)\]/)?.[1];
    return JSON.stringify({
      results: [{ i: Number(index), label: 'BLOCK' }],
    });
  }
  return JSON.stringify({
    verdict: 'discuss',
    score: 80,
    interestLevel: 'high',
    experienceLevel: 'some',
    quality: {
      ...axes,
      noise: prompt.includes('half price') ? 'promo' : 'none',
    },
    lead: 'From the model.',
    steps: [],
  });
}

// The tests share a database, so each run collects items of its own.
let runs = 0;

async function setUp(
  testApp: Parameters<typeof signIn>[0],
  { prefilterFails = false } = {},
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
  const generate = vi.fn(async ({ prompt }: { prompt: string }) => ({
    text: fakeModel(prompt, prefilterFails),
  }));
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(async () => ({
        status: 'ok',
        items: collected.map((item) => ({
          ...item,
          externalId: `${run}-${item.externalId}`,
          publishedAt: new Date().toISOString(),
        })),
        truncated: false,
      })),
      enrich: vi.fn(async () => ({
        status: 'ok',
        comments: [{ author: 'a', text: 'We do this too.', depth: 0 }],
        coverage: { comments: { status: 'available' } },
      })),
      collectorConfigured: () => false,
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
    interests: '',
    expertise: 'Postgres operations',
    avoid: '',
    dailyLimit: 50,
    keepLearning: true,
    locale: 'en-US',
  });
  await service.createTopic(ownerId, {
    name: 'Postgres',
    goal: 'postgres backups',
    avoid: null,
    mode: 'both',
    sourceIds: [],
  });
  const source = await service.createSource(ownerId, {
    platform: 'hn',
    operation: 'new',
    name: 'HN',
    target: '',
    frequency: 60,
    candidateLimit: 20,
    topicIds: [],
  });
  await service.runSource(ownerId, source.id, 'manual');
  const items = await database
    .query()
    .selectFrom('feedItems as i')
    .innerJoin('feedAnalyses as a', (join) =>
      join.onRef('a.itemId', '=', 'i.id').on('a.current', '=', true),
    )
    .select([
      'i.id as id',
      'i.externalId as externalId',
      'a.verdict as verdict',
      'a.gate as gate',
      'a.engine as engine',
      'a.quality as quality',
      'a.priority as priority',
    ])
    .where('i.ownerId', '=', ownerId)
    .execute<Record<string, unknown>>();
  const row = (externalId: string) =>
    items.find((item) => item.externalId === `${run}-${externalId}`)!;
  return { service, ownerId, generate, row, database };
}

const callsAbout = (
  generate: ReturnType<typeof vi.fn>,
  text: string,
  kind: 'prefilter' | 'analysis',
) =>
  generate.mock.calls.filter(
    ([{ prompt }]: [{ prompt: string }]) =>
      prompt.includes(text) &&
      prompt.includes('"results"') === (kind === 'prefilter'),
  ).length;

test('spends the model only on what could belong, and ranks by worth', async ({
  testApp,
}) => {
  const { generate, row, service, ownerId } = await setUp(testApp);

  expect(row('unrelated')).toMatchObject({
    verdict: 'ignore',
    gate: 'prefilter',
    engine: 'rules',
  });
  expect(callsAbout(generate, 'tomatoes', 'analysis')).toBe(0);
  // Keyword matches let an item through without asking.
  expect(callsAbout(generate, 'restored in minutes', 'prefilter')).toBe(0);

  expect(row('bare')).toMatchObject({
    gate: 'awaitingMaterial',
    engine: 'rules',
  });
  expect(row('bare').verdict).not.toBe('discuss');

  expect(row('solid')).toMatchObject({ engine: 'model', verdict: 'discuss' });
  // Selling is capped below the bar, so it is hidden however relevant.
  expect(row('advert')).toMatchObject({ quality: 20, verdict: 'ignore' });

  const { items } = await service.listItems(ownerId, {
    view: 'all',
    sort: 'priority',
    pageSize: 10,
  } as never);
  expect(items[0]?.title).toBe('Postgres backups restored in minutes');
  expect(items[0]?.quality).toBe(80);
});

test('stored analyses take on the current worth rules without asking the model', async ({
  testApp,
}) => {
  const { generate, row, service, database } = await setUp(testApp);
  const advert = Number(row('advert').id);
  // As the older, looser rules left it: capped at 30 and still shown.
  await database
    .query()
    .updateTable('feedAnalyses')
    .set({ quality: 30, priority: 0, verdict: 'learn' })
    .where('itemId', '=', advert)
    .where('current', '=', true)
    .execute();
  const current = () =>
    database
      .query()
      .selectFrom('feedAnalyses')
      .select(['quality', 'verdict'])
      .where('itemId', '=', advert)
      .where('current', '=', true)
      .executeTakeFirst<Record<string, unknown>>();
  const calls = generate.mock.calls.length;

  const preview = await service.reapplyWorth({ dryRun: true });
  expect(preview.hidden).toContain('Postgres backups course, half price');
  expect(await current()).toMatchObject({ quality: 30, verdict: 'learn' });

  const applied = await service.reapplyWorth();
  expect(applied.hidden).toContain('Postgres backups course, half price');
  expect(await current()).toMatchObject({ quality: 20, verdict: 'ignore' });
  // Solid content stays shown, and nothing was asked of the model.
  expect(applied.hidden).not.toContain('Postgres backups restored in minutes');
  expect(generate.mock.calls.length).toBe(calls);
  // Settled: a second pass has nothing left to change.
  expect((await service.reapplyWorth()).hidden).not.toContain(
    'Postgres backups course, half price',
  );
});

test('fetching material runs the analysis a bare title was waiting for', async ({
  testApp,
}) => {
  const { generate, row, service, ownerId } = await setUp(testApp);
  const id = Number(row('bare').id);
  const before = generate.mock.calls.length;

  const detail = await service.enrichItem(ownerId, id);

  expect(generate.mock.calls.length).toBeGreaterThan(before);
  expect(detail.analysis).toMatchObject({ engine: 'model', gate: null });
  expect(detail.analysisStale).toBe(false);
});

test('asking again analyses a bare title, without recommending joining in', async ({
  testApp,
}) => {
  const { row, service, ownerId } = await setUp(testApp);
  const detail = await service.reanalyzeItem(ownerId, Number(row('bare').id));
  expect(detail.analysis).toMatchObject({
    engine: 'model',
    gate: null,
    verdict: 'learn',
  });
});

test('asks again when an answer is cut off, and leaves room for reasoning', async ({
  testApp,
}) => {
  const { generate, row, service, ownerId } = await setUp(testApp);
  const id = Number(row('solid').id);
  generate.mockClear();
  generate.mockResolvedValueOnce({ text: '' });

  const detail = await service.reanalyzeItem(ownerId, id);

  expect(generate).toHaveBeenCalledTimes(2);
  expect(detail.analysis).toMatchObject({ engine: 'model' });
  const [[request]] = generate.mock.calls as unknown as [
    [{ maxOutputTokens: number }],
  ];
  expect(request.maxOutputTokens).toBeGreaterThanOrEqual(4_000);
});

test('accepts a daily limit up to 10000', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const profile = {
    interests: '',
    expertise: '',
    avoid: '',
    keepLearning: true,
    locale: 'en-US',
  };
  const save = (dailyLimit: number) =>
    admin.fetch('/feedProfile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ ...profile, dailyLimit }),
    });
  expect((await save(10_000)).status).toBe(200);
  expect((await save(10_001)).status).toBe(400);
});

test('a prefilter that fails stops nothing', async ({ testApp }) => {
  const { row } = await setUp(testApp, { prefilterFails: true });
  expect(row('unrelated')).toMatchObject({ gate: null, engine: 'model' });
});
