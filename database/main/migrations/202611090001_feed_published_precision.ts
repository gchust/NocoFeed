import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * How sure the publication time is.
 *
 * - `feedItems.publishedApproximate`  `publishedAt` was worked out from relative text such as "3 weeks ago" (YouTube
 *                                     search) rather than read as a date. Existing rows are exact or have no time.
 * - `feedItems.publishedCheckedAt`    when NocoFeed last asked the Collector for the exact time of an item that has
 *                                     none or an approximate one; null when it never has. Existing YouTube search
 *                                     items, stored without a time, are picked up by the scheduled lookup from here.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611090001_feed_published_precision',

  async up({ builder }) {
    await builder.alterCollection('feedItems', (collection) => {
      collection.boolean('publishedApproximate').notNull().defaultTo(false);
      collection.datetimeTz('publishedCheckedAt').nullable();
    });
  },

  async down({ builder }) {
    await builder.alterCollection('feedItems', (collection) => {
      collection.dropFields('publishedApproximate', 'publishedCheckedAt');
    });
  },
});

export default migration;
