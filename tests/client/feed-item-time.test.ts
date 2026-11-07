import { describe, expect, it } from 'vitest';

import { itemTime } from '../../client/pages/feed/format.js';
import enUS from '../../client/locales/en-US.js';
import zhCN from '../../client/locales/zh-CN.js';

const NOW = Date.parse('2026-11-04T13:51:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A `t` over one locale's `feed.time` group, with `{{time}}` filled in the way i18next does. */
const translator =
  (locale: typeof enUS) =>
  (key: string, values?: Record<string, string>): string => {
    const group = locale.feed.time as Record<string, string>;
    const text = group[key.replace('feed.time.', '')] ?? key;
    return text.replace('{{time}}', values?.time ?? '');
  };

const at = (ms: number) => new Date(NOW - ms).toISOString();

describe('itemTime', () => {
  it('shows an exact time as it is', () => {
    const time = itemTime(
      translator(enUS) as never,
      {
        publishedAt: at(3 * 60 * MINUTE),
        publishedApproximate: false,
        createdAt: at(MINUTE),
      },
      'en-US',
      NOW,
    );
    expect(time.text).toBe('3 hours ago');
    expect(time.dateTime).toBe(at(3 * 60 * MINUTE));
  });

  it('says an approximate time is approximate, in both languages', () => {
    const item = {
      publishedAt: at(21 * DAY),
      publishedApproximate: true,
      createdAt: at(13 * MINUTE),
    };
    const en = itemTime(translator(enUS) as never, item, 'en-US', NOW);
    expect(en.text).toBe('about 3 weeks ago');
    expect(en.dateTime).toBe(item.publishedAt);
    const zh = itemTime(translator(zhCN as never) as never, item, 'zh-CN', NOW);
    expect(zh.text).toBe('约3周前');
    // A day read from the video page, also approximate: "about 3 days ago".
    const day = itemTime(
      translator(zhCN as never) as never,
      { ...item, publishedAt: at(3 * DAY) },
      'zh-CN',
      NOW,
    );
    expect(day.text).toBe('约3天前');
    expect(zh.title).toContain('相对时间');
  });

  it('says the publication time is unknown rather than showing only the collection time', () => {
    const item = {
      publishedAt: null,
      publishedApproximate: false,
      createdAt: at(13 * MINUTE),
    };
    const en = itemTime(translator(enUS) as never, item, 'en-US', NOW);
    expect(en.text).toBe('publication time unknown · collected 13 minutes ago');
    expect(en.dateTime).toBe(item.createdAt);
    const zh = itemTime(translator(zhCN as never) as never, item, 'zh-CN', NOW);
    expect(zh.text).toBe('发布时间未知 · 收录于13分钟前');
    expect(zh.title).toContain('没有给出发布时间');
  });

  it('ignores the flag without a time', () => {
    const time = itemTime(
      translator(enUS) as never,
      { publishedAt: null, publishedApproximate: true, createdAt: at(2 * DAY) },
      'en-US',
      NOW,
    );
    expect(time.text).toBe('publication time unknown · collected 2 days ago');
  });
});
