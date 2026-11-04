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
import { expect } from 'vitest';

import { FEED_ITEM_SUBJECT } from '../../server/providers/feed/agent-reader.js';
import {
  feedServiceToken,
  type FeedService,
} from '../../server/providers/feed/index.js';
import { createStandaloneServer } from '../../server/standalone.js';

const ORIGIN = 'http://localhost';
const AGENT_ID = 'nocofeed-test-reader';

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

interface Detail {
  analysis: { engine: string; model: string | null; verdict: string } | null;
  agentReading: { runId: number; agentId: string } | null;
}

const ANSWER = JSON.stringify({
  topicId: null,
  verdict: 'learn',
  score: 72,
  quality: {
    contentType: 'howto',
    substance: 7,
    novelty: 6,
    evidence: 7,
    usefulness: 8,
    noise: 'none',
  },
  interestLevel: 'high',
  interestReason: 'Evaluating tool use is the topic.',
  experienceLevel: 'some',
  experienceReason: 'Built evaluation harnesses.',
  lead: 'Read the harness design in the original post.',
  steps: [
    { title: 'Read', detail: 'The method section.' },
    { title: 'Compare', detail: 'With your own harness.' },
    { title: 'Try', detail: 'One of the metrics.' },
  ],
  evidence: 'The post and 40 comments, read on the original page.',
  uncertainty: '',
});

async function setUp(testApp: Parameters<typeof signIn>[0]) {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const container = (
    testApp as unknown as {
      application: { container: { resolve: <T>(token: unknown) => T } };
    }
  ).application.container;
  const database = container.resolve<DatabaseManager>(databaseManagerToken);
  const agents = container.resolve<Agents>(agentsToken);
  const feed = container.resolve<FeedService>(feedServiceToken);
  // An enabled agent of the application's own stands in for one a runner reported: no runner is connected, so the
  // run stays queued until the test ends it.
  await agents.agents.ensureSystem({
    id: AGENT_ID,
    name: 'Test reader',
    description: 'Reads feed items',
    instructions: null,
    actions: [],
    modelEntries: [{ tool: 'claude', model: 'sonnet' }],
  });
  await admin.fetch(
    '/feedProfile',
    json('PUT', {
      interests: 'LLM agents',
      expertise: 'Built evaluation harnesses for LLM agents',
      avoid: '',
      dailyLimit: 0,
      keepLearning: true,
      locale: 'en-US',
      readerAgentId: AGENT_ID,
    }),
  );
  const now = new Date();
  const { record } = (await database.repository('feedItems').createOne({
    values: {
      ownerId: admin.user.id,
      platform: 'hn',
      externalId: `agent-${Date.now()}-${Math.random()}`,
      title: 'Ask HN: How do you evaluate tool use in LLM agents?',
      body: null,
      url: 'https://news.ycombinator.com/item?id=1',
      coverage: {
        body: { status: 'missing' },
        comments: { status: 'notRequested' },
      },
      contentVersion: 1,
      fetchedAt: now,
      createdAt: now,
    },
  } as never)) as { record: { id: number } };
  const itemId = Number(record.id);
  const detail = async (): Promise<Detail> =>
    (
      (await (await admin.fetch(`/feedItems/${itemId}`)).json()) as {
        data: Detail;
      }
    ).data;
  const agentRunId = async (): Promise<string> => {
    const [row] = await database
      .query()
      .selectFrom('feedRuns')
      .select(['agentRunId'])
      .where('itemId', '=', itemId)
      .where('agentRunId', 'is not', null)
      .execute<{ agentRunId: string }>();
    return row!.agentRunId;
  };
  return { admin, database, agents, feed, itemId, detail, agentRunId };
}

test('the profile keeps the chosen runner agent', async ({ testApp }) => {
  const { admin } = await setUp(testApp);
  const profile = (await (await admin.fetch('/feedProfile')).json()) as {
    data: { readerAgentId: string | null };
  };
  expect(profile.data.readerAgentId).toBe(AGENT_ID);
});

