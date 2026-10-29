import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { expect, vi } from 'vitest';

import type { Adapters } from '../../server/providers/feed/adapters.js';
import {
  createFeedService,
  type Notice,
} from '../../server/providers/feed/service.js';
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

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function seedItem(
  database: DatabaseManager,
  ownerId: string,
  values: { externalId: string; title: string; body?: string; url?: string },
): Promise<number> {
  const now = new Date();
  const { record } = (await database.repository('feedItems').createOne({
    values: {
      ownerId,
      platform: 'hn',
      externalId: values.externalId,
      title: values.title,
      body: values.body ?? null,
      url: values.url ?? null,
      coverage: {
        body: { status: values.body ? 'available' : 'missing' },
        comments: { status: 'notRequested' },
      },
      contentVersion: 1,
      fetchedAt: now,
      createdAt: now,
    },
  } as never)) as { record: { id: number } };
  return Number(record.id);
}

/** A person with one topic about agents, signed in, and a way to seed and analyse items. */
async function setUp(testApp: Parameters<typeof signIn>[0]) {
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
  const analysed = async (values: Parameters<typeof seedItem>[2]) => {
    const id = await seedItem(database, admin.user.id, values);
    const response = await admin.fetch(
      `/feedItems/${id}/analyze`,
      json('POST'),
    );
    expect(response.status).toBe(200);
    return id;
  };
  return { admin, database, analysed };
}

test('feedback moves the weight of the matched words and can be taken back', async ({
  testApp,
}) => {
  const { admin, analysed } = await setUp(testApp);
  const id = await analysed({
    externalId: '1',
    title: 'Ask HN: How do you evaluate tool use in LLM agents?',
    body: 'We struggle with evaluation of agents and tool calls.',
  });
  const before = (await (await admin.fetch(`/feedItems/${id}`)).json()) as {
    data: { score: number };
  };

  const irrelevant = await admin.fetch(
    `/feedItems/${id}/state`,
    json('PATCH', { feedback: 'irrelevant' }),
  );
  expect(irrelevant.status).toBe(200);
  const { data: change } = (await irrelevant.json()) as {
    data: {
      feedback: string;
      adjustment: { direction: string; terms: string[]; rescored: number };
    };
  };
  expect(change.feedback).toBe('irrelevant');
  expect(change.adjustment.direction).toBe('down');
  expect(change.adjustment.terms).toEqual(
    expect.arrayContaining(['agents', 'evaluation']),
  );
  expect(change.adjustment.rescored).toBeGreaterThan(0);

  const after = (await (await admin.fetch(`/feedItems/${id}`)).json()) as {
    data: { score: number; analysis: { interestReason: string } };
  };
  expect(after.data.score).toBeLessThan(before.data.score);
  expect(after.data.analysis.interestReason).toMatch(/not relevant/);
  const profile = (await (await admin.fetch('/feedProfile')).json()) as {
    data: { termWeights: Record<string, number> };
  };
  expect(profile.data.termWeights.agents).toBe(-1);

  // Withdrawing the feedback undoes the step instead of adding another one.
  const undo = await admin.fetch(
    `/feedItems/${id}/state`,
    json('PATCH', { feedback: null }),
  );
  await expect(undo.json()).resolves.toMatchObject({
    data: { adjustment: { direction: 'up' } },
  });
  const restored = (await (await admin.fetch('/feedProfile')).json()) as {
    data: { termWeights: Record<string, number> };
  };
  expect(restored.data.termWeights).toEqual({});
});

test('the digest picks from the last day and a dismissed item leaves the feed', async ({
  testApp,
}) => {
  const { admin, analysed } = await setUp(testApp);
  const id = await analysed({
    externalId: '2',
    title: 'Ask HN: How do you evaluate tool use in LLM agents?',
    body: 'We struggle with evaluation of agents and tool calls.',
  });

  const digest = await admin.fetch('/feedDigest');
  expect(digest.status).toBe(200);
  const { data } = (await digest.json()) as {
    data: { discuss: { id: number }[]; learn: { id: number }[] };
  };
  expect([...data.discuss, ...data.learn].map((item) => item.id)).toContain(id);

  type Counts = { data: { all: number; saved: number } };
  const before = (await (
    await admin.fetch('/feedItems/summary')
  ).json()) as Counts;
  await admin.fetch(
    `/feedItems/${id}/state`,
    json('PATCH', { dismissed: true, favorite: true }),
  );
  const feed = (await (await admin.fetch('/feedItems')).json()) as {
    data: { id: number }[];
  };
  expect(feed.data.map((item) => item.id)).not.toContain(id);
  // What the person kept on purpose stays in its own view.
  const saved = (await (await admin.fetch('/feedItems?view=saved')).json()) as {
    data: { id: number }[];
  };
  expect(saved.data.map((item) => item.id)).toContain(id);
  await expect(
    (await admin.fetch('/feedItems/summary')).json(),
  ).resolves.toMatchObject({
    data: { all: before.data.all - 1, saved: before.data.saved + 1 },
  });
});

