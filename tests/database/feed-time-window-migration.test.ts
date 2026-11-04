import path from 'node:path';
import type { MigrationSource } from '@nocobase/db';
import { describeMigration } from '@nocobase/app-testing/server';
import { expect } from 'vitest';

const PUBLISHED = new Date('2026-10-01T08:00:00Z');
const COLLECTED = new Date('2026-11-01T08:00:00Z');

const sources: readonly MigrationSource[] = [
  {
    packageName: 'nocofeed-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

describeMigration('202611070001_feed_time_window', {
  sources,
  before: async ({ connection }) => {
    const item = (externalId: string, publishedAt: Date | null) => ({
      ownerId: 'owner',
      platform: 'hn',
      externalId,
      title: externalId,
      contentVersion: 1,
      publishedAt,
      fetchedAt: COLLECTED,
      createdAt: COLLECTED,
    });
    await connection.query
      .insertInto('feedItems')
      .values([item('dated', PUBLISHED), item('undated', null)])
      .execute();
  },
  up: async ({ expectCollection, connection }) => {
    // Existing items are placed in time: when published, else when collected.
    const rows = await connection.query
      .selectFrom('feedItems')
      .select(['externalId', 'timelineAt'])
      .orderBy('externalId', 'asc')
      .execute();
    expect(
      rows.map((row) => [
        row.externalId,
        new Date(row.timelineAt as string).toISOString(),
      ]),
    ).toEqual([
      ['dated', PUBLISHED.toISOString()],
      ['undated', COLLECTED.toISOString()],
    ]);
    await expectCollection('feedProfiles').toHaveField('maxAgeDays', {
      nullable: false,
    });
    await expectCollection('feedItems').toHaveField('timelineAt', {
      nullable: true,
    });
    await expectCollection('feedItems').toHaveIndex(['ownerId', 'timelineAt']);
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedProfiles').not.toHaveField('maxAgeDays');
    await expectCollection('feedItems').not.toHaveField('timelineAt');
    await expectCollection('feedItems').toExist();
  },
});
