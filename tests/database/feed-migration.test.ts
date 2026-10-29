import path from 'node:path';
import type { MigrationSource } from '@nocobase/db';
import { describeMigration } from '@nocobase/app-testing/server';

const sources: readonly MigrationSource[] = [
  {
    packageName: 'nocofeed-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

const TABLES = [
  'feedProfiles',
  'feedTopics',
  'feedSources',
  'feedItems',
  'feedAnalyses',
  'feedItemStates',
  'feedRuns',
] as const;

describeMigration('202610280001_create_feed', {
  sources,
  up: async ({ expectCollection }) => {
    for (const table of TABLES) await expectCollection(table).toExist();
    // One stored copy per item and owner: a re-run never duplicates what it already brought in.
    await expectCollection('feedItems').toHaveIndex(
      ['ownerId', 'platform', 'externalId'],
      { unique: true },
    );
    // The person's own record is one row per item, never mixed into the analysis.
    await expectCollection('feedItemStates').toHaveIndex(
      ['ownerId', 'itemId'],
      {
        unique: true,
      },
    );
    await expectCollection('feedSources').toHaveIndex(['active', 'nextRunAt']);
    await expectCollection('feedProfiles').toHaveField('dailyLimit', {
      nullable: false,
    });
    await expectCollection('feedAnalyses').toHaveField('verdict', {
      nullable: false,
    });
    await expectCollection('feedRuns').toHaveField('finishedAt', {
      nullable: true,
    });
  },
  down: async ({ expectCollection }) => {
    for (const table of TABLES) await expectCollection(table).not.toExist();
  },
});
