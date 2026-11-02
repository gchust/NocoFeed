import { describe, expect, it } from 'vitest';

import {
  analyzeWithRules,
  awaitingMaterial,
  blockedByPrefilter,
  hasOnlyTitle,
  limitedToTitle,
  LOW_QUALITY,
  needsPrefilter,
  parseModelAnswer,
  parsePrefilterAnswer,
  priorityOf,
  qualityOf,
  type AnalysisItem,
  type AnalysisProfile,
  type AnalysisTopic,
} from '../../server/providers/feed/analyzer.js';
import {
  parseGold,
  scoreResults,
  sweepPriority,
} from '../../server/providers/feed/evaluation.js';

const item = (overrides: Partial<AnalysisItem> = {}): AnalysisItem => ({
  platform: 'hn',
  title: 'Postgres backups at scale',
  author: null,
  summary: 'How we restore in minutes.',
  body: null,
  comments: null,
  transcript: null,
  coverage: {
    body: { status: 'missing' },
    comments: { status: 'notRequested' },
  },
  ...overrides,
});
const topics: AnalysisTopic[] = [
  {
    id: 1,
    name: 'Postgres',
    goal: 'postgres backups',
    avoid: null,
    mode: 'both',
  },
];
const profile: AnalysisProfile = {
  interests: null,
  expertise: null,
  avoid: null,
  keepLearning: true,
};
const answer = (fields: Record<string, unknown>) =>
  JSON.stringify({
    verdict: 'discuss',
    score: 80,
    interestLevel: 'high',
    experienceLevel: 'some',
    ...fields,
  });
const axes = {
  contentType: 'howto',
  substance: 8,
  novelty: 8,
  evidence: 8,
  usefulness: 8,
  noise: 'none',
} as const;

describe('quality', () => {
  it('weighs the axes by content type', () => {
    expect(qualityOf(axes)).toBe(80);
    const useful = { ...axes, substance: 0, usefulness: 10 };
    expect(qualityOf(useful)).toBeGreaterThan(
      qualityOf({ ...useful, contentType: 'news' }),
    );
  });

  it('caps noise however high the axes', () => {
    expect(qualityOf({ ...axes, noise: 'promo' })).toBe(30);
    expect(qualityOf({ ...axes, noise: 'roundup' })).toBe(40);
  });

  it('ranks relevant and solid above relevant and thin, and rules between them', () => {
    expect(priorityOf(80, 90)).toBeGreaterThan(priorityOf(80, null));
    expect(priorityOf(80, null)).toBeGreaterThan(priorityOf(80, 10));
    // Relevance still decides: worth cannot lift what does not concern the person.
    expect(priorityOf(20, 100)).toBeLessThan(priorityOf(80, 10));
  });

  it('reads quality from the model, unknown rather than guessed when unusable', () => {
    const parse = (fields: Record<string, unknown>) =>
      parseModelAnswer(answer(fields), topics, item(), 'en-US', 'm');
    expect(parse({ quality: axes })).toMatchObject({
      quality: 80,
      verdict: 'discuss',
      priority: priorityOf(80, 80),
    });
    expect(
      parse({ quality: { ...axes, substance: 99, novelty: 99 } }).qualityDetail,
    ).toMatchObject({ substance: 10, novelty: 10 });
    expect(parse({})).toMatchObject({ quality: null, qualityDetail: null });
    expect(parse({ quality: { ...axes, contentType: 'poem' } }).quality).toBe(
      null,
    );
  });

  it('keeps the analysis when a level is mangled, but not without a verdict', () => {
    const parse = (fields: Record<string, unknown>) =>
      parseModelAnswer(answer(fields), topics, item(), 'zh-CN', 'm');
    expect(
      parse({ interestLevel: '中', experienceLevel: 'lots' }),
    ).toMatchObject({
      interestLevel: 'high',
      experienceLevel: 'none',
      engine: 'model',
    });
    expect(() => parse({ verdict: '学习' })).toThrow('invalid verdict');
  });

  it('does not let noise be recommended for joining, and hides what is worthless', () => {
    const parse = (quality: Record<string, unknown>) =>
      parseModelAnswer(
        answer({ quality }),
        topics,
        item({ body: 'The whole article.' }),
        'en-US',
        'm',
      );
    expect(parse({ ...axes, noise: 'hype' }).verdict).toBe('learn');
    // One label lowers an item but does not hide it; only low axes do.
    expect(parse({ ...axes, noise: 'promo' }).verdict).toBe('learn');
    const worthless = parse({
      ...axes,
      substance: 1,
      novelty: 1,
      evidence: 1,
      usefulness: 1,
    });
    expect(worthless.quality).toBeLessThan(LOW_QUALITY);
    expect(worthless.verdict).toBe('ignore');
  });
});

