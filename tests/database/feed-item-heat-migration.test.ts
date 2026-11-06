import path from 'node:path';
import type { MigrationSource } from '@nocobase/db';
import { describeMigration } from '@nocobase/app-testing/server';
import { expect } from 'vitest';

const COLLECTED = new Date('2026-11-04T13:38:47Z');

const sources: readonly MigrationSource[] = [
  {
    packageName: 'nocofeed-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

describeMigration('202611110001_feed_item_heat', {
  sources,
  before: async ({ connection }) => {
    // A Hacker News story stored before, with the counts it had when collected.
    await connection.query
      .insertInto('feedItems')
      .values({
        ownerId: 'owner',
        platform: 'hn',
        externalId: '46012345',
        title: 'OpenSSH 10.6p2 released',
        metrics: JSON.stringify({ points: 3, comments: 0 }),
        contentVersion: 1,
        publishedAt: COLLECTED,
        timelineAt: COLLECTED,
        fetchedAt: COLLECTED,
        createdAt: COLLECTED,
      })
      .execute();
  },
  up: async ({ expectCollection, connection }) => {
    for (const field of ['heat', 'heatAtCollection', 'metricsCheckedAt'])
      await expectCollection('feedItems').toHaveField(field, {
        nullable: true,
      });
    // Existing rows start without heat and unread, so the scheduled refresh picks up the recent ones.
    const [row] = await connection.query
      .selectFrom('feedItems')
      .select(['heat', 'heatAtCollection', 'metricsCheckedAt'])
      .execute();
    expect(row).toEqual({
      heat: null,
      heatAtCollection: null,
      metricsCheckedAt: null,
    });
  },
  down: async ({ expectCollection }) => {
    for (const field of ['heat', 'heatAtCollection', 'metricsCheckedAt'])
      await expectCollection('feedItems').not.toHaveField(field);
    await expectCollection('feedItems').toHaveField('metrics', {
      nullable: true,
    });
  },
});
