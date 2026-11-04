import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * `feedItems.media`: the images and videos of a post in display order, as
 * `[{ type: 'image' | 'video', url, width?, height?, cover?, duration? }]`. They are the platform's own CDN links
 * (https only), shown in the reader's browser and never downloaded or analysed.
 *
 * Existing rows keep null, which reads as "no media"; enriching an item fills it in.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611060001_feed_item_media',

  async up({ builder }) {
    await builder.alterCollection('feedItems', (collection) => {
      collection.json('media').nullable();
    });
  },

  async down({ builder }) {
    await builder.alterCollection('feedItems', (collection) => {
      collection.dropFields('media');
    });
  },
});

export default migration;
