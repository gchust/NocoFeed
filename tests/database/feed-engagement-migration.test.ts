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

describeMigration('202610290001_feed_engagement', {
  sources,
  up: async ({ expectCollection }) => {
    await expectCollection('feedProfiles').toHaveField('termWeights', {
      nullable: true,
    });
    await expectCollection('feedProfiles').toHaveField('digestHour', {
      nullable: false,
    });
    await expectCollection('feedItemStates').toHaveField('dismissed', {
      nullable: false,
    });
    await expectCollection('feedItemStates').toHaveIndex(['followUpAt']);
    await expectCollection('feedSources').toHaveField('failureStreak', {
      nullable: false,
    });
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedProfiles').not.toHaveField('termWeights');
    await expectCollection('feedItemStates').not.toHaveField('dismissed');
    await expectCollection('feedSources').not.toHaveField('failureStreak');
    // The tables themselves stay: they belong to the earlier migration.
    await expectCollection('feedSources').toExist();
  },
});
