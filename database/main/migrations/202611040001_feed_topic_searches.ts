import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * Keyword searches belong to the topic they search for. A topic may carry search terms and the search platforms to run
 * them on; each term × platform pair runs as a subscription row owned by the topic:
 *
 * - `feedTopics.searchTerms`      the terms, in order; null or empty when the topic only judges what other sources bring
 * - `feedTopics.searchPlatforms`  the platforms to search; null or empty means every platform that can search
 * - `feedTopics.searchFrequency`  minutes between runs of each of the topic's searches
 * - `feedTopics.searchLimit`      candidates each search brings back
 * - `feedSources.topicId`         the topic that owns a search row; null for a subscription the person made directly
 *
 * Existing subscriptions keep `topicId` null and run as before.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611040001_feed_topic_searches',

  async up({ builder }) {
    await builder.alterCollection('feedTopics', (collection) => {
      collection.json('searchTerms').nullable();
      collection.json('searchPlatforms').nullable();
      collection.integer('searchFrequency').notNull().defaultTo(360);
      collection.integer('searchLimit').notNull().defaultTo(20);
    });
    await builder.alterCollection('feedSources', (collection) => {
      collection.integer('topicId').nullable();
      collection.index('topicId', { name: 'ix_feed_sources_topic' });
    });
  },

  async down({ builder }) {
    await builder.alterCollection('feedSources', (collection) => {
      // Dropping `topicId` drops its index with it on every supported database.
      collection.dropFields('topicId');
    });
    await builder.alterCollection('feedTopics', (collection) => {
      collection.dropFields(
        'searchTerms',
        'searchPlatforms',
        'searchFrequency',
        'searchLimit',
      );
    });
  },
});

export default migration;
