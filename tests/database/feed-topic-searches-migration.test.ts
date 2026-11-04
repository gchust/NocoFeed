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

describeMigration('202611040001_feed_topic_searches', {
  sources,
  up: async ({ expectCollection }) => {
    await expectCollection('feedTopics').toHaveField('searchTerms', {
      nullable: true,
    });
    await expectCollection('feedTopics').toHaveField('searchPlatforms', {
      nullable: true,
    });
    await expectCollection('feedTopics').toHaveField('searchFrequency', {
      nullable: false,
    });
    await expectCollection('feedTopics').toHaveField('searchLimit', {
      nullable: false,
    });
    await expectCollection('feedSources').toHaveField('topicId', {
      nullable: true,
    });
    await expectCollection('feedSources').toHaveIndex(['topicId']);
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedTopics').not.toHaveField('searchTerms');
    await expectCollection('feedTopics').not.toHaveField('searchFrequency');
    await expectCollection('feedSources').not.toHaveField('topicId');
    await expectCollection('feedTopics').toExist();
  },
});
