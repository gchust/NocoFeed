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

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: body === undefined ? undefined : JSON.stringify(body),
});

interface SearchRow {
  id: number;
  topicId: number | null;
  platform: string;
  operation: string;
  target: string;
  name: string;
  frequency: number;
  candidateLimit: number;
}
interface TopicBody {
  id: number;
  name: string;
  goal: string;
  sourceIds: number[];
  searchTerms: string[];
  searchPlatforms: string[];
  searchFrequency: number;
  searchLimit: number;
  searches: SearchRow[];
}

const pairs = (topic: TopicBody) =>
  topic.searches.map((search) => `${search.platform}:${search.target}`).sort();

test('a topic runs its search terms on its platforms, and keeps them in step', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);

  const created = await admin.fetch(
    '/feedTopics',
    json('POST', {
      name: 'Vibe',
      goal: 'vibe coding in practice',
      mode: 'learn',
      searchTerms: ['vibe coding', ' vibe coding ', 'Claude Code'],
      searchPlatforms: ['bilibili', 'x'],
      searchFrequency: 720,
      searchLimit: 30,
    }),
  );
  expect(created.status).toBe(201);
  const { data: topic } = (await created.json()) as { data: TopicBody };
  // Terms are trimmed and de-duplicated; each term × platform is one search.
  expect(topic.searchTerms).toEqual(['vibe coding', 'Claude Code']);
  expect(pairs(topic)).toEqual([
    'bilibili:Claude Code',
    'bilibili:vibe coding',
    'x:Claude Code',
    'x:vibe coding',
  ]);
  expect(topic.searches[0]).toMatchObject({
    topicId: topic.id,
    operation: 'keyword',
    frequency: 720,
    candidateLimit: 30,
    name: expect.stringMatching(/^Vibe · /) as unknown,
  });

  // Searches belong to the topic, not to the subscription list, and cannot be changed there.
  const sources = (await (await admin.fetch('/feedSources')).json()) as {
    data: SearchRow[];
  };
  expect(sources.data.some((row) => row.topicId === topic.id)).toBe(false);
  const managed = topic.searches[0]!.id;
  expect(
    (
      await admin.fetch(
        `/feedSources/${managed}`,
        json('PATCH', { active: false }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await admin.fetch(`/feedSources/${managed}`, json('DELETE'))).status,
  ).toBe(400);

  // An update that leaves fields out keeps them; changing terms adds and removes only what changed.
  const renamed = await admin.fetch(
    `/feedTopics/${topic.id}`,
    json('PATCH', {
      name: 'Vibe coding',
      searchTerms: ['Claude Code', 'Cursor'],
    }),
  );
  expect(renamed.status).toBe(200);
  const { data: updated } = (await renamed.json()) as { data: TopicBody };
  expect(updated).toMatchObject({
    goal: 'vibe coding in practice',
    searchPlatforms: ['bilibili', 'x'],
    searchFrequency: 720,
    searchLimit: 30,
  });
  expect(pairs(updated)).toEqual([
    'bilibili:Claude Code',
    'bilibili:Cursor',
    'x:Claude Code',
    'x:Cursor',
  ]);
  const kept = updated.searches.find(
    (search) => search.platform === 'x' && search.target === 'Claude Code',
  );
  expect(kept?.id).toBe(
    topic.searches.find(
      (search) => search.platform === 'x' && search.target === 'Claude Code',
    )?.id,
  );
  expect(kept?.name).toBe('Vibe coding · Claude Code');

  // No platforms chosen means every platform that can search.
  const everywhere = await admin.fetch(
    `/feedTopics/${topic.id}`,
    json('PATCH', { searchTerms: ['Cursor'], searchPlatforms: [] }),
  );
  const { data: wide } = (await everywhere.json()) as { data: TopicBody };
  expect(pairs(wide)).toEqual([
    'bilibili:Cursor',
    'x:Cursor',
    'xiaohongshu:Cursor',
    'youtube:Cursor',
  ]);

  // Running starts the topic's searches in the background.
  const run = await admin.fetch(`/feedTopics/${topic.id}/run`, json('POST'));
  expect(run.status).toBe(202);
  await expect(run.json()).resolves.toEqual({ data: { started: 4 } });

  // No terms: the topic only judges, and its searches go.
  const judging = await admin.fetch(
    `/feedTopics/${topic.id}`,
    json('PATCH', { searchTerms: [] }),
  );
  await expect(judging.json()).resolves.toMatchObject({
    data: { searches: [] },
  });

  const deleted = await admin.fetch(`/feedTopics/${topic.id}`, json('DELETE'));
  expect(deleted.status).toBeLessThan(300);
  expect(
    (await admin.fetch(`/feedTopics/${topic.id}/run`, json('POST'))).status,
  ).toBe(404);
});

