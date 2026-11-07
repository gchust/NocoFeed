import {
  HIDDEN_NOISE,
  LOW_QUALITY,
  type AnalysisDraft,
  type AnalysisGate,
  type AnalysisItem,
  type Locale,
  type Verdict,
} from './analyzer.js';
import { HOT_HEAT } from './heat.js';

/**
 * Whether an analysed search result may enter the feed (issue #19). A topic search finds whatever mentions its words,
 * so a keyword match says nothing about worth: a three-word reply to strangers matches "vibe coding" as well as a
 * tutorial does. Worth and attention are weighed together:
 *
 * - substance shown (a model's quality of `LOW_QUALITY` or more), or worth the rules cannot judge (longer text, video):
 *   in, whatever the attention;
 * - thin (a model rated it below `LOW_QUALITY`, or a short text post the rules alone judged) or a reply without
 *   `SOLID_QUALITY`: only once it is hot (`HOT_HEAT`), and then as a hot item;
 * - a thin post younger than the person's `waitHours` has not had time to be noticed: it waits (`watching`) and is
 *   decided when its counts are read again (`settleWatching` in the service).
 *
 * Subscriptions, mail and pushed items are what the person chose and are left alone, and so is anything they kept
 * (favourite, later, participated, notes). The person's "Analyze again" decides at once rather than waiting.
 */

/** Gates set here; the item stays out of the feed and is listed under "Filtered" with the reason. */
export const HOLD_GATES = ['thin', 'reply', 'watching'] as const;
export type HoldGate = (typeof HOLD_GATES)[number];

export function isHoldGate(gate: unknown): gate is HoldGate {
  return (HOLD_GATES as readonly unknown[]).includes(gate);
}

/** From here a model analysis counts as solid, as `SOLID_QUALITY` in the service. */
const SOLID = 60;
/** Text shorter than this (CJK characters count twice) is too short for the rules to see any substance in. */
export const THIN_TEXT = 280;
/** Platforms whose posts are their text; a video's description says little about the video. */
const TEXT_POST_PLATFORMS = new Set(['x', 'xiaohongshu', 'reddit']);
export const DEFAULT_WAIT_HOURS = 12;
export const MIN_WAIT_HOURS = 1;
export const MAX_WAIT_HOURS = 48;

export interface AdmissionContext {
  /** The item came from a topic search (`feedSources.topicId`). */
  fromSearch: boolean;
  /** The person kept it: favourite, later, participated or notes. */
  kept: boolean;
  /** The person asked for this analysis: decide now, never wait. */
  asked: boolean;
  heat: number | null;
  /** When it was published, or collected when that is unknown. */
  publishedAt: Date;
  waitForHeat: boolean;
  waitHours: number;
  now: Date;
  locale: Locale;
}

