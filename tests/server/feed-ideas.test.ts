import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import {
  agentsToken,
  type Agents,
} from '@nocobase/app-plugin-agents/server/tokens';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildIdeasPrompt,
  createFeedIdeas,
  DEFAULT_IDEA_STYLE,
  IDEA_KINDS,
  ideasSchema,
  normalizeIdea,
  parseIdeasAnswer,
  splitPost,
  styleVersionOf,
  X_POST_LIMIT,
  type BilibiliIdea,
  type IdeaKind,
  type ShortVideoIdea,
  type XIdea,
  type XiaohongshuIdea,
} from '../../server/providers/feed/ideas.js';
import {
  feedIdeasToken,
  feedServiceToken,
  type FeedIdeas,
  type FeedService,
} from '../../server/providers/feed/index.js';
import type { FeedIdeasDeps } from '../../server/providers/feed/ideas.js';
import { createStandaloneServer } from '../../server/standalone.js';

const ORIGIN = 'http://localhost';
const MEMBER = {
  email: 'ideas-member@example.com',
  password: 'member-password-123',
  name: 'Member',
};

const item = {
  platform: 'hn' as const,
  title: 'Postgres backups restored in minutes',
  author: 'ops',
  url: 'https://news.ycombinator.com/item?id=1',
  summary: null,
  body: 'We cut restore time from 3 hours to 4 minutes with incremental snapshots.',
  brief: { brief: 'Restores went from **3 hours** to 4 minutes.' },
  analysis: { lead: 'Useful for anyone running Postgres.' },
};

const longPost = `${'Restores used to take three hours. '.repeat(12)}Now four minutes.`;

/** A full answer for every kind, as a well-behaved model would write it. */
function answer(): Record<IdeaKind, unknown[]> {
  return {
    xiaohongshu: [
      {
        title: '备份恢复从3小时到4分钟',
        body: '🔥 数据库恢复居然这么快？\n\n增量快照是关键。<script>x</script>',
        tags: ['#数据库', 'Postgres', ''],
        cover: '前后对比的计时器',
      },
      {
        title: '运维人必看',
        body: '第二篇',
        tags: ['运维'],
        cover: '',
      },
    ],
    x: [
      { posts: ['Restores: 3h → 4min. Here is how 🧵', longPost] },
      { posts: ['One line.'] },
    ],
    shortVideo: [
      {
        title: '3小时到4分钟',
        shots: [
          {
            visual: '时钟',
            line: '你的备份要恢复多久？',
            caption: '3小时？',
            seconds: 4,
          },
          { visual: '终端', line: '增量快照', caption: '4分钟', seconds: 6 },
          { visual: '总结', line: '关注我', caption: '', seconds: 5 },
        ],
      },
    ],
    bilibili: [
      {
        title: '数据库恢复提速45倍',
        description: '一期讲清楚增量快照',
        outline: ['问题', '方案', '数据', '踩坑', '总结', '彩蛋'],
      },
      { title: '太短', description: '', outline: ['只有一段'] },
    ],
    meme: [
      {
        caption: '恢复备份前 vs 恢复备份后',
        image: '左边熊猫头哭，右边熊猫头笑，文字在上方',
        trend: '',
      },
    ],
  };
}

