import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * NocoFeed's personal multi-source feed. Every row belongs to one user (`ownerId`, the Better Auth user id) and is only
 * ever read through that owner's session.
 *
 * - `feedProfiles`     what the person wants to follow and what they can genuinely contribute (one row per user)
 * - `feedTopics`       interest topics: "what is worth my attention"
 * - `feedSources`      subscriptions: platform + operation + target, frequency and incremental state
 * - `feedItems`        unified content, deduplicated per owner + platform + external id, with per-part coverage
 * - `feedAnalyses`     versioned recommendations; a new analysis never overwrites the person's own state
 * - `feedItemStates`   favourites, read-later, notes, feedback and participation records the person writes
 * - `feedRuns`         one row per collect / enrich / analyze attempt, with result scope and failures
 */
const migration: MigrationDefinition = defineMigration({
  name: '202610280001_create_feed',

  async up({ builder }) {
    await builder.createCollection('feedProfiles', (collection) => {
      collection.string('ownerId', { length: 64 }).notNull();
      collection.text('interests').nullable();
      collection.text('expertise').nullable();
      collection.text('avoid').nullable();
      collection.integer('dailyLimit').notNull().defaultTo(20);
      collection.boolean('keepLearning').notNull().defaultTo(true);
      collection.string('locale', { length: 16 }).nullable();
      collection.datetimeTz('updatedAt').notNull();
      collection.primary('ownerId', { name: 'pk_feed_profiles' });
    });

    await builder.createCollection('feedTopics', (collection) => {
      collection.increments('id');
      collection.string('ownerId', { length: 64 }).notNull();
      collection.string('name', { length: 80 }).notNull();
      collection.text('goal').notNull();
      collection.text('avoid').nullable();
      collection.string('mode', { length: 16 }).notNull().defaultTo('both');
      collection.json('sourceIds').nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.index('ownerId', { name: 'ix_feed_topics_owner' });
    });

    await builder.createCollection('feedSources', (collection) => {
      collection.increments('id');
      collection.string('ownerId', { length: 64 }).notNull();
      collection.string('platform', { length: 32 }).notNull();
      collection.string('operation', { length: 32 }).notNull();
      collection.string('name', { length: 120 }).notNull();
      collection.string('target', { length: 500 }).notNull();
      collection.integer('frequency').notNull().defaultTo(60);
      collection.integer('candidateLimit').notNull().defaultTo(20);
      collection.boolean('active').notNull().defaultTo(true);
      collection.string('status', { length: 24 }).notNull().defaultTo('pending');
      collection.text('statusMessage').nullable();
      collection.json('cursor').nullable();
      collection.datetimeTz('lastRunAt').nullable();
      collection.datetimeTz('lastSuccessAt').nullable();
      collection.datetimeTz('nextRunAt').nullable();
      collection.datetimeTz('createdAt').notNull();
      collection.datetimeTz('updatedAt').notNull();
      collection.index('ownerId', { name: 'ix_feed_sources_owner' });
      collection.index(['active', 'nextRunAt'], { name: 'ix_feed_sources_due' });
    });

    await builder.createCollection('feedItems', (collection) => {
      collection.increments('id');
      collection.string('ownerId', { length: 64 }).notNull();
      collection.string('platform', { length: 32 }).notNull();
      collection.string('externalId', { length: 191 }).notNull();
      collection.integer('sourceId').nullable();
      collection.string('sourceLabel', { length: 200 }).nullable();
      collection.string('url', { length: 1000 }).nullable();
      collection.string('title', { length: 500 }).notNull();
      collection.string('author', { length: 200 }).nullable();
      collection.text('summary').nullable();
      collection.text('body').nullable();
      collection.json('comments').nullable();
      collection.json('transcript').nullable();
      collection.json('metrics').nullable();
      collection.json('coverage').nullable();
      collection.integer('contentVersion').notNull().defaultTo(1);
      collection.datetimeTz('publishedAt').nullable();
      collection.datetimeTz('fetchedAt').notNull();
      collection.datetimeTz('createdAt').notNull();
      collection.unique(['ownerId', 'platform', 'externalId'], {
        name: 'uq_feed_items_identity',
      });
      collection.index(['ownerId', 'createdAt'], {
        name: 'ix_feed_items_owner_created',
      });
    });

    await builder.createCollection('feedAnalyses', (collection) => {
      collection.increments('id');
      collection.string('ownerId', { length: 64 }).notNull();
      collection.integer('itemId').notNull();
      collection.boolean('current').notNull().defaultTo(true);
      collection.integer('contentVersion').notNull();
      collection.integer('topicId').nullable();
      collection.string('verdict', { length: 16 }).notNull();
      collection.integer('score').notNull().defaultTo(0);
      collection.string('interestLevel', { length: 16 }).notNull();
      collection.text('interestReason').nullable();
      collection.string('experienceLevel', { length: 16 }).notNull();
      collection.text('experienceReason').nullable();
      collection.text('lead').nullable();
      collection.json('steps').nullable();
      collection.text('evidence').nullable();
      collection.text('uncertainty').nullable();
      collection.string('engine', { length: 16 }).notNull();
      collection.string('model', { length: 200 }).nullable();
      collection.string('promptVersion', { length: 32 }).notNull();
      collection.datetimeTz('createdAt').notNull();
      collection.index(['itemId', 'current'], {
        name: 'ix_feed_analyses_item_current',
      });
      collection.index(['ownerId', 'current', 'verdict'], {
        name: 'ix_feed_analyses_owner_verdict',
      });
      collection.index(['ownerId', 'createdAt'], {
        name: 'ix_feed_analyses_owner_created',
      });
    });

    await builder.createCollection('feedItemStates', (collection) => {
      collection.increments('id');
      collection.string('ownerId', { length: 64 }).notNull();
      collection.integer('itemId').notNull();
      collection.boolean('favorite').notNull().defaultTo(false);
      collection.boolean('later').notNull().defaultTo(false);
      collection.boolean('participated').notNull().defaultTo(false);
      collection.string('feedback', { length: 16 }).nullable();
      collection.text('notes').nullable();
      collection.string('participationUrl', { length: 1000 }).nullable();
      collection.text('participationNote').nullable();
      collection.datetimeTz('updatedAt').notNull();
      collection.unique(['ownerId', 'itemId'], {
        name: 'uq_feed_item_states_owner_item',
      });
    });

    await builder.createCollection('feedRuns', (collection) => {
      collection.increments('id');
      collection.string('ownerId', { length: 64 }).notNull();
      collection.integer('sourceId').nullable();
      collection.integer('itemId').nullable();
      collection.string('stage', { length: 16 }).notNull();
      collection.string('trigger', { length: 16 }).notNull();
      collection.string('status', { length: 24 }).notNull();
      collection.string('scope', { length: 300 }).nullable();
      collection.integer('found').notNull().defaultTo(0);
      collection.integer('inserted').notNull().defaultTo(0);
      collection.integer('analyzed').notNull().defaultTo(0);
      collection.text('coverage').nullable();
      collection.text('error').nullable();
      collection.datetimeTz('startedAt').notNull();
      collection.datetimeTz('finishedAt').nullable();
      collection.index(['ownerId', 'startedAt'], {
        name: 'ix_feed_runs_owner_started',
      });
    });
  },

  async down({ builder }) {
    await builder.dropCollection('feedRuns');
    await builder.dropCollection('feedItemStates');
    await builder.dropCollection('feedAnalyses');
    await builder.dropCollection('feedItems');
    await builder.dropCollection('feedSources');
    await builder.dropCollection('feedTopics');
    await builder.dropCollection('feedProfiles');
  },
});

export default migration;
