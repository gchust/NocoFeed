import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AppCommand, CommandError, appPath } from '@nocobase/app-cli';
import { Flags } from '@oclif/core';
import type { Interfaces } from '@oclif/core';

export interface FeedExportLabelsResult {
  readonly file: string;
  readonly exported: number;
}

export default class FeedExportLabels extends AppCommand {
  static override summary =
    'Turn "Useful" and "Not relevant" feedback into cases for feed evaluate.';
  static override examples = [
    '<%= config.bin %> <%= command.id %> --output storage/feed-gold.jsonl',
  ];
  static override flags: {
    output: Interfaces.OptionFlag<string>;
    owner: Interfaces.OptionFlag<string | undefined>;
  } = {
    output: appPath({
      description: 'Where to write the cases. An existing file is replaced.',
      required: true,
    }) as Interfaces.OptionFlag<string>,
    owner: Flags.string({
      description:
        'Whose feedback to export. Needed only when several people have items.',
    }),
  };

  public async run(): Promise<FeedExportLabelsResult> {
    const { flags } = await this.parse(FeedExportLabels);
    const cases = await this.withApp(async ({ app }) => {
      app.registerProviders();
      const { feedServiceToken } =
        await import('../../../server/providers/feed/index.js');
      const feed = app.container.resolve(feedServiceToken);
      const owners = await feed.itemOwners();
      const owner =
        flags.owner ?? (owners.length === 1 ? owners[0] : undefined);
      if (!owner)
        throw new CommandError(
          'Choose whose feedback to export with --owner.',
          { code: 'OWNER_REQUIRED', details: { owners } },
        );
      return feed.labelledCases(owner);
    });
    if (!cases.length)
      throw new CommandError('No item has feedback yet.', {
        code: 'NO_LABELS',
      });
    await mkdir(path.dirname(flags.output), { recursive: true });
    await writeFile(
      flags.output,
      `${cases.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    this.log(`Wrote ${cases.length} cases to ${flags.output}.`);
    return { file: flags.output, exported: cases.length };
  }
}