test('a joined Hacker News thread is followed and new replies are announced once', async ({
  testApp,
}) => {
  const { admin, database, analysed } = await setUp(testApp);
  const id = await analysed({ externalId: '3', title: 'LLM agents tool use' });
  const linked = await admin.fetch(
    `/feedItems/${id}/state`,
    json('PATCH', {
      participated: true,
      participationUrl: 'https://news.ycombinator.com/item?id=42',
    }),
  );
  await expect(linked.json()).resolves.toMatchObject({
    data: { followUp: { replies: null, newReplies: 0 } },
  });

  let replies = 2;
  const notify = vi.fn(async (_notice: Notice) => true);
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(),
      enrich: vi.fn(),
      collectorConfigured: () => false,
      replyCount: vi.fn(async () => replies),
    } as unknown as Adapters,
    agents: () => undefined,
    config: () => ({
      collector: { timeoutMs: 1_000 },
      tickMinutes: 5,
      userAgent: 'test',
      notificationChannel: 'inbox',
    }),
    notify,
    log: () => undefined,
  });

  // The first check only records where the thread stood.
  const start = new Date();
  await service.checkFollowUps(new Date(start.getTime() + 1_000));
  expect(notify).not.toHaveBeenCalled();

  replies = 5;
  await service.checkFollowUps(new Date(start.getTime() + 2 * 3_600_000));
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0]).toMatchObject({
    ownerId: admin.user.id,
    type: 'followUp',
    path: `/?view=participated&item=${id}`,
  });

  const detail = (await (await admin.fetch(`/feedItems/${id}`)).json()) as {
    data: { newReplies: number; state: { followUp: { newReplies: number } } };
  };
  expect(detail.data.newReplies).toBe(3);
  expect(detail.data.state.followUp.newReplies).toBe(3);

  const seen = await admin.fetch(
    `/feedItems/${id}/state`,
    json('PATCH', { followUpSeen: true }),
  );
  await expect(seen.json()).resolves.toMatchObject({
    data: { followUp: { replies: 5, newReplies: 0 } },
  });

  // The daily digest goes out once per local day, after the chosen hour.
  await database.repository('feedProfiles').updateOne({
    filter: { ownerId: admin.user.id },
    values: { digestHour: 0, timeZone: 'UTC', lastDigestAt: null },
  } as never);
  notify.mockClear();
  const noon = new Date();
  noon.setUTCHours(12, 0, 0, 0);
  await service.sendDigests(noon);
  await service.sendDigests(new Date(noon.getTime() + 60_000));
  const digests = notify.mock.calls.filter(
    ([notice]) => notice.type === 'digest',
  );
  expect(digests).toHaveLength(1);
  expect(digests[0][0].key).toBe(
    `feed-digest:${admin.user.id}:${noon.toISOString().slice(0, 10)}`,
  );
});

test('a subscription that keeps failing is flagged and reported once', async ({
  testApp,
}) => {
  const { admin, database } = await setUp(testApp);
  const created = await admin.fetch(
    '/feedSources',
    json('POST', {
      platform: 'rss',
      operation: 'feed',
      name: 'Broken blog',
      target: 'https://example.com/feed.xml',
      frequency: 60,
    }),
  );
  const { data: source } = (await created.json()) as { data: { id: number } };

  const notify = vi.fn(async (_notice: Notice) => true);
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(async () => ({
        status: 'failed',
        message: 'notAFeed',
        items: [],
      })),
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
    notify,
    log: () => undefined,
  });

  for (let run = 0; run < 4; run += 1)
    await service.runSource(admin.user.id, source.id, 'manual');

  const sources = (await (await admin.fetch('/feedSources')).json()) as {
    data: { id: number; health: string; failureStreak: number }[];
  };
  expect(sources.data.find((entry) => entry.id === source.id)).toMatchObject({
    health: 'failing',
    failureStreak: 4,
  });
  const notices = notify.mock.calls.filter(
    ([notice]) => notice.type === 'sourceHealth',
  );
  expect(notices).toHaveLength(1);
  expect(notices[0][0]).toMatchObject({ path: '/sources' });
  await expect(
    (await admin.fetch('/feedItems/summary')).json(),
  ).resolves.toMatchObject({ data: { unhealthySources: 1 } });
});

test('an enrich that reads no comments keeps the stored ones unless the thread is confirmed empty', async ({
  testApp,
}) => {
  const { admin, database } = await setUp(testApp);
  const id = await seedItem(database, admin.user.id, {
    externalId: 'enrich-keep',
    title: 'Thread with comments',
    url: 'https://news.ycombinator.com/item?id=7',
  });
  await database.repository('feedItems').updateOne({
    filter: { id },
    values: { comments: [{ text: 'stored', depth: 0 }] },
  } as never);

  let reply: unknown = {
    status: 'ok',
    comments: [],
    coverage: { comments: { status: 'missing' } },
  };
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(),
      enrich: vi.fn(async () => reply),
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
  const comments = async () =>
    (
      (await (await admin.fetch(`/feedItems/${id}`)).json()) as {
        data: { comments: unknown[] | null };
      }
    ).data.comments;

  await service.enrichItem(admin.user.id, id);
  expect(await comments()).toEqual([{ text: 'stored', depth: 0 }]);

  reply = {
    status: 'ok',
    comments: [],
    coverage: { comments: { status: 'available', note: 'noComments' } },
  };
  await service.enrichItem(admin.user.id, id);
  expect(await comments()).toEqual([]);
});
