import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { expect, vi } from 'vitest';

import type { Adapters } from '../../server/providers/feed/adapters.js';
import { heatOf, HOT_HEAT } from '../../server/providers/feed/heat.js';
import { createFeedService } from '../../server/providers/feed/service.js';
import { createStandaloneServer } from '../../server/standalone.js';

const ORIGIN = 'http://localhost';
const HOUR = 3_600_000;

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

/** A topic's source on Reddit, which is read natively, so its counts can be read again without the Collector. */
async function topicSource(
  database: DatabaseManager,
  ownerId: string,
  topicId: number,
): Promise<number> {
  const { record } = (await database.repository('feedSources').createOne({
    values: {
      ownerId,
      topicId,
      platform: 'reddit',
      operation: 'community',
      name: 'vibe coding · reddit',
      target: 'vibecoding',
      frequency: 360,
      candidateLimit: 20,
      active: true,
      status: 'idle',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as never)) as { record: { id: number } };
  return Number(record.id);
}

interface Listed {
  id: number;
  verdict: string | null;
  gate: string | null;
}

test('thin search results stay out, new ones wait for their heat, and what the person kept is left alone', async ({
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
  const ownerId = admin.user.id;

  // No model: the keyword rules judge, as when the daily model budget is used up (issue #19).
  const saved = await admin.fetch(
    '/feedProfile',
    json('PUT', {
      interests: 'vibe coding',
      expertise: '',
      avoid: '',
      dailyLimit: 0,
      keepLearning: true,
      locale: 'zh-CN',
    }),
  );
  const profile = (await saved.json()) as {
    data: { waitForHeat: boolean; waitHours: number };
  };
  // Waiting is on by default, for half a day.
  expect(profile.data).toMatchObject({ waitForHeat: true, waitHours: 12 });

  const created = await admin.fetch(
    '/feedTopics',
    json('POST', {
      name: 'vibe coding',
      goal: 'vibe coding in practice',
      mode: 'both',
      searchTerms: ['vibe coding'],
      searchPlatforms: ['x'],
    }),
  );
  const { data: topic } = (await created.json()) as {
    data: { id: number; searches: { id: number; platform: string }[] };
  };
  const xSearch = topic.searches.find((row) => row.platform === 'x')!.id;
  // Reddit has no keyword search; a topic's source there stands for a search on a platform read natively.
  const redditSearch = await topicSource(database, ownerId, topic.id);
  const { record: subscription } = (await database
    .repository('feedSources')
    .createOne({
      values: {
        ownerId,
        platform: 'x',
        operation: 'account',
        name: 'A followed account',
        target: 'someone',
        frequency: 60,
        candidateLimit: 20,
        active: true,
        status: 'idle',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never)) as { record: { id: number } };

  const now = new Date();
  let next = 1;
  const seed = async (values: {
    sourceId: number;
    platform?: string;
    text: string;
    ageHours: number;
    metrics?: Record<string, number>;
  }): Promise<number> => {
    const platform = values.platform ?? 'x';
    const at = new Date(now.getTime() - values.ageHours * HOUR);
    const metrics = values.metrics ?? { likes: 0 };
    const externalId = String(next++);
    const { record } = (await database.repository('feedItems').createOne({
      values: {
        ownerId,
        platform,
        externalId,
        sourceId: values.sourceId,
        url: `https://x.com/i/status/${externalId}`,
        title: values.text.slice(0, 120),
        body: values.text,
        metrics,
        heat: heatOf(platform, metrics),
        coverage: {
          body: { status: 'available' },
          comments: { status: 'notRequested' },
        },
        contentVersion: 1,
        publishedAt: at,
        timelineAt: at,
        fetchedAt: now,
        createdAt: now,
      },
    } as never)) as { record: { id: number } };
    return Number(record.id);
  };

  const issueReply = await seed({
    sourceId: xSearch,
    text: '@ChromeSpectre @jcgabesol @tiagozip_ to me, vibe coding is using ai to any capacity\ni also am retarded, and an swe',
    ageHours: 12,
  });
  const newThin = await seed({
    sourceId: xSearch,
    text: 'vibe coding is the future, change my mind',
    ageHours: 1,
  });
  const newThinQuiet = await seed({
    sourceId: xSearch,
    text: 'vibe coding all weekend again, send coffee',
    ageHours: 2,
  });
  const oldThin = await seed({
    sourceId: xSearch,
    text: 'anyone else vibe coding on a sunday?',
    ageHours: 30,
  });
  const hotThin = await seed({
    sourceId: xSearch,
    text: 'vibe coding is just coding with extra steps',
    ageHours: 30,
    metrics: { likes: 4_000, reposts: 900, replies: 600 },
  });
  const longPost = await seed({
    sourceId: xSearch,
    text: `How I ship features with vibe coding. ${'First I write the tests, then I ask the agent for a plan, review it, and only then let it edit. '.repeat(4)}`,
    ageHours: 1,
  });
  const redditThin = await seed({
    sourceId: redditSearch,
    platform: 'reddit',
    text: 'vibe coding, thoughts?',
    ageHours: 1,
    metrics: { points: 1, comments: 0 },
  });
  const followed = await seed({
    sourceId: subscription.id,
    text: 'vibe coding, short and sweet',
    ageHours: 1,
  });

  const enrich = vi.fn(
    async (request: { externalId: string; want: string[] }) => {
      if (request.externalId === '2')
        return {
          status: 'ok' as const,
          comments: [],
          metrics: { likes: 3_000, reposts: 500, replies: 200 },
          coverage: { comments: { status: 'available' as const } },
        };
      return {
        status: 'ok' as const,
        comments: [{ author: 'a', text: 'meh' }],
        coverage: { comments: { status: 'partial' as const } },
      };
    },
  );
  const metrics = vi.fn(async () => ({ points: 2, comments: 1 }));
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(),
      enrich,
      metrics,
      collectorConfigured: () => true,
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

  for (const [ids, sourceId] of [
    [[issueReply, newThin, newThinQuiet, oldThin, hotThin, longPost], xSearch],
    [[redditThin], redditSearch],
    [[followed], subscription.id],
  ] as const)
    await service.analyzeItems(ownerId, [...ids], sourceId);

  const gates = async () =>
    Object.fromEntries(
      (
        await database
          .query()
          .selectFrom('feedAnalyses')
          .select(['itemId', 'verdict', 'gate'])
          .where('current', '=', true)
          .execute()
      ).map((row) => [
        Number(row.itemId),
        `${String(row.verdict)}/${String(row.gate)}`,
      ]),
    );
  expect(await gates()).toMatchObject({
    [issueReply]: 'ignore/reply',
    [newThin]: 'ignore/watching',
    [newThinQuiet]: 'ignore/watching',
    [oldThin]: 'ignore/thin',
    [hotThin]: 'learn/null',
    [longPost]: 'learn/null',
    [redditThin]: 'ignore/watching',
    [followed]: 'learn/null',
  });

  // The feed lists what came in; "Filtered" lists the rest with the reason.
  const list = async (view: string) =>
    (
      (await (await admin.fetch(`/feedItems?view=${view}`)).json()) as {
        data: Listed[];
      }
    ).data;
  expect((await list('all')).map((row) => row.id).sort()).toEqual(
    [hotThin, longPost, followed].sort(),
  );
  const filtered = await list('filtered');
  expect(filtered.find((row) => row.id === issueReply)?.gate).toBe('reply');
  const summary = (await (await admin.fetch('/feedItems/summary')).json()) as {
    data: { all: number; filtered: number; unread: { filtered: number } };
  };
  expect(summary.data).toMatchObject({ all: 3, filtered: 5 });
  expect(summary.data.unread.filtered).toBe(5);

  // Nothing is due before the wait is over.
  expect(await service.settleWatching({ now })).toBe(0);
  expect(enrich).not.toHaveBeenCalled();

  // After the wait the counts are read again: the post that took off comes in, the quiet ones stay out.
  const later = new Date(now.getTime() + 13 * HOUR);
  expect(await service.settleWatching({ now: later })).toBe(3);
  expect(enrich).toHaveBeenCalledTimes(2);
  expect(enrich).toHaveBeenCalledWith(
    expect.objectContaining({ want: ['comments'] }),
  );
  expect(metrics).toHaveBeenCalledWith(
    'reddit',
    expect.any(String),
    expect.anything(),
  );
  expect(await gates()).toMatchObject({
    [newThin]: 'learn/null',
    [newThinQuiet]: 'ignore/thin',
    [redditThin]: 'ignore/thin',
  });
  const risen = (await (await admin.fetch(`/feedItems/${newThin}`)).json()) as {
    data: { heat: number; metrics: Record<string, number> };
  };
  expect(risen.data.heat).toBeGreaterThanOrEqual(HOT_HEAT);
  // The lower bound from the replies read went into the stored counts.
  const quiet = (await (
    await admin.fetch(`/feedItems/${newThinQuiet}`)
  ).json()) as { data: { metrics: Record<string, number> } };
  expect(quiet.data.metrics).toEqual({ likes: 0, replies: 1 });
});

test('watching has a cap, a Collector that cannot read retries until the grace is over, and the switch decides at once', async ({
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
  const ownerId = admin.user.id;
  await admin.fetch(
    '/feedProfile',
    json('PUT', {
      interests: 'vibe coding',
      expertise: '',
      avoid: '',
      dailyLimit: 0,
      keepLearning: true,
      locale: 'en-US',
      waitHours: 6,
    }),
  );
  const created = await admin.fetch(
    '/feedTopics',
    json('POST', {
      name: 'vibe coding',
      goal: 'vibe coding in practice',
      mode: 'both',
      searchTerms: ['vibe coding'],
      searchPlatforms: ['x'],
    }),
  );
  const { data: topic } = (await created.json()) as {
    data: { searches: { id: number }[] };
  };
  const sourceId = topic.searches[0]!.id;
  const now = new Date();
  const seed = async (externalId: string, ageHours: number) => {
    const at = new Date(now.getTime() - ageHours * HOUR);
    const { record } = (await database.repository('feedItems').createOne({
      values: {
        ownerId,
        platform: 'x',
        externalId,
        sourceId,
        url: `https://x.com/i/status/${externalId}`,
        title: `vibe coding thought number ${externalId}`,
        body: `vibe coding thought number ${externalId}`,
        metrics: { likes: 1 },
        heat: heatOf('x', { likes: 1 }),
        coverage: {
          body: { status: 'available' },
          comments: { status: 'notRequested' },
        },
        contentVersion: 1,
        publishedAt: at,
        timelineAt: at,
        fetchedAt: now,
        createdAt: now,
      },
    } as never)) as { record: { id: number } };
    return Number(record.id);
  };
  const ids = [await seed('w1', 3), await seed('w2', 2), await seed('w3', 1)];
  const enrich = vi.fn(async () => ({
    status: 'rateLimited' as const,
    coverage: {},
  }));
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(),
      enrich,
      metrics: vi.fn(),
      collectorConfigured: () => true,
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
  await service.analyzeItems(ownerId, ids, sourceId);
  const current = async () =>
    await database
      .query()
      .selectFrom('feedAnalyses')
      .select(['itemId', 'gate', 'watchUntil'])
      .where('current', '=', true)
      .where('itemId', 'in', ids)
      .orderBy('itemId')
      .execute();
  // The person's six hours count from publication.
  const watched = await current();
  expect(watched.map((row) => row.gate)).toEqual([
    'watching',
    'watching',
    'watching',
  ]);
  expect(new Date(watched[0]!.watchUntil as Date).getTime()).toBe(
    now.getTime() + 3 * HOUR,
  );

  // Over the cap, the oldest is decided at once on what is known; nothing is read for it.
  expect(await service.settleWatching({ now, maxWatching: 2 })).toBe(1);
  expect(enrich).not.toHaveBeenCalled();
  expect((await current()).map((row) => row.gate)).toEqual([
    'thin',
    'watching',
    'watching',
  ]);

  // Due, but the Collector is rate limited: it stops for this tick and the items wait.
  const due = new Date(now.getTime() + 6 * HOUR);
  expect(await service.settleWatching({ now: due })).toBe(0);
  expect(enrich).toHaveBeenCalledTimes(1);
  // Past the grace they are decided on the counts they have.
  expect(
    await service.settleWatching({ now: new Date(due.getTime() + 7 * HOUR) }),
  ).toBe(2);
  expect((await current()).map((row) => row.gate)).toEqual([
    'thin',
    'thin',
    'thin',
  ]);

  // Turned off: a new thin post is decided at once.
  const off = await admin.fetch(
    '/feedProfile',
    json('PUT', {
      interests: 'vibe coding',
      expertise: '',
      avoid: '',
      dailyLimit: 0,
      keepLearning: true,
      waitForHeat: false,
    }),
  );
  expect(
    ((await off.json()) as { data: { waitForHeat: boolean } }).data,
  ).toMatchObject({ waitForHeat: false, waitHours: 6 });
  const fresh = await seed('w4', 1);
  ids.push(fresh);
  await service.analyzeItems(ownerId, [fresh], sourceId);
  expect((await current()).at(-1)).toMatchObject({
    itemId: fresh,
    gate: 'thin',
  });
  expect(
    (
      await admin.fetch(
        '/feedProfile',
        json('PUT', {
          interests: '',
          expertise: '',
          avoid: '',
          dailyLimit: 0,
          keepLearning: true,
          waitHours: 0,
        }),
      )
    ).status,
  ).toBe(400);
});

test('reapply-admission hides thin search results already in the feed, never what the person kept, and a hot one comes back', async ({
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
  const ownerId = admin.user.id;
  await admin.fetch(
    '/feedProfile',
    json('PUT', {
      interests: 'vibe coding',
      expertise: '',
      avoid: '',
      dailyLimit: 0,
      keepLearning: true,
      locale: 'en-US',
    }),
  );
  const created = await admin.fetch(
    '/feedTopics',
    json('POST', {
      name: 'vibe coding',
      goal: 'vibe coding in practice',
      mode: 'both',
      searchTerms: ['vibe coding'],
      searchPlatforms: ['x'],
    }),
  );
  const { data: topic } = (await created.json()) as {
    data: { id: number };
  };
  const sourceId = await topicSource(database, ownerId, topic.id);
  const now = new Date();
  const at = new Date(now.getTime() - 30 * HOUR);
  const ids: number[] = [];
  for (const [externalId, title] of [
    ['a1', 'vibe coding, thoughts?'],
    ['a2', 'vibe coding is fun'],
    ['a3', 'vibe coding again today'],
    ['a4', 'vibe coding what a ride'],
  ]) {
    const { record } = (await database.repository('feedItems').createOne({
      values: {
        ownerId,
        platform: 'reddit',
        externalId,
        sourceId,
        url: `https://www.reddit.com/r/x/comments/${externalId}/`,
        title,
        body: title,
        metrics: { points: 1, comments: 0 },
        heat: heatOf('reddit', { points: 1, comments: 0 }),
        coverage: {
          body: { status: 'available' },
          comments: { status: 'notRequested' },
        },
        contentVersion: 1,
        publishedAt: at,
        timelineAt: at,
        fetchedAt: now,
        createdAt: now,
      },
    } as never)) as { record: { id: number } };
    ids.push(Number(record.id));
  }
  const [plain, favourite, joined, dismissed] = ids as [
    number,
    number,
    number,
    number,
  ];
  // Analysed before the rules existed: all four were recommended.
  for (const itemId of ids)
    await database.repository('feedAnalyses').createOne({
      values: {
        ownerId,
        itemId,
        current: true,
        contentVersion: 1,
        topicId: null,
        verdict: 'learn',
        score: 70,
        priority: 52,
        interestLevel: 'high',
        interestReason: '',
        experienceLevel: 'none',
        experienceReason: '',
        lead: '',
        steps: [],
        evidence: '',
        uncertainty: '',
        engine: 'rules',
        promptVersion: 'rules-4',
        createdAt: now,
      },
    } as never);
  expect(
    (
      await admin.fetch(
        `/feedItems/${favourite}/state`,
        json('PATCH', { favorite: true }),
      )
    ).status,
  ).toBe(200);
  await admin.fetch(
    `/feedItems/${joined}/state`,
    json('PATCH', { participated: true }),
  );
  await admin.fetch(
    `/feedItems/${dismissed}/state`,
    json('PATCH', { dismissed: true }),
  );

  const metrics = vi.fn(async () => ({ points: 900, comments: 300 }));
  const enrich = vi.fn(async () => ({ status: 'ok' as const, coverage: {} }));
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

  const preview = await service.reapplyAdmission({ dryRun: true, now });
  expect(preview).toMatchObject({ hidden: ['vibe coding, thoughts?'] });
  const verdicts = async () =>
    (
      await database
        .query()
        .selectFrom('feedAnalyses')
        .select(['itemId', 'verdict', 'gate'])
        .where('current', '=', true)
        .where('itemId', 'in', ids)
        .orderBy('itemId')
        .execute()
    ).map((row) => `${String(row.verdict)}/${String(row.gate)}`);
  expect(await verdicts()).toEqual([
    'learn/null',
    'learn/null',
    'learn/null',
    'learn/null',
  ]);
  const applied = await service.reapplyAdmission({ now });
  expect(applied.hidden).toEqual(['vibe coding, thoughts?']);
  // Kept or dismissed items are not touched; the favourite stays saved.
  expect(await verdicts()).toEqual([
    'ignore/thin',
    'learn/null',
    'learn/null',
    'learn/null',
  ]);
  const saved = (await (await admin.fetch('/feedItems?view=saved')).json()) as {
    data: Listed[];
  };
  expect(saved.data.map((row) => row.id)).toEqual([favourite]);

  // It turns hot: the refresh lets it in again, judged as before.
  expect(await service.refreshHeat({ now })).toBeGreaterThan(0);
  const back = (await (await admin.fetch(`/feedItems/${plain}`)).json()) as {
    data: { verdict: string; gate: string | null; heat: number };
  };
  expect(back.data.heat).toBeGreaterThanOrEqual(HOT_HEAT);
  expect(back.data).toMatchObject({ verdict: 'learn', gate: null });
});
