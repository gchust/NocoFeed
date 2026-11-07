import { AppCommand } from '@nocobase/app-cli';
import { Flags } from '@oclif/core';
import type { Interfaces } from '@oclif/core';

export interface FeedReapplyAdmissionResult {
  readonly checked: number;
  readonly hidden: readonly string[];
  readonly watching: readonly string[];
  readonly dryRun: boolean;
}

export default class FeedReapplyAdmission extends AppCommand {
  static override summary =
    'Apply the admission rules to search results already in the feed, leaving out the thin ones nobody noticed.';
  static override description =
    'Checks the recommended items that topic searches brought: a thin post or a reply without substance or attention ' +
    'is left out (and listed under "Filtered" with the reason), a new one is watched until its attention can be read ' +
    'again. It never touches what the person kept (favourite, later, participated, notes) or dismissed, never shows a ' +
    'hidden item, and calls no model. An item left out comes back on its own if it turns hot.';
  static override examples = [
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %>',
  ];
  static override flags: {
    'dry-run': Interfaces.BooleanFlag<boolean>;
  } = {
    'dry-run': Flags.boolean({
      description: 'Report what would change without writing it.',
      default: false,
    }),
  };

  public async run(): Promise<FeedReapplyAdmissionResult> {
    const { flags } = await this.parse(FeedReapplyAdmission);
    const dryRun = flags['dry-run'];
    const result = await this.withApp(async ({ app }) => {
      app.registerProviders();
      const { feedServiceToken } =
        await import('../../../server/providers/feed/index.js');
      return app.container
        .resolve(feedServiceToken)
        .reapplyAdmission({ dryRun });
    });
    for (const title of result.hidden) this.log(`hide: ${title}`);
    for (const title of result.watching) this.log(`watch: ${title}`);
    this.log(
      `Checked ${result.checked} search results; ${result.hidden.length} ${dryRun ? 'would be' : 'are now'} left out, ` +
        `${result.watching.length} ${dryRun ? 'would be' : 'are now'} watched.`,
    );
    return { ...result, dryRun };
  }
}
