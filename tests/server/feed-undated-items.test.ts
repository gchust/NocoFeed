import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { expect, vi } from 'vitest';

import { windowReport } from '../../cli/commands/feed/reapply-window.js';
import type { Adapters } from '../../server/providers/feed/adapters.js';
import { timeStatus } from '../../server/providers/feed/admission.js';
import { createFeedService } from '../../server/providers/feed/service.js';
import type {
  CollectedItem,
  EnrichRequest,
  EnrichResult,
} from '../../server/providers/feed/types.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * Issue #21: a three-year-old YouTube video came in as new, because the search page's "3y ago" was not understood and
 * an item without a time passed every time filter. With a time window, an item of unknown age is now held until its
 * time is read, then judged; one older than the window is left out, and both are listed under "Filtered".
 */

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

const read = {
  body: { status: 'available' },
  comments: { status: 'notRequested' },
  transcript: { status: 'notRequested' },
} as const;
const BODY =
  'How we build internal tools with NocoBase: data modelling, permissions and workflows, step by step with examples.';

let runs = 0;

async function setUp(
  testApp: Parameters<typeof signIn>[0],
  {
    platform = 'youtube',
    maxAgeDays = 1,
    published = () => ({ status: 'ok', coverage: {} }),
  }: {
    platform?: 'youtube' | 'rss';
    maxAgeDays?: number;
    published?: (externalId: string) => EnrichResult;
  } = {},
) {
  const run = (runs += 1);
  const id = (name: string) => `${name}w${String(run).padStart(3, '0')}`;
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const database = (
    testApp as unknown as {
      application: {
        container: { resolve: (token: unknown) => DatabaseManager };
      };
    }
  ).application.container.resolve(databaseManagerToken);
  const url = (name: string) =>
    platform === 'youtube'
      ? `https://www.youtube.com/watch?v=${id(name)}`
      : `https://example.com/${id(name)}`;
  const item = (name: string, extra: Partial<CollectedItem> = {}) => ({
    externalId: id(name),
    url: url(name),
    title: `NocoBase ${id(name)}`,
    body: BODY,
    coverage: read,
    ...extra,
  });
  const items: CollectedItem[] = [
    // "3y ago" the Collector could not read, and a video from this morning in the same state.
    item('old'),
    item('fresh'),
    // A control with a known time inside the window: what the fresh one should become.
    item('dated', {
      publishedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    }),
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
    maxAgeDays,
  });
  const source = await service.createSource(ownerId, {
    platform,
    operation: platform === 'youtube' ? 'keyword' : 'feed',
    name: `NocoBase ${run}`,
    target:
      platform === 'youtube' ? 'nocobase' : `https://example.com/${run}.xml`,
    frequency: 60,
    candidateLimit: 20,
    topicIds: [],
  });
  await service.runSource(ownerId, source.id, 'manual');
  const analysis = async (name: string) => {
    const [row] = (await database
      .query()
      .selectFrom('feedItems as i')
      .innerJoin('feedAnalyses as a', (join) =>
        join.onRef('a.itemId', '=', 'i.id').on('a.current', '=', true),
      )
      .select([
        'i.id',
        'i.publishedAt',
        'a.verdict',
        'a.gate',
        'a.heldVerdict',
        'a.uncertainty',
        'a.score',
      ])
      .where('i.ownerId', '=', ownerId)
      .where('i.externalId', '=', id(name))
      .execute<Record<string, unknown>>()) as {
      id: number;
      publishedAt: string | Date | null;
      verdict: string;
      gate: string | null;
      heldVerdict: string | null;
      uncertainty: string;
      score: number;
    }[];
    return row!;
  };
  const view = async (name: 'all' | 'filtered') =>
    (
      await service.listItems(ownerId, {
        view: name,
        platform,
        pageSize: 100,
      } as never)
    ).items
      .map((entry) => entry.url)
      .filter((value): value is string => Boolean(value?.includes(id(''))));
  return { service, database, ownerId, enrich, analysis, view, id, url };
}

