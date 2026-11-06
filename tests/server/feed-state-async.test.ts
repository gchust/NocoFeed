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
  type RescoreTask,
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

const scoreOf = async (
  admin: Awaited<ReturnType<typeof setUp>>['admin'],
  id: number,
): Promise<number> =>
  (
    (await (await admin.fetch(`/feedItems/${id}`)).json()) as {
      data: { score: number };
    }
  ).data.score;

// Issue #11: marking an item must answer at once. Feedback used to re-score up to 200 recent analyses inside the
// request (about 2.6 s with 200 items in this database); the re-score now runs in a background job after the response.
test('feedback answers before the re-score, which a background job finishes', async ({
  testApp,
}) => {
  const { admin, database, analysed } = await setUp(testApp);
  const ids: number[] = [];
  for (let n = 0; n < 3; n += 1)
    ids.push(
      await analysed({
        externalId: `async-${n}`,
        title: `Ask HN: How do you evaluate tool use in LLM agents? (${n})`,
        body: 'We struggle with evaluation of agents and tool calls.',
      }),
    );
  const before = await scoreOf(admin, ids[1]);

  const deferred: RescoreTask[] = [];
  const service = createFeedService({
    database,
    adapters: {} as Adapters,
    agents: () => undefined,
    config: () => ({
      collector: { timeoutMs: 1_000 },
      tickMinutes: 5,
      userAgent: 'test',
      notificationChannel: 'inbox',
    }),
    notify: async () => true,
    log: () => undefined,
    deferRescore: async (task) => {
      deferred.push(task);
    },
  });

  const change = await service.updateState(admin.user.id, ids[0], {
    feedback: 'irrelevant',
  });
  // The weights are saved with the feedback; scoring the other items is left to the job.
  expect(change.adjustment).toMatchObject({
    direction: 'down',
    rescoring: true,
  });
  expect(deferred).toEqual([
    {
      ownerId: admin.user.id,
      terms: expect.arrayContaining(['agents', 'evaluation']),
    },
  ]);
  expect(await scoreOf(admin, ids[1])).toBe(before);
  const profile = (await (await admin.fetch('/feedProfile')).json()) as {
    data: { termWeights: Record<string, number> };
  };
  expect(profile.data.termWeights.agents).toBeLessThan(0);

  // The job does the work later.
  const rescored = await service.rescoreTerms(
    deferred[0].ownerId,
    deferred[0].terms,
  );
  expect(rescored).toBeGreaterThan(0);
  expect(await scoreOf(admin, ids[1])).toBeLessThan(before);
});

test('the route queues the re-score and the job completes it', async ({
  testApp,
}) => {
  const { admin, analysed } = await setUp(testApp);
  const ids: number[] = [];
  for (let n = 0; n < 3; n += 1)
    ids.push(
      await analysed({
        externalId: `route-${n}`,
        title: `Ask HN: How do you evaluate tool use in LLM agents? (${n})`,
        body: 'We struggle with evaluation of agents and tool calls.',
      }),
    );
  const before = await scoreOf(admin, ids[2]);
  const response = await admin.fetch(
    `/feedItems/${ids[0]}/state`,
    json('PATCH', { feedback: 'irrelevant' }),
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: { feedback: 'irrelevant', adjustment: { rescoring: true } },
  });
  await vi.waitFor(
    async () => expect(await scoreOf(admin, ids[2])).toBeLessThan(before),
    { timeout: 10_000, interval: 50 },
  );
});

test('a change sent again with the same operation key is applied once', async ({
  testApp,
}) => {
  const { admin, analysed } = await setUp(testApp);
  const id = await analysed({
    externalId: 'keyed',
    title: 'Ask HN: How do you evaluate tool use in LLM agents?',
    body: 'We struggle with evaluation of agents and tool calls.',
  });
  const weightOf = async (term: string) =>
    (
      (await (await admin.fetch('/feedProfile')).json()) as {
        data: { termWeights: Record<string, number> };
      }
    ).data.termWeights[term] ?? 0;
  const start = await weightOf('agents');
  const key = `${Date.now()}.${crypto.randomUUID()}`;
  const send = (body: unknown) =>
    admin.fetch(`/feedItems/${id}/state`, {
      ...json('PATCH', body),
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'idempotency-key': key,
      },
    });

  const first = await send({ feedback: 'irrelevant' });
  expect(first.status).toBe(200);
  expect(first.headers.get('idempotency-replayed')).toBe('false');
  // A retry after a lost response answers the first result and does not move the weights a second time.
  const again = await send({ feedback: 'irrelevant' });
  expect(again.status).toBe(200);
  expect(again.headers.get('idempotency-replayed')).toBe('true');
  await expect(again.json()).resolves.toMatchObject({
    data: { feedback: 'irrelevant', adjustment: { direction: 'down' } },
  });
  expect(await weightOf('agents')).toBe(start - 1);

  // The same key with another change is refused rather than applied.
  const changed = await send({ feedback: 'helpful' });
  expect(changed.status).toBe(409);
});
