import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * Whether the person has read an item.
 *
 * - `feedItemStates.readAt`  when the person first opened the item, or marked it read; null (or no state row at all)
 *                            means unread. Marking an item unread clears it.
 *
 * Existing items start unread, except those the person has clearly been through already: an item they saved, joined,
 * gave feedback on, wrote notes on or dismissed is read as of its last change. "Read later" alone stays unread.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611080002_feed_read_state',

  async up({ builder, query }) {
    await builder.alterCollection('feedItemStates', (collection) => {
      collection.datetimeTz('readAt').nullable();
    });
    // The query builder has no column-to-column update, so the rows are copied one by one, in id order.
    let after = 0;
    for (;;) {
      const rows = await query
        .selectFrom('feedItemStates')
        .select(['id', 'updatedAt'])
        .where('id', '>', after)
        .where((eb) =>
          eb.or([
            eb('favorite', '=', true),
            eb('participated', '=', true),
            eb('dismissed', '=', true),
            eb('feedback', 'is not', null),
            eb('notes', 'is not', null),
          ]),
        )
        .orderBy('id', 'asc')
        .limit(500)
        .execute();
      if (!rows.length) break;
      for (const row of rows) {
        await query
          .updateTable('feedItemStates')
          .set({ readAt: row.updatedAt })
          .where('id', '=', row.id)
          .execute();
      }
      after = Number(rows[rows.length - 1].id);
    }
  },

  async down({ builder }) {
    await builder.alterCollection('feedItemStates', (collection) => {
      collection.dropFields('readAt');
    });
  },
});

export default migration;
