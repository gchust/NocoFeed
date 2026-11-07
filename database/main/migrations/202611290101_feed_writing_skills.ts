import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * Writing skills: which skill of the Agents plugin's library a person uses for each kind of writing and language.
 *
 * - `feedProfiles.writingSkills`  `{ replies?: { en?, zh?, other? }, ideas?: …, briefs?: … }`, each a skill id
 *                                 (`agSkills.id`); null uses no skill anywhere
 *
 * Existing rows keep null: nobody had chosen a skill.
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611290101_feed_writing_skills',

  async up({ builder }) {
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.json('writingSkills').nullable();
    });
  },

  async down({ builder }) {
    await builder.alterCollection('feedProfiles', (collection) => {
      collection.dropFields('writingSkills');
    });
  },
});

export default migration;
