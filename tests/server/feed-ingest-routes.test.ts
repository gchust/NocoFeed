import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { expect } from 'vitest';

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

const json = (
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

type TestApp = Parameters<typeof signIn>[0];

const databaseOf = (testApp: TestApp) =>
  (
    testApp as unknown as {
      application: {
        container: { resolve: (token: unknown) => DatabaseManager };
      };
    }
  ).application.container.resolve(databaseManagerToken);

async function member(testApp: TestApp) {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const credentials = {
    email: 'push-member@example.com',
    password: 'push-member-password',
  };
  const create = json(
    'POST',
    { name: 'Push member', ...credentials },
    {
      'idempotency-key': `${Date.now()}.${crypto.randomUUID()}`,
    },
  );
  expect((await admin.fetch('/users', create)).status).toBe(201);
  return { admin, member: await signIn(testApp, credentials) };
}

const post = {
  title: 'Notes on running Postgres on a small VPS',
  content:
    'What I learned keeping a database alive on 1 GB of memory: shared_buffers, autovacuum and backups.',
  author: 'someone',
  publishedAt: '2026-11-01T08:00:00Z',
};

test('pushing requires a session or an API key', async ({ request }) => {
  const response = await request('/feedItems/ingest', json('POST', post));
  expect(response.status).toBe(401);
  const keyed = await request(
    '/feedItems/ingest',
    json('POST', post, { 'x-api-key': 'not-a-real-key' }),
  );
  // Better Auth refuses an unknown key (401 or 403, by its own code); either way nothing is stored.
  expect([401, 403]).toContain(keyed.status);
  expect((await request('/feedMailAccounts')).status).toBe(401);
});

test('a post pushed with a session lands in my own inbox, once', async ({
  testApp,
}) => {
  const { admin, member: other } = await member(testApp);
  const created = await admin.fetch('/feedItems/ingest', json('POST', post));
  expect(created.status).toBe(201);
  const { data } = (await created.json()) as {
    data: { itemId: number; duplicate: boolean; fetched: string };
  };
  expect(data).toMatchObject({ duplicate: false, fetched: 'none' });

  const item = await admin.fetch(`/feedItems/${data.itemId}`);
  expect(item.status).toBe(200);
  await expect(item.json()).resolves.toMatchObject({
    data: {
      platform: 'inbox',
      title: post.title,
      author: 'someone',
      publishedAt: '2026-11-01T08:00:00.000Z',
    },
  });

  // The same post again is stored once.
  const again = await admin.fetch('/feedItems/ingest', json('POST', post));
  expect(again.status).toBe(200);
  await expect(again.json()).resolves.toMatchObject({
    data: { itemId: data.itemId, duplicate: true },
  });

  // The inbox is not a subscription: it is not listed, run, changed or removed as one.
  const sources = (await (await admin.fetch('/feedSources')).json()) as {
    data: unknown[];
  };
  expect(sources.data).toEqual([]);
  const inbox = (await databaseOf(testApp)
    .query()
    .selectFrom('feedSources')
    .select(['id', 'active', 'nextRunAt'])
    .where('platform', '=', 'inbox')
    .execute()) as { id: number; active: unknown; nextRunAt: unknown }[];
  expect(inbox).toHaveLength(1);
  expect(Boolean(inbox[0].active)).toBe(false);
  expect(inbox[0].nextRunAt).toBeNull();
  for (const [path, init] of [
    [`/feedSources/${inbox[0].id}/run`, json('POST')],
    [`/feedSources/${inbox[0].id}`, json('PATCH', { active: true })],
    [`/feedSources/${inbox[0].id}`, json('DELETE')],
  ] as const) {
    const response = await admin.fetch(path, init);
    expect({ path, status: response.status }).toEqual({ path, status: 400 });
  }
  // Nobody subscribes to an inbox.
  expect(
    (
      await admin.fetch(
        '/feedSources',
        json('POST', {
          platform: 'inbox',
          operation: 'push',
          name: 'Mine',
          target: 'x',
          frequency: 60,
        }),
      )
    ).status,
  ).toBe(400);

  // Someone else neither sees it nor can push into another person's feed.
  expect((await other.fetch(`/feedItems/${data.itemId}`)).status).toBe(404);
  const list = (await (await other.fetch('/feedItems?view=all')).json()) as {
    data: unknown[];
  };
  expect(list.data).toEqual([]);
  expect(
    (
      await other.fetch(
        '/feedItems/ingest',
        json('POST', { ...post, ownerId: admin.user.id }),
      )
    ).status,
  ).toBe(400);
  // Their own push of the same post is theirs, not a duplicate of mine.
  const theirs = await other.fetch('/feedItems/ingest', json('POST', post));
  expect(theirs.status).toBe(201);
  const { data: their } = (await theirs.json()) as {
    data: { itemId: number };
  };
  expect(their.itemId).not.toBe(data.itemId);
  expect((await admin.fetch(`/feedItems/${their.itemId}`)).status).toBe(404);
});

test('an API key pushes as its owner', async ({ testApp, request }) => {
  const { admin } = await member(testApp);
  const created = await admin.fetch(
    '/auth/api-key/create',
    json('POST', { name: 'browser extension' }),
  );
  expect(created.status).toBe(200);
  const key = (await created.json()) as { id: string; key: string };

  const pushed = await request(
    '/feedItems/ingest',
    json('POST', { ...post, externalId: 'ext-1' }, { 'x-api-key': key.key }),
  );
  expect(pushed.status).toBe(201);
  const { data } = (await pushed.json()) as { data: { itemId: number } };
  const owners = await databaseOf(testApp)
    .query()
    .selectFrom('feedItems')
    .select(['ownerId'])
    .where('id', '=', data.itemId)
    .execute();
  expect(owners).toEqual([{ ownerId: admin.user.id }]);

  // The same external id is the same item, whatever else changed.
  const again = await request(
    '/feedItems/ingest',
    json(
      'POST',
      { ...post, title: 'Edited title', externalId: 'ext-1' },
      { 'x-api-key': key.key },
    ),
  );
  expect(again.status).toBe(200);

  expect(
    (await admin.fetch('/auth/api-key/delete', json('POST', { keyId: key.id })))
      .status,
  ).toBe(200);
  const revoked = await request(
    '/feedItems/ingest',
    json('POST', post, { 'x-api-key': key.key }),
  );
  expect(revoked.status).toBe(401);
});

test('a push is validated and its size is limited', async ({ testApp }) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const push = (body: unknown) =>
    admin.fetch('/feedItems/ingest', json('POST', body));
  // Neither a link nor a post.
  expect((await push({})).status).toBe(400);
  expect((await push({ title: 'Only a title' })).status).toBe(400);
  expect((await push({ url: 'ftp://example.com/file' })).status).toBe(400);
  expect((await push({ url: 'not a link' })).status).toBe(400);
  expect((await push({ ...post, publishedAt: 'yesterday' })).status).toBe(400);
  // Content past its cap, and a body past the route's limit.
  expect(
    (await push({ title: 'Long', content: 'x'.repeat(100_001) })).status,
  ).toBe(400);
  const huge = await push({ title: 'Huge', content: 'x'.repeat(300 * 1024) });
  expect(huge.status).toBe(413);
  // An internal address is never fetched; the link is kept with the reason.
  const internal = await push({ url: 'http://127.0.0.1:3000/secret' });
  expect(internal.status).toBe(201);
  await expect(internal.json()).resolves.toMatchObject({
    data: {
      fetched: 'failed',
      fetchError: 'pageUrlNotAllowed',
      url: 'http://127.0.0.1:3000/secret',
    },
  });
});

test('mail accounts list only my own, and a mail subscription needs one of them', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const accounts = await admin.fetch('/feedMailAccounts');
  expect(accounts.status).toBe(200);
  await expect(accounts.json()).resolves.toMatchObject({
    data: [],
    meta: { total: 0, available: true },
  });
  const catalog = (await (await admin.fetch('/feedCatalog')).json()) as {
    data: { platforms: { platform: string; operations: unknown[] }[] };
  };
  expect(
    catalog.data.platforms.find((entry) => entry.platform === 'mail'),
  ).toMatchObject({
    operations: [
      expect.objectContaining({ operation: 'messages', input: 'account' }),
    ],
  });
  const created = await admin.fetch(
    '/feedSources',
    json('POST', {
      platform: 'mail',
      operation: 'messages',
      name: 'Newsletters',
      target: 'someone-elses-account',
      frequency: 60,
      options: { senders: ['@example.com'] },
    }),
  );
  expect(created.status).toBe(400);
  await expect(created.json()).resolves.toMatchObject({
    error: { reason: 'FEED_MAIL_ACCOUNT_MISSING' },
  });
});
