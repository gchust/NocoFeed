import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * What the person asked for when writing again (issue #20), kept with what was written:
 *
 * - `feedReplyDrafts.steer`  `{ angles, note }` the drafts were written with ("another batch" with a note); null when
 *                            they were written under the rules alone
 * - `feedIdeas.steer`        the same for a set of ideas ("regenerate" or "one more" with a note)
 *
 * Existing rows keep null: they were written without a request.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611270101_feed_steer',

  async up({ builder }) {
    await builder.alterCollection('feedReplyDrafts', (collection) => {
      collection.json('steer').nullable();
    });
    await builder.alterCollection('feedIdeas', (collection) => {
      collection.json('steer').nullable();
    });
  },

  async down({ builder }) {
    await builder.alterCollection('feedIdeas', (collection) => {
      collection.dropFields('steer');
    });
    await builder.alterCollection('feedReplyDrafts', (collection) => {
      collection.dropFields('steer');
    });
  },
});

export default migration;
