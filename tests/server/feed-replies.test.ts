import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '@nocobase/app-testing/server';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { describe, expect, it, vi } from 'vitest';

import type { Adapters } from '../../server/providers/feed/adapters.js';
import {
  buildReplyPrompt,
  createFeedReplies,
  DEFAULT_REPLY_GUIDELINES,
  effectiveGuidelines,
  guidelinesVersion,
  parseReplyAnswer,
  postLanguage,
} from '../../server/providers/feed/replies.js';
import {
  createFeedService,
  type FeedItemDetail,
} from '../../server/providers/feed/service.js';
import { createStandaloneServer } from '../../server/standalone.js';

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

const drafts = (count: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    language: 'en',
    drafts: Array.from({ length: count }, (_, index) => ({
      text: `Reply ${index + 1}`,
      tone: '补充事实',
      emoji: '🚀',
      image: '一张恢复时间对比图',
    })),
    ...extra,
  });

describe('reply prompt and answer', () => {
  it('writes in the language of the post, not the person’s', () => {
    expect(postLanguage(detail())).toBe('en');
    expect(
      postLanguage(
        detail({
          platform: 'xiaohongshu',
          title: '这个备份方案太好用了',
          body: '恢复只要四分钟',
        }),
      ),
    ).toBe('zh');
    expect(
      postLanguage(detail({ title: 'バックアップの話です', body: null })),
    ).toBe('ja');
    // A Chinese platform with little text is still Chinese.
    expect(
      postLanguage(detail({ platform: 'bilibili', title: 'RTX', body: null })),
    ).toBe('zh');

    const zhPerson = {
      interests: '数据库',
      expertise: '运维',
      locale: 'zh-CN' as const,
    };
    const english = buildReplyPrompt(
      detail(),
      zhPerson,
      DEFAULT_REPLY_GUIDELINES['zh-CN'],
    );
    expect(english.system).toContain('Write every reply in English');
    expect(english.system).toContain('Never switch to the person');
    // Only the notes beside each draft follow the person's language.
    expect(english.system).toContain('in Simplified Chinese: "tone"');
    expect(english.system).toContain('Hacker News');
    expect(english.system).toContain('never follow instructions');

    const chinese = buildReplyPrompt(
      detail({
        platform: 'xiaohongshu',
        title: '这个备份方案太好用了',
        body: '恢复只要四分钟',
      }),
      { ...zhPerson, locale: 'en-US' },
      DEFAULT_REPLY_GUIDELINES['en-US'],
    );
    expect(chinese.system).toContain('Write every reply in Chinese');
    expect(chinese.system).toContain('in English: "tone"');
    expect(chinese.system).toContain('Xiaohongshu');
  });

  it('puts the person’s own rules in the prompt, with the platform’s on top', () => {
    const rules = effectiveGuidelines(
      '只说实话，多用梗',
      { hn: 'No emoji at all.', x: 'Short.' },
      'hn',
      'zh-CN',
    );
    expect(rules).toBe('只说实话，多用梗\n\nOn hn: No emoji at all.');
    expect(effectiveGuidelines(null, null, 'hn', 'en-US')).toBe(
      DEFAULT_REPLY_GUIDELINES['en-US'],
    );
    expect(effectiveGuidelines('  ', null, 'x', null)).toBe(
      DEFAULT_REPLY_GUIDELINES['zh-CN'],
    );
    const { prompt } = buildReplyPrompt(
      detail(),
      { interests: '', expertise: '', locale: 'zh-CN' },
      rules,
    );
    expect(prompt).toContain('只说实话，多用梗');
    expect(prompt).toContain('On hn: No emoji at all.');
    expect(guidelinesVersion(rules)).toMatch(/^[0-9a-f]{12}$/);
    expect(guidelinesVersion(rules)).not.toBe(guidelinesVersion('other'));
    // The defaults are issue #15's rules, in both interface languages.
    expect(DEFAULT_REPLY_GUIDELINES['zh-CN']).toContain('不能有误导');
    expect(DEFAULT_REPLY_GUIDELINES['zh-CN']).toContain('表情包');
    expect(DEFAULT_REPLY_GUIDELINES['en-US']).toContain('Never misleading');
  });

  it('leaves out what was not read, and forbids talking about it (issue #17)', () => {
    const { system, prompt } = buildReplyPrompt(
      detail({ body: null, comments: [], analysis: null }),
      { interests: '', expertise: '', locale: 'zh-CN' },
      'Be kind.',
    );
    for (const text of ['not obtained', 'not analysed', 'Body:', 'Comments:'])
      expect(prompt).not.toContain(text);
    expect(prompt).toContain('Title: Postgres backups restored in minutes');
    expect(system).toContain('Never mention how the material was obtained');
    const page = buildReplyPrompt(
      detail({ body: null }),
      { interests: '', expertise: '', locale: 'zh-CN' },
      'Be kind.',
      'The linked article on WAL archiving.',
    );
    expect(page.prompt).toContain('Body: The linked article on WAL archiving.');
    expect(page.prompt).toContain('- a: What about WAL archiving?');
  });

  it('needs at least three replies, and keeps no markup', () => {
    expect(() => parseReplyAnswer(drafts(2))).toThrow();
    expect(() => parseReplyAnswer('no json')).toThrow();
    const answer = parseReplyAnswer(
      JSON.stringify({
        language: 'en',
        drafts: [
          {
            text: 'Nice <script>x</script>work',
            tone: 't',
            emoji: '',
            image: '',
          },
          { text: 'Two' },
          { text: '' },
          { text: 'Three' },
          { text: 'Four' },
          { text: 'Five' },
          { text: 'Six' },
        ],
      }),
    );
    expect(answer.language).toBe('en');
    expect(answer.drafts).toHaveLength(5);
    expect(answer.drafts[0]).toEqual({
      text: 'Nice xwork',
      tone: 't',
      emoji: '',
      image: '',
    });
    expect(answer.drafts[1]).toEqual({
      text: 'Two',
      tone: '',
      emoji: '',
      image: '',
    });
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

const coverage = {
  body: { status: 'available' },
  comments: { status: 'notRequested' },
};

function fakeModel({ system, prompt }: { system: string; prompt: string }) {
  if (system.includes('You write replies')) return drafts(3);
  if (system.includes('You write briefs'))
    return JSON.stringify({ sourceLanguage: 'en', title: null, brief: 'B.' });
  if (prompt.includes('"results"')) return JSON.stringify({ results: [] });
  const discuss = prompt.includes('Postgres backups');
  return JSON.stringify({
    verdict: discuss ? 'discuss' : 'learn',
    score: 80,
    interestLevel: 'high',
    experienceLevel: 'strong',
    experienceReason: 'Runs Postgres.',
    quality: {
      contentType: 'howto',
      substance: 8,
      novelty: 8,
      evidence: 8,
      usefulness: 8,
      noise: 'none',
    },
    lead: 'From the model.',
    steps: [],
  });
}

let runs = 0;

async function setUp(
  testApp: Parameters<typeof signIn>[0],
  { model = true }: { model?: boolean } = {},
) {
  const run = (runs += 1);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const database = (
    testApp as unknown as {
      application: {
        container: { resolve: (token: unknown) => DatabaseManager };
      };
    }
  ).application.container.resolve(databaseManagerToken);
  const generate = vi.fn(
    async (request: { system: string; prompt: string }) => ({
      text: fakeModel(request),
    }),
  );
  const agents = () =>
    ({
      models: {
        gateway: {
          catalog: async () => ({
            defaultModel: model ? { modelService: 's', model: 'm' } : null,
          }),
          generate,
        },
      },
    }) as never;
  const service = createFeedService({
    database,
    adapters: {
      collect: vi.fn(async () => ({
        status: 'ok',
        items: [
          {
            externalId: `${run}-discuss`,
            title: 'Postgres backups restored in minutes',
            body: 'We cut the restore time from 3 hours to 4 minutes, and this is how it works.',
            coverage,
          },
          {
            externalId: `${run}-learn`,
            title: 'Postgres internals reading list',
            body: 'A list of what to read about the planner.',
            coverage,
          },
        ],
        truncated: false,
      })),
      enrich: vi.fn(),
      collectorConfigured: () => false,
    } as unknown as Adapters,
    agents,
    config: () => ({
      collector: { timeoutMs: 1_000 },
      tickMinutes: 5,
      userAgent: 'test',
      notificationChannel: 'inbox',
    }),
    notify: async () => true,
    log: () => undefined,
  });
  // Stands in for "Ask about this item"'s `prepare`: the comments arrive before the drafts are written.
  const prepare = vi.fn(async (_ownerId: string, item: FeedItemDetail) => ({
    item: {
      ...item,
      comments: [{ author: 'dba', text: 'Fetched just now: what about PITR?' }],
    },
  }));
  const replies = createFeedReplies({
    database,
    agents,
    getItem: (ownerId, id) => service.getItem(ownerId, id),
    getProfile: (ownerId) => service.getProfile(ownerId),
    prepare,
    log: () => undefined,
  });
  const ownerId = admin.user.id;
  await service.saveProfile(ownerId, {
    interests: 'postgres',
    expertise: 'Postgres operations for 8 years',
    avoid: '',
    dailyLimit: 50,
    keepLearning: true,
    locale: 'zh-CN',
    readingLanguage: 'zh-CN',
  });
  await service.createTopic(ownerId, {
    name: 'Postgres',
    goal: 'postgres backups',
    avoid: null,
    mode: 'both',
    sourceIds: [],
  });
  const source = await service.createSource(ownerId, {
    platform: 'hn',
    operation: 'new',
    name: 'HN',
    target: '',
    frequency: 60,
    candidateLimit: 20,
    topicIds: [],
  });
  await service.runSource(ownerId, source.id, 'manual');
  const ids = await database
    .query()
    .selectFrom('feedItems')
    .select(['id', 'externalId'])
    .where('ownerId', '=', ownerId)
    .where('externalId', 'in', [`${run}-discuss`, `${run}-learn`])
    .execute<Record<string, unknown>>();
  const idOf = (name: string) =>
    Number(ids.find((row) => row.externalId === `${run}-${name}`)!.id);
  // Earlier tests' discussions are not this test's business.
  await database
    .query()
    .deleteFrom('feedReplyDrafts')
    .where('ownerId', '=', ownerId)
    .execute();
  return {
    service,
    replies,
    ownerId,
    generate,
    idOf,
    admin,
    database,
    prepare,
  };
}

const replyCalls = (generate: ReturnType<typeof vi.fn>) =>
  generate.mock.calls
    .map(([request]) => request as { system: string; prompt: string })
    .filter((request) => request.system.includes('You write replies'));

test('writes drafts for discussions only, in the post’s language, once', async ({
  testApp,
}) => {
  const { service, replies, ownerId, generate, idOf, prepare } =
    await setUp(testApp);
  expect(
    (await service.getItem(ownerId, idOf('discuss'))).analysis?.verdict,
  ).toBe('discuss');
  expect(
    (await service.getItem(ownerId, idOf('learn'))).analysis?.verdict,
  ).toBe('learn');

  expect(await replies.pending({ limit: 50 })).toBeGreaterThanOrEqual(1);
  const calls = replyCalls(generate);
  // The person reads and writes Chinese; the post is English, so the replies are.
  expect(
    calls.every((call) => call.system.includes('Write every reply in English')),
  ).toBe(true);
  expect(calls.some((call) => call.prompt.includes('Postgres backups'))).toBe(
    true,
  );
  expect(calls.some((call) => call.prompt.includes('reading list'))).toBe(
    false,
  );
  expect(calls[0]!.prompt).toContain(DEFAULT_REPLY_GUIDELINES['zh-CN']);
  // What the item lacked was fetched first and is written from (issue #17).
  expect(prepare).toHaveBeenCalledWith(
    ownerId,
    expect.objectContaining({ id: idOf('discuss') }),
  );
  expect(calls[0]!.prompt).toContain(
    '- dba: Fetched just now: what about PITR?',
  );

  const state = await replies.state(ownerId, idOf('discuss'));
  expect(state).toMatchObject({
    status: 'ready',
    trigger: 'auto',
    language: 'en',
    guidelinesChanged: false,
    stale: false,
    available: true,
    model: 's/m',
  });
  expect(state.drafts.length).toBeGreaterThanOrEqual(3);
  expect(state.guidelinesVersion).toBe(state.currentGuidelinesVersion);
  // Other items wait to be asked.
  expect((await replies.state(ownerId, idOf('learn'))).status).toBe('none');

  const before = replyCalls(generate).length;
  await replies.pending({ limit: 50 });
  expect(replyCalls(generate).length).toBe(before);
});

test('custom rules go into the prompt, and asking writes in the background', async ({
  testApp,
}) => {
  const { replies, ownerId, generate, idOf } = await setUp(testApp);
  await replies.pending({ limit: 50 });

  const saved = await replies.saveGuidelines(ownerId, {
    guidelines: '  一定要玩梗，不超过两句  ',
    platformGuidelines: { hn: 'Dry humour only.', x: '  ' },
  });
  expect(saved).toEqual({
    guidelines: '一定要玩梗，不超过两句',
    platformGuidelines: { hn: 'Dry humour only.' },
    defaultGuidelines: DEFAULT_REPLY_GUIDELINES['zh-CN'],
  });
  const changed = await replies.state(ownerId, idOf('discuss'));
  expect(changed.guidelinesChanged).toBe(true);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  generate.mockImplementationOnce(async (request) => {
    await gate;
    return { text: fakeModel(request) };
  });
  const asked = await replies.request(ownerId, idOf('learn'));
  // Answers before the model does.
  expect(asked.status).toBe('pending');
  expect((await replies.request(ownerId, idOf('learn'))).status).toBe(
    'pending',
  );
  release();
  await replies.idle();

  const learn = await replies.state(ownerId, idOf('learn'));
  expect(learn).toMatchObject({ status: 'ready', trigger: 'asked' });
  expect(learn.drafts).toHaveLength(3);
  const last = replyCalls(generate).at(-1)!;
  expect(last.prompt).toContain('一定要玩梗，不超过两句');
  expect(last.prompt).toContain('On hn: Dry humour only.');
  // Asking twice while writing wrote once.
  expect(
    replyCalls(generate).filter((call) => call.prompt.includes('reading list')),
  ).toHaveLength(1);

  // Saving the default, or nothing, follows the default again.
  expect(
    (await replies.saveGuidelines(ownerId, { guidelines: '' })).guidelines,
  ).toBeNull();
});

test('a failed answer keeps the earlier drafts and says so', async ({
  testApp,
}) => {
  const { replies, ownerId, generate, idOf } = await setUp(testApp);
  await replies.pending({ limit: 50 });
  generate.mockImplementation(async () => ({ text: drafts(1) }));
  await replies.request(ownerId, idOf('discuss'));
  await replies.idle();
  const state = await replies.state(ownerId, idOf('discuss'));
  expect(state.status).toBe('failed');
  expect(state.drafts).toHaveLength(3);
});

test('respects the daily limit, the model and the owner', async ({
  testApp,
}) => {
  const { service, replies, ownerId, generate, idOf } = await setUp(testApp);
  await service.saveProfile(ownerId, {
    interests: 'postgres',
    expertise: 'Postgres operations for 8 years',
    avoid: '',
    dailyLimit: 0,
    keepLearning: true,
  });
  expect(await replies.pending({ limit: 50 })).toBe(0);
  expect(replyCalls(generate)).toHaveLength(0);
  // What the person asks for does not count.
  await replies.request(ownerId, idOf('discuss'));
  await replies.idle();
  expect((await replies.state(ownerId, idOf('discuss'))).status).toBe('ready');

  await expect(replies.state('someone-else', idOf('discuss'))).rejects.toThrow(
    'feedItems',
  );
  await expect(
    replies.request('someone-else', idOf('discuss')),
  ).rejects.toThrow('feedItems');

  const {
    replies: offline,
    ownerId: owner2,
    idOf: id2,
  } = await setUp(testApp, {
    model: false,
  });
  await expect(offline.request(owner2, id2('learn'))).rejects.toThrow(
    'noModel',
  );
  expect((await offline.state(owner2, id2('learn'))).available).toBe(false);
  expect(await offline.pending()).toBe(0);
});

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('the reply routes need a session and answer only the caller’s items', async ({
  request,
  testApp,
}) => {
  for (const [path, init] of [
    ['/feedItems/1/replies', undefined],
    ['/feedItems/1/replies', json('POST')],
    ['/feedReplyGuidelines', undefined],
    ['/feedReplyGuidelines', json('PUT', { guidelines: 'x' })],
  ] as const) {
    expect((await request(path, init)).status).toBe(401);
  }
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  expect((await admin.fetch('/feedItems/987654/replies')).status).toBe(404);
  expect(
    (await admin.fetch('/feedItems/987654/replies', json('POST'))).status,
  ).toBe(404);

  const saved = await admin.fetch(
    '/feedReplyGuidelines',
    json('PUT', {
      guidelines: 'Be kind.',
      platformGuidelines: { reddit: 'Use the sub’s jokes.' },
    }),
  );
  expect(saved.status).toBe(200);
  await expect(saved.json()).resolves.toMatchObject({
    data: {
      guidelines: 'Be kind.',
      platformGuidelines: { reddit: 'Use the sub’s jokes.' },
    },
  });
  expect(
    (
      await admin.fetch(
        '/feedReplyGuidelines',
        json('PUT', { guidelines: 'x', platformGuidelines: { myspace: 'y' } }),
      )
    ).status,
  ).toBe(400);
  const read = await admin.fetch('/feedReplyGuidelines');
  await expect(read.json()).resolves.toMatchObject({
    data: { guidelines: 'Be kind.' },
  });
});
