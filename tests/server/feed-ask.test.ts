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
import { afterAll, beforeAll, expect } from 'vitest';

import { FEED_ITEM_SUBJECT } from '../../server/providers/feed/agent-reader.js';
import {
  ASK_ANSWER_NOTICE,
  ASK_LINK_KIND,
  ASK_QUEUED_NOTICE,
  ASK_THREAD,
  askSystemPrompt,
  fetchableUrl,
} from '../../server/providers/feed/ask.js';
import {
  feedAskToken,
  type FeedAsk,
} from '../../server/providers/feed/index.js';
import { createStandaloneServer } from '../../server/standalone.js';

const ORIGIN = 'http://localhost';
const AGENT_ID = 'nocofeed-test-asker';
const MEMBER = {
  email: 'ask-member@example.com',
  password: 'member-password-123',
  name: 'Member',
};

/**
 * A stand-in for an OpenAI-compatible chat model: the first turn calls `feed_read_item`, the next answers with what
 * the tool returned. Every request body is kept for the assertions.
 */
const requests: { messages: { role: string; content: unknown }[] }[] = [];
let modelServer: Server;
let modelUrl = '';

function chunk(delta: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake-chat',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

beforeAll(async () => {
  modelServer = createServer((request, response) => {
    let body = '';
    request.on('data', (part: Buffer) => (body += part.toString()));
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}') as (typeof requests)[number];
      requests.push(parsed);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const toolResult = parsed.messages?.find(
        (message) => message.role === 'tool',
      );
      if (!toolResult) {
        response.write(chunk({ role: 'assistant', content: '' }));
        response.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call_read',
                type: 'function',
                function: { name: 'feed_read_item', arguments: '{}' },
              },
            ],
          }),
        );
        response.write(chunk({}, 'tool_calls'));
      } else {
        const text = JSON.stringify(toolResult.content);
        const mentions = text.includes('Kubernetes operator')
          ? 'The item explains a Kubernetes operator.'
          : 'The item says nothing.';
        response.write(chunk({ role: 'assistant', content: mentions }));
        response.write(
          chunk({ content: ' See [docs](https://kubernetes.io/docs/).' }),
        );
        response.write(chunk({}, 'stop'));
      }
      response.end('data: [DONE]\n\n');
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

interface AskState {
  conversationId: string | null;
  online: boolean;
  webSearch: boolean;
  runnerAgentId: string | null;
  runnerPending: boolean;
}

type TestApp = Parameters<typeof signIn>[0];

function containerOf(testApp: TestApp) {
  return (
    testApp as unknown as {
      application: { container: { resolve: <T>(token: unknown) => T } };
    }
  ).application.container;
}

async function setUp(
  testApp: TestApp,
  options: { model?: boolean; runner?: boolean } = {},
) {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const container = containerOf(testApp);
  const database = container.resolve<DatabaseManager>(databaseManagerToken);
  const agents = container.resolve<Agents>(agentsToken);
  const ask = container.resolve<FeedAsk>(feedAskToken);
  // The database lives as long as the file: start each test from the model services it asks for.
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
  if (options.runner) {
    await agents.agents.ensureSystem({
      id: AGENT_ID,
      name: 'Test asker',
      description: 'Answers questions about feed items',
      instructions: null,
      actions: [],
      modelEntries: [{ tool: 'claude', model: 'sonnet' }],
    });
  }
  await admin.fetch(
    '/feedProfile',
    json('PUT', {
      interests: 'Platform engineering',
      expertise: 'Ran Kubernetes clusters for years',
      avoid: 'crypto',
      dailyLimit: 0,
      keepLearning: true,
      locale: 'en-US',
      readerAgentId: options.runner ? AGENT_ID : null,
    }),
  );
  const now = new Date();
  const { record } = (await database.repository('feedItems').createOne({
    values: {
      ownerId: admin.user.id,
      platform: 'hn',
      externalId: `ask-${Date.now()}-${Math.random()}`,
      title: 'Show HN: Kopf, a framework for writing operators',
      body: 'We built a Kubernetes operator framework in Python.',
      url: 'https://news.ycombinator.com/item?id=2',
      comments: [
        { author: 'alice', text: 'How does it compare to kubebuilder?' },
      ],
      coverage: {
        body: { status: 'available' },
        comments: { status: 'available' },
      },
      contentVersion: 1,
      fetchedAt: now,
      createdAt: now,
    },
  } as never)) as { record: { id: number } };
  const itemId = Number(record.id);
  const state = async (): Promise<AskState> =>
    (
      (await (await admin.fetch(`/feedItems/${itemId}/ask`)).json()) as {
        data: AskState;
      }
    ).data;
  return { admin, database, agents, ask, itemId, state };
}

