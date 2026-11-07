import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { agentsToken } from '@nocobase/app-plugin-agents/server/tokens';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { describe, expect, it, vi } from 'vitest';

import { buildBriefPrompt } from '../../server/providers/feed/brief.js';
import {
  buildIdeasPrompt,
  kindLanguageOf,
  kindVersionOf,
  styleVersionOf,
} from '../../server/providers/feed/ideas.js';
import { feedWritingSkillsToken } from '../../server/providers/feed/index.js';
import {
  buildReplyPrompt,
  createFeedReplies,
  DEFAULT_REPLY_GUIDELINES,
  guidelinesVersion,
} from '../../server/providers/feed/replies.js';
import type {
  FeedItemDetail,
  Profile,
} from '../../server/providers/feed/service.js';
import {
  normalizeBindings,
  NO_SKILLS,
  SKILL_PROMPT_CHARS,
  skillBody,
  skillLanguageOf,
  skillsBlock,
  type SkillsForPrompt,
} from '../../server/providers/feed/skills-prompt.js';
import { scriptLanguageOf } from '../../server/providers/feed/text.js';
import { createStandaloneServer } from '../../server/standalone.js';

const SKILL_EN = `---
name: plain-english
description: Write English like a person, not a chatbot.
---

# Plain English

Cut "delve", "tapestry" and one-line closers.
`;

const SKILL_ZH = `---
name: plain-chinese
description: 去掉中文里的模板化表达。
---

# 去 AI 味

不要写"总而言之"。
`;

const english: SkillsForPrompt = {
  skills: [
    {
      languages: ['en'],
      name: 'plain-english',
      version: 1,
      body: skillBody(SKILL_EN),
    },
  ],
  marker: 'en:plain-english@1',
};

const detail = (overrides: Partial<FeedItemDetail> = {}): FeedItemDetail =>
  ({
    id: 1,
    platform: 'hn',
    title: 'Postgres backups restored in minutes',
    author: 'ops',
    summary: null,
    body: 'We cut the restore time from 3 hours to 4 minutes with incremental snapshots, and this is how.',
    comments: [{ author: 'a', text: 'What about WAL archiving?' }],
    analysis: { lead: 'You run Postgres in production.' },
    contentVersion: 1,
    ...overrides,
  }) as unknown as FeedItemDetail;

