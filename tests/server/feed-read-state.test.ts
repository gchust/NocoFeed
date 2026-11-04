import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { expect } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';

const ORIGIN = 'http://localhost';
const HOUR = 3_600_000;

const test = createAppTest({
  createServer: createStandaloneServer,
  connections: ['main'],
  // Each test counts the whole feed, so each starts on fresh databases.
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

interface ListItem {
  id: number;
  title: string;
  read: boolean;
}

interface Summary {
  all: number;
  learn: number;
  discuss: number;
  later: number;
  unread: Record<string, number>;
}

function databaseOf(testApp: Parameters<typeof signIn>[0]): DatabaseManager {
  return (
    testApp as unknown as {
      application: {
        container: { resolve: (token: unknown) => DatabaseManager };
      };
    }
  ).application.container.resolve(databaseManagerToken);
}

/**
 * Three analysed items: "old-best" was published long ago but ranks highest, "new-weak" is the newest and ranks
 * lowest, "middle" sits between on both. Sorting by time and by priority therefore give different orders.
 */
async function seed(database: DatabaseManager, ownerId: string) {
  const now = Date.now();
  const rows = [
    { key: 'old-best', age: 48 * HOUR, priority: 90, verdict: 'learn' },
    { key: 'middle', age: 10 * HOUR, priority: 60, verdict: 'discuss' },
    { key: 'new-weak', age: 1 * HOUR, priority: 20, verdict: 'learn' },
  ];
  const ids: Record<string, number> = {};
  for (const row of rows) {
    const published = new Date(now - row.age);
    await database
      .query()
      .insertInto('feedItems')
      .values({
        ownerId,
        platform: 'hn',
        externalId: row.key,
        title: `Item ${row.key}`,
        contentVersion: 1,
        publishedAt: published,
        timelineAt: published,
        fetchedAt: new Date(now),
        createdAt: new Date(now),
      })
      .execute();
    const [item] = await database
      .query()
      .selectFrom('feedItems')
      .select(['id'])
      .where('ownerId', '=', ownerId)
      .where('externalId', '=', row.key)
      .execute();
    ids[row.key] = Number(item.id);
    await database
      .query()
      .insertInto('feedAnalyses')
      .values({
        ownerId,
        itemId: Number(item.id),
        current: true,
        contentVersion: 1,
        verdict: row.verdict,
        score: row.priority,
        priority: row.priority,
        interestLevel: 'high',
        experienceLevel: 'some',
        engine: 'rules',
        promptVersion: 'test',
        createdAt: new Date(now),
      })
      .execute();
  }
  return ids;
}

test('the feed lists newest first unless the person asks for priority', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await seed(databaseOf(testApp), admin.user.id);
  const titles = async (query = '') =>
    (
      (await (await admin.fetch(`/feedItems?pageSize=10${query}`)).json()) as {
        data: ListItem[];
      }
    ).data.map((item) => item.title);

  expect(await titles()).toEqual([
    'Item new-weak',
    'Item middle',
    'Item old-best',
  ]);
  expect(await titles('&view=learn')).toEqual([
    'Item new-weak',
    'Item old-best',
  ]);
  expect(await titles('&sort=priority')).toEqual([
    'Item old-best',
    'Item middle',
    'Item new-weak',
  ]);
});

test('the digest picks by priority and shows its picks newest first', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  await seed(databaseOf(testApp), admin.user.id);
  const digest = (await (await admin.fetch('/feedDigest')).json()) as {
    data: { learn: ListItem[]; discuss: ListItem[] };
  };
  // Of the two learning items the best is picked, however old.
  expect(digest.data.learn.map((item) => item.title)).toEqual([
    'Item old-best',
  ]);
  expect(digest.data.discuss.map((item) => item.title)).toEqual([
    'Item middle',
  ]);
});

