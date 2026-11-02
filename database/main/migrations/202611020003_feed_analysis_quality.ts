import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * Separates "does this concern the person" from "is it worth their attention":
 *
 * - `quality`        what the content is worth on its own, 0-100; null when no model judged it
 * - `qualityDetail`  the content type, the four axes and the kind of noise behind `quality`
 * - `priority`       what the feed sorts by: relevance weighed by quality
 * - `gate`           why the full analysis did not run: `prefilter` or `awaitingMaterial`
 *
 * Existing rows have no quality, so their priority is their score at the neutral quality of 50.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611020003_feed_analysis_quality',

  async up({ builder, query }) {
    await builder.alterCollection('feedAnalyses', (collection) => {
      collection.integer('quality').nullable();
      collection.json('qualityDetail').nullable();
      collection.integer('priority').notNull().defaultTo(0);
      collection.string('gate', { length: 24 }).nullable();
    });
    const rows = await query
      .selectFrom('feedAnalyses')
      .select(['id', 'score'])
      .execute();
    for (const row of rows as { id: number; score: number }[]) {
      await query
        .updateTable('feedAnalyses')
        .set({ priority: Math.round(Number(row.score) * 0.75) })
        .where('id', '=', row.id)
        .execute();
    }
  },

  async down({ builder }) {
    await builder.alterCollection('feedAnalyses', (collection) => {
      collection.dropFields('quality', 'qualityDetail', 'priority', 'gate');
    });
  },
});

export default migration;