describe('low worth', () => {
  const low = {
    ...axes,
    substance: 1,
    novelty: 1,
    evidence: 1,
    usefulness: 1,
  };

  it('does not hide what was judged from a blurb, only ranks it low', () => {
    const draft = parseModelAnswer(
      answer({ verdict: 'learn', quality: low }),
      topics,
      item(),
      'en-US',
      'm',
    );
    expect(draft.verdict).toBe('learn');
    expect(draft.priority).toBeLessThan(priorityOf(80, null));
  });
});

describe('prefilter', () => {
  it('asks only about items the keywords did not match, given something to compare with', () => {
    expect(needsPrefilter(item(), topics, profile)).toBe(false);
    const other = item({ title: 'Gardening tips', summary: 'Tomatoes.' });
    expect(needsPrefilter(other, topics, profile)).toBe(true);
    expect(needsPrefilter(other, [], profile)).toBe(false);
  });

  it('stops only explicit, in-range BLOCKs', () => {
    const blocked = parsePrefilterAnswer(
      JSON.stringify({
        results: [
          { i: 0, label: 'PASS' },
          { i: 1, label: 'BLOCK' },
          { i: 2, label: 'UNKNOWN' },
          { i: 3, label: 'BLOCK' },
          { i: 99, label: 'BLOCK' },
          { i: '4', label: 'BLOCK' },
        ],
      }),
      4,
    );
    expect([...blocked]).toEqual([1, 3]);
  });

  it('throws on nonsense so that the caller lets the batch through', () => {
    expect(() => parsePrefilterAnswer('no json', 1)).toThrow();
    expect(() => parsePrefilterAnswer('{"results":1}', 1)).toThrow();
  });

  it('marks what it stopped as not analysed', () => {
    const draft = blockedByPrefilter(
      analyzeWithRules(item(), topics, profile, 'en-US'),
      'en-US',
    );
    expect(draft).toMatchObject({ verdict: 'ignore', gate: 'prefilter' });
    expect(draft.uncertainty).toContain('Analyze again');
  });
});

describe('thin material', () => {
  const bare = item({ summary: null });

  it('recognises a bare title, including a summary that repeats it', () => {
    expect(hasOnlyTitle(bare)).toBe(true);
    expect(hasOnlyTitle(item({ summary: ' Postgres backups at scale ' }))).toBe(
      true,
    );
    expect(hasOnlyTitle(item())).toBe(false);
    expect(hasOnlyTitle(item({ summary: null, body: 'Text' }))).toBe(false);
    expect(
      hasOnlyTitle(
        item({ summary: null, transcript: [{ start: 0, text: 'Hi' }] }),
      ),
    ).toBe(false);
  });

  it('never recommends joining from a title alone', () => {
    const draft = analyzeWithRules(bare, topics, profile, 'en-US');
    const discussing = { ...draft, verdict: 'discuss' as const };
    expect(awaitingMaterial(discussing, profile, 'en-US')).toMatchObject({
      verdict: 'learn',
      gate: 'awaitingMaterial',
    });
    expect(limitedToTitle(discussing, profile, 'en-US').verdict).toBe('learn');
    expect(
      limitedToTitle(discussing, { ...profile, keepLearning: false }, 'en-US')
        .verdict,
    ).toBe('ignore');
  });
});

describe('evaluation', () => {
  const results = [
    { caseId: 'a', label: 'keep', kept: true, priority: 80 },
    { caseId: 'b', label: 'keep', kept: false, priority: 10 },
    { caseId: 'c', label: 'drop', kept: true, priority: 30 },
    { caseId: 'd', label: 'drop', kept: false, priority: 5 },
    { caseId: 'e', label: 'either', kept: true, priority: 50 },
  ] as const;

  it('scores precision and recall, leaving out the undecided', () => {
    expect(scoreResults(results)).toMatchObject({
      total: 4,
      precision: 0.5,
      recall: 0.5,
      accuracy: 0.5,
    });
    expect(scoreResults([]).precision).toBeNull();
  });

  it('shows what a higher priority floor would have kept', () => {
    const [, at40] = sweepPriority(results, [0, 40]);
    expect(at40).toMatchObject({ floor: 40, precision: 1, recall: 0.5 });
  });

  it('reads cases and names the line that does not fit', () => {
    const [first] = parseGold(
      '{"caseId":"a","label":"keep","item":{"title":"T"}}\n\n',
    );
    expect(first).toMatchObject({ caseId: 'a', label: 'keep' });
    expect(first?.item.coverage.body.status).toBe('missing');
    expect(() =>
      parseGold('{"caseId":"a","label":"maybe","item":{"title":"T"}}'),
    ).toThrow('line 1');
    const row = '{"caseId":"a","label":"keep","item":{"title":"T"}}';
    expect(() => parseGold(`${row}\n${row}`)).toThrow('line 2');
    expect(() => parseGold('nonsense')).toThrow('line 1');
  });
});