test('the ask routes need a session', async ({ testApp, request }) => {
  const { itemId } = await setUp(testApp, { model: false });
  for (const [path, init] of [
    [`/feedItems/${itemId}/ask`, json('GET')],
    [`/feedItems/${itemId}/ask`, json('POST')],
    [`/feedItems/${itemId}/ask`, json('DELETE')],
    [`/feedItems/${itemId}/ask/runner`, json('POST', { question: 'What?' })],
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
    [`/feedItems/${itemId}/ask`, json('GET')],
    [`/feedItems/${itemId}/ask`, json('POST')],
    [`/feedItems/${itemId}/ask`, json('DELETE')],
    [`/feedItems/${itemId}/ask/runner`, json('POST', { question: 'What?' })],
  ] as const) {
    const response = await member.fetch(path, init);
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
  }
});

test('without a model or agent the state says what is missing', async ({
  testApp,
}) => {
  const { admin, itemId, state } = await setUp(testApp, { model: false });
  expect(await state()).toEqual({
    conversationId: null,
    online: false,
    webSearch: false,
    runnerAgentId: null,
    runnerPending: false,
  });
  const opened = await admin.fetch(`/feedItems/${itemId}/ask`, json('POST'));
  expect(opened.status).toBe(503);
  const runner = await admin.fetch(
    `/feedItems/${itemId}/ask/runner`,
    json('POST', { question: 'What is Kopf?' }),
  );
  expect(runner.status).toBe(503);
});

test('the context carries the item, its analysis and the interests', () => {
  const prompt = askSystemPrompt(
    {
      id: 1,
      title: 'Show HN: Kopf',
      platform: 'hn',
      author: 'nolar',
      url: 'https://example.com/kopf',
      publishedAt: '2026-11-01T00:00:00.000Z',
      summary: null,
      body: 'A Kubernetes operator framework.',
      comments: [{ author: 'alice', text: 'Compare with kubebuilder' }],
      transcript: [{ start: 0, text: 'In this video we write an operator' }],
      brief: { brief: 'An operator framework for Python.' },
      analysis: {
        verdict: 'learn',
        score: 80,
        quality: 70,
        lead: 'Try writing an operator in Python.',
        interestLevel: 'high',
        interestReason: 'Platform engineering',
        experienceLevel: 'some',
        experienceReason: 'Ran clusters',
        steps: [{ title: 'Read', detail: 'The handler docs' }],
        evidence: 'The post',
        uncertainty: 'No benchmarks',
      },
    } as never,
    { interests: 'Platform engineering', expertise: 'Kubernetes', avoid: '' },
  );
  expect(prompt).toContain('Title: Show HN: Kopf');
  expect(prompt).toContain('Original link: https://example.com/kopf');
  expect(prompt).toContain('A Kubernetes operator framework.');
  expect(prompt).toContain('In this video we write an operator');
  expect(prompt).toContain('alice: Compare with kubebuilder');
  expect(prompt).toContain('An operator framework for Python.');
  expect(prompt).toContain('Verdict: learn');
  expect(prompt).toContain('Try writing an operator in Python.');
  expect(prompt).toContain('Interests:\nPlatform engineering');
  expect(prompt).toContain('feed_read_item');
});

test('only public addresses are read for the original page', () => {
  expect(fetchableUrl('https://example.com/post')).toBe(true);
  expect(fetchableUrl('http://localhost:3000/')).toBe(false);
  expect(fetchableUrl('http://127.0.0.1/')).toBe(false);
  expect(fetchableUrl('http://10.0.0.8/')).toBe(false);
  expect(fetchableUrl('http://192.168.1.2/')).toBe(false);
  expect(fetchableUrl('http://[::1]/')).toBe(false);
  expect(fetchableUrl('file:///etc/passwd')).toBe(false);
  expect(fetchableUrl('https://user:pw@example.com/')).toBe(false);
});

