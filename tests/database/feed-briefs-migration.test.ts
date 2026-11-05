import path from 'node:path';
import type { MigrationSource } from '@nocobase/db';
import { describeMigration } from '@nocobase/app-testing/server';
import { expect } from 'vitest';

const NOW = new Date('2026-11-05T04:00:00Z');

const sources: readonly MigrationSource[] = [
  {
    packageName: 'nocofeed-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

describeMigration('202611100001_feed_briefs', {
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
    // An existing profile keeps following the interface language.
    await expectCollection('feedProfiles').toHaveField('readingLanguage', {
      nullable: true,
    });
    const [profile] = await connection.query
      .selectFrom('feedProfiles')
      .select(['readingLanguage'])
      .execute();
    expect(profile!.readingLanguage).toBeNull();

    await expectCollection('feedBriefs').toHaveField('brief', {
      nullable: false,
    });
    await expectCollection('feedBriefs').toHaveField('body', {
      nullable: true,
    });
    const brief = {
      ownerId: 'owner',
      itemId: 1,
      language: 'zh-CN',
      contentVersion: 1,
      brief: '一句话要点。',
      createdAt: NOW,
      updatedAt: NOW,
    };
    await connection.query.insertInto('feedBriefs').values(brief).execute();
    // One brief per item and language.
    await expect(
      connection.query.insertInto('feedBriefs').values(brief).execute(),
    ).rejects.toThrow();
    await connection.query
      .insertInto('feedBriefs')
      .values({ ...brief, language: 'en' })
      .execute();
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedProfiles').not.toHaveField('readingLanguage');
    await expectCollection('feedProfiles').toHaveField('dailyLimit', {
      nullable: false,
    });
  },
});
