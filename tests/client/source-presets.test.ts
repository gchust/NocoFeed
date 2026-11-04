import { describe, expect, it } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import zhCN from '../../client/locales/zh-CN.js';
import {
  filterPresets,
  PRESET_CATEGORIES,
  presetKey,
  SOURCE_PRESETS,
  type SourcePreset,
  subscribedPresetIds,
} from '../../client/pages/sources/presets.js';
import { FREQUENCIES } from '../../client/pages/sources/types.js';
import { findOperation } from '../../server/providers/feed/catalog.js';

type Presets = {
  readonly categories: Record<string, string>;
  readonly items: Record<string, string>;
};
const english = (enUS as unknown as { sources: { presets: Presets } }).sources
  .presets;
const chinese = (zhCN as unknown as { sources: { presets: Presets } }).sources
  .presets;

/** What is wrong with one preset, as short codes; empty when the server would accept it as typed. */
function problems(preset: SourcePreset): string[] {
  const found = findOperation(preset.platform, preset.operation);
  if (!found) return ['unsupportedOperation'];
  const { operation } = found;
  const wrong: string[] = [];
  // Searches belong to topics and single items are not subscriptions.
  if (operation.operation === 'keyword') wrong.push('keyword');
  if (operation.single) wrong.push('single');
  if (operation.input === 'none' && preset.target !== '')
    wrong.push('targetNotEmpty');
  if (operation.input !== 'none' && !preset.target) wrong.push('targetEmpty');
  if (preset.target.trim() !== preset.target) wrong.push('targetSpaces');
  if (operation.input === 'url' && !/^https:\/\/\S+$/u.test(preset.target))
    wrong.push('targetNotHttpsUrl');
  const length = operation.targetLength;
  if (
    length &&
    (preset.target.length < length.min ||
      preset.target.length > length.max ||
      preset.target.startsWith('-'))
  )
    wrong.push('targetLength');
  const forms: Partial<Record<SourcePreset['platform'], RegExp>> = {
    reddit: /^r\/[A-Za-z0-9_]{2,32}$/u,
    youtube: /^UC[A-Za-z0-9_-]{22}$/u,
    x: /^@[A-Za-z0-9_]{1,15}$/u,
  };
  const form = forms[preset.platform];
  if (form && !form.test(preset.target)) wrong.push('targetForm');
  if (!(FREQUENCIES as readonly number[]).includes(preset.frequency))
    wrong.push('frequency');
  if (!preset.name || preset.name.length > 60) wrong.push('name');
  return wrong;
}

describe('recommended subscriptions', () => {
  it('offers a useful number of sources in every category', () => {
    expect(SOURCE_PRESETS.length).toBeGreaterThanOrEqual(50);
    expect(SOURCE_PRESETS.length).toBeLessThanOrEqual(150);
    const thin = PRESET_CATEGORIES.filter(
      (category) =>
        SOURCE_PRESETS.filter((preset) => preset.category === category).length <
        4,
    );
    expect(thin).toEqual([]);
  });

  it('only uses list operations the catalog declares, with targets the server and adapters accept', () => {
    const wrong = SOURCE_PRESETS.flatMap((preset) =>
      problems(preset).map((code) => `${preset.id}: ${code}`),
    );
    expect(wrong).toEqual([]);
  });

  it('has no duplicates', () => {
    const ids = SOURCE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = SOURCE_PRESETS.map((preset) =>
      presetKey(preset.platform, preset.operation, preset.target),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('describes every source and names every category in English and Chinese', () => {
    const ids = SOURCE_PRESETS.map((preset) => preset.id).sort();
    expect(Object.keys(english.items).sort()).toEqual(ids);
    expect(Object.keys(chinese.items).sort()).toEqual(ids);
    const blank = ids.filter(
      (id) => !english.items[id]?.trim() || !chinese.items[id]?.trim(),
    );
    expect(blank).toEqual([]);
    const unnamed = ['all', ...PRESET_CATEGORIES].filter(
      (category) =>
        !english.categories[category] || !chinese.categories[category],
    );
    expect(unnamed).toEqual([]);
  });

  it('filters by category and by every word of the query, including the description', () => {
    const describe = (preset: SourcePreset) => english.items[preset.id];
    const security = filterPresets(SOURCE_PRESETS, {
      category: 'security',
      query: '',
      describe,
    });
    expect(security.length).toBeGreaterThan(0);
    expect(security.every((preset) => preset.category === 'security')).toBe(
      true,
    );
    const ids = (category: 'all' | 'ai', query: string) =>
      filterPresets(SOURCE_PRESETS, { category, query, describe }).map(
        (preset) => preset.id,
      );
    expect(ids('all', 'krebs  SECURITY')).toEqual(['krebs']);
    expect(ids('all', 'cybercrime')).toEqual(['krebs']);
    expect(ids('ai', 'krebs')).toEqual([]);
  });

  it('recognizes a source the person already follows, however the target was typed', () => {
    const ids = subscribedPresetIds([
      { platform: 'reddit', operation: 'community', target: 'Rust' },
      {
        platform: 'rss',
        operation: 'feed',
        target: 'http://lobste.rs/rss/',
      },
      { platform: 'hn', operation: 'new', target: 'hn:new' },
      { platform: 'x', operation: 'account', target: 'Karpathy' },
      // Two communities in one subscription are a different thing from either alone.
      { platform: 'reddit', operation: 'community', target: 'r/golang r/go' },
    ]);
    expect([...ids].sort()).toEqual(['hnNew', 'karpathyX', 'lobsters', 'rust']);
  });
});