test('"Analyze again" queues a run for the runner agent with the analysis brief', async ({
  testApp,
}) => {
  const { admin, agents, itemId, detail, agentRunId } = await setUp(testApp);
  const response = await admin.fetch(
    `/feedItems/${itemId}/analyze`,
    json('POST'),
  );
  expect(response.status).toBe(200);
  const handed = ((await response.json()) as { data: Detail }).data;
  expect(handed.agentReading).not.toBeNull();
  expect(handed.analysis).toBeNull();

  const run = await agents.runs.get(await agentRunId());
  expect(run.status).toBe('queued');
  expect(run.agentId).toBe(AGENT_ID);
  expect(run.subject).toEqual({ kind: FEED_ITEM_SUBJECT, id: String(itemId) });
  expect(run.actorUserId).toBe(admin.user.id);

  // The claim assembles the brief through the subject binding from the run's own input; no runner is connected, so
  // the test assembles it as a claim would.
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
  expect(assembly.subject.url).toBe('https://news.ycombinator.com/item?id=1');
  expect(assembly.task).toContain(
    'Open the original at https://news.ycombinator.com/item?id=1',
  );
  expect(assembly.context).toContain('evaluate tool use in LLM agents');
  expect(assembly.context).toContain('"verdict"');

  // Asking again while it reads queues nothing more.
  await admin.fetch(`/feedItems/${itemId}/analyze`, json('POST'));
  expect((await detail()).agentReading?.runId).toBe(handed.agentReading?.runId);
});

test("the agent's answer becomes the item's analysis", async ({ testApp }) => {
  const { agents, feed, itemId, detail, agentRunId, admin } =
    await setUp(testApp);
  await admin.fetch(`/feedItems/${itemId}/analyze`, json('POST'));
  const run = await agents.runs.get(await agentRunId());
  const binding = agents.subjects.get(FEED_ITEM_SUBJECT)!;
  await agents.tx.run((tx) =>
    binding.sink!.onRunFinished!(tx, {
      ...run,
      status: 'completed',
      summary: ANSWER,
      model: 'sonnet',
    }),
  );
  expect(await feed.settleAgentReads()).toBe(1);
  const settled = await detail();
  expect(settled.agentReading).toBeNull();
  expect(settled.analysis).toMatchObject({
    engine: 'agent',
    verdict: 'learn',
    model: `${AGENT_ID} (sonnet)`,
  });
  // Settled once: the schedule finds nothing left.
  expect(await feed.settleAgentReads()).toBe(0);
});

test('a stopped run falls back to the rules', async ({ testApp }) => {
  const { admin, agents, feed, itemId, detail, agentRunId, database } =
    await setUp(testApp);
  await admin.fetch(`/feedItems/${itemId}/analyze`, json('POST'));
  // Cancelling a queued run ends it at once through the plugin, which calls the subject's sink.
  await agents.runs.cancel(await agentRunId(), admin.user.id);
  expect(await feed.settleAgentReads()).toBe(1);
  const settled = await detail();
  expect(settled.agentReading).toBeNull();
  expect(settled.analysis?.engine).toBe('rules');
  const [run] = await database
    .query()
    .selectFrom('feedRuns')
    .select(['status', 'error'])
    .where('itemId', '=', itemId)
    .execute<{ status: string; error: string }>();
  expect(run).toEqual({ status: 'fellBack', error: 'agentCancelled' });
});

test('an unreadable answer falls back to the rules', async ({ testApp }) => {
  const { admin, agents, feed, itemId, detail, agentRunId } =
    await setUp(testApp);
  await admin.fetch(`/feedItems/${itemId}/analyze`, json('POST'));
  const run = await agents.runs.get(await agentRunId());
  await agents.tx.run((tx) =>
    agents.subjects.get(FEED_ITEM_SUBJECT)!.sink!.onRunFinished!(tx, {
      ...run,
      status: 'completed',
      summary: 'I read it and it looks interesting.',
    }),
  );
  await feed.settleAgentReads();
  expect((await detail()).analysis?.engine).toBe('rules');
});

test('without a workable agent "Analyze again" analyses here as before', async ({
  testApp,
}) => {
  const { admin, itemId } = await setUp(testApp);
  await admin.fetch(
    '/feedProfile',
    json('PUT', {
      interests: 'LLM agents',
      expertise: '',
      avoid: '',
      dailyLimit: 0,
      keepLearning: true,
      readerAgentId: 'no-such-agent',
    }),
  );
  const response = await admin.fetch(
    `/feedItems/${itemId}/analyze`,
    json('POST'),
  );
  expect(response.status).toBe(200);
  const data = ((await response.json()) as { data: Detail }).data;
  expect(data.agentReading).toBeNull();
  expect(data.analysis?.engine).toBe('rules');
});
