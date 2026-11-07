import path from 'node:path';
import type { MigrationSource } from '@nocobase/db';
import { describeMigration } from '@nocobase/app-testing/server';
import { expect } from 'vitest';

const NOW = new Date('2026-11-07T05:30:00Z');

const sources: readonly MigrationSource[] = [
  {
    packageName: 'nocofeed-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

describeMigration('202611290101_feed_writing_skills', {
  sources,
  before: async ({ connection }) => {
    // A profile from before anyone could choose a writing skill.
    await connection.query
      .insertInto('feedProfiles')
      .values({
        ownerId: 'owner',
        dailyLimit: 20,
        keepLearning: true,
        replyGuidelines: 'Be kind.',
        updatedAt: NOW,
      })
      .execute();
  },
  up: async ({ expectCollection, connection }) => {
    await expectCollection('feedProfiles').toHaveField('writingSkills', {
      nullable: true,
    });
    const [profile] = await connection.query
      .selectFrom('feedProfiles')
      .select(['replyGuidelines', 'writingSkills'])
      .execute();
    expect(profile).toEqual({
      replyGuidelines: 'Be kind.',
      writingSkills: null,
    });
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedProfiles').not.toHaveField('writingSkills');
    await expectCollection('feedProfiles').toHaveField('replyGuidelines', {
      nullable: true,
    });
  },
});
