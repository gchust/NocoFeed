import { AppCommand } from '@nocobase/app-cli';
import { Flags } from '@oclif/core';
import type { Interfaces } from '@oclif/core';

export interface FeedReapplyWindowResult {
  readonly checked: number;
  readonly stale: readonly {
    readonly title: string;
    readonly publishedAt: string;
    readonly approximate: boolean;
  }[];
  readonly undated: readonly string[];
  readonly dryRun: boolean;
}

/** What the command prints: one line per item it leaves out, then the totals and whether anything was written. */
export function windowReport(
  result: Omit<FeedReapplyWindowResult, 'dryRun'>,
  dryRun: boolean,
): string[] {
  return [
    ...result.stale.map(
      (entry) =>
        `stale: ${entry.title} (published ${entry.approximate ? 'about ' : ''}${entry.publishedAt.slice(0, 10)})`,
    ),
    ...result.undated.map((title) => `undated: ${title}`),
    `Checked ${result.checked} items; ${result.stale.length} older than the window and ` +
      `${result.undated.length} without a publication time ${dryRun ? 'would be' : 'are now'} left out.` +
      (dryRun
        ? ' Nothing was changed: run again with --apply to write it.'
        : ''),
  ];
}

export default class FeedReapplyWindow extends AppCommand {
  static override summary =
    "Apply each person's time window to items already collected, leaving out the old and the undated.";
  static override description =
    'Checks the items in the feed, and those still waiting to come in, against the time window of the person who ' +
    'collected them: one published before the window is left out (listed under "Filtered" as older than the window); ' +
    'one without a publication time is held until the scheduled lookup reads it from the original page, then judged ' +
    'again. It never touches what the person kept (favourite, later, participated, notes) or dismissed, never shows a ' +
    'hidden item, and calls no model. Only reports what it would do unless --apply is given.';
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --apply',
  ];
  static override flags: {
    apply: Interfaces.BooleanFlag<boolean>;
  } = {
    apply: Flags.boolean({
      description: 'Write the changes; without it nothing is changed.',
      default: false,
    }),
  };

  public async run(): Promise<FeedReapplyWindowResult> {
    const { flags } = await this.parse(FeedReapplyWindow);
    const dryRun = !flags.apply;
    const result = await this.withApp(async ({ app }) => {
      app.registerProviders();
      const { feedServiceToken } =
        await import('../../../server/providers/feed/index.js');
      return app.container
        .resolve(feedServiceToken)
        .reapplyTimeWindow({ dryRun });
    });
    for (const line of windowReport(result, dryRun)) this.log(line);
    return { ...result, dryRun };
  }
}
