/**
 * The material a generated piece (ideas, reply drafts) is written from: only what was actually read of the item.
 *
 * Issue #17: a prompt that says "Body: (not obtained)" gets output that says "the post's text could not be read, so
 * here is a take on the title". What could not be read is left out of these prompts altogether, and the model is told
 * never to talk about fetching or missing parts. ("Ask about this item" is different: there the person asks, and
 * `ask.ts` keeps its MATERIAL STATUS on purpose.)
 */
import type { FeedItemDetail } from './service.js';
import { truncate } from './text.js';

/** The item after the missing parts were fetched, plus the linked page's text when the item is only a link. */
export interface PreparedMaterial {
  readonly item: FeedItemDetail;
  /** Text of the linked web page, read for an item that is only a link; not stored on the item. */
  readonly pageText?: string | null;
}

/**
 * Fetches the parts an item lacks (text, comments, subtitles) before something is written from it — the same
 * `prepare` as "Ask about this item": bounded in time, never throws, stores what it fetched on the item.
 */
export type PrepareMaterial = (
  ownerId: string,
  item: FeedItemDetail,
) => Promise<PreparedMaterial>;

/** The system rule every prompt built from this material carries. */
export const NO_META_RULE =
  'Work only from the content in MATERIAL. Never mention how the material was obtained or what it lacks: no words about fetching, scraping, text or comments or subtitles that could not be read, or having only a title. If something is not in MATERIAL, simply do not talk about it.';

type MaterialItem = Pick<
  FeedItemDetail,
  'platform' | 'title' | 'author' | 'url' | 'summary' | 'body'
> &
  Partial<Pick<FeedItemDetail, 'comments' | 'transcript'>> & {
    brief?: { brief: string } | null;
    analysis?: { lead: string | null } | null;
  };

const blank = (value: string | null | undefined): boolean =>
  !value || !value.trim();

/**
 * The summary when it says something of its own: platforms put the link (Hacker News) or the community name (Reddit)
 * there, which is no content.
 */
function summaryOf(item: MaterialItem): string | null {
  const summary = item.summary?.trim();
  if (!summary) return null;
  if (/^https?:\/\/\S+$/i.test(summary)) return null;
  if (summary === item.title.trim()) return null;
  if (summary.length < 20 && !/\s/.test(summary)) return null;
  return summary;
}

/** The post's own text: the stored body, else the page read for a link-only item. */
function bodyOf(item: MaterialItem, pageText?: string | null): string | null {
  if (!blank(item.body)) return item.body!.trim();
  if (!blank(pageText)) return pageText!.trim();
  return null;
}

/**
 * Whether the item has anything beyond its title to write from: text, a summary of its own, subtitles or comments.
 * A brief or an analysis written from a bare title does not count.
 */
export function hasSubstance(
  item: MaterialItem,
  pageText?: string | null,
): boolean {
  return Boolean(
    bodyOf(item, pageText) ||
    summaryOf(item) ||
    item.transcript?.some((segment) => !blank(segment.text)) ||
    item.comments?.some((comment) => !blank(comment.text)),
  );
}

/**
 * The MATERIAL lines: each line only when there is something in it. Nothing says what is missing.
 */
export function materialLines(
  item: MaterialItem,
  options: {
    pageText?: string | null;
    bodyChars: number;
    summaryChars?: number;
    transcriptChars?: number;
    comments?: number;
    commentChars?: number;
    /** Leave out the brief and the analysis (the caller puts them elsewhere). */
    noAnalysis?: boolean;
  },
): string[] {
  const lines = [`Title: ${item.title}`];
  if (!blank(item.author)) lines.push(`Author: ${item.author}`);
  if (!blank(item.url)) lines.push(`Link: ${item.url}`);
  const body = bodyOf(item, options.pageText);
  const transcript = (item.transcript ?? [])
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ');
  if (!options.noAnalysis) {
    // A brief written without the post's text is mostly about that ("only the title was available"): left out.
    if (!blank(item.brief?.brief) && (body || transcript))
      lines.push(`Brief: ${truncate(item.brief!.brief, 1_500)}`);
    if (!blank(item.analysis?.lead))
      lines.push(`Analysis: ${truncate(item.analysis!.lead, 500)}`);
  }
  const summary = summaryOf(item);
  if (summary)
    lines.push(`Summary: ${truncate(summary, options.summaryChars ?? 1_000)}`);
  if (body) lines.push(`Body: ${truncate(body, options.bodyChars)}`);
  if (transcript)
    lines.push(
      `Subtitles: ${truncate(transcript, options.transcriptChars ?? 4_000)}`,
    );
  const comments = (item.comments ?? [])
    .filter((comment) => !blank(comment.text))
    .slice(0, options.comments ?? 12)
    .map(
      (comment) =>
        `- ${comment.author ?? '?'}: ${truncate(comment.text.replace(/\s+/g, ' '), options.commentChars ?? 400)}`,
    );
  if (comments.length) lines.push(`Comments:\n${comments.join('\n')}`);
  return lines;
}
