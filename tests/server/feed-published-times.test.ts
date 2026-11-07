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
  CollectedItem,
  EnrichRequest,
  EnrichResult,
} from '../../server/providers/feed/types.js';
import { createStandaloneServer } from '../../server/standalone.js';

const ORIGIN = 'http://localhost';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

const titleOnly = {
  body: { status: 'missing', note: 'titleOnly' },
  comments: { status: 'notRequested' },
  transcript: { status: 'notRequested' },
} as const;

// The tests share a database, so each one collects videos of its own.
let runs = 0;

/**
 * A YouTube keyword search through a stubbed Collector: one video said to be "2 days ago" (an approximate time), one
 * whose relative text was not understood (no time), one with an exact time. `published` answers the exact-time lookup.
 */
async function setUp(
  testApp: Parameters<typeof signIn>[0],
  published: (externalId: string) => EnrichResult,
) {
  const run = (runs += 1);
  const id = (name: string) => `${name}${String(run).padStart(4, '0')}`;
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const database = (
    testApp as unknown as {
      application: {
        container: { resolve: (token: unknown) => DatabaseManager };
      };
    }
  ).application.container.resolve(databaseManagerToken);
  const collectedAt = Date.now();
  const approximate = new Date(collectedAt - 2 * DAY).toISOString();
  const exact = new Date(collectedAt - 5 * HOUR).toISOString();
  const items: CollectedItem[] = [
    {
      externalId: id('approx'),
      url: `https://www.youtube.com/watch?v=${id('approx')}`,
      title: 'Approx',
      publishedAt: approximate,
      publishedAtApproximate: true,
      coverage: titleOnly,
    },
    {
      externalId: id('undated'),
      url: `https://www.youtube.com/watch?v=${id('undated')}`,
      title: 'Undated',
      coverage: titleOnly,
    },
    {
      externalId: id('exact'),
      url: `https://www.youtube.com/watch?v=${id('exact')}`,
      title: 'Exact',
      publishedAt: exact,
      coverage: titleOnly,
    },
  ];
  const enrich = vi.fn(async (request: EnrichRequest) =>
    published(request.externalId),
  );
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(async () => ({ status: 'ok', items, truncated: false })),
      enrich,
      collectorConfigured: () => true,
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
  const ownerId = admin.user.id;
  await service.saveProfile(ownerId, {
    interests: 'nocobase',
    expertise: '',
    avoid: '',
    dailyLimit: 0,
    keepLearning: true,
    locale: 'en-US',
  });
  const source = await service.createSource(ownerId, {
    platform: 'youtube',
    operation: 'keyword',
    name: 'NocoBase',
    target: 'nocobase',
    frequency: 60,
    candidateLimit: 20,
    topicIds: [],
  });
  const stored = async (externalId: string) =>
    (await database
      .query()
      .selectFrom('feedItems')
      .select([
        'id',
        'ownerId',
        'publishedAt',
        'publishedApproximate',
        'publishedCheckedAt',
        'timelineAt',
        'createdAt',
      ])
      .where('externalId', '=', externalId)
      .orderBy('id', 'asc')
      .execute<Record<string, unknown>>()) as {
      id: number;
      ownerId: string;
      publishedAt: string | Date | null;
      publishedApproximate: boolean | number;
      publishedCheckedAt: string | Date | null;
      timelineAt: string | Date;
      createdAt: string | Date;
    }[];
  const time = (value: string | Date | null) =>
    value == null ? null : new Date(value).toISOString();
  return {
    service,
    database,
    ownerId,
    source,
    enrich,
    stored,
    time,
    id,
    approximate,
    exact,
  };
}

test('an approximate time is kept as approximate and an unknown one is never the collection time', async ({
  testApp,
}) => {
  const { service, ownerId, source, stored, time, id, approximate, exact } =
    await setUp(testApp, () => ({ status: 'ok', coverage: {} }));
  await service.runSource(ownerId, source.id, 'manual');

  const [approx] = await stored(id('approx'));
  expect(time(approx!.publishedAt)).toBe(approximate);
  expect(Boolean(approx!.publishedApproximate)).toBe(true);
  expect(time(approx!.timelineAt)).toBe(approximate);

  const [undated] = await stored(id('undated'));
  expect(undated!.publishedAt).toBeNull();
  expect(Boolean(undated!.publishedApproximate)).toBe(false);
  // It still needs a place in time: when it was collected, but not as its publication time.
  expect(time(undated!.timelineAt)).toBe(time(undated!.createdAt));

  const [dated] = await stored(id('exact'));
  expect(time(dated!.publishedAt)).toBe(exact);
  expect(Boolean(dated!.publishedApproximate)).toBe(false);

  // No view: every item, whatever its analysis says.
  const { items } = await service.listItems(ownerId, {
    platform: 'youtube',
    pageSize: 100,
  } as never);
  const card = (title: string) =>
    items.find(
      (item) =>
        item.title === title && item.url?.endsWith(id(title.toLowerCase())),
    )!;
  expect(card('Approx')).toMatchObject({
    publishedAt: approximate,
    publishedApproximate: true,
  });
  expect(card('Undated')).toMatchObject({
    publishedAt: null,
    publishedApproximate: false,
  });
  expect(card('Exact')).toMatchObject({
    publishedAt: exact,
    publishedApproximate: false,
  });
  const detail = await service.getItem(ownerId, approx!.id);
  expect(detail.publishedApproximate).toBe(true);
});

