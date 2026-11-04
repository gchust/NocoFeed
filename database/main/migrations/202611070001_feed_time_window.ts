import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * A feed is about what is new.
 *
 * - `feedProfiles.maxAgeDays`  how many days back a collected item may have been published; 0 keeps everything.
 *                              Existing profiles get the default of 7 days.
 * - `feedItems.timelineAt`     where the item sits in time: when it was published, or when it was collected if the
 *                              platform did not say. The feed sorts "newest first" and filters by period on it.
 *                              Every insert sets it; existing rows are filled here.
 */
const BATCH = 500;

const migration: MigrationDefinition = defineMigration({
  name: '202611070001_feed_time_window',

  async up({ builder, query }) {
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.integer('maxAgeDays').notNull().defaultTo(7);
    });
    await builder.alterCollection('feedItems', (collection) => {
      collection.datetimeTz('timelineAt').nullable();
      collection.index(['ownerId', 'timelineAt'], {
        name: 'ix_feed_items_owner_timeline',
      });
    });
    // The query builder has no COALESCE, so existing rows are filled one by one, in id order.
    let after = 0;
    for (;;) {
      const rows = await query
        .selectFrom('feedItems')
        .select(['id', 'publishedAt', 'createdAt'])
        .where('id', '>', after)
        .orderBy('id', 'asc')
        .limit(BATCH)
        .execute();
      if (!rows.length) break;
      for (const row of rows) {
        await query
          .updateTable('feedItems')
          .set({ timelineAt: row.publishedAt ?? row.createdAt })
          .where('id', '=', row.id)
          .execute();
      }
      after = Number(rows[rows.length - 1].id);
    }
  },

  async down({ builder }) {
    await builder.alterCollection('feedItems', (collection) => {
      collection.dropIndex('ix_feed_items_owner_timeline');
    });
    await builder.alterCollection('feedItems', (collection) => {
      collection.dropFields('timelineAt');
    });
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.dropFields('maxAgeDays');
    });
  },
});

export default migration;
