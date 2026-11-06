import type { OnlineAgentContext } from '@nocobase/app-plugin-agents/server/online-agent';
import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization';
import type { Application } from '@nocobase/app-server/application';
import {
  ApiError,
  apiErrorResponse,
  apiValidator,
  dataResponse,
  defineApiRoutes,
  describeRoute,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type Context } from 'hono';
import { every } from 'hono/combine';
import { z } from 'zod';

import { FeedError, feedAskToken } from '../providers/feed/index.js';
import { IdParams } from './feed-schemas.js';

/**
 * "Ask about this item" (`server/providers/feed/ask.ts`). The conversation itself, its messages, streaming and Stop are
 * the Agents plugin's `/api/agents/conversations/:id/…` routes, which check that the caller owns it; these routes only
 * find, create and clear the caller's conversation about one of their own items and hand a question to their runner
 * agent. Another person's item is a `404`, as everywhere in NocoFeed.
 */
const DOMAIN = 'nocofeed';

const AskStateSchema = z
  .object({
    conversationId: z.string().nullable(),
    online: z.boolean(),
    webSearch: z.boolean(),
    runnerAgentId: z.string().nullable(),
    runnerPending: z.boolean(),
  })
  .meta({ id: 'FeedAskState' });

const AskOpenedSchema = z
  .object({ conversationId: z.string(), created: z.boolean() })
  .meta({ id: 'FeedAskOpened' });

const AskClearedSchema = z
  .object({ deleted: z.number().int() })
  .meta({ id: 'FeedAskCleared' });

const AskRunnerBody = z
  .object({ question: z.string().trim().min(1).max(2_000) })
  .meta({ id: 'FeedAskRunnerBody' });

const AskRunnerSchema = z
  .object({ conversationId: z.string(), runId: z.string() })
  .meta({ id: 'FeedAskRunnerQueued' });

const errors = {
  '400': apiErrorResponse(400),
  '401': apiErrorResponse(401),
  '404': apiErrorResponse(404),
  '409': apiErrorResponse(409),
  '503': apiErrorResponse(503),
  '500': apiErrorResponse(500),
};

type Env = AuthEnv & AuthorizationEnv;

function actorOf(context: Context<Env>): OnlineAgentContext {
  const auth = context.get('auth');
  const authz = context.get('authz');
  if (!auth || !authz) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: DOMAIN,
      message: 'A session is required.',
    });
  }
  return {
    user: { id: auth.user.id },
    authorization: authz,
    credentials: auth,
  };
}

function reasonOf(message: string): string {
  return `FEED_${message.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FeedError) {
      const status = {
        notFound: 'NOT_FOUND',
        invalid: 'INVALID_ARGUMENT',
        busy: 'ABORTED',
        unavailable: 'UNAVAILABLE',
      } as const;
      throw new ApiError({
        status: status[error.code],
        reason:
          error.code === 'notFound'
            ? 'FEED_RECORD_NOT_FOUND'
            : reasonOf(error.message),
        domain: DOMAIN,
        message: error.message,
      });
    }
    throw error;
  }
}

export const feedAskRoutes: AppApiRouteContribution<Application> =
  defineApiRoutes((app) => {
    const router = new Hono();
    const asks = new Hono<Env>();
    const auth = app.container.resolve(authenticationToken);
    const authorization = app.container.resolve(authorizationToken);
    const ask = () => app.container.resolve(feedAskToken);
    // A person's session; the online agent needs the request's authorization context as its actor.
    const person = every(auth.required(), authorization.middleware());
    // Scoped to the paths this file owns; the rest of `/feedItems` is `feed.ts`'s.
    asks.use('/:id/ask', person);
    asks.use('/:id/ask/*', person);

    asks.get(
      '/:id/ask',
      describeRoute({
        tags: ['Feed'],
        summary: 'Get my conversation about an item and what can answer',
        operationId: 'getFeedItemAsk',
        responses: {
          '200': dataResponse(AskStateSchema),
          '401': errors['401'],
          '404': errors['404'],
          '500': errors['500'],
        },
      }),
      apiValidator('param', IdParams),
      async (context) => {
        const { id } = context.req.valid('param');
        const actor = actorOf(context);
        return context.json({
          data: await guard(() => ask().state(actor.user.id, id)),
        });
      },
    );

    asks.post(
      '/:id/ask',
      describeRoute({
        tags: ['Feed'],
        summary: 'Open my conversation about an item',
        description:
          'Answers the existing conversation, or creates one with the item as context. Messages are sent to `/api/agents/conversations/{conversationId}/messages`.',
        operationId: 'openFeedItemAsk',
        responses: {
          '200': dataResponse(AskOpenedSchema),
          '401': errors['401'],
          '404': errors['404'],
          '503': errors['503'],
          '500': errors['500'],
        },
      }),
      apiValidator('param', IdParams),
      async (context) => {
        const { id } = context.req.valid('param');
        const actor = actorOf(context);
        return context.json({
          data: await guard(() => ask().open(actor, id)),
        });
      },
    );

    asks.delete(
      '/:id/ask',
      describeRoute({
        tags: ['Feed'],
        summary: 'Clear my conversation about an item',
        operationId: 'clearFeedItemAsk',
        responses: {
          '200': dataResponse(AskClearedSchema),
          '401': errors['401'],
          '404': errors['404'],
          '500': errors['500'],
        },
      }),
      apiValidator('param', IdParams),
      async (context) => {
        const { id } = context.req.valid('param');
        const actor = actorOf(context);
        return context.json({
          data: {
            deleted: await guard(() => ask().clear(actor.user.id, id)),
          },
        });
      },
    );

    asks.post(
      '/:id/ask/runner',
      describeRoute({
        tags: ['Feed'],
        summary: 'Hand a question about an item to my runner agent',
        description:
          'Queues a run on the `feedItem` subject (thread `ask`); the answer arrives in the same conversation as a notice.',
        operationId: 'askFeedItemRunner',
        responses: {
          '200': dataResponse(AskRunnerSchema),
          '400': errors['400'],
          '401': errors['401'],
          '404': errors['404'],
          '409': errors['409'],
          '503': errors['503'],
          '500': errors['500'],
        },
      }),
      apiValidator('param', IdParams),
      apiValidator('json', AskRunnerBody),
      async (context) => {
        const { id } = context.req.valid('param');
        const { question } = context.req.valid('json');
        const actor = actorOf(context);
        return context.json({
          data: await guard(() => ask().askRunner(actor, id, question)),
        });
      },
    );

    router.route('/feedItems', asks);
    return router;
  });