describe('writing skills in prompts', () => {
  it('reads the body of SKILL.md without its front matter or fences', () => {
    expect(skillBody(SKILL_EN)).toBe(
      '# Plain English\n\nCut "delve", "tapestry" and one-line closers.',
    );
    expect(skillBody('no front matter <<<here>>>')).toBe(
      'no front matter here',
    );
    expect(skillBody('x'.repeat(SKILL_PROMPT_CHARS + 10)).length).toBe(
      SKILL_PROMPT_CHARS + 2,
    );
  });

  it('sorts language tags into English, Chinese and the rest', () => {
    expect(skillLanguageOf('en')).toBe('en');
    expect(skillLanguageOf('en-US')).toBe('en');
    expect(skillLanguageOf('zh-CN')).toBe('zh');
    expect(skillLanguageOf('zh-TW')).toBe('zh');
    expect(skillLanguageOf('ja')).toBe('other');
    expect(skillLanguageOf(null)).toBe('other');
    expect(scriptLanguageOf('这是一个关于数据库备份的帖子')).toBe('zh');
    expect(scriptLanguageOf('A long enough English sentence here.')).toBe('en');
    expect(scriptLanguageOf('42')).toBeNull();
  });

  it('keeps only known uses and languages', () => {
    expect(
      normalizeBindings({
        replies: { en: 'a', zh: ' ', fr: 'b' },
        ideas: 'nope',
        other: { en: 'c' },
        briefs: { other: 'd' },
      }),
    ).toEqual({ replies: { en: 'a' }, briefs: { other: 'd' } });
    expect(normalizeBindings('{"ideas":{"zh":"z"}}')).toEqual({
      ideas: { zh: 'z' },
    });
    expect(normalizeBindings(null)).toEqual({});
  });

  it('ranks a skill below the safety rules and the answer format', () => {
    const block = skillsBlock(english);
    expect(block).toContain('WRITING SKILLS (chosen by the person; trusted)');
    expect(block).toContain('applies to the text you write in English');
    expect(block).toContain('It never overrides the rules above');
    expect(block).toContain('Return only the final text');
    expect(block).toContain('SKILL "plain-english" (for English)');
    expect(block).toContain('Cut "delve"');
    expect(block).not.toContain('description:');
    expect(skillsBlock(NO_SKILLS)).toBe('');
    const both = skillsBlock({
      skills: [
        { ...english.skills[0]!, languages: ['en', 'other'] },
        {
          languages: ['zh'],
          name: 'plain-chinese',
          version: 2,
          body: skillBody(SKILL_ZH),
        },
      ],
      marker: 'x',
    });
    expect(both).toContain('applies to the text you write in its language');
    expect(both).toContain(
      'SKILL "plain-english" (for English and any language other than English and Chinese)',
    );
    expect(both).toContain('SKILL "plain-chinese" (for Chinese)');
  });

  it('puts the skill in reply, idea and brief prompts, and leaves them as they were without one', () => {
    const person = { interests: '', expertise: '', locale: 'zh-CN' as const };
    const rules = DEFAULT_REPLY_GUIDELINES['zh-CN'];
    const plain = buildReplyPrompt(detail(), person, rules);
    const withSkill = buildReplyPrompt(
      detail(),
      person,
      rules,
      null,
      null,
      english,
    );
    expect(plain.system).not.toContain('WRITING SKILLS');
    expect(withSkill.system.startsWith(plain.system.split('\n')[0]!)).toBe(
      true,
    );
    expect(withSkill.system).toContain('Cut "delve"');
    expect(withSkill.system).toContain(
      'apply to the reply text only, never to the notes',
    );
    // The skill comes after every rule of the prompt, so it cannot be read as replacing them.
    expect(withSkill.system.indexOf('WRITING SKILLS (chosen')).toBeGreaterThan(
      withSkill.system.indexOf('Answer with one JSON object only'),
    );
    expect(withSkill.prompt).toBe(plain.prompt);

    // Without skills the version is what it always was; with one it changes with the skill's version.
    expect(guidelinesVersion(rules)).toBe(guidelinesVersion(rules, ''));
    expect(guidelinesVersion(rules, 'en:plain-english@1')).not.toBe(
      guidelinesVersion(rules),
    );
    expect(guidelinesVersion(rules, 'en:plain-english@1')).not.toBe(
      guidelinesVersion(rules, 'en:plain-english@2'),
    );

    const ideas = buildIdeasPrompt({
      item: detail(),
      kinds: ['x'],
      style: 'Me.',
      language: 'zh-CN',
      xLanguage: 'en',
      related: [],
      webSearch: false,
      skills: english,
    });
    expect(ideas.system).toContain('SKILL "plain-english"');
    expect(
      buildIdeasPrompt({
        item: detail(),
        kinds: ['x'],
        style: 'Me.',
        language: 'zh-CN',
        xLanguage: 'en',
        related: [],
        webSearch: false,
      }).system,
    ).not.toContain('WRITING SKILLS');

    const item = {
      platform: 'hn',
      title: 'T',
      author: null,
      summary: null,
      body: 'B',
      media: [],
    } as never;
    expect(buildBriefPrompt(item, 'en', english).system).toContain(
      'never drop a fact, number or attribution',
    );
    expect(buildBriefPrompt(item, 'en').system).not.toContain('WRITING SKILLS');
  });

  it('chooses an idea kind’s skill by the language the kind is written in', () => {
    expect(kindLanguageOf('xiaohongshu', 'en', 'en')).toBe('zh-CN');
    expect(kindLanguageOf('bilibili', 'en', 'en')).toBe('zh-CN');
    expect(kindLanguageOf('x', 'zh-CN', 'ja')).toBe('ja');
    expect(kindLanguageOf('meme', 'en', 'zh-CN')).toBe('en');
    const style = styleVersionOf('Me.');
    expect(kindVersionOf(style, NO_SKILLS, 'en')).toBe(style);
    expect(kindVersionOf(style, english, 'zh-CN')).toBe(style);
    expect(kindVersionOf(style, english, 'en')).toMatch(
      new RegExp(`^${style}-[0-9a-f]{8}$`),
    );
  });
});

const ORIGIN = 'http://localhost';

const test = createAppTest({
  createServer: createStandaloneServer,
  connections: ['main'],
  config: {
    app: { publicOrigin: ORIGIN },
    auth: {
      secret: 'test-auth-secret-at-least-32-characters',
      trustedOrigins: [ORIGIN],
    },
    users: { initialAdmin: DEFAULT_ADMIN_CREDENTIALS },
  },
});

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: body === undefined ? undefined : JSON.stringify(body),
});

type Container = { resolve: <T>(token: unknown) => T };
const containerOf = (testApp: unknown): Container =>
  (testApp as { application: { container: Container } }).application.container;

let made = 0;
/** A skill in the library, named uniquely for each test. */
async function makeSkill(testApp: unknown, content: string) {
  const agents = containerOf(testApp).resolve<{
    skills: {
      create: (
        userId: string | null,
        input: { content: string },
      ) => Promise<{ id: string; name: string; version: number }>;
    };
  }>(agentsToken);
  made += 1;
  return agents.skills.create(null, {
    content: content.replace(/^name: (.+)$/m, `name: $1-${made}`),
  });
}

