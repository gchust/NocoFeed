import path from 'node:path';
import type { MigrationSource } from '@nocobase/db';
import { describeMigration } from '@nocobase/app-testing/server';
import { expect } from 'vitest';

const NOW = new Date('2026-11-06T14:24:01Z');

const sources: readonly MigrationSource[] = [
  {
    packageName: 'nocofeed-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

describeMigration('202611270101_feed_steer', {
  sources,
  before: async ({ connection }) => {
    // Drafts and ideas written before the person could steer them.
    await connection.query
      .insertInto('feedReplyDrafts')
      .values({
        ownerId: 'owner',
        itemId: 1,
        status: 'ready',
        trigger: 'asked',
        drafts: JSON.stringify([
          { text: 'Nice', tone: 'agree', emoji: '', image: '' },
        ]),
        contentVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .execute();
    await connection.query
      .insertInto('feedIdeas')
      .values({
        ownerId: 'owner',
        itemId: 1,
        kind: 'meme',
        status: 'ready',
        ideas: JSON.stringify([{ caption: 'c', image: 'i', trend: '' }]),
        webSearch: false,
        trigger: 'manual',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .execute();
  },
  up: async ({ expectCollection, connection }) => {
    await expectCollection('feedReplyDrafts').toHaveField('steer', {
      nullable: true,
    });
    await expectCollection('feedIdeas').toHaveField('steer', {
      nullable: true,
    });
    const [drafts] = await connection.query
      .selectFrom('feedReplyDrafts')
      .select(['status', 'steer'])
      .execute();
    expect(drafts).toEqual({ status: 'ready', steer: null });
    const [ideas] = await connection.query
      .selectFrom('feedIdeas')
      .select(['kind', 'steer'])
      .execute();
    expect(ideas).toEqual({ kind: 'meme', steer: null });
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedReplyDrafts').not.toHaveField('steer');
    await expectCollection('feedIdeas').not.toHaveField('steer');
    await expectCollection('feedReplyDrafts').toHaveField('drafts', {
      nullable: true,
    });
  },
});