test('the rule: unknown is held, older than the window is stale, a day-precise time counts', () => {
  const collectedAt = new Date('2026-11-06T12:00:00Z');
  const base = {
    maxAgeDays: 1,
    approximate: false,
    collectedAt,
    lookupPending: true,
    locale: 'en-US' as const,
  };
  expect(timeStatus({ ...base, publishedAt: null })).toBe('undated');
  expect(timeStatus({ ...base, maxAgeDays: null, publishedAt: null })).toBe(
    'ok',
  );
  expect(
    timeStatus({ ...base, publishedAt: new Date('2023-09-12T12:00:00Z') }),
  ).toBe('stale');
  expect(
    timeStatus({ ...base, publishedAt: new Date('2026-11-06T02:00:00Z') }),
  ).toBe('ok');
  // Only the day is known (noon UTC): a day's grace, then it is stale.
  expect(
    timeStatus({
      ...base,
      approximate: true,
      publishedAt: new Date('2026-11-04T12:00:00Z'),
    }),
  ).toBe('ok');
  expect(
    timeStatus({
      ...base,
      approximate: true,
      publishedAt: new Date('2026-11-03T12:00:00Z'),
    }),
  ).toBe('stale');
});

test('an item of unknown age waits for its time, then comes in or is left out as old', async ({
  testApp,
}) => {
  const now = Date.now();
  const { service, enrich, analysis, view, id, url } = await setUp(testApp, {
    published: (externalId) =>
      externalId.startsWith('old')
        ? {
            status: 'ok',
            publishedAt: '2023-09-12T12:00:00.000Z',
            publishedAtApproximate: true,
            coverage: {},
          }
        : {
            status: 'ok',
            publishedAt: new Date(now - 5 * HOUR).toISOString(),
            coverage: {},
          },
  });

  // Collected: neither undated item is in the feed; both are under "Filtered", saying why.
  for (const name of ['old', 'fresh']) {
    const held = await analysis(name);
    expect(held).toMatchObject({ verdict: 'ignore', gate: 'undated' });
    expect(held.uncertainty).toMatch(/^Publication time unknown/);
  }
  const dated = await analysis('dated');
  expect(dated.gate).toBeNull();
  expect(await view('all')).toEqual([url('dated')]);
  expect((await view('filtered')).sort()).toEqual(
    [url('fresh'), url('old')].sort(),
  );

  // The scheduled lookup reads both times, undated items first.
  await service.resolvePublishedTimes();
  const asked = enrich.mock.calls
    .map(([request]) => request.externalId)
    .filter((externalId) => externalId.endsWith(id('')));
  expect(asked.sort()).toEqual([id('fresh'), id('old')].sort());

  // Three years old: left out, with the date and the window.
  const old = await analysis('old');
  expect(old).toMatchObject({ verdict: 'ignore', gate: 'stale' });
  expect(old.uncertainty).toMatch(
    /^Published around 2023-09-12, before your time window \(the last 1 days\)/,
  );
  expect(old.uncertainty).not.toMatch(/Publication time unknown/);
  // From this morning: analysed as the dated control was, and in the feed.
  const fresh = await analysis('fresh');
  expect(fresh.gate).toBeNull();
  expect(fresh.verdict).toBe(dated.verdict);
  expect(fresh.score).toBe(dated.score);
  expect(fresh.uncertainty).not.toMatch(/Publication time unknown/);
  expect((await view('all')).sort()).toEqual(
    [url('dated'), url('fresh')].sort(),
  );
  expect(await view('filtered')).toEqual([url('old')]);
});

test('a time that cannot be read keeps the item out and says so', async ({
  testApp,
}) => {
  const { service, analysis, view, url } = await setUp(testApp);
  await service.resolvePublishedTimes();
  for (const name of ['old', 'fresh']) {
    const held = await analysis(name);
    expect(held).toMatchObject({ verdict: 'ignore', gate: 'undated' });
    expect(held.uncertainty).toMatch(
      /^Publication time unknown: the platform gave none and the original page did not say/,
    );
    // The explanation is replaced, not piled up.
    expect(held.uncertainty.match(/Publication time unknown/g)).toHaveLength(1);
  }
  expect(await view('all')).toEqual([url('dated')]);
});

