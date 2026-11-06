import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * How much attention an item is getting on its own platform, kept apart from what the analysis says it is worth.
 *
 * - `feedItems.heat`              0-100 from the item's latest counts (`heat.ts`); null when the platform gives no
 *                                 counts NocoFeed can weigh
 * - `feedItems.heatAtCollection`  the same when it was collected, so a recommendation can later be checked against
 *                                 whether the item went on to become hot
 * - `feedItems.metricsCheckedAt`  when the counts were last read; recent items are read again on a schedule
 *
 * Existing rows start without heat; the scheduled refresh fills it for the items still recent enough to matter.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611110001_feed_item_heat',

  async up({ builder }) {
    await builder.alterCollection('feedItems', (collection) => {
      collection.integer('heat').nullable();
      collection.integer('heatAtCollection').nullable();
      collection.datetimeTz('metricsCheckedAt').nullable();
      collection.index(['ownerId', 'heat'], { name: 'ix_feed_items_heat' });
    });
  },

  async down({ builder }) {
    await builder.alterCollection('feedItems', (collection) => {
      collection.dropIndex('ix_feed_items_heat');
      collection.dropFields('heat', 'heatAtCollection', 'metricsCheckedAt');
    });
  },
});

export default migration;
