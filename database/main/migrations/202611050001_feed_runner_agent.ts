import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * "Analyze again" can be handed to a runner agent of the Agents plugin instead of the model gateway:
 *
 * - `feedProfiles.readerAgentId`  the runner agent the person hands items to; null keeps the model and the rules
 * - `feedRuns.agentRunId`         the Agents plugin run an `analyze` run waits for; null for every other run
 * - `feedRuns.agentResult`        how that run ended (`{ status, summary, failureReason }`), written when it ends and
 *                                 read once more when the analysis is settled outside the plugin's transaction
 *
 * Existing rows keep null in all three and behave as before.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611050001_feed_runner_agent',

  async up({ builder }) {
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.string('readerAgentId', { length: 200 }).nullable();
    });
    await builder.alterCollection('feedRuns', (collection) => {
      collection.string('agentRunId', { length: 64 }).nullable();
      collection.json('agentResult').nullable();
      collection.index('agentRunId', { name: 'ix_feed_runs_agent_run' });
    });
  },

  async down({ builder }) {
    await builder.alterCollection('feedRuns', (collection) => {
      // Dropping `agentRunId` drops its index with it on every supported database.
      collection.dropFields('agentRunId', 'agentResult');
    });
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.dropFields('readerAgentId');
    });
  },
});

export default migration;