test('opening marks an item read; it can be marked unread again', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const database = databaseOf(testApp);
  const ids = await seed(database, admin.user.id);
  const list = async (query = '') =>
    (
      (await (await admin.fetch(`/feedItems?pageSize=10${query}`)).json()) as {
        data: ListItem[];
      }
    ).data;
  const summary = async (query = '') =>
    (
      (await (await admin.fetch(`/feedItems/summary${query}`)).json()) as {
        data: Summary;
      }
    ).data;

  expect((await list()).every((item) => !item.read)).toBe(true);
  expect((await summary()).unread).toMatchObject({
    all: 3,
    learn: 2,
    discuss: 1,
  });

  const read = await admin.fetch(
    `/feedItems/${ids.middle}/state`,
    json('PATCH', { read: true }),
  );
  expect(read.status).toBe(200);
  await expect(read.json()).resolves.toMatchObject({ data: { read: true } });
  const readAt = async () =>
    (
      await database
        .query()
        .selectFrom('feedItemStates')
        .select(['readAt'])
        .where('itemId', '=', ids.middle)
        .execute()
    )[0]?.readAt;
  const first = await readAt();
  expect(first).not.toBeNull();
  // Opening it again keeps when it was first read.
  await admin.fetch(
    `/feedItems/${ids.middle}/state`,
    json('PATCH', { read: true }),
  );
  expect(String(await readAt())).toBe(String(first));

  const detail = (await (
    await admin.fetch(`/feedItems/${ids.middle}`)
  ).json()) as { data: { read: boolean; state: { read: boolean } } };
  expect(detail.data.read).toBe(true);
  expect(detail.data.state.read).toBe(true);

  // "Unread only" lists exactly what the counts under the same filter say.
  const unreadList = await list('&unread=true');
  expect(unreadList.map((item) => item.title)).toEqual([
    'Item new-weak',
    'Item old-best',
  ]);
  const filtered = await summary('?unread=true');
  expect(filtered.all).toBe(unreadList.length);
  expect(filtered.discuss).toBe(0);
  expect(filtered.learn).toBe((await list('&view=learn&unread=true')).length);
  const plain = await summary();
  expect(plain.all).toBe(3);
  expect(plain.unread.all).toBe(2);
  expect(plain.unread.discuss).toBe(0);

  // Other marks leave the read state alone; marking unread brings it back.
  await admin.fetch(
    `/feedItems/${ids.middle}/state`,
    json('PATCH', { favorite: true }),
  );
  expect((await summary()).unread.all).toBe(2);
  const unread = await admin.fetch(
    `/feedItems/${ids.middle}/state`,
    json('PATCH', { read: false }),
  );
  await expect(unread.json()).resolves.toMatchObject({
    data: { read: false, favorite: true },
  });
  expect((await summary()).unread.all).toBe(3);
});

test('"Mark all as read" reaches exactly what the view lists', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const ids = await seed(databaseOf(testApp), admin.user.id);
  // One item already has a state row without being read; the others have none.
  await admin.fetch(
    `/feedItems/${ids['old-best']}/state`,
    json('PATCH', { later: true }),
  );

  const learn = await admin.fetch(
    '/feedItems/markRead',
    json('POST', { view: 'learn' }),
  );
  expect(learn.status).toBe(200);
  await expect(learn.json()).resolves.toEqual({ data: { marked: 2 } });
  const summary = (await (await admin.fetch('/feedItems/summary')).json()) as {
    data: Summary;
  };
  expect(summary.data.unread).toMatchObject({
    all: 1,
    learn: 0,
    discuss: 1,
    later: 0,
  });
  // The earlier mark stays.
  const detail = (await (
    await admin.fetch(`/feedItems/${ids['old-best']}`)
  ).json()) as { data: { state: { read: boolean; later: boolean } } };
  expect(detail.data.state).toMatchObject({ read: true, later: true });

  // Filters narrow it like the list; nothing left to mark answers 0.
  const none = await admin.fetch(
    '/feedItems/markRead',
    json('POST', { view: 'all', q: 'no such words' }),
  );
  await expect(none.json()).resolves.toEqual({ data: { marked: 0 } });
  const all = await admin.fetch(
    '/feedItems/markRead',
    json('POST', { view: 'all' }),
  );
  await expect(all.json()).resolves.toEqual({ data: { marked: 1 } });
  expect(
    (await admin.fetch('/feedItems/markRead', json('POST', { view: 'nope' })))
      .status,
  ).toBe(400);
  expect((await admin.fetch('/feedItems?unread=maybe')).status).toBe(400);
});

test('read state needs a session and is never someone else’s', async ({
  testApp,
  request,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const ids = await seed(databaseOf(testApp), admin.user.id);

  expect(
    (
      await request(
        `/feedItems/${ids.middle}/state`,
        json('PATCH', { read: true }),
      )
    ).status,
  ).toBe(401);
  expect(
    (await request('/feedItems/markRead', json('POST', { view: 'all' })))
      .status,
  ).toBe(401);

  const credentials = {
    email: 'feed-reader@example.com',
    password: 'feed-reader-password',
  };
  const createUser = json('POST', { name: 'Feed reader', ...credentials });
  const user = await admin.fetch('/users', {
    ...createUser,
    headers: {
      ...(createUser.headers as Record<string, string>),
      // The users API is a standard write and takes an operation key.
      'idempotency-key': `${Date.now()}.${crypto.randomUUID()}`,
    },
  });
  expect(user.status).toBe(201);
  const member = await signIn(testApp, credentials);

  expect(
    (
      await member.fetch(
        `/feedItems/${ids.middle}/state`,
        json('PATCH', { read: true }),
      )
    ).status,
  ).toBe(404);
  // Marking everything as read only reaches the person's own feed.
  await expect(
    (
      await member.fetch('/feedItems/markRead', json('POST', { view: 'all' }))
    ).json(),
  ).resolves.toEqual({ data: { marked: 0 } });
  const summary = (await (await admin.fetch('/feedItems/summary')).json()) as {
    data: Summary;
  };
  expect(summary.data.unread.all).toBe(3);
});
