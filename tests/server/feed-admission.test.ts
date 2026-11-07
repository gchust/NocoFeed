import { describe, expect, it } from 'vitest';

import {
  admit,
  isReply,
  looksThin,
  settleWatch,
  substanceOf,
  type AdmissionContext,
} from '../../server/providers/feed/admission.js';
import {
  analyzeWithRules,
  parseModelAnswer,
  type AnalysisDraft,
  type AnalysisItem,
  type AnalysisTopic,
} from '../../server/providers/feed/analyzer.js';
import { HOT_HEAT } from '../../server/providers/feed/heat.js';
import { countsAfterRead } from '../../server/providers/feed/service.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-06T14:30:00Z');

const topics: AnalysisTopic[] = [
  {
    id: 2,
    name: 'vibe coding',
    goal: 'vibe coding in practice',
    avoid: null,
    mode: 'both',
  },
];
const profile = {
  interests: 'vibe coding',
  expertise: null,
  avoid: null,
  keepLearning: true,
};

/** The post from issue #19: a reply to three strangers, nobody liked it. */
const reply: AnalysisItem = {
  platform: 'x',
  title:
    '@ChromeSpectre @jcgabesol @tiagozip_ to me, vibe coding is using ai to any capacity',
  author: 'ash__ppc',
  summary: null,
  body: '@ChromeSpectre @jcgabesol @tiagozip_ to me, vibe coding is using ai to any capacity\ni also am retarded, and an swe',
  comments: [],
  transcript: [],
  media: [],
  metrics: { likes: 0 },
  coverage: {
    body: { status: 'available' },
    comments: { status: 'notRequested' },
  },
};
const shortPost: AnalysisItem = {
  ...reply,
  title: 'vibe coding is the future, change my mind',
  body: 'vibe coding is the future, change my mind',
};
const longPost: AnalysisItem = {
  ...reply,
  title: 'How I ship features with vibe coding',
  body: `How I ship features with vibe coding. ${'First I write the tests, then I ask the agent for a plan, review it, and only then let it edit. '.repeat(4)}`,
};

const context = (
  overrides: Partial<AdmissionContext> = {},
): AdmissionContext => ({
  fromSearch: true,
  kept: false,
  asked: false,
  heat: 0,
  publishedAt: new Date(NOW.getTime() - 20 * HOUR),
  waitForHeat: true,
  waitHours: 12,
  now: NOW,
  locale: 'zh-CN',
  ...overrides,
});

const rules = (item: AnalysisItem) =>
  analyzeWithRules(item, topics, profile, 'zh-CN');

/** A model analysis with the given axes; the server computes quality and hides what falls below the bar. */
const model = (
  item: AnalysisItem,
  axes: [number, number, number, number],
  noise = 'none',
): AnalysisDraft =>
  parseModelAnswer(
    JSON.stringify({
      topicId: 2,
      verdict: 'learn',
      score: 80,
      quality: {
        contentType: 'opinion',
        substance: axes[0],
        novelty: axes[1],
        evidence: axes[2],
        usefulness: axes[3],
        noise,
      },
      interestLevel: 'high',
      interestReason: 'vibe coding',
      experienceLevel: 'none',
      experienceReason: '',
      lead: 'lead',
      steps: [],
      evidence: '',
      uncertainty: '',
    }),
    topics,
    item,
    'zh-CN',
    'test/model',
  );

