import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { describe, expect, it, vi } from 'vitest';

import type { Adapters } from '../../server/providers/feed/adapters.js';
import {
  collectWindow,
  createFeedService,
  withinWindow,
} from '../../server/providers/feed/service.js';
import type {
  CollectRequest,
  CollectResult,
  CollectedItem,
} from '../../server/providers/feed/types.js';
import { createStandaloneServer } from '../../server/standalone.js';

const ORIGIN = 'http://localhost';
const DAY = 86_400_000;

const test = createAppTest({
  createServer: createStandaloneServer,
  connections: ['main'],
  // Each test counts and orders the whole feed, so each starts on fresh databases.
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

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const entry = (externalId: string, publishedAt?: string): CollectedItem => ({
  externalId,
  title: `Item ${externalId}`,
  url: `https://example.com/${externalId}`,
  publishedAt,
  coverage: {
    body: { status: 'missing' },
    comments: { status: 'notRequested' },
  },
});

describe('collectWindow', () => {
  const now = new Date('2026-11-10T00:00:00Z');

  it('starts at the cutoff on the first run, then shortly before the last success', () => {
    expect(collectWindow(7, null, now)).toEqual({
      cutoff: new Date('2026-11-03T00:00:00Z'),
      since: new Date('2026-11-03T00:00:00Z'),
    });
    expect(collectWindow(7, '2026-11-09T12:00:00Z', now)).toEqual({
      cutoff: new Date('2026-11-03T00:00:00Z'),
      since: new Date('2026-11-08T12:00:00Z'),
    });
    // A long pause never reaches back past the window.
    expect(collectWindow(7, '2026-10-01T00:00:00Z', now)?.since).toEqual(
      new Date('2026-11-03T00:00:00Z'),
    );
  });

  it('is absent when the person keeps everything', () => {
    expect(collectWindow(0, '2026-11-09T12:00:00Z', now)).toBeNull();
  });
});

describe('withinWindow', () => {
  const cutoff = new Date(Date.now() - 7 * DAY);

  it('drops what is older, keeps what is undated, and closes the window', () => {
    const result: CollectResult = {
      status: 'ok',
      truncated: true,
      items: [
        entry('new', ago(DAY)),
        entry('undated'),
        entry('old', ago(30 * DAY)),
      ],
    };
    const kept = withinWindow(result, cutoff);
    expect(kept.items.map((item) => item.externalId)).toEqual([
      'new',
      'undated',
    ]);
    expect(kept.truncated).toBe(false);
  });

  it('leaves a result with nothing old as it was', () => {
    const result: CollectResult = {
      status: 'ok',
      truncated: true,
      items: [entry('new', ago(DAY))],
    };
    expect(withinWindow(result, cutoff)).toBe(result);
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
  const profile = (maxAgeDays?: number) =>
    admin.fetch(
      '/feedProfile',
      json('PUT', {
        interests: 'databases',
        expertise: '',
        avoid: '',
        dailyLimit: 0,
        keepLearning: true,
        locale: 'en-US',
        ...(maxAgeDays === undefined ? {} : { maxAgeDays }),
      }),
    );
  await profile();
  const created = await admin.fetch(
    '/feedSources',
    json('POST', {
      platform: 'rss',
      operation: 'feed',
      name: 'Blog',
      target: 'https://example.com/feed.xml',
      frequency: 60,
    }),
  );
  const { data: source } = (await created.json()) as { data: { id: number } };

  let answer: CollectedItem[] = [];
  const requests: CollectRequest[] = [];
  const collect = vi.fn(async (request: CollectRequest) => {
    requests.push(request);
    return { status: 'ok', items: answer } satisfies CollectResult;
  });
  const service = createFeedService({
    database,
    adapters: {
      collect,
      enrich: vi.fn(),
      collectorConfigured: () => false,
      replyCount: vi.fn(),
    } as unknown as Adapters,
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
  const run = async (items: CollectedItem[]) => {
    answer = items;
    return service.runSource(admin.user.id, source.id, 'manual');
  };
  const stored = async () =>
    (
      await database
        .query()
        .selectFrom('feedItems')
        .select(['externalId'])
        .where('ownerId', '=', admin.user.id)
        .orderBy('externalId', 'asc')
        .execute()
    ).map((row) => String(row.externalId));
  const analyses = async () =>
    (
      await database
        .query()
        .selectFrom('feedAnalyses')
        .select(['itemId'])
        .where('ownerId', '=', admin.user.id)
        .execute()
    ).length;
  return { admin, database, service, profile, run, requests, stored, analyses };
}

test('collection keeps only what is new and never fetches or analyses an item twice', async ({
  testApp,
}) => {
  const { admin, profile, run, requests, stored, analyses } =
    await setUp(testApp);
  const profileData = (await (await admin.fetch('/feedProfile')).json()) as {
    data: { maxAgeDays: number };
  };
  expect(profileData.data.maxAgeDays).toBe(7);

  const started = Date.now();
  const first = await run([
    entry('fresh', ago(DAY)),
    entry('undated'),
    entry('stale', ago(30 * DAY)),
  ]);
  expect(first.status).toBe('succeeded');
  expect(first.inserted).toBe(2);
  // The first run asks for the whole window.
  const firstSince = requests[0].since!.getTime();
  expect(Math.abs(firstSince - (started - 7 * DAY))).toBeLessThan(60_000);
  expect(await stored()).toEqual(['fresh', 'undated']);
  expect(await analyses()).toBe(2);

  // The next run asks from shortly before the last one; what is stored already is neither stored nor analysed again.
  const second = await run([
    entry('newer', ago(1_000)),
    entry('fresh', ago(DAY)),
    entry('undated'),
  ]);
  expect(second.inserted).toBe(1);
  const secondSince = requests[1].since!.getTime();
  expect(Math.abs(secondSince - (Date.now() - DAY))).toBeLessThan(60_000);
  expect([...requests[1].knownIds].sort()).toEqual(['fresh', 'undated']);
  expect(await stored()).toEqual(['fresh', 'newer', 'undated']);
  expect(await analyses()).toBe(3);

  // Keeping everything sends no window and stores the old item too.
  expect((await profile(0)).status).toBe(200);
  await run([entry('stale', ago(30 * DAY))]);
  expect(requests[2].since).toBeNull();
  expect(await stored()).toEqual(['fresh', 'newer', 'stale', 'undated']);
});

test('the feed lists newest first and by publication period', async ({
  testApp,
}) => {
  const { admin, database, run } = await setUp(testApp);
  await run([
    entry('today', ago(2 * 3_600_000)),
    entry('this-week', ago(3 * DAY)),
    entry('undated'),
  ]);
  // Keep them all under "Later", so the verdict of the rules does not matter here.
  const items = await database
    .query()
    .selectFrom('feedItems')
    .select(['id'])
    .where('ownerId', '=', admin.user.id)
    .execute();
  for (const item of items)
    await admin.fetch(
      `/feedItems/${item.id}/state`,
      json('PATCH', { later: true }),
    );

  const titles = async (query: string) =>
    (
      (await (
        await admin.fetch(`/feedItems?view=later&pageSize=10${query}`)
      ).json()) as { data: { title: string }[] }
    ).data.map((item) => item.title);
  // Undated items sit where they were collected: now.
  expect(await titles('&sort=newest')).toEqual([
    'Item undated',
    'Item today',
    'Item this-week',
  ]);
  expect(await titles('&sort=newest&period=day')).toEqual([
    'Item undated',
    'Item today',
  ]);
  expect((await titles('&period=week')).sort()).toEqual([
    'Item this-week',
    'Item today',
    'Item undated',
  ]);
  const summary = (await (
    await admin.fetch('/feedItems/summary?period=day')
  ).json()) as { data: { later: number } };
  expect(summary.data.later).toBe(2);
  expect((await admin.fetch('/feedItems?period=year')).status).toBe(400);
});