test('a search term every chosen platform accepts, and no more than ten', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const create = (body: Record<string, unknown>) =>
    admin.fetch(
      '/feedTopics',
      json('POST', { name: 'T', goal: 'g', mode: 'both', ...body }),
    );

  const short = await create({
    searchTerms: ['猫'],
    searchPlatforms: ['xiaohongshu'],
  });
  expect(short.status).toBe(400);
  await expect(short.json()).resolves.toMatchObject({
    error: { reason: 'FEED_SEARCH_TERM_LENGTH' },
  });

  const many = await create({
    searchTerms: Array.from({ length: 11 }, (_, i) => `term ${i}`),
  });
  expect(many.status).toBe(400);

  // A platform that cannot search is refused.
  expect(
    (await create({ searchTerms: ['agents'], searchPlatforms: ['hn'] })).status,
  ).toBe(400);
});

test('a topic judges what other subscriptions bring in, and always its own searches', async ({
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
  const prompts: string[] = [];
  let collected = 0;
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(async () => ({
        status: 'ok',
        items: [
          {
            externalId: `topic-search-${(collected += 1)}`,
            publishedAt: new Date().toISOString(),
            title: 'Shipping an app with vibe coding',
            summary: 'What worked.',
            coverage: {
              body: { status: 'available' },
              comments: { status: 'notRequested' },
            },
          },
        ],
        truncated: false,
      })),
      enrich: vi.fn(),
      collectorConfigured: () => true,
    } as unknown as Adapters,
    agents: () =>
      ({
        models: {
          gateway: {
            catalog: async () => ({
              defaultModel: { modelService: 's', model: 'm' },
            }),
            generate: async ({ prompt }: { prompt: string }) => {
              prompts.push(prompt);
              return {
                text: prompt.includes('"results"')
                  ? JSON.stringify({ results: [] })
                  : JSON.stringify({
                      verdict: 'learn',
                      score: 60,
                      interestLevel: 'medium',
                      experienceLevel: 'none',
                      lead: 'ok',
                      steps: [],
                    }),
              };
            },
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
  const hn = await service.createSource(ownerId, {
    platform: 'hn',
    operation: 'new',
    name: 'HN',
    target: '',
    frequency: 60,
    candidateLimit: 20,
    topicIds: [],
  });
  // Limited to HN, yet it judges what its own search brings.
  const searching = await service.createTopic(ownerId, {
    name: 'Searching topic',
    goal: 'vibe coding',
    avoid: null,
    mode: 'learn',
    sourceIds: [hn.id],
    searchTerms: ['vibe coding'],
    searchPlatforms: ['x'],
    searchFrequency: 360,
    searchLimit: 20,
  });
  // Limited to HN too, so it has no say over another topic's search.
  await service.createTopic(ownerId, {
    name: 'Other limited topic',
    goal: 'vibe coding',
    avoid: null,
    mode: 'learn',
    sourceIds: [hn.id],
    searchTerms: [],
    searchPlatforms: [],
    searchFrequency: 360,
    searchLimit: 20,
  });
  // Choosing no subscriptions means judging all of them, searches included.
  await service.createTopic(ownerId, {
    name: 'Global topic',
    goal: 'vibe coding',
    avoid: null,
    mode: 'learn',
    sourceIds: [],
    searchTerms: [],
    searchPlatforms: [],
    searchFrequency: 360,
    searchLimit: 20,
  });

  await expect(
    service.runTopicSearches(ownerId, searching.id, { wait: true }),
  ).resolves.toEqual({ started: 1 });
  const analysis = prompts.filter((prompt) => !prompt.includes('"results"'));
  expect(analysis.length).toBeGreaterThan(0);
  const last = analysis.at(-1)!;
  expect(last).toContain('Searching topic');
  expect(last).toContain('Global topic');
  expect(last).not.toContain('Other limited topic');
});
