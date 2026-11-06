import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * Ideas for creating something from an item (issue #16): a Xiaohongshu note, an X post or thread, a short-video script,
 * a Bilibili video outline, a meme. Generated on request, or automatically for items worth discussing when the person
 * turns that on.
 *
 * - `feedIdeaSettings`  one row per person: the creative style / persona (`style`, null = the built-in default), which
 *                       kinds to generate (`kinds`, null = all), whether to generate automatically (`auto`) and the
 *                       language of X posts (`xLanguage`, null = English).
 * - `feedIdeas`         one row per person, item and kind: the ideas as JSON (`ideas`), `status` (`pending`, `ready`,
 *                       `failed`) with an error code, the hash of the style they were written in (`styleVersion`), the
 *                       model, whether web search was used, how they were asked for (`trigger`: `manual` / `auto`)
 *                       and when they were generated.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611250001_feed_ideas',

  async up({ builder }) {
    await builder.createCollection('feedIdeaSettings', (collection) => {
      collection.string('ownerId', { length: 64 }).notNull();
      collection.text('style').nullable();
      collection.json('kinds').nullable();
      collection.boolean('auto').notNull().defaultTo(false);
      collection.string('xLanguage', { length: 16 }).nullable();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('ownerId', { name: 'pk_feed_idea_settings' });
    });
    await builder.createCollection('feedIdeas', (collection) => {
      collection.increments('id');
      collection.string('ownerId', { length: 64 }).notNull();
      collection.integer('itemId').notNull();
      collection.string('kind', { length: 32 }).notNull();
      collection.string('status', { length: 16 }).notNull();
      collection.json('ideas').nullable();
      collection.string('error', { length: 64 }).nullable();
      collection.string('styleVersion', { length: 32 }).nullable();
      collection.string('model', { length: 200 }).nullable();
      collection.boolean('webSearch').notNull().defaultTo(false);
      collection.string('trigger', { length: 16 }).notNull().defaultTo('manual');
      collection.datetimeTz('generatedAt').nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.unique(['ownerId', 'itemId', 'kind'], {
        name: 'uq_feed_ideas_item_kind',
      });
      collection.index(['ownerId', 'createdAt'], {
        name: 'ix_feed_ideas_owner_created',
      });
    });
  },

  async down({ builder }) {
    await builder.dropCollection('feedIdeas');
    await builder.dropCollection('feedIdeaSettings');
  },
});

export default migration;
