import { describe, expect, it } from 'vitest';

import { parseFeed } from '../../server/providers/feed/adapters.js';
import {
  analyzeWithRules,
  matchTopics,
  TERM_WEIGHT_MAX,
  TERM_WEIGHT_MIN,
  termFactor,
  type AnalysisItem,
  type AnalysisProfile,
  type AnalysisTopic,
} from '../../server/providers/feed/analyzer.js';
import {
  localClock,
  nextFollowUp,
  sourceHealth,
} from '../../server/providers/feed/service.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example</title>
    <item>
      <title>Self-hosted Postgres backups</title>
      <link>https://example.com/backups</link>
      <guid>backup-1</guid>
      <dc:creator>Ada</dc:creator>
      <pubDate>Tue, 27 Oct 2026 10:00:00 GMT</pubDate>
      <description>&lt;p&gt;How we &lt;b&gt;back up&lt;/b&gt; Postgres.&lt;/p&gt;</description>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.com/second</link>
      <content:encoded>&lt;p&gt;Full text here.&lt;/p&gt;</content:encoded>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:abc</id>
    <yt:videoId>abc</yt:videoId>
    <title>Building agents with tools</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc"/>
    <author><name>Channel</name></author>
    <published>2026-10-27T08:00:00+00:00</published>
    <media:group>
      <media:description>A talk about LLM agents.</media:description>
      <media:community><media:statistics views="1234"/></media:community>
    </media:group>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('reads RSS items and says how much of each it holds', () => {
    const [first, second] = parseFeed(RSS);
    expect(first).toMatchObject({
      externalId: 'backup-1',
      url: 'https://example.com/backups',
      title: 'Self-hosted Postgres backups',
      author: 'Ada',
      summary: 'How we back up Postgres.',
      publishedAt: '2026-10-27T10:00:00.000Z',
      coverage: { body: { status: 'partial', note: 'feedSummaryOnly' } },
    });
    // Without a guid the link identifies the item, and full content counts as the body.
    expect(second).toMatchObject({
      externalId: 'https://example.com/second',
      body: 'Full text here.',
      coverage: { body: { status: 'available', note: 'feedContent' } },
    });
  });

  it('reads Atom and YouTube entries', () => {
    expect(parseFeed(ATOM)).toEqual([
      expect.objectContaining({
        externalId: 'abc',
        url: 'https://www.youtube.com/watch?v=abc',
        title: 'Building agents with tools',
        author: 'Channel',
        summary: 'A talk about LLM agents.',
        metrics: { views: 1234 },
      }),
    ]);
  });

  it('rejects a page that is not a feed, so the subscription reports why', () => {
    expect(() => parseFeed('<html><body>hi</body></html>')).toThrow(
      expect.objectContaining({ status: 'failed', message: 'notAFeed' }),
    );
  });
});

describe('analyzeWithRules', () => {
  const topic: AnalysisTopic = {
    id: 1,
    name: 'Agent engineering',
    goal: 'Building LLM agents: tool use, evaluation and memory',
    avoid: 'funding',
    mode: 'both',
  };
  const profile: AnalysisProfile = {
    interests: 'agents',
    expertise: 'Built tool use and evaluation harnesses for LLM agents',
    avoid: null,
    keepLearning: true,
  };
  const item = (overrides: Partial<AnalysisItem>): AnalysisItem => ({
    platform: 'hn',
    title: 'Untitled',
    author: null,
    summary: null,
    body: null,
    comments: null,
    transcript: null,
    coverage: {
      body: { status: 'available' },
      comments: { status: 'notRequested' },
    },
    ...overrides,
  });

  it('suggests joining an open question the person has experience with', () => {
    const draft = analyzeWithRules(
      item({
        title: 'Ask HN: How do you evaluate tool use in LLM agents?',
        body: 'We are building agents and struggle with evaluation of tool calls.',
      }),
      [topic],
      profile,
      'en-US',
    );
    expect(draft).toMatchObject({
      topicId: 1,
      verdict: 'discuss',
      experienceLevel: 'strong',
      engine: 'rules',
    });
    expect(draft.lead).toContain('Agent engineering');
    // The score rises with each match but never pins at 100.
    expect(draft.score).toBeGreaterThan(50);
    expect(draft.score).toBeLessThan(100);
  });

  it('keeps unrelated items out and lowers what the person avoids', () => {
    const unrelated = analyzeWithRules(
      item({ title: 'A recipe for sourdough bread' }),
      [topic],
      profile,
      'en-US',
    );
    expect(unrelated.verdict).toBe('ignore');

    const plain = analyzeWithRules(
      item({ title: 'LLM agents tool use' }),
      [topic],
      profile,
      'en-US',
    );
    const avoided = analyzeWithRules(
      item({ title: 'LLM agents tool use funding' }),
      [topic],
      profile,
      'en-US',
    );
    expect(avoided.score).toBeLessThan(plain.score);
  });

  it('skips what can only be learned when the person asked for that', () => {
    const draft = analyzeWithRules(
      item({ title: 'A long read on LLM agents memory design' }),
      [{ ...topic, mode: 'learn' }],
      { ...profile, keepLearning: false },
      'en-US',
    );
    expect(draft.verdict).toBe('ignore');
  });

  it('writes in Chinese when asked and states what was not read', () => {
    const draft = analyzeWithRules(
      item({
        title: 'LLM agents 的工具调用评估',
        coverage: {
          body: { status: 'missing' },
          comments: { status: 'notRequested' },
        },
      }),
      [topic],
      profile,
      'zh-CN',
    );
    expect(draft.lead).toMatch(/Agent engineering/);
    expect(draft.uncertainty).toBeTruthy();
  });
});

