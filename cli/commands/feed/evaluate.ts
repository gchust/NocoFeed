import { readFile } from 'node:fs/promises';

import { AppCommand, CommandError, appPath } from '@nocobase/app-cli';
import { Flags } from '@oclif/core';
import type { Interfaces } from '@oclif/core';

export interface FeedEvaluateResult {
  readonly cases: number;
  readonly model: unknown;
  readonly rules: unknown;
  readonly sweep: unknown;
  readonly misjudged: readonly unknown[];
}

export default class FeedEvaluate extends AppCommand {
  static override summary =
    'Measure the feed filtering against hand-labelled cases, without writing to the feed.';
  static override examples = [
    '<%= config.bin %> <%= command.id %> --gold storage/feed-gold.jsonl --split development',
  ];
  static override flags: {
    gold: Interfaces.OptionFlag<string>;
    split: Interfaces.OptionFlag<string | undefined>;
    owner: Interfaces.OptionFlag<string | undefined>;
  } = {
    gold: appPath({
      description: 'The labelled cases, one JSON object per line.',
      required: true,
    }) as Interfaces.OptionFlag<string>,
    split: Flags.string({
      options: ['development', 'holdout'],
      description:
        'Run only this split. Cases without a split count as development.',
    }),
    owner: Flags.string({
      description:
        'The user whose topics and profile to judge with. Needed only when several people have items.',
    }),
  };

  public async run(): Promise<FeedEvaluateResult> {
    const { flags } = await this.parse(FeedEvaluate);
    const { parseGold, scoreResults, sweepPriority } =
      await import('../../../server/providers/feed/evaluation.js');
    let cases;
    try {
      cases = parseGold(await readFile(flags.gold, 'utf8'));
    } catch (error) {
      throw new CommandError(
        error instanceof Error
          ? error.message
          : 'The gold file cannot be read.',
        { code: 'INVALID_GOLD' },
      );
    }
    if (flags.split)
      cases = cases.filter(
        (entry) => (entry.split ?? 'development') === flags.split,
      );
    if (!cases.length)
      throw new CommandError('No cases to evaluate.', { code: 'NO_CASES' });

    const judged = await this.withApp(async ({ app }) => {
      await app.start();
      const { feedServiceToken } =
        await import('../../../server/providers/feed/index.js');
      const feed = app.container.resolve(feedServiceToken);
      const owner = flags.owner ?? (await soleOwner(await feed.itemOwners()));
      const rows = [];
      for (const [index, entry] of cases.entries()) {
        this.logToStderr(`${index + 1}/${cases.length} ${entry.caseId}`);
        rows.push({ entry, ...(await feed.judgeCase(owner, entry.item)) });
      }
      return rows;
    });

    const asResults = (pick: 'model' | 'rules') =>
      judged.map(({ entry, ...verdicts }) => ({
        caseId: entry.caseId,
        label: entry.label,
        kept: verdicts[pick].kept,
        priority: verdicts[pick].priority,
      }));
    const model = scoreResults(asResults('model'));
    const rules = scoreResults(asResults('rules'));
    const sweep = sweepPriority(asResults('model'));
    const misjudged = judged
      .filter(
        ({ entry, model: verdict }) =>
          entry.label !== 'either' && verdict.kept !== (entry.label === 'keep'),
      )
      .map(({ entry, model: verdict }) => ({
        caseId: entry.caseId,
        label: entry.label,
        title: entry.item.title.slice(0, 80),
        ...verdict,
      }));
    const fellBack = judged.filter(
      (row) => row.model.engine !== 'model',
    ).length;
    if (fellBack)
      this.warn(
        `${fellBack} of ${judged.length} cases were not judged by a model: none is configured, the daily limit is used up, a gate applied, or the call failed.`,
      );

    const percent = (value: number | null) =>
      value === null ? '-' : `${(value * 100).toFixed(1)}%`;
    const line = (name: string, scores: typeof model) =>
      `${name}: precision ${percent(scores.precision)}, recall ${percent(scores.recall)}, accuracy ${percent(scores.accuracy)} (${scores.total} cases)`;
    this.log(line('Pipeline', model));
    this.log(line('Rules only', rules));
    for (const entry of sweep)
      this.log(`  priority >= ${entry.floor}: ${line('kept', entry)}`);
    for (const entry of misjudged)
      this.log(
        `  wrong: ${entry.caseId} expected ${entry.label}, got ${entry.verdict} (gate ${entry.gate ?? '-'}, priority ${entry.priority}): ${entry.title}`,
      );
    return { cases: judged.length, model, rules, sweep, misjudged };
  }
}

function soleOwner(owners: readonly string[]): string {
  if (owners.length === 1) return owners[0]!;
  throw new CommandError(
    owners.length
      ? `Several people have items; choose one with --owner: ${owners.join(', ')}`
      : 'Nobody has items yet.',
    { code: 'OWNER_REQUIRED' },
  );
}
