import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FeedConfig } from '../../server/config/feed.js';
import { createAdapters } from '../../server/providers/feed/adapters.js';

const config = (): FeedConfig => ({
  collector: { url: '', token: '', timeoutMs: 1_000 },
  tickMinutes: 5,
  userAgent: 'NocoFeed-test',
  notificationChannel: 'inbox',
});

const story = (id: number, score: number) => ({
  id,
  type: 'story',
  title: `Story ${id}`,
  by: 'someone',
  time: 1_793_000_000,
  score,
  descendants: score,
  url: `https://example.com/${id}`,
});

function stub(routes: Record<string, unknown>): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      const key = Object.keys(routes).find((path) => url.includes(path));
      return key
        ? Response.json(routes[key])
        : new Response('not found', { status: 404 });
    }),
  );
  return requested;
}

afterEach(() => vi.unstubAllGlobals());

describe('Hacker News ranked lists', () => {
  it('reads the front page, and missing a known id there skips nothing', async () => {
    const requested = stub({
      '/topstories.json': [3, 2, 1],
      '/item/3.json': story(3, 400),
      '/item/2.json': story(2, 120),
    });
    const result = await createAdapters(config).collect({
      platform: 'hn',
      operation: 'top',
      target: '',
      limit: 2,
      cursor: null,
      knownIds: new Set(['99']),
      signal: new AbortController().signal,
    });
    expect(requested[0]).toContain('/topstories.json');
    expect(result.status).toBe('ok');
    // The list is ranked, not newest first: not reaching a known id is no gap.
    expect(result.truncated).toBe(false);
    expect(result.items.map((item) => [item.externalId, item.metrics])).toEqual(
      [
        ['3', { points: 400, comments: 400 }],
        ['2', { points: 120, comments: 120 }],
      ],
    );
  });
});

describe('reading counts again', () => {
  it('reads Hacker News and Bilibili counts, and nothing it cannot read on its own', async () => {
    const requested = stub({
      '/item/42.json': story(42, 77),
      'web-interface/view?bvid=BV1xx411c7mD': {
        code: 0,
        data: { stat: { view: 1_000, like: 50, reply: 5, favorite: 9 } },
      },
    });
    const adapters = createAdapters(config);
    const signal = new AbortController().signal;
    expect(await adapters.metrics('hn', '42', signal)).toEqual({
      points: 77,
      comments: 77,
    });
    expect(await adapters.metrics('bilibili', 'BV1xx411c7mD', signal)).toEqual({
      views: 1_000,
      likes: 50,
      comments: 5,
      favorites: 9,
    });
    // Search platforms need the Collector; ids that are not ids are never sent anywhere.
    expect(await adapters.metrics('xiaohongshu', 'abc', signal)).toBeNull();
    expect(await adapters.metrics('hn', '../x', signal)).toBeNull();
    expect(requested).toHaveLength(2);
  });
});
