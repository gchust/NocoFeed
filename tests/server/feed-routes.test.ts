import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { expect } from 'vitest';

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

test('every feed route requires a session', async ({ request }) => {
  for (const path of [
    '/feedProfile',
    '/feedTopics',
    '/feedSources',
    '/feedCatalog',
    '/feedRuns',
    '/feedItems',
    '/feedItems/summary',
  ]) {
    const response = await request(path);
    expect({ path, status: response.status }).toEqual({ path, status: 401 });
  }
  expect(
    (
      await request(
        '/feedTopics',
        json('POST', { name: 'x', goal: 'y', mode: 'both' }),
      )
    ).status,
  ).toBe(401);
});

test('a person manages their own topics, subscriptions and profile', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);

  const profile = await admin.fetch(
    '/feedProfile',
    json('PUT', {
      interests: 'LLM agents, self-hosting',
      expertise: 'TypeScript and PostgreSQL backends',
      avoid: 'crypto',
      dailyLimit: 10,
      keepLearning: true,
      locale: 'en-US',
    }),
  );
  expect(profile.status).toBe(200);
  await expect(profile.json()).resolves.toMatchObject({
    data: { dailyLimit: 10, locale: 'en-US', configured: true },
  });

  // A subscription is validated against the platform catalogue, and creating it fetches nothing yet.
  const source = await admin.fetch(
    '/feedSources',
    json('POST', {
      platform: 'hn',
      operation: 'ask',
      name: 'Ask HN',
      target: '',
      frequency: 60,
    }),
  );
  expect(source.status).toBe(201);
  const { data: created } = (await source.json()) as {
    data: { id: number; status: string; active: boolean };
  };
  expect(created).toMatchObject({ status: 'pending', active: true });

  const unknown = await admin.fetch(
    '/feedSources',
    json('POST', {
      platform: 'hn',
      operation: 'nope',
      name: 'Broken',
      target: '',
      frequency: 60,
    }),
  );
  expect(unknown.status).toBe(400);

  const topic = await admin.fetch(
    '/feedTopics',
    json('POST', {
      name: 'Agents',
      goal: 'Building LLM agents with tools',
      mode: 'both',
      sourceIds: [created.id, 99_999],
    }),
  );
  expect(topic.status).toBe(201);
  // A subscription the person does not own is dropped rather than linked.
  await expect(topic.json()).resolves.toMatchObject({
    data: { name: 'Agents', sourceIds: [created.id] },
  });

  const paused = await admin.fetch(
    `/feedSources/${created.id}`,
    json('PATCH', { active: false }),
  );
  expect(paused.status).toBe(200);
  await expect(paused.json()).resolves.toMatchObject({
    data: { active: false },
  });

  const catalog = await admin.fetch('/feedCatalog');
  expect(catalog.status).toBe(200);
  await expect(catalog.json()).resolves.toMatchObject({
    data: { collectorConfigured: false },
  });

  const items = await admin.fetch('/feedItems?view=discuss');
  expect(items.status).toBe(200);
  const page = (await items.json()) as {
    data: unknown[];
    meta: { nextPageToken?: string | null };
  };
  expect(page.data).toEqual([]);
  // The last page carries no token to continue from.
  expect(page.meta.nextPageToken ?? null).toBeNull();
  expect((await admin.fetch('/feedItems?view=unknown')).status).toBe(400);
  expect((await admin.fetch('/feedItems/123456')).status).toBe(404);
});

test("another person neither sees nor changes someone else's data", async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const credentials = {
    email: 'feed-member@example.com',
    password: 'feed-member-password',
  };
  const createUser = json('POST', { name: 'Feed member', ...credentials });
  const user = await admin.fetch('/users', {
    ...createUser,
    headers: {
      ...(createUser.headers as Record<string, string>),
      // The users API is a standard write and takes an operation key.
      'idempotency-key': `${Date.now()}.${crypto.randomUUID()}`,
    },
  });
  expect(user.status).toBe(201);

  const topic = await admin.fetch(
    '/feedTopics',
    json('POST', { name: 'Private', goal: 'Only mine', mode: 'learn' }),
  );
  const { data: owned } = (await topic.json()) as { data: { id: number } };
  const source = await admin.fetch(
    '/feedSources',
    json('POST', {
      platform: 'hn',
      operation: 'show',
      name: 'Show HN',
      target: '',
      frequency: 120,
    }),
  );
  const { data: ownedSource } = (await source.json()) as {
    data: { id: number };
  };

  const member = await signIn(testApp, credentials);
  const topics = await member.fetch('/feedTopics');
  expect(topics.status).toBe(200);
  await expect(topics.json()).resolves.toMatchObject({ data: [] });
  await expect(
    (await member.fetch('/feedSources')).json(),
  ).resolves.toMatchObject({ data: [] });

  expect(
    (
      await member.fetch(
        `/feedTopics/${owned.id}`,
        json('PATCH', { name: 'Taken' }),
      )
    ).status,
  ).toBe(404);
  expect(
    (await member.fetch(`/feedTopics/${owned.id}`, json('DELETE'))).status,
  ).toBe(404);
  expect(
    (await member.fetch(`/feedSources/${ownedSource.id}/run`, json('POST')))
      .status,
  ).toBe(404);

  const still = await admin.fetch('/feedTopics');
  await expect(still.json()).resolves.toMatchObject({
    data: expect.arrayContaining([
      expect.objectContaining({ id: owned.id, name: 'Private' }),
    ]),
  });
});
