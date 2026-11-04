import { describe, expect, it } from 'vitest';

import {
  parseYouTubeUrl,
  youTubeEmbedUrl,
  youTubeThumbnail,
  youTubeVideoOf,
  youTubeWatchUrl,
} from '../../client/pages/feed/youtube.js';

const ID = 'dQw4w9WgXcQ';

describe('YouTube video ids', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, { id: ID, short: false }],
    [
      `https://youtube.com/watch?v=${ID}&list=PL123&index=2`,
      { id: ID, short: false },
    ],
    [
      `https://m.youtube.com/watch?feature=share&v=${ID}`,
      { id: ID, short: false },
    ],
    [`https://music.youtube.com/watch?v=${ID}`, { id: ID, short: false }],
    [
      `https://www.youtube.com/watch?v=${ID}&t=90s`,
      { id: ID, short: false, start: 90 },
    ],
    [
      `https://www.youtube.com/watch?v=${ID}&t=1h2m3s`,
      { id: ID, short: false, start: 3723 },
    ],
    [`https://youtu.be/${ID}`, { id: ID, short: false }],
    [`https://youtu.be/${ID}?si=abc&t=42`, { id: ID, short: false, start: 42 }],
    [`https://www.youtube.com/shorts/${ID}`, { id: ID, short: true }],
    [`https://youtube.com/shorts/${ID}?feature=share`, { id: ID, short: true }],
    [
      `https://www.youtube.com/embed/${ID}?start=30`,
      { id: ID, short: false, start: 30 },
    ],
    [`https://www.youtube-nocookie.com/embed/${ID}`, { id: ID, short: false }],
    [`https://www.youtube.com/live/${ID}`, { id: ID, short: false }],
    [` https://www.youtube.com/watch?v=${ID} `, { id: ID, short: false }],
  ])('reads %s', (link, expected) => {
    expect(parseYouTubeUrl(link)).toEqual(expected);
  });

  it.each([
    null,
    '',
    'not a link',
    'https://www.youtube.com/@channel',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=short',
    `https://www.youtube.com/watch?v=${ID}x`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://www.youtube.com.evil.example/watch?v=${ID}`,
    `javascript:alert(1)//youtu.be/${ID}`,
    `https://www.bilibili.com/video/BV1xx411c7mD`,
  ])('ignores %s', (link) => {
    expect(parseYouTubeUrl(link)).toBeNull();
  });

  it('falls back to a YouTube item’s external id', () => {
    expect(
      youTubeVideoOf({
        platform: 'youtube',
        url: null,
        externalId: `yt:video:${ID}`,
      }),
    ).toEqual({ id: ID, short: false });
    expect(
      youTubeVideoOf({
        platform: 'youtube',
        url: 'https://example.com/x',
        externalId: ID,
      }),
    ).toEqual({ id: ID, short: false });
    // Another platform's id is never taken for a video id.
    expect(
      youTubeVideoOf({ platform: 'hn', url: null, externalId: ID }),
    ).toBeNull();
    expect(
      youTubeVideoOf({
        platform: 'youtube',
        url: null,
        externalId: 'yt:channel:none',
      }),
    ).toBeNull();
  });

  it('plays a video another platform links', () => {
    expect(
      youTubeVideoOf({ platform: 'hn', url: `https://youtu.be/${ID}` }),
    ).toEqual({ id: ID, short: false });
  });

  it('derives the thumbnail, the privacy-enhanced player and the page', () => {
    expect(youTubeThumbnail(ID)).toBe(
      `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
    );
    expect(youTubeEmbedUrl({ id: ID, short: false, start: 42 })).toBe(
      `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&playsinline=1&rel=0&start=42`,
    );
    expect(youTubeWatchUrl({ id: ID, short: false })).toBe(
      `https://www.youtube.com/watch?v=${ID}`,
    );
    expect(youTubeWatchUrl({ id: ID, short: true })).toBe(
      `https://www.youtube.com/shorts/${ID}`,
    );
  });
});
