import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * Replies the person can copy to join a discussion (issue #15), apart from the analysis and the brief:
 *
 * - `feedProfiles.replyGuidelines`          the person's own rules for those replies (plain text); null keeps the
 *                                           default for their interface language.
 * - `feedProfiles.replyPlatformGuidelines`  JSON `{ [platform]: text }`: rules added for one platform (X, Xiaohongshu,
 *                                           Reddit…) on top of the general ones; null when there are none.
 * - `feedReplyDrafts`                       one row per item: the drafts (JSON list of `{ text, tone, emoji, image }`)
 *                                           in the language of the post, `guidelinesVersion` (a hash of the rules they
 *                                           were written with), `contentVersion` (the item's version), `status`
 *                                           (`ready`, `pending` while a background run writes them, `failed`) and
 *                                           `trigger` (`auto`, written for a discussion without being asked, which
 *                                           counts against the daily limit; `asked`, which does not).
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611210001_feed_reply_drafts',

  async up({ builder }) {
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.text('replyGuidelines').nullable();
      collection.json('replyPlatformGuidelines').nullable();
    });
    await builder.createCollection('feedReplyDrafts', (collection) => {
      collection.increments('id');
      collection.string('ownerId', { length: 64 }).notNull();
      collection.integer('itemId').notNull();
      collection.string('status', { length: 16 }).notNull();
      collection.string('trigger', { length: 16 }).notNull();
      collection.json('drafts').nullable();
      collection.string('language', { length: 16 }).nullable();
      collection.string('guidelinesVersion', { length: 32 }).nullable();
      collection.integer('contentVersion').notNull().defaultTo(1);
      collection.string('model', { length: 200 }).nullable();
      collection.datetimeTz('requestedAt').nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.unique(['ownerId', 'itemId'], {
        name: 'uq_feed_reply_drafts_item',
      });
      collection.index(['ownerId', 'updatedAt'], {
        name: 'ix_feed_reply_drafts_owner_updated',
      });
    });
  },

  async down({ builder }) {
    await builder.dropCollection('feedReplyDrafts');
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.dropFields('replyGuidelines', 'replyPlatformGuidelines');
    });
  },
});

export default migration;
