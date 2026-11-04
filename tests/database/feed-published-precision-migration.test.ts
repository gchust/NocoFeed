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

describeMigration('202611090001_feed_published_precision', {
  sources,
  before: async ({ connection }) => {
    // A YouTube search result stored before: no publication time, placed at the time it was collected.
    await connection.query
      .insertInto('feedItems')
      .values({
        ownerId: 'owner',
        platform: 'youtube',
        externalId: 'PPl884-BKWY',
        title: 'Migrating a Sales App from AppSheet to Nocobase',
        contentVersion: 1,
        publishedAt: null,
        timelineAt: COLLECTED,
        fetchedAt: COLLECTED,
        createdAt: COLLECTED,
      })
      .execute();
  },
  up: async ({ expectCollection, connection }) => {
    await expectCollection('feedItems').toHaveField('publishedApproximate', {
      nullable: false,
    });
    await expectCollection('feedItems').toHaveField('publishedCheckedAt', {
      nullable: true,
    });
    // Existing rows are not approximate and have never been looked up, so the scheduled lookup picks them up.
    const [row] = await connection.query
      .selectFrom('feedItems')
      .select(['publishedAt', 'publishedApproximate', 'publishedCheckedAt'])
      .execute();
    expect(row!.publishedAt).toBeNull();
    expect(Boolean(row!.publishedApproximate)).toBe(false);
    expect(row!.publishedCheckedAt).toBeNull();
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedItems').not.toHaveField('publishedApproximate');
    await expectCollection('feedItems').not.toHaveField('publishedCheckedAt');
    await expectCollection('feedItems').toHaveField('timelineAt', {
      nullable: true,
    });
  },
});
