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

describeMigration('202611080001_feed_run_window', {
  sources,
  before: async ({ connection }) => {
    await connection.query
      .insertInto('feedRuns')
      .values({
        ownerId: 'owner',
        stage: 'collect',
        trigger: 'schedule',
        status: 'succeeded',
        startedAt: new Date('2026-11-01T08:00:00Z'),
      })
      .execute();
  },
  up: async ({ expectCollection, connection }) => {
    await expectCollection('feedRuns').toHaveField('windowFilter', {
      nullable: true,
    });
    await expectCollection('feedRuns').toHaveField('windowScanned', {
      nullable: true,
    });
    // Earlier runs did not record it: unknown, not "applied by the platform".
    const rows = await connection.query
      .selectFrom('feedRuns')
      .select(['windowFilter', 'windowScanned'])
      .execute();
    expect(rows).toEqual([{ windowFilter: null, windowScanned: null }]);
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedRuns').not.toHaveField('windowFilter');
    await expectCollection('feedRuns').not.toHaveField('windowScanned');
    await expectCollection('feedRuns').toExist();
  },
});
