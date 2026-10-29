import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * What NocoFeed learns from the person and keeps watching for them:
 *
 * - `feedProfiles.termWeights`   per-word adjustments learned from "useful" / "not relevant" feedback
 * - `feedProfiles.digest*`       the daily digest: whether it is sent, at which local hour, and when it last went out
 * - `feedItemStates.dismissed`   an item the person cleared from the feed without judging it
 * - `feedItemStates.followUp*`   the reply count of the thread the person joined, re-checked for two weeks after they
 *                                posted: when following began, the count they have seen, the latest count, and when next
 * - `feedSources.*Streak`        consecutive failed and empty runs, so a silent subscription is noticed
 */
const migration: MigrationDefinition = defineMigration({
  name: '202610290001_feed_engagement',

  async up({ builder }) {
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.json('termWeights').nullable();
      collection.boolean('digestEnabled').notNull().defaultTo(true);
      collection.integer('digestHour').notNull().defaultTo(8);
      collection.string('timeZone', { length: 64 }).nullable();
      collection.datetimeTz('lastDigestAt').nullable();
    });

    await builder.alterCollection('feedItemStates', (collection) => {
      collection.boolean('dismissed').notNull().defaultTo(false);
      collection.datetimeTz('followUpSince').nullable();
      collection.datetimeTz('followUpAt').nullable();
      collection.integer('followUpBaseline').nullable();
      collection.integer('followUpReplies').nullable();
      collection.integer('followUpNew').notNull().defaultTo(0);
      collection.datetimeTz('followUpCheckedAt').nullable();
      collection.index('followUpAt', { name: 'ix_feed_item_states_follow_up' });
    });

    await builder.alterCollection('feedSources', (collection) => {
      collection.integer('failureStreak').notNull().defaultTo(0);
      collection.integer('emptyStreak').notNull().defaultTo(0);
      collection.datetimeTz('healthNotifiedAt').nullable();
    });
  },

  async down({ builder }) {
    await builder.alterCollection('feedSources', (collection) => {
      collection.dropFields('failureStreak', 'emptyStreak', 'healthNotifiedAt');
    });
    await builder.alterCollection('feedItemStates', (collection) => {
      // Dropping `followUpAt` drops its index with it on every supported database.
      collection.dropFields(
        'dismissed',
        'followUpSince',
        'followUpAt',
        'followUpBaseline',
        'followUpReplies',
        'followUpNew',
        'followUpCheckedAt',
      );
    });
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.dropFields(
        'termWeights',
        'digestEnabled',
        'digestHour',
        'timeZone',
        'lastDigestAt',
      );
    });
  },
});

export default migration;
