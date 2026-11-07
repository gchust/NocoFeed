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

describeMigration('202611260101_feed_admission', {
  sources,
  before: async ({ connection }) => {
    // A person who set their preferences, and an analysis stored before the admission rules.
    await connection.query
      .insertInto('feedProfiles')
      .values({
        ownerId: 'owner',
        interests: 'vibe coding',
        dailyLimit: 20,
        keepLearning: true,
        updatedAt: NOW,
      })
      .execute();
    await connection.query
      .insertInto('feedAnalyses')
      .values({
        ownerId: 'owner',
        itemId: 1,
        current: true,
        contentVersion: 1,
        verdict: 'learn',
        score: 74,
        interestLevel: 'high',
        experienceLevel: 'none',
        engine: 'rules',
        promptVersion: 'rules-4',
        createdAt: NOW,
      })
      .execute();
  },
  up: async ({ expectCollection, connection }) => {
    for (const field of ['heldVerdict', 'watchUntil'])
      await expectCollection('feedAnalyses').toHaveField(field, {
        nullable: true,
      });
    await expectCollection('feedProfiles').toHaveField('waitForHeat', {
      nullable: false,
    });
    await expectCollection('feedProfiles').toHaveField('waitHours', {
      nullable: false,
    });
    // Existing people wait half a day by default; existing analyses keep their verdicts.
    const [profile] = await connection.query
      .selectFrom('feedProfiles')
      .select(['waitForHeat', 'waitHours'])
      .execute();
    expect(Boolean(profile?.waitForHeat)).toBe(true);
    expect(Number(profile?.waitHours)).toBe(12);
    const [analysis] = await connection.query
      .selectFrom('feedAnalyses')
      .select(['verdict', 'gate', 'heldVerdict', 'watchUntil'])
      .execute();
    expect(analysis).toEqual({
      verdict: 'learn',
      gate: null,
      heldVerdict: null,
      watchUntil: null,
    });
  },
  down: async ({ expectCollection }) => {
    for (const field of ['heldVerdict', 'watchUntil'])
      await expectCollection('feedAnalyses').not.toHaveField(field);
    for (const field of ['waitForHeat', 'waitHours'])
      await expectCollection('feedProfiles').not.toHaveField(field);
    await expectCollection('feedAnalyses').toHaveField('gate', {
      nullable: true,
    });
  },
});