test('the online agent answers in a conversation tied to the item, kept and cleared', async ({
  testApp,
}) => {
  const { admin, agents, itemId, state } = await setUp(testApp);
  requests.length = 0;
  expect(await state()).toMatchObject({
    conversationId: null,
    online: true,
    // OpenAI-compatible endpoints have no native search.
    webSearch: false,
  });

  const opened = await admin.fetch(`/feedItems/${itemId}/ask`, json('POST'));
  expect(opened.status).toBe(200);
  const { conversationId, created } = (
    (await opened.json()) as {
      data: { conversationId: string; created: boolean };
    }
  ).data;
  expect(created).toBe(true);
  // Opening again answers the same conversation.
  const again = (await (
    await admin.fetch(`/feedItems/${itemId}/ask`, json('POST'))
  ).json()) as { data: { conversationId: string; created: boolean } };
  expect(again.data).toEqual({ conversationId, created: false });
  expect((await state()).conversationId).toBe(conversationId);

  const links = await agents.conversations.links.list(
    admin.user.id,
    conversationId,
  );
  expect(links).toMatchObject([
    { kind: ASK_LINK_KIND, targetId: String(itemId) },
  ]);

  // The plugin's chat transport: one user message in, a UI message stream out.
  const sent = await admin.fetch(
    `/agents/conversations/${conversationId}/messages`,
    json('POST', {
      message: {
        id: 'ask-1',
        role: 'user',
        parts: [{ type: 'text', text: 'What is an operator?' }],
      },
    }),
  );
  expect(sent.status).toBe(200);
  const stream = await sent.text();
  expect(stream).toContain('Kubernetes operator');

  // The model saw the item in its system prompt, and the tool read it through the conversation's link.
  const system = JSON.stringify(requests[0]?.messages[0]);
  expect(system).toContain('Show HN: Kopf, a framework for writing operators');
  expect(system).toContain('Ran Kubernetes clusters for years');
  expect(requests).toHaveLength(2);

  // History is kept: opening the item again reads it.
  let history: { role: string; parts: { type: string; text?: string }[] }[] =
    [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    history = (
      (await (
        await admin.fetch(`/agents/conversations/${conversationId}/messages`)
      ).json()) as { data: typeof history }
    ).data;
    if (history.some((message) => message.role === 'assistant')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(history.map((message) => message.role)).toEqual(['user', 'assistant']);
  expect(
    history[1]!.parts.some((part) => part.text?.includes('kubernetes.io')),
  ).toBe(true);

  // Clearing deletes it; the next question starts afresh.
  const cleared = await admin.fetch(`/feedItems/${itemId}/ask`, json('DELETE'));
  expect(((await cleared.json()) as { data: unknown }).data).toEqual({
    deleted: 1,
  });
  expect((await state()).conversationId).toBeNull();
  const gone = await admin.fetch(`/agents/conversations/${conversationId}`);
  expect(gone.status).toBe(404);
});

test('a question handed to the runner agent is queued and its answer joins the conversation', async ({
  testApp,
}) => {
  const { admin, agents, itemId, state } = await setUp(testApp, {
    runner: true,
  });
  expect((await state()).runnerAgentId).toBe(AGENT_ID);

  const response = await admin.fetch(
    `/feedItems/${itemId}/ask/runner`,
    json('POST', { question: 'How does Kopf compare to kubebuilder?' }),
  );
  expect(response.status).toBe(200);
  const { conversationId, runId } = (
    (await response.json()) as {
      data: { conversationId: string; runId: string };
    }
  ).data;
  const run = await agents.runs.get(runId);
  expect(run).toMatchObject({
    status: 'queued',
    agentId: AGENT_ID,
    threadScope: ASK_THREAD,
    actorUserId: admin.user.id,
    subject: { kind: FEED_ITEM_SUBJECT, id: String(itemId) },
  });
  expect((await state()).runnerPending).toBe(true);

  // A second question waits for the first.
  const busy = await admin.fetch(
    `/feedItems/${itemId}/ask/runner`,
    json('POST', { question: 'And the license?' }),
  );
  expect(busy.status).toBe(409);

  // The claim assembles the question's brief from the run's own input.
  const conn = agents.tx.read();
  const assembly = await agents.subjects
    .get(FEED_ITEM_SUBJECT)!
    .context.assemble(conn, {
      run,
      agent: await agents.agents.get(AGENT_ID),
      runner: null,
      inputs: await agents.runs.pendingInputs(conn, run.id),
      cli: 'nocofeed',
      appName: 'NocoFeed',
    });
  expect(assembly.readOnly).toBe(true);
  expect(assembly.turn.prompt).toBe('How does Kopf compare to kubebuilder?');
  expect(assembly.task).toContain(
    'Open the original at https://news.ycombinator.com/item?id=2',
  );
  expect(assembly.task).toContain('We built a Kubernetes operator framework');

  // The run ends; the answer arrives in the same conversation.
  await agents.tx.run((tx) =>
    agents.subjects.get(FEED_ITEM_SUBJECT)!.sink!.onRunFinished!(tx, {
      ...run,
      status: 'completed',
      summary: 'Kopf is Python; kubebuilder is Go. [Kopf](https://kopf.dev)',
    }),
  );
  const history = (
    (await (
      await admin.fetch(`/agents/conversations/${conversationId}/messages`)
    ).json()) as {
      data: {
        parts: {
          type: string;
          data?: { type: string; params?: Record<string, string> };
        }[];
      }[];
    }
  ).data;
  const notices = history
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'data-notice')
    .map((part) => part.data!);
  expect(notices.map((notice) => notice.type)).toEqual([
    ASK_QUEUED_NOTICE,
    ASK_ANSWER_NOTICE,
  ]);
  expect(notices[1]!.params).toMatchObject({
    runId,
    status: 'completed',
    question: 'How does Kopf compare to kubebuilder?',
    answer: 'Kopf is Python; kubebuilder is Go. [Kopf](https://kopf.dev)',
  });
});

test('clearing stops a question the runner agent still has', async ({
  testApp,
}) => {
  const { admin, agents, itemId, state } = await setUp(testApp, {
    runner: true,
  });
  const { runId } = (
    (await (
      await admin.fetch(
        `/feedItems/${itemId}/ask/runner`,
        json('POST', { question: 'What is Kopf?' }),
      )
    ).json()) as { data: { runId: string } }
  ).data;
  await admin.fetch(`/feedItems/${itemId}/ask`, json('DELETE'));
  expect((await agents.runs.get(runId)).status).toBe('cancelled');
  expect(await state()).toMatchObject({
    conversationId: null,
    runnerPending: false,
  });
});