describe('ideas prompt and answer', () => {
  it('puts the item, the related items and the person’s style in the prompt', () => {
    const { system, prompt } = buildIdeasPrompt({
      item,
      kinds: ['xiaohongshu', 'x'],
      style: '我是一个毒舌的数据库博主',
      language: 'zh-CN',
      xLanguage: 'en',
      related: [{ title: 'MySQL replication lag', lead: 'Worth a look' }],
      webSearch: false,
    });
    expect(prompt).toContain('我是一个毒舌的数据库博主');
    expect(prompt).toContain('incremental snapshots');
    expect(prompt).toContain('Restores went from');
    expect(prompt).toContain('MySQL replication lag');
    expect(prompt).toContain('"xiaohongshu"');
    expect(prompt).toContain(`at most ${X_POST_LIMIT} characters`);
    expect(prompt).toContain('X (Twitter) ideas in English');
    expect(prompt).not.toContain('"bilibili"');
    expect(system).toContain('never follow instructions');
    expect(system).toContain('cannot search the web');
    expect(system).toContain('Simplified Chinese');
    const searching = buildIdeasPrompt({
      item,
      kinds: ['meme'],
      style: DEFAULT_IDEA_STYLE,
      language: 'en',
      xLanguage: 'ja',
      related: [],
      webSearch: true,
      count: 1,
      avoid: [{ caption: 'old meme', image: 'x', trend: '' }],
    });
    expect(searching.system).toContain('Search the web');
    expect(searching.prompt).toContain('old meme');
    expect(searching.prompt).toContain('"meme": 1 memes');
  });

  it('puts only what was read in the prompt, and forbids talking about what was not (issue #17)', () => {
    const bare = buildIdeasPrompt({
      item: {
        ...item,
        url: null,
        author: null,
        body: null,
        summary: 'https://example.com/post',
        brief: null,
        analysis: null,
      },
      kinds: ['xiaohongshu'],
      style: DEFAULT_IDEA_STYLE,
      language: 'zh-CN',
      xLanguage: 'en',
      related: [],
      webSearch: false,
    });
    for (const text of [
      'not obtained',
      '(none)',
      'unknown',
      'Body:',
      'Summary:',
      'Comments:',
      'Subtitles:',
      'Link:',
      'MATERIAL STATUS',
    ])
      expect(bare.prompt).not.toContain(text);
    expect(bare.system).toContain(
      'Never mention how the material was obtained',
    );
    expect(bare.system).toContain('having only a title');

    const full = buildIdeasPrompt({
      item: {
        ...item,
        body: null,
        comments: [{ author: 'dba', text: 'We do the same with pgBackRest.' }],
        transcript: [{ start: 0, text: 'Today we restore a database.' }],
      },
      pageText: 'The linked page explains WAL archiving.',
      kinds: ['x'],
      style: DEFAULT_IDEA_STYLE,
      language: 'en',
      xLanguage: 'en',
      related: [],
      webSearch: false,
    });
    expect(full.prompt).toContain(
      'Body: The linked page explains WAL archiving.',
    );
    expect(full.prompt).toContain('- dba: We do the same with pgBackRest.');
    expect(full.prompt).toContain('Subtitles: Today we restore a database.');

    // A brief written from a bare title talks about what is missing: it stays out.
    const commentsOnly = buildIdeasPrompt({
      item: {
        ...item,
        body: null,
        brief: { brief: '帖子只抓到了标题。' },
        comments: [{ author: 'dba', text: 'Same here.' }],
      },
      kinds: ['x'],
      style: DEFAULT_IDEA_STYLE,
      language: 'en',
      xLanguage: 'en',
      related: [],
      webSearch: false,
    });
    expect(commentsOnly.prompt).not.toContain('只抓到了标题');
    expect(commentsOnly.prompt).toContain('- dba: Same here.');
  });

  it('keeps every kind in its structure, and X posts within 280 characters', () => {
    const parsed = parseIdeasAnswer(
      `Sure! ${JSON.stringify(answer())}`,
      IDEA_KINDS,
    );
    const note = parsed.xiaohongshu![0] as XiaohongshuIdea;
    expect(note.body).not.toContain('<script>');
    expect(note.tags).toEqual(['数据库', 'Postgres']);
    expect(parsed.xiaohongshu).toHaveLength(2);

    const thread = parsed.x![0] as XIdea;
    expect(thread.posts.length).toBeGreaterThan(2);
    for (const post of thread.posts)
      expect(Array.from(post).length).toBeLessThanOrEqual(X_POST_LIMIT);
    expect(thread.posts.join(' ')).toContain('Now four minutes.');

    const script = parsed.shortVideo![0] as ShortVideoIdea;
    // 15 seconds of shots are stretched to the 30-second minimum.
    expect(script.seconds).toBe(30);
    expect(script.shots.reduce((sum, shot) => sum + shot.seconds, 0)).toBe(30);
    expect(script.shots[0]).toMatchObject({
      visual: '时钟',
      line: '你的备份要恢复多久？',
      caption: '3小时？',
    });

    // Five sections at most; a plan with fewer than three is dropped.
    expect(parsed.bilibili).toHaveLength(1);
    expect((parsed.bilibili![0] as BilibiliIdea).outline).toHaveLength(5);
    expect(parsed.meme).toHaveLength(1);

    expect(parseIdeasAnswer({ x: [] }, ['x', 'meme'])).toEqual({});
    expect(() => parseIdeasAnswer('no json', ['x'])).toThrow();
  });

  it('shortens long scripts and refuses ideas without what the kind needs', () => {
    const long = normalizeIdea('shortVideo', {
      title: 't',
      shots: Array.from({ length: 6 }, () => ({
        visual: 'v',
        line: 'l',
        caption: 'c',
        seconds: 20,
      })),
    }) as ShortVideoIdea;
    expect(long.seconds).toBe(60);
    expect(normalizeIdea('xiaohongshu', { title: 'only' })).toBeNull();
    expect(normalizeIdea('meme', { caption: 'no picture' })).toBeNull();
    expect(normalizeIdea('x', { posts: ['  '] })).toBeNull();
  });

  it('splits at sentence ends', () => {
    const posts = splitPost(`${'a'.repeat(200)}. ${'b'.repeat(200)}.`);
    expect(posts).toEqual([`${'a'.repeat(200)}.`, `${'b'.repeat(200)}.`]);
    expect(splitPost('短。'.repeat(200)).every((p) => p.length <= 280)).toBe(
      true,
    );
  });

  it('describes the result as a strict JSON Schema', () => {
    const schema = ideasSchema(['x', 'meme']) as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(['x', 'meme']);
    expect(schema.additionalProperties).toBe(false);
    expect(styleVersionOf(' a ')).toBe(styleVersionOf('a'));
    expect(styleVersionOf('a')).not.toBe(styleVersionOf('b'));
  });
});