/** The post's own words, without the @names it is addressed to, links and tags. */
function ownWords(item: AnalysisItem): string {
  const text = [item.body?.trim() || item.summary?.trim() || item.title]
    .join(' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(^|\s)[@#][\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/** Length with CJK characters counted twice, so a Chinese and an English post of the same content weigh alike. */
function weightedLength(text: string): number {
  let length = 0;
  for (const char of text) length += /[㐀-鿿豈-﫿]/.test(char) ? 2 : 1;
  return length;
}

/** An X post that answers someone: it begins by addressing them. */
export function isReply(item: AnalysisItem): boolean {
  if (item.platform !== 'x') return false;
  const text = (item.body?.trim() || item.title).trimStart();
  return /^@[A-Za-z0-9_]{1,15}\b/.test(text);
}

/** A short text post with nothing else to it: no subtitles, pictures or video that might carry the content. */
export function looksThin(item: AnalysisItem): boolean {
  if (!TEXT_POST_PLATFORMS.has(item.platform)) return false;
  if (item.transcript?.length || item.media?.length) return false;
  return weightedLength(ownWords(item)) < THIN_TEXT;
}

export type Substance = 'solid' | 'fair' | 'unproven' | 'thin' | 'noise';

/** What the analysis showed the item to be worth; the rules can only tell length. */
export function substanceOf(
  item: AnalysisItem,
  draft: AnalysisDraft,
): Substance {
  if (draft.quality != null) {
    if (draft.qualityDetail && HIDDEN_NOISE.has(draft.qualityDetail.noise))
      return 'noise';
    if (draft.quality >= SOLID) return 'solid';
    if (draft.quality >= LOW_QUALITY) return 'fair';
    return 'thin';
  }
  return looksThin(item) ? 'thin' : 'unproven';
}

const COPY: Record<Locale, Record<HoldGate, string>> = {
  'zh-CN': {
    thin: '内容单薄（没有方法、例子或数据），在原平台上也几乎没人关注，未放进信息流；之后变热会自动放进来。',
    reply:
      '这是话题搜索搜到的一条回复，既没有干货也没有互动，未放进信息流；之后变热会自动放进来。',
    watching:
      '新发布的帖子，内容单薄，热度还没积累起来：先观察，到时重新读取热度再决定是否放进信息流。',
  },
  'en-US': {
    thin: 'Thin (no method, example or data) and hardly noticed on its platform, so it was left out of the feed; it comes in if it turns hot.',
    reply:
      'A reply found by a topic search, with neither substance nor attention, so it was left out of the feed; it comes in if it turns hot.',
    watching:
      'A new, thin post whose attention has not built up yet: watched, and decided once its counts are read again.',
  },
};

function hold(
  draft: AnalysisDraft,
  gate: HoldGate,
  wanted: Verdict,
  context: AdmissionContext,
  watchUntil: Date | null = null,
): AnalysisDraft {
  return {
    ...draft,
    verdict: 'ignore',
    gate,
    heldVerdict: wanted,
    watchUntil,
    uncertainty: [COPY[context.locale][gate], draft.uncertainty]
      .filter(Boolean)
      .join(' '),
  };
}

/** Lets a held item in: the verdict it would have had, no gate. */
export function release(draft: AnalysisDraft): AnalysisDraft {
  return {
    ...draft,
    verdict: draft.heldVerdict ?? draft.verdict,
    gate: null,
    heldVerdict: null,
    watchUntil: null,
  };
}

/** Applies the admission rules to a fresh analysis. Anything they do not concern passes unchanged. */
export function admit(
  item: AnalysisItem,
  draft: AnalysisDraft,
  context: AdmissionContext,
): AnalysisDraft {
  if (!context.fromSearch || context.kept) return draft;
  // The full analysis did not run (prefilter, waiting for material): those gates decide.
  if (draft.gate) return draft;
  const wanted = draft.verdict === 'ignore' ? draft.heldVerdict : draft.verdict;
  if (!wanted || wanted === 'ignore') return draft;
  const substance = substanceOf(item, draft);
  if (substance === 'noise' || substance === 'solid') return draft;
  // Attention without substance is still worth knowing about: it comes in, and the hot view lists it.
  if (context.heat != null && context.heat >= HOT_HEAT)
    return { ...draft, verdict: wanted, heldVerdict: null };
  if (isReply(item)) return hold(draft, 'reply', wanted, context);
  if (substance !== 'thin') return draft;
  const waitUntil = new Date(
    context.publishedAt.getTime() + context.waitHours * 3_600_000,
  );
  if (!context.asked && context.waitForHeat && context.now < waitUntil)
    return hold(draft, 'watching', wanted, context, waitUntil);
  return hold(draft, 'thin', wanted, context);
}

/**
 * Decides a watched item once its counts were read again (or could not be): in when hot, otherwise thin. The
 * explanation of the watch is replaced by the outcome.
 */
export function settleWatch(
  draft: { heldVerdict: Verdict | null; uncertainty: string | null },
  heat: number | null,
  locale: Locale,
): { gate: AnalysisGate | null; verdict: Verdict; uncertainty: string } {
  const without = (draft.uncertainty ?? '')
    .replace(COPY[locale].watching, '')
    .replace(COPY[locale === 'zh-CN' ? 'en-US' : 'zh-CN'].watching, '')
    .trim();
  if (heat != null && heat >= HOT_HEAT)
    return {
      gate: null,
      verdict: draft.heldVerdict ?? 'learn',
      uncertainty: without,
    };
  return {
    gate: 'thin',
    verdict: 'ignore',
    uncertainty: [COPY[locale].thin, without].filter(Boolean).join(' '),
  };
}

/**
 * The person's time window (`maxAgeDays`) for items whose publication time a list did not give (issue #21). The
 * collection run drops what it can see is older than the window, but a list that gave no time (YouTube search text the
 * Collector could not read, an RSS entry without a date) used to come in as if it were new: a three-year-old video in a
 * feed of today's. Now such an item is held (`undated`) until its time is looked up (`resolvePublishedTimes`), then
 * judged again; one found to be older than the window is held as `stale`. Neither is let in by attention, and both are
 * listed under "Filtered" with the reason. Items from a single tracked post, pushed items and anything the person kept
 * are left alone, as is everyone who keeps no window.
 */
export const TIME_GATES = ['undated', 'stale'] as const;
export type TimeGate = (typeof TIME_GATES)[number];

export function isTimeGate(gate: unknown): gate is TimeGate {
  return (TIME_GATES as readonly unknown[]).includes(gate);
}

const DAY_MS = 86_400_000;
/**
 * An approximate time is either relative text ("3 weeks ago", the latest moment it allows) or a day sent as noon UTC,
 * which may be up to a day earlier than the moment in the poster's time zone: a day's grace before calling it older.
 */
const APPROXIMATE_GRACE_MS = DAY_MS;

export interface TimeContext {
  /** The person's window in days; null when none applies to this item (no window, a tracked post, pushed, kept). */
  maxAgeDays: number | null;
  publishedAt: Date | null;
  approximate: boolean;
  /** When the item was collected: the window is counted back from then. */
  collectedAt: Date;
  /** Whether the time may still be looked up (the Collector reads it for this platform and has not tried yet). */
  lookupPending: boolean;
  locale: Locale;
}

/** Whether the item may be judged on its content: `ok`, or held for an unknown (`undated`) or old (`stale`) time. */
export function timeStatus(context: TimeContext): 'ok' | TimeGate {
  if (context.maxAgeDays == null || !(context.maxAgeDays > 0)) return 'ok';
  if (!context.publishedAt || !Number.isFinite(context.publishedAt.getTime()))
    return 'undated';
  const cutoff = context.collectedAt.getTime() - context.maxAgeDays * DAY_MS;
  const latest =
    context.publishedAt.getTime() +
    (context.approximate ? APPROXIMATE_GRACE_MS : 0);
  return latest < cutoff ? 'stale' : 'ok';
}

const TIME_COPY: Record<
  Locale,
  {
    pending: string;
    unknown: string;
    stale: (date: string, approximate: boolean, days: number) => string;
  }
> = {
  'zh-CN': {
    pending:
      '发布时间未知：设置了时间窗口时，只放进能确认发布时间的内容。正在从原页面读取发布时间，读到后再决定。',
    unknown:
      '发布时间未知：平台没有给出，原页面也没读到，无法确认是否在时间窗口内，未放进信息流。',
    stale: (date, approximate, days) =>
      `发布于${approximate ? '约 ' : ''}${date}，早于你的时间窗口（最近 ${days} 天），未放进信息流。`,
  },
  'en-US': {
    pending:
      'Publication time unknown: with a time window only items whose time is known come in. Reading it from the original page; decided once it is known.',
    unknown:
      'Publication time unknown: the platform gave none and the original page did not say, so whether it is inside the time window cannot be told. Left out of the feed.',
    stale: (date, approximate, days) =>
      `Published ${approximate ? 'around ' : ''}${date}, before your time window (the last ${days} days). Left out of the feed.`,
  },
};

/** The explanation of a time gate, in the item's locale. */
export function timeCopy(gate: TimeGate, context: TimeContext): string {
  const copy = TIME_COPY[context.locale];
  if (gate === 'undated')
    return context.lookupPending ? copy.pending : copy.unknown;
  return copy.stale(
    context.publishedAt!.toISOString().slice(0, 10),
    context.approximate,
    context.maxAgeDays ?? 0,
  );
}

/** `uncertainty` without the explanation of an unknown time, so a new one replaces it rather than piling up. */
export function withoutTimeCopy(uncertainty: string | null): string {
  let rest = uncertainty ?? '';
  for (const copy of Object.values(TIME_COPY))
    rest = rest.replace(copy.pending, '').replace(copy.unknown, '');
  return rest.replace(/\s{2,}/g, ' ').trim();
}

/** Holds `draft` for its time: out of the feed, with the verdict it would have had kept for when the time is known. */
export function holdForTime(
  draft: AnalysisDraft,
  gate: TimeGate,
  context: TimeContext,
): AnalysisDraft {
  const wanted =
    draft.verdict === 'ignore' ? (draft.heldVerdict ?? null) : draft.verdict;
  return {
    ...draft,
    verdict: 'ignore',
    gate,
    heldVerdict: wanted,
    watchUntil: null,
    uncertainty: [timeCopy(gate, context), withoutTimeCopy(draft.uncertainty)]
      .filter(Boolean)
      .join(' '),
  };
}
