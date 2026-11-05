import { AppCommand } from '@nocobase/app-cli';
import { Flags } from '@oclif/core';
import type { Interfaces } from '@oclif/core';

export interface FeedReapplyWorthResult {
  readonly checked: number;
  readonly requalified: number;
  readonly hidden: readonly string[];
  readonly dryRun: boolean;
}

export default class FeedReapplyWorth extends AppCommand {
  static override summary =
    'Apply the current worth rules to stored analyses, hiding what now falls below the bar.';
  static override description =
    'Recomputes quality and priority from the axes the model gave, and hides items whose quality is now below the bar. ' +
    'It never shows a hidden item and calls no model. Run it after changing the noise caps or the worth threshold.';
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

  public async run(): Promise<FeedReapplyWorthResult> {
    const { flags } = await this.parse(FeedReapplyWorth);
    const dryRun = flags['dry-run'];
    const result = await this.withApp(async ({ app }) => {
      app.registerProviders();
      const { feedServiceToken } =
        await import('../../../server/providers/feed/index.js');
      return app.container.resolve(feedServiceToken).reapplyWorth({ dryRun });
    });
    for (const title of result.hidden) this.log(`hide: ${title}`);
    this.log(
      `${dryRun ? 'Would update' : 'Updated'} ${result.requalified} of ${result.checked} analyses; ` +
        `${result.hidden.length} ${dryRun ? 'would be' : 'are now'} hidden.`,
    );
    return { ...result, dryRun };
  }
}
