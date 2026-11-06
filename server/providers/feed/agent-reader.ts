import type {
  ClaimContext,
  SubjectAssembly,
  SubjectBinding,
} from '@nocobase/app-plugin-agents/server/tokens';
import type { DatabaseConnection } from '@nocobase/db';

type RunInput = ClaimContext['inputs'][number];

/**
 * "Analyze again" handed to a runner agent of the Agents plugin. A runner agent drives a coding tool on someone's own
 * machine or a shared server, so unlike the model gateway it can open the original link and its discussion itself:
 * Reddit, X and login-bound pages that this server cannot fetch included. It is a subject kind, `feedItem`, whose runs
 * the person starts from an item:
 *
 * - the service queues the run with the brief already built (the same prompt the model gateway would get, see
 *   `buildPrompt`), so the claim's assembly only reads its own input and the item row: no network, no model;
 * - the agent's last message is the analysis JSON. When the run ends, `onRunFinished` stores how it ended on the
 *   waiting `feedRuns` row, inside the plugin's transaction; the service settles it afterwards (parses the answer, or
 *   falls back to the model gateway and the rules) where a model call is allowed.
 */
export const FEED_ITEM_SUBJECT = 'feedItem';

/** The trigger every NocoFeed run carries in `input.payload.trigger`. */
export const ANALYZE_TRIGGER = 'analyze';

/** A run no runner takes within this time fails `queuedExpired`, and the item falls back to the model or the rules. */
export const AGENT_QUEUE_EXPIRY_MS = 30 * 60_000;

/** The application's i18n namespace (`client/runtime.ts` `packageName`), for text the agents pages show. */
const NS = 'nocofeed';

/** What the service puts in the run's input; the assembly needs nothing else. */
export interface AnalyzePayload {
  readonly trigger: typeof ANALYZE_TRIGGER;
  readonly feedRunId: number;
  readonly itemId: number;
  readonly system: string;
  readonly prompt: string;
}

/** How the agent run ended, as stored on `feedRuns.agentResult`. */
export interface AgentResult {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly summary: string | null;
  readonly failureReason: string | null;
  readonly agentId: string;
  readonly model: string | null;
}

export function isAnalyzePayload(value: unknown): value is AnalyzePayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.trigger === ANALYZE_TRIGGER &&
    typeof payload.feedRunId === 'number' &&
    typeof payload.itemId === 'number' &&
    typeof payload.system === 'string' &&
    typeof payload.prompt === 'string'
  );
}

/** The newest analyse request among the run's inputs; earlier ones are the same request asked again. */
function latestRequest(
  inputs: readonly RunInput[],
): { input: RunInput; payload: AnalyzePayload } | null {
  for (let index = inputs.length - 1; index >= 0; index -= 1) {
    const input = inputs[index];
    if (isAnalyzePayload(input.payload))
      return { input, payload: input.payload };
  }
  return null;
}

const RULES: readonly string[] = [
  'This is a reading task. Do not change files, open pull requests, post, comment, vote or sign in anywhere.',
  'Your last message is the analysis: the one JSON object the task describes, with nothing before or after it.',
];

/** Builds the brief of a claimed run from its own input. Database reads only, on the claim's connection. */
export async function assembleAnalysis(
  conn: DatabaseConnection,
  claim: ClaimContext,
): Promise<SubjectAssembly> {
  const request = latestRequest(claim.inputs);
  if (!request) throw new Error('feedItem run without an analyse request');
  const { payload } = request;
  const [item] = await conn.query
    .selectFrom('feedItems')
    .select(['id', 'title', 'url', 'platform'])
    .where('id', '=', payload.itemId)
    .where('ownerId', '=', claim.run.actorUserId)
    .execute();
  if (!item) throw new Error('feedItem no longer exists');
  const url = typeof item.url === 'string' ? item.url : '';
  const open = url
    ? `Open the original at ${url} and, when it has one, its discussion. Read what the MATERIAL below lacks (body, comments, subtitles) before you judge, and say in "evidence" what you read there. What you read on the original yourself counts as MATERIAL; "not obtained" below only says what ${claim.appName} could not fetch.`
    : 'The item has no link to open: judge from the MATERIAL below alone.';
  return {
    subject: {
      key: `feed-item-${payload.itemId}`,
      title: String(item.title),
      url,
      noun: 'feed item',
    },
    guidance: {
      rules: RULES,
      whenBlocked:
        'When the original cannot be opened, judge from the MATERIAL and name what you could not read in "uncertainty".',
    },
    task: `${payload.system}\n\nYou are analysing one item of ${claim.appName}, a personal interest feed, for the person who asked. ${open}`,
    context: payload.prompt,
    inputs: [request.input],
    turn: { prompt: 'Analyse the feed item and answer with the JSON object.' },
    data: { itemId: payload.itemId, url },
    dirs: [],
    scopes: [],
    readOnly: true,
  };
}

/**
 * Records how a run ended on the `feedRuns` row waiting for it. In the plugin's transaction: a write through its
 * connection, nothing else. A row already settled is left alone.
 */
export async function recordAgentResult(
  conn: DatabaseConnection,
  run: {
    readonly id: string;
    readonly agentId: string;
    readonly status: string;
    readonly summary: string | null;
    readonly failureReason: string | null;
    readonly model: string | null;
  },
): Promise<boolean> {
  const status: AgentResult['status'] =
    run.status === 'completed'
      ? 'completed'
      : run.status === 'cancelled'
        ? 'cancelled'
        : 'failed';
  const result: AgentResult = {
    status,
    summary: run.summary,
    failureReason: run.failureReason,
    agentId: run.agentId,
    model: run.model,
  };
  const { updatedCount } = await conn.repository('feedRuns').updateMany({
    filter: { agentRunId: run.id, status: 'running' },
    values: { agentResult: result },
  } as never);
  return updatedCount > 0;
}

/**
 * Questions about an item handed to a runner agent (`ask.ts`): runs on the same subject in thread `ask`, with their own
 * brief and their own ending.
 */
export interface AskHandlers {
  readonly thread: string;
  readonly trigger: string;
  readonly assemble: (
    conn: DatabaseConnection,
    claim: ClaimContext,
  ) => Promise<SubjectAssembly>;
  readonly onRunFinished: NonNullable<
    NonNullable<SubjectBinding['sink']>['onRunFinished']
  >;
}

/** The `feedItem` subject. `onFinished` is told after a result was recorded, to settle it once the transaction ends. */
export function feedItemSubject(
  onFinished: () => void,
  ask?: AskHandlers,
): SubjectBinding {
  return {
    kind: FEED_ITEM_SUBJECT,
    // An item, its analysis and the person's interests are theirs alone, like the rest of NocoFeed.
    private: true,
    title: { key: 'agents.subjects.feedItem', ns: NS },
    path: '/?item={id}',
    triggers: {
      [ANALYZE_TRIGGER]: { key: 'agents.triggers.analyze', ns: NS },
      ...(ask ? { [ask.trigger]: { key: 'agents.triggers.ask', ns: NS } } : {}),
    },
    queuedExpiryMs: AGENT_QUEUE_EXPIRY_MS,
    context: {
      assemble: (conn, claim) =>
        ask && claim.run.threadScope === ask.thread
          ? ask.assemble(conn, claim)
          : assembleAnalysis(conn, claim),
    },
    sink: {
      onRunFinished: async (tx, run) => {
        if (ask && run.threadScope === ask.thread)
          return ask.onRunFinished(tx, run);
        if (await recordAgentResult(tx.conn, run)) onFinished();
      },
    },
  };
}
