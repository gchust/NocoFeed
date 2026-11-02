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

describeMigration('202611020003_feed_analysis_quality', {
  sources,
  up: async ({ expectCollection }) => {
    await expectCollection('feedAnalyses').toHaveField('quality', {
      nullable: true,
    });
    await expectCollection('feedAnalyses').toHaveField('qualityDetail', {
      nullable: true,
    });
    await expectCollection('feedAnalyses').toHaveField('priority', {
      nullable: false,
    });
    await expectCollection('feedAnalyses').toHaveField('gate', {
      nullable: true,
    });
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedAnalyses').not.toHaveField('quality');
    await expectCollection('feedAnalyses').not.toHaveField('priority');
    await expectCollection('feedAnalyses').toExist();
  },
});
