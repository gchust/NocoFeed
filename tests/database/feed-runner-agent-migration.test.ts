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

describeMigration('202611050001_feed_runner_agent', {
  sources,
  up: async ({ expectCollection }) => {
    await expectCollection('feedProfiles').toHaveField('readerAgentId', {
      nullable: true,
    });
    await expectCollection('feedRuns').toHaveField('agentRunId', {
      nullable: true,
    });
    await expectCollection('feedRuns').toHaveField('agentResult', {
      nullable: true,
    });
    await expectCollection('feedRuns').toHaveIndex(['agentRunId']);
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedProfiles').not.toHaveField('readerAgentId');
    await expectCollection('feedRuns').not.toHaveField('agentRunId');
    await expectCollection('feedRuns').not.toHaveField('agentResult');
    await expectCollection('feedRuns').toExist();
  },
});