describe('learned weights and schedules', () => {
  const topic: AnalysisTopic = {
    id: 1,
    name: 'Agents',
    goal: 'LLM agents tool use evaluation',
    avoid: null,
    mode: 'both',
  };
  const profile: AnalysisProfile = {
    interests: null,
    expertise: null,
    avoid: null,
    keepLearning: true,
  };
  const item: AnalysisItem = {
    platform: 'hn',
    title: 'LLM agents tool use evaluation',
    author: null,
    summary: null,
    body: null,
    comments: null,
    transcript: null,
    coverage: {
      body: { status: 'missing' },
      comments: { status: 'notRequested' },
    },
  };

  it('scores words the person marked down lower and says so', () => {
    const plain = matchTopics(item, [topic], profile);
    const lowered = matchTopics(item, [topic], {
      ...profile,
      termWeights: { agents: TERM_WEIGHT_MIN, evaluation: -2 },
    });
    const raised = matchTopics(item, [topic], {
      ...profile,
      termWeights: { agents: TERM_WEIGHT_MAX },
    });
    expect(lowered.score).toBeLessThan(plain.score);
    expect(raised.score).toBeGreaterThan(plain.score);
    expect(lowered.learned.down).toEqual(['agents', 'evaluation']);
    expect(termFactor({ agents: TERM_WEIGHT_MIN }, 'agents')).toBe(0);
  });

  it('follows a thread hourly at first, less often later, and stops after two weeks', () => {
    const since = new Date('2026-10-01T00:00:00Z');
    const after = (hours: number) =>
      new Date(since.getTime() + hours * 3_600_000);
    const gap = (hours: number) =>
      ((nextFollowUp(since, after(hours))?.getTime() ?? NaN) -
        after(hours).getTime()) /
      3_600_000;
    expect(gap(2)).toBe(1);
    expect(gap(30)).toBe(4);
    expect(gap(100)).toBe(12);
    expect(nextFollowUp(since, after(14 * 24))).toBeNull();
  });

  it('reads the digest hour in the person’s time zone', () => {
    const at = new Date('2026-10-28T23:30:00Z');
    expect(localClock(at, 'Asia/Shanghai')).toEqual({
      date: '2026-10-29',
      hour: 7,
    });
    expect(localClock(at, 'UTC')).toEqual({ date: '2026-10-28', hour: 23 });
  });

  it('calls a subscription failing or quiet only after a streak', () => {
    const base = {
      failureStreak: 0,
      emptyStreak: 0,
      frequency: 60,
      single: false,
    };
    expect(sourceHealth({ ...base, failureStreak: 2 })).toBe('ok');
    expect(sourceHealth({ ...base, failureStreak: 3 })).toBe('failing');
    // Five empty hourly runs are normal; three days of them are not.
    expect(sourceHealth({ ...base, emptyStreak: 5 })).toBe('ok');
    expect(sourceHealth({ ...base, emptyStreak: 72 })).toBe('quiet');
    expect(sourceHealth({ ...base, emptyStreak: 72, single: true })).toBe('ok');
  });
});
