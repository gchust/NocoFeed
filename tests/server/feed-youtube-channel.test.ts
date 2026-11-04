import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FeedConfig } from '../../server/config/feed.js';
import { createAdapters } from '../../server/providers/feed/adapters.js';

const OWN = 'UCsBjURrPoezykLs9EqgamOA';
const OTHER = 'UC2Xd-TjJByJyK2w1zNwY0zQ';

const config = (): FeedConfig => ({
  collector: { url: '', token: '', timeoutMs: 1_000 },
  tickMinutes: 5,
  userAgent: 'NocoFeed-test',
  notificationChannel: 'inbox',
});

const FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;

function stubYouTube(page: string): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      return new Response(url.includes('/feeds/videos.xml') ? FEED : page, {
        status: 200,
      });
    }),
  );
  return requested;
}

const collect = (target: string) =>
  createAdapters(config).collect({
    platform: 'youtube',
    operation: 'channel',
    target,
    limit: 20,
    cursor: null,
    knownIds: new Set(),
    signal: new AbortController().signal,
  });

afterEach(() => vi.unstubAllGlobals());

describe('YouTube channel handles', () => {
  it("reads the page's own channel, not the first channel the page mentions", async () => {
    // A handle page lists recommended channels before its own metadata.
    const requested = stubYouTube(
      `{"channelId":"${OTHER}"}<link rel="canonical" href="https://www.youtube.com/channel/${OWN}">` +
        `{"externalId":"${OWN}"}`,
    );
    const result = await collect('@Fireship');
    expect(result.cursor).toEqual({ channelId: OWN });
    expect(requested.at(-1)).toContain(`channel_id=${OWN}`);
  });

  it('falls back to externalId, then to the first channel id', async () => {
    stubYouTube(`{"channelId":"${OTHER}"}{"externalId":"${OWN}"}`);
    expect((await collect('@Fireship')).cursor).toEqual({ channelId: OWN });
    stubYouTube(`{"channelId":"${OTHER}"}`);
    expect((await collect('@Fireship')).cursor).toEqual({ channelId: OTHER });
  });

  it('uses a channel id as given without asking the page', async () => {
    const requested = stubYouTube('');
    await collect(OWN);
    expect(requested).toEqual([
      `https://www.youtube.com/feeds/videos.xml?channel_id=${OWN}`,
    ]);
  });
});
