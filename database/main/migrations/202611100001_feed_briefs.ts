import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * What the model writes for reading, apart from the analysis that decides whether to read:
 *
 * - `feedProfiles.readingLanguage`  the language briefs and translations are written in: a BCP 47 tag such as
 *                                   `zh-CN`; `original` keeps the item's own language; null follows the interface.
 * - `feedBriefs`                    one row per item and language: the brief (Markdown, which may place the item's own
 *                                   images as `media:N`), the title in that language (null when already in it), and
 *                                   the full text translated, filled only when asked. `contentVersion` is the item's
 *                                   version it was written from, so new material makes it stale rather than wrong.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611100001_feed_briefs',

  async up({ builder }) {
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.string('readingLanguage', { length: 16 }).nullable();
    });
    await builder.createCollection('feedBriefs', (collection) => {
      collection.increments('id');
      collection.string('ownerId', { length: 64 }).notNull();
      collection.integer('itemId').notNull();
      collection.string('language', { length: 16 }).notNull();
      collection.integer('contentVersion').notNull().defaultTo(1);
      collection.string('sourceLanguage', { length: 16 }).nullable();
      collection.text('title').nullable();
      collection.text('brief').notNull();
      collection.text('body').nullable();
      collection.integer('bodyVersion').nullable();
      collection.string('model', { length: 200 }).nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.unique(['ownerId', 'itemId', 'language'], {
        name: 'uq_feed_briefs_item_language',
      });
      collection.index(['ownerId', 'createdAt'], {
        name: 'ix_feed_briefs_owner_created',
      });
    });
  },

  async down({ builder }) {
    await builder.dropCollection('feedBriefs');
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.dropFields('readingLanguage');
    });
  },
});

export default migration;