/** An OpenAI-compatible stand-in that answers every idea prompt with `answer()`. */
const prompts: string[] = [];
let modelServer: Server;
let modelUrl = '';

beforeAll(async () => {
  modelServer = createServer((request, response) => {
    let body = '';
    request.on('data', (part: Buffer) => (body += part.toString()));
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}') as {
        stream?: boolean;
        messages?: { content: unknown }[];
      };
      prompts.push(JSON.stringify(parsed.messages ?? []));
      const content = JSON.stringify(answer());
      if (parsed.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: unknown, finish: string | null = null) =>
          `data: ${JSON.stringify({
            id: 'x',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'fake-chat',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        response.write(chunk({ role: 'assistant', content }));
        response.write(chunk({}, 'stop'));
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'fake-chat',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    modelServer.listen(0, '127.0.0.1', resolve),
  );
  modelUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise((resolve) => modelServer.close(resolve));
});

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

type TestApp = Parameters<typeof signIn>[0];

function containerOf(testApp: TestApp) {
  return (
    testApp as unknown as {
      application: { container: { resolve: <T>(token: unknown) => T } };
    }
  ).application.container;
}

async function createItem(
  database: DatabaseManager,
  ownerId: string,
  title = 'Postgres backups restored in minutes',
): Promise<number> {
  const now = new Date();
  const { record } = (await database.repository('feedItems').createOne({
    values: {
      ownerId,
      platform: 'hn',
      externalId: `ideas-${Date.now()}-${Math.random()}`,
      title,
      body: 'We cut restore time from 3 hours to 4 minutes with incremental snapshots.',
      url: 'https://news.ycombinator.com/item?id=1',
      // Comments counted as read, so generating does not go out to fetch them first.
      coverage: {
        body: { status: 'available' },
        comments: { status: 'available' },
      },
      contentVersion: 1,
      fetchedAt: now,
      timelineAt: now,
      createdAt: now,
    },
  } as never)) as { record: { id: number } };
  return Number(record.id);
}

async function setUp(testApp: TestApp, options: { model?: boolean } = {}) {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const container = containerOf(testApp);
  const database = container.resolve<DatabaseManager>(databaseManagerToken);
  const agents = container.resolve<Agents>(agentsToken);
  const ideas = container.resolve<FeedIdeas>(feedIdeasToken);
  const feed = container.resolve<FeedService>(feedServiceToken);
  for (const service of await agents.models.services.list())
    await agents.models.services.remove(service.name);
  if (options.model !== false) {
    const service = await agents.models.services.create({
      title: 'Test models',
      provider: 'openai-compatible',
      baseUrl: modelUrl,
      apiKey: null,
      models: [{ value: 'fake-chat', kind: 'chat' }],
    });
    await agents.models.services.setDefaultChat(
      { modelService: service.name, model: 'fake-chat' },
      null,
    );
  }
  // The database lives as long as the file: every test starts from no settings.
  await database
    .query()
    .deleteFrom('feedIdeaSettings')
    .where('ownerId', '=', admin.user.id)
    .execute();
  const itemId = await createItem(database, admin.user.id);
  return { admin, database, agents, ideas, feed, itemId };
}

test('the idea routes need a session', async ({ testApp, request }) => {
  const { itemId } = await setUp(testApp, { model: false });
  for (const [path, init] of [
    [`/feedItems/${itemId}/ideas`, json('GET')],
    [`/feedItems/${itemId}/ideas`, json('POST', {})],
    [`/feedItems/${itemId}/ideas/again`, json('POST', { kind: 'x', index: 0 })],
    [`/feedItems/${itemId}/ideas`, json('DELETE')],
    ['/feedIdeaSettings', json('GET')],
    [
      '/feedIdeaSettings',
      json('PUT', { style: null, kinds: ['x'], auto: false, xLanguage: null }),
    ],
  ] as const) {
    const response = await request(path, init);
    expect({ path, status: response.status }).toEqual({ path, status: 401 });
  }
});

test("another person's item is not found", async ({ testApp }) => {
  const { admin, itemId } = await setUp(testApp);
  const createUser = json('POST', MEMBER);
  const user = await admin.fetch('/users', {
    ...createUser,
    headers: {
      ...(createUser.headers as Record<string, string>),
      'idempotency-key': `${Date.now()}.${crypto.randomUUID()}`,
    },
  });
  expect(user.status).toBe(201);
  const member = await signIn(testApp, {
    email: MEMBER.email,
    password: MEMBER.password,
  });
  for (const [path, init] of [
    [`/feedItems/${itemId}/ideas`, json('GET')],
    [`/feedItems/${itemId}/ideas`, json('POST', {})],
    [`/feedItems/${itemId}/ideas/again`, json('POST', { kind: 'x', index: 0 })],
    [`/feedItems/${itemId}/ideas`, json('DELETE')],
  ] as const) {
    const response = await member.fetch(path, init);
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
  }
});

test('generates in the background, replaces one idea, and deletes', async ({
  testApp,
}) => {
  const { admin, ideas, feed, database, itemId } = await setUp(testApp);
  // A favourite elsewhere is offered as context.
  const other = await createItem(
    database,
    admin.user.id,
    'MySQL replication lag explained',
  );
  await feed.updateState(admin.user.id, other, { favorite: true } as never);
  await admin.fetch(
    '/feedIdeaSettings',
    json('PUT', {
      style: '我是一个毒舌的数据库博主',
      kinds: ['xiaohongshu', 'x', 'shortVideo', 'bilibili', 'meme'],
      auto: false,
      xLanguage: null,
    }),
  );

  const before = await admin.fetch(`/feedItems/${itemId}/ideas`);
  expect(before.status).toBe(200);
  await expect(before.json()).resolves.toMatchObject({
    data: { available: true, webSearch: false, sets: [] },
  });

  prompts.length = 0;
  const started = await admin.fetch(
    `/feedItems/${itemId}/ideas`,
    json('POST', {}),
  );
  expect(started.status).toBe(202);
  const pending = (await started.json()) as {
    data: { sets: { kind: string; status: string }[] };
  };
  expect(pending.data.sets.map((set) => set.status)).toEqual(
    Array(5).fill('pending'),
  );
  // Asking again while it runs is refused.
  expect(
    (await admin.fetch(`/feedItems/${itemId}/ideas`, json('POST', {}))).status,
  ).toBe(409);

  await ideas.settled();
  const ready = (await (
    await admin.fetch(`/feedItems/${itemId}/ideas`)
  ).json()) as {
    data: {
      styleVersion: string;
      sets: {
        kind: string;
        status: string;
        ideas: Record<string, unknown>[];
        stale: boolean;
        styleVersion: string;
        generatedAt: string | null;
        model: string;
      }[];
    };
  };
  expect(ready.data.sets.map((set) => [set.kind, set.status])).toEqual([
    ['xiaohongshu', 'ready'],
    ['x', 'ready'],
    ['shortVideo', 'ready'],
    ['bilibili', 'ready'],
    ['meme', 'ready'],
  ]);
  const x = ready.data.sets.find((set) => set.kind === 'x')!;
  for (const post of (x.ideas[0] as unknown as XIdea).posts)
    expect(Array.from(post).length).toBeLessThanOrEqual(X_POST_LIMIT);
  expect(x.styleVersion).toBe(styleVersionOf('我是一个毒舌的数据库博主'));
  expect(x.generatedAt).not.toBeNull();
  expect(x.model).toMatch(/\/fake-chat$/);
  expect(prompts.join('\n')).toContain('我是一个毒舌的数据库博主');
  expect(prompts.join('\n')).toContain('incremental snapshots');
  expect(prompts.join('\n')).toContain('MySQL replication lag explained');

  // One more idea in place of the second Xiaohongshu note; the first stays.
  const note = ready.data.sets[0]!.ideas;
  const again = await admin.fetch(
    `/feedItems/${itemId}/ideas/again`,
    json('POST', { kind: 'xiaohongshu', index: 1 }),
  );
  expect(again.status).toBe(202);
  await ideas.settled();
  const replaced = await ideas.state(admin.user.id, itemId);
  const notes = replaced.sets[0]!.ideas as XiaohongshuIdea[];
  expect(notes).toHaveLength(2);
  expect(notes[0]).toEqual(note[0]);
  expect(notes[1]!.title).toBe('备份恢复从3小时到4分钟');
  expect(prompts.at(-1)).toContain('Already suggested');
  expect(
    (
      await admin.fetch(
        `/feedItems/${itemId}/ideas/again`,
        json('POST', { kind: 'xiaohongshu', index: 5 }),
      )
    ).status,
  ).toBe(404);

  // A new style marks the ideas stale.
  await admin.fetch(
    '/feedIdeaSettings',
    json('PUT', {
      style: '换个风格',
      kinds: ['x'],
      auto: false,
      xLanguage: 'ja',
    }),
  );
  const stale = await ideas.state(admin.user.id, itemId);
  expect(stale.sets.every((set) => set.stale)).toBe(true);
  expect(stale.kinds).toEqual(['x']);

  const deleted = await admin.fetch(
    `/feedItems/${itemId}/ideas?kind=meme`,
    json('DELETE'),
  );
  await expect(deleted.json()).resolves.toEqual({ data: { deleted: 1 } });
  const all = await admin.fetch(`/feedItems/${itemId}/ideas`, json('DELETE'));
  await expect(all.json()).resolves.toEqual({ data: { deleted: 4 } });
  expect((await ideas.state(admin.user.id, itemId)).sets).toEqual([]);
});

test('without a model nothing is generated', async ({ testApp }) => {
  const { admin, itemId } = await setUp(testApp, { model: false });
  const state = await admin.fetch(`/feedItems/${itemId}/ideas`);
  await expect(state.json()).resolves.toMatchObject({
    data: { available: false, webSearch: false, sets: [] },
  });
  expect(
    (await admin.fetch(`/feedItems/${itemId}/ideas`, json('POST', {}))).status,
  ).toBe(503);
});

test('saves the settings and falls back to the default style', async ({
  testApp,
}) => {
  const { admin } = await setUp(testApp, { model: false });
  const initial = await admin.fetch('/feedIdeaSettings');
  await expect(initial.json()).resolves.toMatchObject({
    data: {
      style: DEFAULT_IDEA_STYLE,
      customized: false,
      kinds: [...IDEA_KINDS],
      auto: false,
      xLanguage: 'en',
    },
  });
  const saved = await admin.fetch(
    '/feedIdeaSettings',
    json('PUT', {
      style: '  我的风格  ',
      kinds: ['meme', 'x'],
      auto: true,
      xLanguage: 'zh-CN',
    }),
  );
  expect(saved.status).toBe(200);
  await expect(saved.json()).resolves.toMatchObject({
    data: {
      style: '我的风格',
      customized: true,
      // Kept in the canonical order.
      kinds: ['x', 'meme'],
      auto: true,
      xLanguage: 'zh-CN',
      styleVersion: styleVersionOf('我的风格'),
    },
  });
  const reset = await admin.fetch(
    '/feedIdeaSettings',
    json('PUT', {
      style: DEFAULT_IDEA_STYLE,
      kinds: ['x'],
      auto: false,
      xLanguage: null,
    }),
  );
  await expect(reset.json()).resolves.toMatchObject({
    data: { style: DEFAULT_IDEA_STYLE, customized: false, xLanguage: 'en' },
  });
  expect(
    (
      await admin.fetch(
        '/feedIdeaSettings',
        json('PUT', { style: null, kinds: [], auto: false, xLanguage: null }),
      )
    ).status,
  ).toBe(400);
});

test('automatic ideas only for people who turned them on, for items worth discussing', async ({
  testApp,
}) => {
  const { admin, ideas, database, itemId } = await setUp(testApp);
  const ownerId = admin.user.id;
  const now = new Date();
  await database.repository('feedAnalyses').createOne({
    values: {
      ownerId,
      itemId,
      current: true,
      verdict: 'discuss',
      score: 80,
      priority: 80,
      interestLevel: 'high',
      experienceLevel: 'some',
      lead: 'Join in',
      steps: [],
      engine: 'model',
      promptVersion: 'test',
      contentVersion: 1,
      createdAt: now,
    },
  } as never);
  await admin.fetch(
    '/feedIdeaSettings',
    json('PUT', { style: null, kinds: ['meme'], auto: false, xLanguage: null }),
  );
  expect(await ideas.ideasPending({ limit: 5 })).toBe(0);

  await admin.fetch(
    '/feedIdeaSettings',
    json('PUT', { style: null, kinds: ['meme'], auto: true, xLanguage: null }),
  );
  expect(await ideas.ideasPending({ limit: 5 })).toBe(1);
  await ideas.settled();
  const state = await ideas.state(ownerId, itemId);
  expect(state.sets).toMatchObject([
    { kind: 'meme', status: 'ready', trigger: 'auto', webSearch: false },
  ]);
  // Done once: the next tick leaves it.
  expect(await ideas.ideasPending({ limit: 5 })).toBe(0);
});

describe('which way to the model', () => {
  const profile = {
    readingLanguage: null,
    locale: 'zh-CN',
    dailyLimit: 20,
  };
  const detail = {
    ...item,
    id: 1,
  };

  function fakeDatabase() {
    const rows = new Map<string, Record<string, unknown>>();
    const key = (filter: Record<string, unknown>) =>
      `${String(filter.itemId)}:${String(filter.kind)}`;
    const empty = {
      selectFrom: () => chain,
    };
    const chain: Record<string, unknown> = {};
    for (const name of [
      'innerJoin',
      'leftJoin',
      'select',
      'where',
      'orderBy',
      'limit',
    ])
      chain[name] = () => chain;
    chain.execute = async () => [];
    return {
      rows,
      database: {
        query: () => empty,
        repository: (name: string) => ({
          findOne: async () =>
            name === 'feedIdeaSettings' ? { style: '人设' } : null,
          findMany: async ({ filter }: { filter: Record<string, unknown> }) =>
            [...rows.values()].filter((row) => row.itemId === filter.itemId),
          upsertOne: async ({
            filter,
            create,
          }: {
            filter: Record<string, unknown>;
            create: Record<string, unknown>;
          }) => {
            rows.set(key(filter), { ...create });
          },
          updateOne: async ({
            filter,
            values,
          }: {
            filter: Record<string, unknown>;
            values: Record<string, unknown>;
          }) => {
            const row = rows.get(key(filter));
            if (row) Object.assign(row, values);
          },
        }),
      } as unknown as DatabaseManager,
    };
  }

  function setUpFake(
    online: { webSearch: boolean; fails?: boolean },
    options: {
      detail?: Record<string, unknown>;
      prepare?: FeedIdeasDeps['prepare'];
    } = {},
  ) {
    const { rows, database } = fakeDatabase();
    const generate = vi.fn(async () => ({ text: JSON.stringify(answer()) }));
    const run = vi.fn(async () => {
      if (online.fails) throw new Error('search refused');
    });
    const background = vi.fn(async () => ({
      sessionId: 's1',
      run,
      get: async () => ({ meme: answer().meme }),
    }));
    const remove = vi.fn(async () => undefined);
    const ideas = createFeedIdeas({
      database,
      agents: () =>
        ({
          models: {
            gateway: {
              catalog: async () => ({
                defaultModel: { modelService: 's', model: 'm' },
              }),
              generate,
            },
            services: {
              capabilities: async () => ({ webSearch: online.webSearch }),
            },
          },
          onlineAgent: { background },
          conversations: { delete: remove },
        }) as never,
      getItem: async () => (options.detail ?? detail) as never,
      getProfile: async () => profile as never,
      prepare: options.prepare,
      log: () => undefined,
    });
    const actor = {
      user: { id: 'u1' },
      authorization: {},
      credentials: {},
    } as never;
    return { ideas, rows, generate, background, run, remove, actor };
  }

  it('searches the web through the online agent when the model can', async () => {
    const fake = setUpFake({ webSearch: true });
    const state = await fake.ideas.request(fake.actor, 'u1', 1, ['meme']);
    expect(state.webSearch).toBe(true);
    await fake.ideas.settled();
    expect(fake.background).toHaveBeenCalledWith(
      fake.actor,
      expect.objectContaining({ webSearch: true, tool: [] }),
    );
    const [messages, schema] = fake.run.mock.calls[0] as unknown as [
      { content: string }[],
      { required: string[] },
    ];
    expect(messages[0]!.content).toContain('人设');
    expect(schema.required).toEqual(['meme']);
    expect(fake.generate).not.toHaveBeenCalled();
    // The helper session is removed once the result is in.
    expect(fake.remove).toHaveBeenCalledWith('u1', 's1');
    expect(fake.rows.get('1:meme')).toMatchObject({
      status: 'ready',
      webSearch: true,
    });
  });

  it('falls back to the model alone when search fails or is not supported', async () => {
    const failing = setUpFake({ webSearch: true, fails: true });
    await failing.ideas.request(failing.actor, 'u1', 1, ['meme']);
    await failing.ideas.settled();
    expect(failing.generate).toHaveBeenCalled();
    expect(failing.rows.get('1:meme')).toMatchObject({
      status: 'ready',
      webSearch: false,
    });

    const plain = setUpFake({ webSearch: false });
    await plain.ideas.request(plain.actor, 'u1', 1, ['x']);
    await plain.ideas.settled();
    expect(plain.background).not.toHaveBeenCalled();
    const [request] = plain.generate.mock.calls[0] as unknown as [
      { system: string },
    ];
    expect(request.system).toContain('cannot search the web');
  });

  it('fetches what the item lacks before writing, and writes from it (issue #17)', async () => {
    const titleOnly = {
      ...detail,
      platform: 'xiaohongshu',
      body: null,
      summary: null,
      brief: null,
      analysis: null,
      comments: [],
      transcript: [],
    };
    const prepare = vi.fn(async (_owner: string, current: unknown) => ({
      item: {
        ...(current as typeof titleOnly),
        body: '搜索排名只是入场券，点击靠标题和描述。',
        comments: [{ author: '读者', text: '标题决定了一半的点击率' }],
      } as never,
    }));
    const fake = setUpFake(
      { webSearch: false },
      { detail: titleOnly, prepare },
    );
    await fake.ideas.request(fake.actor, 'u1', 1, ['xiaohongshu']);
    await fake.ideas.settled();
    expect(prepare).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ id: 1 }),
    );
    const [request] = fake.generate.mock.calls[0] as unknown as [
      { prompt: string },
    ];
    expect(request.prompt).toContain('Body: 搜索排名只是入场券');
    expect(request.prompt).toContain('- 读者: 标题决定了一半的点击率');
    expect(request.prompt).not.toContain('not obtained');
    expect(fake.rows.get('1:xiaohongshu')).toMatchObject({ status: 'ready' });
  });

  it('does not generate from a bare title, even when fetching fails', async () => {
    const titleOnly = {
      ...detail,
      platform: 'xiaohongshu',
      body: null,
      summary: null,
      comments: [],
      transcript: [],
    };
    const prepare = vi.fn(async () => {
      throw new Error('collector down');
    });
    const fake = setUpFake(
      { webSearch: false },
      { detail: titleOnly, prepare },
    );
    await fake.ideas.request(fake.actor, 'u1', 1, ['xiaohongshu']);
    await fake.ideas.settled();
    expect(prepare).toHaveBeenCalled();
    expect(fake.generate).not.toHaveBeenCalled();
    expect(fake.rows.get('1:xiaohongshu')).toMatchObject({
      status: 'failed',
      error: 'thinMaterial',
    });
  });
});