describe('admission of search results', () => {
  it('tells replies and thin text posts apart from the rest', () => {
    expect(isReply(reply)).toBe(true);
    expect(isReply(shortPost)).toBe(false);
    expect(isReply({ ...reply, platform: 'reddit' })).toBe(false);
    expect(looksThin(reply)).toBe(true);
    expect(looksThin(shortPost)).toBe(true);
    expect(looksThin(longPost)).toBe(false);
    // Pictures may carry what the text does not say; a video's description says little about the video.
    expect(
      looksThin({
        ...shortPost,
        media: [{ type: 'image', url: 'https://example.com/a.jpg' }],
      }),
    ).toBe(false);
    expect(looksThin({ ...shortPost, platform: 'youtube' })).toBe(false);
    expect(substanceOf(longPost, rules(longPost))).toBe('unproven');
    expect(substanceOf(shortPost, model(shortPost, [2, 2, 1, 1]))).toBe('thin');
    expect(substanceOf(shortPost, model(shortPost, [7, 7, 6, 7]))).toBe(
      'solid',
    );
  });

  it('leaves the thin, unnoticed reply from issue #19 out of the feed, with the reason', () => {
    // The rules alone matched the topic words and recommended it.
    const analysed = rules(reply);
    expect(analysed.verdict).toBe('learn');
    const draft = admit(reply, analysed, context());
    expect(draft).toMatchObject({
      verdict: 'ignore',
      gate: 'reply',
      heldVerdict: 'learn',
    });
    expect(draft.uncertainty).toContain('回复');
    // The same with a model that found it thin.
    expect(admit(reply, model(reply, [1, 1, 0, 1]), context())).toMatchObject({
      verdict: 'ignore',
      gate: 'reply',
    });
    // A reply with real substance comes in, however quiet.
    expect(admit(reply, model(reply, [7, 7, 6, 7]), context())).toMatchObject({
      verdict: 'learn',
      gate: null,
    });
  });

  it('lets substance in whatever its attention', () => {
    const fair = model(longPost, [5, 4, 4, 5]);
    expect(fair.quality).toBeGreaterThanOrEqual(35);
    expect(admit(longPost, fair, context())).toMatchObject({
      verdict: 'learn',
      gate: null,
    });
    // Worth the rules cannot judge (longer text) keeps its verdict.
    expect(admit(longPost, rules(longPost), context())).toMatchObject({
      verdict: 'learn',
      gate: null,
    });
  });

  it('lets a hot, thin item in as a hot item, but never selling or hype', () => {
    const thin = model(shortPost, [2, 2, 1, 1]);
    // Hidden by worth alone, with the verdict it would have had kept.
    expect(thin).toMatchObject({ verdict: 'ignore', heldVerdict: 'learn' });
    expect(admit(shortPost, thin, context({ heat: HOT_HEAT }))).toMatchObject({
      verdict: 'learn',
      gate: null,
      heldVerdict: null,
    });
    expect(
      admit(reply, rules(reply), context({ heat: HOT_HEAT + 10 })),
    ).toMatchObject({ verdict: 'learn', gate: null });
    const promo = model(shortPost, [2, 2, 1, 1], 'promo');
    expect(promo.heldVerdict).toBeNull();
    expect(admit(shortPost, promo, context({ heat: 100 }))).toMatchObject({
      verdict: 'ignore',
      gate: null,
    });
    // Without attention, thin stays out.
    expect(admit(shortPost, thin, context())).toMatchObject({
      verdict: 'ignore',
      gate: 'thin',
    });
  });

  it('lets a new thin post wait for its heat, unless the person turned that off or asked', () => {
    const publishedAt = new Date(NOW.getTime() - 2 * HOUR);
    const waiting = admit(
      shortPost,
      rules(shortPost),
      context({ publishedAt }),
    );
    expect(waiting).toMatchObject({
      verdict: 'ignore',
      gate: 'watching',
      heldVerdict: 'learn',
      watchUntil: new Date(publishedAt.getTime() + 12 * HOUR),
    });
    expect(
      admit(
        shortPost,
        rules(shortPost),
        context({ publishedAt, waitForHeat: false }),
      ),
    ).toMatchObject({ gate: 'thin', watchUntil: null });
    expect(
      admit(shortPost, rules(shortPost), context({ publishedAt, asked: true })),
    ).toMatchObject({ gate: 'thin' });
    // A longer wait keeps an older post waiting too.
    expect(
      admit(
        shortPost,
        rules(shortPost),
        context({
          publishedAt: new Date(NOW.getTime() - 20 * HOUR),
          waitHours: 24,
        }),
      ),
    ).toMatchObject({ gate: 'watching' });

    // When the wait is over: hot comes in, anything else stays out as thin.
    expect(settleWatch(waiting, HOT_HEAT, 'zh-CN')).toMatchObject({
      gate: null,
      verdict: 'learn',
    });
    const cold = settleWatch(waiting, 12, 'zh-CN');
    expect(cold).toMatchObject({ gate: 'thin', verdict: 'ignore' });
    expect(cold.uncertainty).not.toContain('先观察');
    expect(settleWatch(waiting, null, 'zh-CN').gate).toBe('thin');
  });

  it('leaves alone what the person chose or kept', () => {
    const analysed = rules(reply);
    expect(admit(reply, analysed, context({ fromSearch: false }))).toBe(
      analysed,
    );
    expect(admit(reply, analysed, context({ kept: true }))).toBe(analysed);
  });
});

describe('counts after reading a discussion through the Collector', () => {
  it('uses the counts the Collector sent, or the replies read as a lower bound', () => {
    expect(
      countsAfterRead(
        'x',
        { likes: 0 },
        { metrics: { likes: 120, reposts: 30 }, comments: [] },
      ),
    ).toEqual({ likes: 120, reposts: 30 });
    expect(
      countsAfterRead(
        'x',
        { likes: 4, replies: 1 },
        {
          comments: [
            { author: 'a', text: 'yes' },
            { author: 'b', text: 'no' },
          ],
        },
      ),
    ).toEqual({ likes: 4, replies: 2 });
    expect(
      countsAfterRead('xiaohongshu', null, {
        comments: [{ author: 'a', text: '好' }],
      }),
    ).toEqual({ comments: 1 });
    expect(countsAfterRead('x', { likes: 1 }, {})).toBeNull();
  });
});
