import path from 'node:path';
import type { MigrationSource } from '@nocobase/db';
import { describeMigration } from '@nocobase/app-testing/server';
import { expect } from 'vitest';

const sources: readonly MigrationSource[] = [
  {
    packageName: 'nocofeed-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

describeMigration('202611200001_feed_source_options', {
  sources,
  before: async ({ connection }) => {
    await connection.query
      .insertInto('feedSources')
      .values({
        ownerId: 'owner',
        platform: 'rss',
        operation: 'feed',
        name: 'Blog',
        target: 'https://example.com/feed.xml',
        createdAt: new Date('2026-11-01T08:00:00Z'),
        updatedAt: new Date('2026-11-01T08:00:00Z'),
      })
      .execute();
  },
  up: async ({ expectCollection, connection }) => {
    await expectCollection('feedSources').toHaveField('options', {
      nullable: true,
    });
    // Earlier subscriptions keep no options.
    const rows = await connection.query
      .selectFrom('feedSources')
      .select(['options'])
      .execute();
    expect(rows).toEqual([{ options: null }]);
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedSources').not.toHaveField('options');
    await expectCollection('feedSources').toExist();
  },
});
