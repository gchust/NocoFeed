import type { AnalysisItem } from './analyzer.js';
import type { ItemCoverage } from './types.js';

/**
 * Measures the feed's filtering against items a person labelled by hand. "Keep" means it belongs in their feed; the rest
 * of the pipeline is judged on the labels alone, so a change to a prompt or threshold can be compared before it ships.
 */
export type GoldLabel = 'keep' | 'drop' | 'either';

export interface GoldCase {
  caseId: string;
  label: GoldLabel;
  /** `holdout` cases are for the final check: tune against `development` only. */
  split?: 'development' | 'holdout';
  item: AnalysisItem;
}

export interface CaseResult {
  caseId: string;
  label: GoldLabel;
  kept: boolean;
  priority: number;
}

export interface Scores {
  total: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  /** Of what was kept, how much should have been. Null when nothing was kept. */
  precision: number | null;
  /** Of what should be kept, how much was. Null when no case should be. */
  recall: number | null;
  accuracy: number | null;
}

const DEFAULT_COVERAGE: ItemCoverage = {
  body: { status: 'missing' },
  comments: { status: 'notRequested' },
};

/** Reads JSON Lines; a line that does not fit stops the run, naming its number, because a skipped case skews the result. */
export function parseGold(text: string): GoldCase[] {
  const seen = new Set<string>();
  return text.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    const where = `line ${index + 1}`;
    let value: Partial<GoldCase> & { item?: Partial<AnalysisItem> };
    try {
      value = JSON.parse(line) as typeof value;
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    if (typeof value.caseId !== 'string' || !value.caseId)
      throw new Error(`${where}: caseId is required`);
    if (seen.has(value.caseId))
      throw new Error(`${where}: caseId ${value.caseId} is repeated`);
    seen.add(value.caseId);
    if (!['keep', 'drop', 'either'].includes(value.label as string))
      throw new Error(`${where}: label must be keep, drop or either`);
    if (typeof value.item?.title !== 'string' || !value.item.title)
      throw new Error(`${where}: item.title is required`);
    return [
      {
        caseId: value.caseId,
        label: value.label as GoldLabel,
        ...(value.split ? { split: value.split } : {}),
        item: {
          platform: value.item.platform ?? 'rss',
          title: value.item.title,
          author: value.item.author ?? null,
          summary: value.item.summary ?? null,
          body: value.item.body ?? null,
          comments: value.item.comments ?? null,
          transcript: value.item.transcript ?? null,
          coverage: value.item.coverage ?? DEFAULT_COVERAGE,
        },
      },
    ];
  });
}

const ratio = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 1000) / 1000 : null;

/** `either` cases count for nothing: they are the ones reasonable judges would split on. */
export function scoreResults(results: readonly CaseResult[]): Scores {
  const judged = results.filter((result) => result.label !== 'either');
  const count = (label: GoldLabel, kept: boolean) =>
    judged.filter((result) => result.label === label && result.kept === kept)
      .length;
  const truePositive = count('keep', true);
  const falsePositive = count('drop', true);
  const falseNegative = count('keep', false);
  const trueNegative = count('drop', false);
  return {
    total: judged.length,
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision: ratio(truePositive, truePositive + falsePositive),
    recall: ratio(truePositive, truePositive + falseNegative),
    accuracy: ratio(truePositive + trueNegative, judged.length),
  };
}

/** What each minimum priority would have kept, for choosing where the top of the feed should begin. */
export function sweepPriority(
  results: readonly CaseResult[],
  floors: readonly number[] = [0, 20, 30, 40, 50, 60, 70, 80],
): (Scores & { floor: number })[] {
  return floors.map((floor) => ({
    floor,
    ...scoreResults(
      results.map((result) => ({
        ...result,
        kept: result.kept && result.priority >= floor,
      })),
    ),
  }));
}
