import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * What keeps thin, unnoticed search results out of the feed (issue #19), and lets a new post wait for its heat.
 *
 * - `feedAnalyses.heldVerdict`  the verdict the analysis would have shown when the admission rules (`admission.ts`)
 *                               hid the item instead (`gate`: `thin`, `reply` or `watching`), so it can be let in
 *                               without asking a model again once it turns out to be hot
 * - `feedAnalyses.watchUntil`   for `watching`: when to read the item's counts again and decide
 * - `feedProfiles.waitForHeat`  whether a new thin post waits for its heat (on by default) or is decided at once
 * - `feedProfiles.waitHours`    how long after publication it waits (12 by default)
 *
 * Existing analyses keep their verdicts: `feed reapply-admission` (`--dry-run` first) applies the rules to them.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260101_feed_admission',

  async up({ builder }) {
    await builder.alterCollection('feedAnalyses', (collection) => {
      collection.string('heldVerdict', { length: 16 }).nullable();
      collection.datetimeTz('watchUntil').nullable();
      collection.index(['gate', 'watchUntil'], {
        name: 'ix_feed_analyses_watch',
      });
    });
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.boolean('waitForHeat').notNull().defaultTo(true);
      collection.integer('waitHours').notNull().defaultTo(12);
    });
  },

  async down({ builder }) {
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.dropFields('waitForHeat', 'waitHours');
    });
    await builder.alterCollection('feedAnalyses', (collection) => {
      collection.dropIndex('ix_feed_analyses_watch');
      collection.dropFields('heldVerdict', 'watchUntil');
    });
  },
});

export default migration;
