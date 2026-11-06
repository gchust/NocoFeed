import path from 'node:path';
import type { MigrationSource } from '@nocobase/db';
import { describeMigration } from '@nocobase/app-testing/server';
import { expect } from 'vitest';

const NOW = new Date('2026-11-06T04:00:00Z');

const sources: readonly MigrationSource[] = [
  {
    packageName: 'nocofeed-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

describeMigration('202611210001_feed_reply_drafts', {
  sources,
  before: async ({ connection }) => {
    await connection.query
      .insertInto('feedProfiles')
      .values({
        ownerId: 'owner',
        dailyLimit: 20,
        keepLearning: true,
        locale: 'zh-CN',
        updatedAt: NOW,
      })
      .execute();
  },
  up: async ({ expectCollection, connection }) => {
    // An existing profile keeps the default rules.
    await expectCollection('feedProfiles').toHaveField('replyGuidelines', {
      nullable: true,
    });
    await expectCollection('feedProfiles').toHaveField(
      'replyPlatformGuidelines',
      { nullable: true },
    );
    const [profile] = await connection.query
      .selectFrom('feedProfiles')
      .select(['replyGuidelines', 'replyPlatformGuidelines'])
      .execute();
    expect(profile).toEqual({
      replyGuidelines: null,
      replyPlatformGuidelines: null,
    });

    await expectCollection('feedReplyDrafts').toHaveField('status', {
      nullable: false,
    });
    await expectCollection('feedReplyDrafts').toHaveField('drafts', {
      nullable: true,
    });
    await expectCollection('feedReplyDrafts').toHaveField('guidelinesVersion', {
      nullable: true,
    });
    const row = {
      ownerId: 'owner',
      itemId: 1,
      status: 'ready',
      trigger: 'auto',
      drafts: JSON.stringify([
        { text: 'Nice.', tone: '', emoji: '', image: '' },
      ]),
      language: 'en',
      guidelinesVersion: 'abc123abc123',
      createdAt: NOW,
      updatedAt: NOW,
    };
    await connection.query.insertInto('feedReplyDrafts').values(row).execute();
    // One row per person and item.
    await expect(
      connection.query.insertInto('feedReplyDrafts').values(row).execute(),
    ).rejects.toThrow();
    await connection.query
      .insertInto('feedReplyDrafts')
      .values({ ...row, ownerId: 'someone-else' })
      .execute();
    const [stored] = await connection.query
      .selectFrom('feedReplyDrafts')
      .select(['contentVersion'])
      .where('ownerId', '=', 'owner')
      .execute();
    expect(Number(stored!.contentVersion)).toBe(1);
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedReplyDrafts').not.toExist();
    await expectCollection('feedProfiles').not.toHaveField('replyGuidelines');
    await expectCollection('feedProfiles').not.toHaveField(
      'replyPlatformGuidelines',
    );
    await expectCollection('feedProfiles').toHaveField('dailyLimit', {
      nullable: false,
    });
  },
});
