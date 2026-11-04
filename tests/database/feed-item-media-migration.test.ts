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

describeMigration('202611060001_feed_item_media', {
  sources,
  up: async ({ expectCollection }) => {
    await expectCollection('feedItems').toHaveField('media', {
      nullable: true,
    });
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedItems').not.toHaveField('media');
    await expectCollection('feedItems').toHaveField('body', { nullable: true });
  },
});
