import type { Agents } from '@nocobase/app-plugin-agents/server/tokens';
import type { DatabaseManager } from '@nocobase/db';

import type { Profile } from './service.js';
import { FeedError } from './service.js';
import {
  NO_SKILLS,
  normalizeBindings,
  type ResolvedSkill,
  SKILL_LANGUAGES,
  SKILL_USES,
  type SkillLanguage,
  skillBody,
  skillLanguageOf,
  type SkillsForPrompt,
  type SkillUse,
  type WritingSkillBindings,
  type WritingSkillOption,
  type WritingSkillSettings,
} from './skills-prompt.js';

export * from './skills-prompt.js';

/**
 * Writing skills: Agent Skills (`SKILL.md`) from the Agents plugin's skill library that a person picks, per kind of
 * writing and per language of the text, to shape what the model writes for them — for example `humanizer` for English
 * reply drafts and `humanizer-zh` for Chinese ones.
 *
 * The library itself (import, edit, versions) is the plugin's: System settings → Skills. NocoFeed only keeps which
 * skill a person uses where (`feedProfiles.writingSkills`) and, when it writes, puts the chosen skills' `SKILL.md`
 * bodies into the prompt as trusted writing rules. The calls are single model calls (`models.gateway.generate`), so a
 * skill is followed as guidance for the text being written: nothing is run, no tool is used, and files a skill keeps
 * beside `SKILL.md` are not read.
 */

type Row = Record<string, unknown>;

export interface WritingSkillsDeps {
  database: DatabaseManager;
  agents: () => Agents | undefined;
  getProfile: (ownerId: string) => Promise<Profile>;
  log: (
    level: 'info' | 'warn' | 'error',
    message: string,
    context?: Row,
  ) => void;
}

export type WritingSkills = ReturnType<typeof createWritingSkills>;

export function createWritingSkills(deps: WritingSkillsDeps) {
  const repo = () => deps.database.repository('feedProfiles');
  /** `SKILL.md` bodies by `id@version`, so a generation does not read the library twice for one version. */
  const bodies = new Map<string, { name: string; body: string }>();

  async function bindings(ownerId: string): Promise<WritingSkillBindings> {
    const row = (await repo().findOne({ filter: { ownerId } })) as Row | null;
    return normalizeBindings(row?.writingSkills);
  }

  async function options(): Promise<WritingSkillOption[]> {
    const agents = deps.agents();
    if (!agents) return [];
    const skills = await agents.skills.list();
    return skills
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        version: skill.version,
        size: skill.size,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function settings(ownerId: string): Promise<WritingSkillSettings> {
    const [bound, skills] = await Promise.all([bindings(ownerId), options()]);
    // A skill deleted from the library is shown as not chosen.
    const known = new Set(skills.map((skill) => skill.id));
    const visible: WritingSkillBindings = {};
    for (const use of SKILL_USES) {
      const entry = Object.fromEntries(
        Object.entries(bound[use] ?? {}).filter(([, id]) => known.has(id)),
      );
      if (Object.keys(entry).length) visible[use] = entry;
    }
    return {
      bindings: visible,
      skills,
      available: Boolean(deps.agents()),
    };
  }

  /** Saves which skill is used where; unknown ids are refused. */
  async function save(
    ownerId: string,
    input: WritingSkillBindings,
  ): Promise<WritingSkillSettings> {
    const next = normalizeBindings(input);
    const ids = new Set(
      Object.values(next).flatMap((entry) => Object.values(entry ?? {})),
    );
    if (ids.size) {
      const known = new Set((await options()).map((skill) => skill.id));
      if ([...ids].some((id) => !known.has(id)))
        throw new FeedError('invalid', 'writingSkillMissing');
    }
    const profile = await deps.getProfile(ownerId);
    const values = {
      writingSkills: Object.keys(next).length ? next : null,
      updatedAt: new Date(),
    };
    await repo().upsertOne({
      filter: { ownerId },
      create: {
        ownerId,
        dailyLimit: profile.dailyLimit,
        keepLearning: profile.keepLearning,
        ...values,
      },
      update: values,
    } as never);
    return settings(ownerId);
  }

  async function load(
    id: string,
  ): Promise<{ name: string; version: number; body: string } | null> {
    const agents = deps.agents();
    if (!agents) return null;
    try {
      const detail = await agents.skills.get(id);
      const key = `${id}@${detail.version}`;
      let cached = bodies.get(key);
      if (!cached) {
        cached = { name: detail.name, body: skillBody(detail.content) };
        bodies.set(key, cached);
        if (bodies.size > 64) bodies.delete(bodies.keys().next().value!);
      }
      return { ...cached, version: detail.version };
    } catch (error) {
      // Deleted from the library, or the library cannot be read: write without it.
      deps.log('info', 'writing skill could not be read', {
        skillId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * The skills a person chose for `use` and the languages of the text about to be written (language tags, any number;
   * one skill per bucket). Never throws: a skill that cannot be read is left out.
   */
  async function forPrompt(
    ownerId: string,
    use: SkillUse,
    languages: readonly (string | null | undefined)[],
  ): Promise<SkillsForPrompt> {
    if (!deps.agents()) return NO_SKILLS;
    let entry: Partial<Record<SkillLanguage, string>> | undefined;
    try {
      entry = (await bindings(ownerId))[use];
    } catch {
      return NO_SKILLS;
    }
    if (!entry) return NO_SKILLS;
    const buckets = [...new Set(languages.map(skillLanguageOf))].filter(
      (bucket) => entry[bucket],
    );
    const skills: ResolvedSkill[] = [];
    const byId = new Map<string, ResolvedSkill>();
    for (const bucket of SKILL_LANGUAGES) {
      if (!buckets.includes(bucket)) continue;
      const id = entry[bucket]!;
      const known = byId.get(id);
      // One skill chosen for two languages goes in once, for both.
      if (known) {
        known.languages.push(bucket);
        continue;
      }
      const loaded = await load(id);
      if (!loaded || !loaded.body) continue;
      const skill = { languages: [bucket], ...loaded };
      byId.set(id, skill);
      skills.push(skill);
    }
    return {
      skills,
      marker: skills
        .map(
          (skill) =>
            `${skill.languages.join('+')}:${skill.name}@${skill.version}`,
        )
        .join(','),
    };
  }

  return { settings, save, forPrompt, bindings };
}
