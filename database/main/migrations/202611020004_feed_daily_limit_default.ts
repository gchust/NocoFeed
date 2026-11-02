import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * The default daily limit went from 20 to 1000 analyses, in the service. Rows holding the old default move with it: 20
 * was never distinguishable from a choice. The column's own default stays, because every write sets the value.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611020004_feed_daily_limit_default',

  async up({ query }) {
    await query
      .updateTable('feedProfiles')
      .set({ dailyLimit: 1000 })
      .where('dailyLimit', '=', 20)
      .execute();
  },

  async down({ query }) {
    await query
      .updateTable('feedProfiles')
      .set({ dailyLimit: 20 })
      .where('dailyLimit', '=', 1000)
      .execute();
  },
});

export default migration;
