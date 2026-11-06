import path from 'node:path';
import type { MigrationSource } from '@nocobase/db';
import { describeMigration } from '@nocobase/app-testing/server';
import { expect } from 'vitest';

const NOW = new Date('2026-11-25T04:00:00Z');

const sources: readonly MigrationSource[] = [
  {
    packageName: 'nocofeed-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

describeMigration('202611250001_feed_ideas', {
  sources,
  up: async ({ expectCollection, connection }) => {
    await expectCollection('feedIdeaSettings').toHaveField('style', {
      nullable: true,
    });
    await expectCollection('feedIdeaSettings').toHaveField('auto', {
      nullable: false,
    });
    await connection.query
      .insertInto('feedIdeaSettings')
      .values({ ownerId: 'owner', updatedAt: NOW })
      .execute();
    const [settings] = await connection.query
      .selectFrom('feedIdeaSettings')
      .select(['auto', 'style', 'kinds', 'xLanguage'])
      .execute();
    // Automatic ideas are off until the person turns them on.
    expect(Boolean(settings!.auto)).toBe(false);
    expect(settings!.style).toBeNull();
    expect(settings!.kinds).toBeNull();
    expect(settings!.xLanguage).toBeNull();

    await expectCollection('feedIdeas').toHaveField('ideas', {
      nullable: true,
    });
    await expectCollection('feedIdeas').toHaveField('status', {
      nullable: false,
    });
    const row = {
      ownerId: 'owner',
      itemId: 1,
      kind: 'x',
      status: 'pending',
      createdAt: NOW,
      updatedAt: NOW,
    };
    await connection.query.insertInto('feedIdeas').values(row).execute();
    // One set of ideas per item and kind.
    await expect(
      connection.query.insertInto('feedIdeas').values(row).execute(),
    ).rejects.toThrow();
    await connection.query
      .insertInto('feedIdeas')
      .values({ ...row, kind: 'meme' })
      .execute();
    const [stored] = await connection.query
      .selectFrom('feedIdeas')
      .select(['trigger', 'webSearch'])
      .where('kind', '=', 'x')
      .execute();
    expect(stored!.trigger).toBe('manual');
    expect(Boolean(stored!.webSearch)).toBe(false);
  },
  down: async ({ expectCollection }) => {
    await expectCollection('feedIdeas').not.toExist();
    await expectCollection('feedIdeaSettings').not.toExist();
    await expectCollection('feedProfiles').toHaveField('dailyLimit', {
      nullable: false,
    });
  },
});
