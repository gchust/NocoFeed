import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * Settings a subscription needs beyond its target, kept per platform.
 *
 * - `feedSources.options`  JSON, null when the platform has none. A mail subscription (`platform` `mail`, `target` the
 *                          Mail plugin account id) keeps `folder`, `senders` and `subjectKeywords` here. The push inbox
 *                          (`platform` `inbox`) and every earlier platform keep none.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611200001_feed_source_options',

  async up({ builder }) {
    await builder.alterCollection('feedSources', (collection) => {
      collection.json('options').nullable();
    });
  },

  async down({ builder }) {
    await builder.alterCollection('feedSources', (collection) => {
      collection.dropFields('options');
    });
  },
});

export default migration;