test('an RSS entry without a date is held at once, and nobody without a window is affected', async ({
  testApp,
}) => {
  const rss = await setUp(testApp, { platform: 'rss' });
  const held = await rss.analysis('fresh');
  expect(held).toMatchObject({ verdict: 'ignore', gate: 'undated' });
  // Nothing can look an RSS entry's time up: the final reason straight away.
  expect(held.uncertainty).toMatch(/the original page did not say/);
  expect(rss.enrich).not.toHaveBeenCalled();

  const open = await setUp(testApp, { maxAgeDays: 0 });
  const kept = await open.analysis('old');
  expect(kept.gate).toBeNull();
  expect(kept.verdict).toBe((await open.analysis('dated')).verdict);
});

test('reapply-window reports old and undated items already in the feed, writes only with --apply, and spares kept ones', async ({
  testApp,
}) => {
  // Collected before the change: no window then, so everything came in.
  const { service, database, ownerId, analysis, view, url, id } = await setUp(
    testApp,
    { maxAgeDays: 0 },
  );
  const oldItem = await analysis('old');
  await database
    .query()
    .updateTable('feedItems')
    .set({
      publishedAt: new Date('2023-09-12T12:00:00.000Z'),
      publishedApproximate: true,
    })
    .where('id', '=', oldItem.id)
    .execute();
  const dated = await analysis('dated');
  await service.updateState(ownerId, dated.id, { favorite: true } as never);
  await database
    .query()
    .updateTable('feedItems')
    .set({ publishedAt: new Date('2020-01-01T00:00:00.000Z') })
    .where('id', '=', dated.id)
    .execute();
  // The person narrows the window to today.
  await service.saveProfile(ownerId, {
    interests: 'nocobase',
    expertise: '',
    avoid: '',
    dailyLimit: 0,
    keepLearning: true,
    maxAgeDays: 1,
  });
  const before = (await view('all')).sort();
  expect(before).toEqual([url('dated'), url('fresh'), url('old')].sort());

  const preview = await service.reapplyTimeWindow({ dryRun: true });
  const stale = preview.stale.filter((entry) => entry.title.endsWith(id('')));
  const undated = preview.undated.filter((title) => title.endsWith(id('')));
  expect(stale).toEqual([
    {
      title: `NocoBase ${id('old')}`,
      publishedAt: '2023-09-12T12:00:00.000Z',
      approximate: true,
    },
  ]);
  // The favourite is the person's: never reported, never touched.
  expect(undated).toEqual([`NocoBase ${id('fresh')}`]);
  // A dry run changes nothing.
  expect((await view('all')).sort()).toEqual(before);
  expect(windowReport({ checked: 3, stale, undated }, true)).toEqual([
    `stale: NocoBase ${id('old')} (published about 2023-09-12)`,
    `undated: NocoBase ${id('fresh')}`,
    'Checked 3 items; 1 older than the window and 1 without a publication time would be left out. Nothing was changed: run again with --apply to write it.',
  ]);
  expect(windowReport({ checked: 3, stale, undated }, false).at(-1)).toBe(
    'Checked 3 items; 1 older than the window and 1 without a publication time are now left out.',
  );

  await service.reapplyTimeWindow();
  expect(await view('all')).toEqual([url('dated')]);
  expect(await analysis('old')).toMatchObject({
    gate: 'stale',
    heldVerdict: oldItem.verdict,
  });
  expect((await analysis('fresh')).gate).toBe('undated');
  // Nothing left to do.
  const again = await service.reapplyTimeWindow({ dryRun: true });
  expect(
    [...again.stale.map((entry) => entry.title), ...again.undated].filter(
      (title) => title.endsWith(id('')),
    ),
  ).toEqual([]);
});
