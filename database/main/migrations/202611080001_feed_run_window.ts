import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * How a collection run's time window was applied, so the run record can say when a platform could not search by date.
 *
 * - `feedRuns.windowFilter`   `platform` (the platform sorted or filtered by date), `local` (it could not; the
 *                             Collector read deeper and kept what was published inside the window), or null when the
 *                             run had no window or the Collector did not say (older Collectors, native adapters).
 * - `feedRuns.windowScanned`  how many results a `local` run read to find them; null when unknown.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611080001_feed_run_window',

  async up({ builder }) {
    await builder.alterCollection('feedRuns', (collection) => {
      collection.string('windowFilter', { length: 16 }).nullable();
      collection.integer('windowScanned').nullable();
    });
  },

  async down({ builder }) {
    await builder.alterCollection('feedRuns', (collection) => {
      collection.dropFields('windowFilter', 'windowScanned');
    });
  },
});

export default migration;