test('the scheduled lookup replaces missing and approximate times with exact ones, for every copy of a video', async ({
  testApp,
}) => {
  const resolved = '2026-10-09T11:00:33.000Z';
  const {
    service,
    database,
    ownerId,
    source,
    enrich,
    stored,
    time,
    id,
    exact,
  } = await setUp(testApp, () => ({
    status: 'ok',
    publishedAt: resolved,
    coverage: {},
  }));
  await service.runSource(ownerId, source.id, 'manual');
  // Another person's copy of the same video, collected without a time.
  const now = new Date();
  await database
    .query()
    .insertInto('feedItems')
    .values({
      ownerId: 'someone-else',
      platform: 'youtube',
      externalId: id('undated'),
      title: 'Undated',
      coverage: JSON.stringify(titleOnly),
      contentVersion: 1,
      publishedAt: null,
      timelineAt: now,
      fetchedAt: now,
      createdAt: now,
    } as never)
    .execute();

  // Earlier tests in this database may leave videos of their own to look up; only this test's are counted.
  const mine = () =>
    enrich.mock.calls
      .map(([request]) => [request.externalId, request.want])
      .filter(([externalId]) => String(externalId).endsWith(id('')));
  expect(await service.resolvePublishedTimes()).toBeGreaterThanOrEqual(2);
  // Only the videos without an exact time were looked up, once each, for the time alone.
  expect(mine()).toEqual([
    [id('undated'), ['published']],
    [id('approx'), ['published']],
  ]);

  for (const row of [
    ...(await stored(id('approx'))),
    ...(await stored(id('undated'))),
  ]) {
    expect(time(row.publishedAt)).toBe(resolved);
    expect(Boolean(row.publishedApproximate)).toBe(false);
    // The feed places it at its real time now.
    expect(time(row.timelineAt)).toBe(resolved);
  }
  expect((await stored(id('undated'))).map((row) => row.ownerId)).toEqual([
    ownerId,
    'someone-else',
  ]);
  // The exact time collected with the item was left alone.
  const [dated] = await stored(id('exact'));
  expect(time(dated!.publishedAt)).toBe(exact);
  expect(dated!.publishedCheckedAt).toBeNull();

  // Nothing is left to look up.
  await service.resolvePublishedTimes();
  expect(mine()).toHaveLength(2);
});

test('a lookup that finds nothing waits a day; one the Collector could not make is tried on the next tick', async ({
  testApp,
}) => {
  let answer: EnrichResult = {
    status: 'needsLogin',
    message: 'loginRequired',
    coverage: {},
  };
  const { service, ownerId, source, enrich, stored, id, approximate, time } =
    await setUp(testApp, () => answer);
  await service.runSource(ownerId, source.id, 'manual');

  const mine = () =>
    enrich.mock.calls.filter(([request]) => request.externalId.endsWith(id('')))
      .length;
  // A sign-in wall says nothing about the video: stop after the first, mark nothing.
  expect(await service.resolvePublishedTimes()).toBe(0);
  expect(enrich).toHaveBeenCalledTimes(1);
  expect((await stored(id('approx')))[0]!.publishedCheckedAt).toBeNull();
  expect((await stored(id('undated')))[0]!.publishedCheckedAt).toBeNull();

  // The page had no date: remembered, and the approximate time stays.
  answer = { status: 'ok', coverage: {} };
  expect(await service.resolvePublishedTimes()).toBe(0);
  expect(mine()).toBe(3);
  const [approx] = await stored(id('approx'));
  expect(approx!.publishedCheckedAt).not.toBeNull();
  expect(time(approx!.publishedAt)).toBe(approximate);
  expect(Boolean(approx!.publishedApproximate)).toBe(true);

  await service.resolvePublishedTimes();
  expect(mine()).toBe(3);
  // A day later it is asked again.
  expect(
    await service.resolvePublishedTimes({
      now: new Date(Date.now() + DAY + HOUR),
    }),
  ).toBe(0);
  expect(mine()).toBe(5);
});

test('a page that gives only the day sets an approximate time where it says more than the stored one', async ({
  testApp,
}) => {
  const noonOf = (ms: number) => {
    const date = new Date(ms);
    date.setUTCHours(12, 0, 0, 0);
    return date.toISOString();
  };
  // YouTube asked the Collector to sign in: the page said only "Oct 9, 2026", sent as noon UTC, approximate.
  let day = noonOf(Date.now() - 2 * DAY);
  const { service, ownerId, source, stored, id, approximate, time } =
    await setUp(testApp, () => ({
      status: 'ok',
      publishedAt: day,
      publishedAtApproximate: true,
      coverage: {},
    }));
  await service.runSource(ownerId, source.id, 'manual');

  // No exact time was found, so none is counted.
  expect(await service.resolvePublishedTimes()).toBe(0);
  const [undated] = await stored(id('undated'));
  expect(time(undated!.publishedAt)).toBe(day);
  expect(Boolean(undated!.publishedApproximate)).toBe(true);
  expect(time(undated!.timelineAt)).toBe(day);
  // "2 days ago" and that day agree: the relative time stays, it is closer.
  const [approx] = await stored(id('approx'));
  expect(time(approx!.publishedAt)).toBe(approximate);
  expect(approx!.publishedCheckedAt).not.toBeNull();

  // A day later the page says an earlier day: that replaces the relative time, still approximate.
  day = noonOf(Date.now() - 10 * DAY);
  await service.resolvePublishedTimes({
    now: new Date(Date.now() + DAY + HOUR),
  });
  const [moved] = await stored(id('approx'));
  expect(time(moved!.publishedAt)).toBe(day);
  expect(Boolean(moved!.publishedApproximate)).toBe(true);
});
