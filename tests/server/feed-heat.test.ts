import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { describe, expect, it, vi } from 'vitest';

import type { Adapters } from '../../server/providers/feed/adapters.js';
import {
  HEAT_WINDOW_MS,
  HOT_HEAT,
  heatOf,
  refreshInterval,
} from '../../server/providers/feed/heat.js';
import { createFeedService } from '../../server/providers/feed/service.js';
import { createStandaloneServer } from '../../server/standalone.js';

const ORIGIN = 'http://localhost';
const HOUR = 3_600_000;

describe('heat', () => {
  it('puts the front page of each platform around the hot line', () => {
    // About the Hacker News front page.
    expect(heatOf('hn', { points: 30, comments: 10 })).toBeGreaterThanOrEqual(
      HOT_HEAT,
    );
    expect(heatOf('hn', { points: 3, comments: 0 })).toBeLessThan(30);
    expect(heatOf('hn', { points: 5_000, comments: 2_000 })).toBe(100);
    // Likes come cheaply on Xiaohongshu; a few hundred is not yet hot.
    expect(heatOf('xiaohongshu', { likes: 200 })).toBeLessThan(HOT_HEAT);
    expect(heatOf('xiaohongshu', { likes: 5_000 })).toBeGreaterThan(HOT_HEAT);
    // Views count for little next to likes and comments.
    expect(heatOf('bilibili', { views: 300 })).toBeLessThan(
      heatOf('bilibili', { likes: 300 })!,
    );
  });

  it('is unknown rather than cold when nothing can be weighed', () => {
    expect(heatOf('hn', null)).toBeNull();
    expect(heatOf('hn', {})).toBeNull();
    expect(heatOf('hn', { parts: 3 })).toBeNull();
    expect(heatOf('rss', { points: 100 })).toBeNull();
  });

  it('reads young items often and stops once they are too old to trend', () => {
    expect(refreshInterval(HOUR)).toBe(30 * 60_000);
    expect(refreshInterval(12 * HOUR)).toBe(2 * HOUR);
    expect(refreshInterval(48 * HOUR)).toBe(6 * HOUR);
    expect(refreshInterval(HEAT_WINDOW_MS)).toBeNull();
  });
});

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

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function seedItem(
  database: DatabaseManager,
  ownerId: string,
  values: { externalId: string; title: string; body: string; at: Date },
): Promise<number> {
  const now = new Date();
  const { record } = (await database.repository('feedItems').createOne({
    values: {
      ownerId,
      platform: 'hn',
      externalId: values.externalId,
      url: `https://news.ycombinator.com/item?id=${values.externalId}`,
      title: values.title,
      body: values.body,
      metrics: { points: 2, comments: 0 },
      heat: heatOf('hn', { points: 2, comments: 0 }),
      coverage: {
        body: { status: 'available' },
        comments: { status: 'notRequested' },
      },
      contentVersion: 1,
      publishedAt: values.at,
      timelineAt: values.at,
      fetchedAt: now,
      createdAt: now,
    },
  } as never)) as { record: { id: number } };
  return Number(record.id);
}

