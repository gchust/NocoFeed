import path from 'node:path';
import type { MigrationSource } from '@nocobase/db';
import { describeMigration } from '@nocobase/app-testing/server';
import { expect } from 'vitest';

const CHANGED = new Date('2026-11-01T08:00:00Z');

const sources: readonly MigrationSource[] = [
  {
    packageName: 'nocofeed-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

describeMigration('202611080002_feed_read_state', {
  sources,
  before: async ({ connection }) => {
    const state = (itemId: number, values: Record<string, unknown>) => ({
      ownerId: 'owner',
      itemId,
      favorite: false,
      later: false,
      participated: false,
      dismissed: false,
      followUpNew: 0,
      updatedAt: CHANGED,
      ...values,
    });
    await connection.query
      .insertInto('feedItemStates')
      .values([
        state(1, { favorite: true }),
        state(2, { feedback: 'helpful' }),
        state(3, { notes: 'mine' }),
        state(4, { dismissed: true }),
        state(5, { participated: true }),
        state(6, { later: true }),
        state(7, {}),
      ])
      .execute();
  },
  up: async ({ expectCollection, connection }) => {
    await expectCollection('feedItemStates').toHaveField('readAt', {
      nullable: true,
    });
    // What the person has clearly been through is read as of its last change; "read later" alone stays unread.
    const rows = await connection.query
      .selectFrom('feedItemStates')
      .select(['itemId', 'readAt'])
      .orderBy('itemId', 'asc')
      .execute();
    expect(
      rows.map((row) => [
        Number(row.itemId),
        row.readAt == null
          ? null
          : new Date(row.readAt as string).toISOString(),
      ]),
    ).toEqual([
      [1, CHANGED.toISOString()],
      [2, CHANGED.toISOString()],
      [3, CHANGED.toISOString()],
      [4, CHANGED.toISOString()],
      [5, CHANGED.toISOString()],
      [6, null],
      [7, null],
    ]);
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedItemStates').not.toHaveField('readAt');
    await expectCollection('feedItemStates').toHaveField('favorite');
  },
});