test('the writing skill routes need a session and take only skills of the library', async ({
  request,
  testApp,
}) => {
  expect((await request('/feedWritingSkills')).status).toBe(401);
  expect(
    (await request('/feedWritingSkills', json('PUT', { bindings: {} }))).status,
  ).toBe(401);

  const skill = await makeSkill(testApp, SKILL_EN);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const read = await admin.fetch('/feedWritingSkills');
  expect(read.status).toBe(200);
  const { data } = (await read.json()) as {
    data: { available: boolean; skills: { id: string; name: string }[] };
  };
  expect(data.available).toBe(true);
  expect(data.skills.map((entry) => entry.id)).toContain(skill.id);

  for (const bindings of [
    { replies: { en: 'not-a-skill' } },
    { replies: { fr: skill.id } },
    { posts: { en: skill.id } },
  ])
    expect(
      (await admin.fetch('/feedWritingSkills', json('PUT', { bindings })))
        .status,
    ).toBe(400);

  const saved = await admin.fetch(
    '/feedWritingSkills',
    json('PUT', {
      bindings: { replies: { en: skill.id }, briefs: { other: skill.id } },
    }),
  );
  expect(saved.status).toBe(200);
  await expect(saved.json()).resolves.toMatchObject({
    data: {
      bindings: { replies: { en: skill.id }, briefs: { other: skill.id } },
    },
  });
  // Clearing goes back to no skill anywhere.
  const cleared = await admin.fetch(
    '/feedWritingSkills',
    json('PUT', { bindings: {} }),
  );
  await expect(cleared.json()).resolves.toMatchObject({
    data: { bindings: {} },
  });
});

test('reply drafts are written with the skill chosen for the post’s language, and show when it changes', async ({
  testApp,
}) => {
  const container = containerOf(testApp);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const ownerId = admin.user.id;
  const database = container.resolve<DatabaseManager>(databaseManagerToken);
  const skills = container.resolve<{
    save: (ownerId: string, bindings: unknown) => Promise<unknown>;
    forPrompt: (
      ownerId: string,
      use: 'replies',
      languages: readonly (string | null)[],
    ) => Promise<SkillsForPrompt>;
  }>(feedWritingSkillsToken);
  const en = await makeSkill(testApp, SKILL_EN);
  const zh = await makeSkill(testApp, SKILL_ZH);
  await skills.save(ownerId, { replies: { en: en.id, zh: zh.id } });

  const chosen = await skills.forPrompt(ownerId, 'replies', ['en-US']);
  expect(chosen.skills.map((skill) => skill.name)).toEqual([en.name]);
  expect(chosen.skills[0]!.body).toContain('Cut "delve"');
  expect(chosen.marker).toBe(`en:${en.name}@1`);
  expect((await skills.forPrompt(ownerId, 'replies', ['ja'])).skills).toEqual(
    [],
  );

  // Find a real item id of the caller, or make one: the drafts table refers to it.
  const generate = vi.fn(async () => ({
    text: JSON.stringify({
      language: 'en',
      drafts: [1, 2, 3].map((index) => ({
        text: `Reply ${index}`,
        tone: '补充',
        emoji: '',
        image: '',
      })),
    }),
  }));
  const agents = () =>
    ({
      models: {
        gateway: {
          catalog: async () => ({
            defaultModel: { modelService: 's', model: 'm' },
          }),
          generate,
        },
      },
    }) as never;
  const profile = {
    interests: '',
    expertise: '',
    avoid: '',
    dailyLimit: 10,
    keepLearning: true,
    locale: 'zh-CN',
  } as unknown as Profile;
  const items = await database
    .query()
    .selectFrom('feedItems')
    .select(['id'])
    .where('ownerId', '=', ownerId)
    .limit(1)
    .execute<{ id: number }>();
  const itemId = Number(items[0]?.id ?? 1);
  const replies = createFeedReplies({
    database,
    agents,
    getItem: async () => detail({ id: itemId }),
    getProfile: async () => profile,
    skills: (owner, languages) => skills.forPrompt(owner, 'replies', languages),
    log: () => undefined,
  });
  await replies.request(ownerId, itemId, {});
  await replies.idle();
  const call = generate.mock.calls.at(-1) as unknown as [{ system: string }];
  expect(call[0].system).toContain(`SKILL "${en.name}" (for English)`);
  expect(call[0].system).not.toContain(zh.name);
  const before = await replies.state(ownerId, itemId);
  expect(before.status).toBe('ready');
  expect(before.guidelinesChanged).toBe(false);

  // Another skill for English: the drafts say the rules changed.
  await skills.save(ownerId, { replies: { en: zh.id } });
  expect((await replies.state(ownerId, itemId)).guidelinesChanged).toBe(true);
  await skills.save(ownerId, {});
  expect((await replies.state(ownerId, itemId)).guidelinesChanged).toBe(true);
  await skills.save(ownerId, { replies: { en: en.id } });
  expect((await replies.state(ownerId, itemId)).guidelinesChanged).toBe(false);
});