test('recent items are read again, and one that turns hot is looked at properly and trends', async ({
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
  await admin.fetch(
    '/feedProfile',
    json('PUT', {
      interests: 'LLM agents',
      expertise: 'Built evaluation harnesses for LLM agents and tool use',
      avoid: '',
      dailyLimit: 0,
      keepLearning: true,
      locale: 'en-US',
    }),
  );
  await admin.fetch(
    '/feedTopics',
    json('POST', {
      name: 'Agents',
      goal: 'LLM agents, tool use, evaluation',
      mode: 'both',
    }),
  );

  const now = new Date();
  const topic = 'How we evaluate tool use in LLM agents';
  const body = 'Our evaluation harness for agents and tool calls.';
  const rising = await seedItem(database, admin.user.id, {
    externalId: '1',
    title: topic,
    body,
    at: new Date(now.getTime() - HOUR),
  });
  const quiet = await seedItem(database, admin.user.id, {
    externalId: '2',
    title: `${topic}, part two`,
    body,
    at: new Date(now.getTime() - HOUR),
  });
  const old = await seedItem(database, admin.user.id, {
    externalId: '3',
    title: `${topic}, from last week`,
    body,
    at: new Date(now.getTime() - 5 * 24 * HOUR),
  });
  for (const id of [rising, quiet, old])
    expect(
      (await admin.fetch(`/feedItems/${id}/analyze`, json('POST'))).status,
    ).toBe(200);

  const counts: Record<string, { points: number; comments: number }> = {
    '1': { points: 240, comments: 95 },
    '2': { points: 3, comments: 1 },
    '3': { points: 900, comments: 400 },
  };
  const metrics = vi.fn(async (_platform: string, externalId: string) =>
    externalId in counts ? counts[externalId] : null,
  );
  const enrich = vi.fn(async () => ({
    status: 'ok' as const,
    comments: [
      { author: 'someone', text: 'We do the same with replayed traces.' },
    ],
    coverage: { comments: { status: 'available' as const } },
  }));
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(),
      enrich,
      metrics,
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
    notify: vi.fn(async () => true),
    log: () => undefined,
  });

  expect(await service.refreshHeat({ now })).toBe(2);
  // Too old to trend: its counts are never asked for.
  expect(metrics.mock.calls.map((call) => call[1]).sort()).toEqual(['1', '2']);

  const item = async (id: number) =>
    (
      (await (await admin.fetch(`/feedItems/${id}`)).json()) as {
        data: {
          heat: number | null;
          metrics: Record<string, number>;
          verdict: string;
        };
      }
    ).data;
  const hot = await item(rising);
  expect(hot.heat).toBeGreaterThanOrEqual(HOT_HEAT);
  expect(hot.metrics).toEqual({ points: 240, comments: 95 });
  expect((await item(quiet)).heat).toBeLessThan(HOT_HEAT);

  // Turning hot read the discussion and ran the analysis again, past the gates.
  expect(enrich).toHaveBeenCalledTimes(1);
  expect(enrich).toHaveBeenCalledWith(
    expect.objectContaining({ externalId: '1', want: ['comments'] }),
  );
  const analyses = await database
    .query()
    .selectFrom('feedAnalyses')
    .select(['itemId'])
    .where('itemId', '=', rising)
    .execute();
  expect(analyses).toHaveLength(2);

  // Read again only when its age says so.
  metrics.mockClear();
  expect(
    await service.refreshHeat({ now: new Date(now.getTime() + 60_000) }),
  ).toBe(0);
  expect(metrics).not.toHaveBeenCalled();

  expect(hot.verdict).not.toBe('ignore');
  const listed = (await (
    await admin.fetch('/feedItems?view=hot&sort=priority')
  ).json()) as { data: { id: number }[] };
  expect(listed.data.map((row) => row.id)).toEqual([rising]);

  // In depth lists what the analysis found substantial, whatever its attention.
  await database
    .query()
    .updateTable('feedAnalyses')
    .set({ quality: 72 })
    .where('itemId', '=', quiet)
    .where('current', '=', true)
    .execute();
  const solid = (await (
    await admin.fetch('/feedItems?view=solid&sort=priority')
  ).json()) as { data: { id: number }[] };
  expect(solid.data.map((row) => row.id)).toEqual([quiet]);

  const summary = (await (await admin.fetch('/feedItems/summary')).json()) as {
    data: { hot: number; solid: number };
  };
  expect(summary.data).toMatchObject({ hot: 1, solid: 1 });

  const digest = (await (await admin.fetch('/feedDigest')).json()) as {
    data: {
      hot: { id: number }[];
      discuss: { id: number }[];
      learn: { id: number }[];
    };
  };
  expect(digest.data.hot.map((row) => row.id)).toEqual([rising]);
  // Shown once: not again under discussions or learning.
  expect(
    [...digest.data.discuss, ...digest.data.learn].map((row) => row.id),
  ).not.toContain(rising);
});
