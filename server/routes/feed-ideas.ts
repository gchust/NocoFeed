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

import { FeedError, feedIdeasToken } from '../providers/feed/index.js';
import { IDEA_KINDS, X_LANGUAGES } from '../providers/feed/ideas.js';
import { IDEA_ANGLES } from '../providers/feed/steer.js';
import { IdParams, SteerSchema, steerBody } from './feed-schemas.js';

/**
 * Ideas for creating something from an item (`server/providers/feed/ideas.ts`): the state of the caller's ideas about
 * one of their own items, starting a generation (it runs in the background and the page polls), one more idea in place
 * of another, deleting, and the caller's idea settings. Another person's item is a `404`, as everywhere in NocoFeed.
 */
const DOMAIN = 'nocofeed';

const Kind = z.enum(IDEA_KINDS);

const IdeaSetSchema = z
  .object({
    kind: Kind,
    status: z.enum(['pending', 'ready', 'failed']),
    ideas: z.array(z.record(z.string(), z.unknown())),
    error: z.string().nullable(),
    generatedAt: z.string().nullable(),
    styleVersion: z.string().nullable(),
    stale: z.boolean(),
    webSearch: z.boolean(),
    model: z.string().nullable(),
    trigger: z.enum(['manual', 'auto']),
    steer: SteerSchema.nullable().meta({
      description:
        'What the person asked for when these ideas were last written; null when nothing',
    }),
  })
  .meta({ id: 'FeedIdeaSet' });

const IdeasStateSchema = z
  .object({
    available: z.boolean(),
    webSearch: z.boolean(),
    kinds: z.array(Kind),
    auto: z.boolean(),
    styleVersion: z.string(),
    sets: z.array(IdeaSetSchema),
  })
  .meta({ id: 'FeedIdeasState' });

const IdeasRequestBody = steerBody(IDEA_ANGLES)
  .extend({ kinds: z.array(Kind).max(IDEA_KINDS.length).optional() })
  .meta({ id: 'FeedIdeasRequest' });

const IdeaAgainBody = steerBody(IDEA_ANGLES)
  .extend({ kind: Kind, index: z.number().int().min(0).max(10) })
  .meta({ id: 'FeedIdeaAgain' });

const IdeasDeleteQuery = z.object({ kind: Kind.optional() });

const IdeasDeletedSchema = z
  .object({ deleted: z.number().int() })
  .meta({ id: 'FeedIdeasDeleted' });

const IdeaSettingsSchema = z
  .object({
    style: z.string(),
    customized: z.boolean(),
    kinds: z.array(Kind),
    auto: z.boolean(),
    xLanguage: z.enum(X_LANGUAGES),
    styleVersion: z.string(),
    defaultStyle: z.string(),
  })
  .meta({ id: 'FeedIdeaSettings' });

const IdeaSettingsBody = z
  .object({
    style: z.string().max(4_000).nullable(),
    kinds: z.array(Kind).min(1).max(IDEA_KINDS.length),
    auto: z.boolean(),
    xLanguage: z.enum(X_LANGUAGES).nullable(),
  })
  .meta({ id: 'FeedIdeaSettingsBody' });

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

export const feedIdeasRoutes: AppApiRouteContribution<Application> =
  defineApiRoutes((app) => {
    const router = new Hono();
    const items = new Hono<Env>();
    const settings = new Hono<Env>();
    const auth = app.container.resolve(authenticationToken);
    const authorization = app.container.resolve(authorizationToken);
    const ideas = () => app.container.resolve(feedIdeasToken);
    // A person's session; generating with web search runs an online agent as that person.
    const person = every(auth.required(), authorization.middleware());
    // Scoped to the paths this file owns.
    items.use('/:id/ideas', person);
    items.use('/:id/ideas/*', person);
    settings.use('/', person);

    items.get(
      '/:id/ideas',
      describeRoute({
        tags: ['Feed'],
        summary: 'Get my ideas for an item',
        operationId: 'getFeedItemIdeas',
        responses: {
          '200': dataResponse(IdeasStateSchema),
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
          data: await guard(() => ideas().state(actor.user.id, id)),
        });
      },
    );

    items.post(
      '/:id/ideas',
      describeRoute({
        tags: ['Feed'],
        summary: 'Generate ideas for an item',
        description:
          'Starts generating in the background and answers at once (202) with the pending state; read the state again until no set is pending. Replaces earlier ideas of the same kinds.',
        operationId: 'generateFeedItemIdeas',
        responses: {
          '202': dataResponse(IdeasStateSchema),
          '400': errors['400'],
          '401': errors['401'],
          '404': errors['404'],
          '409': errors['409'],
          '503': errors['503'],
          '500': errors['500'],
        },
      }),
      apiValidator('param', IdParams),
      apiValidator('json', IdeasRequestBody),
      async (context) => {
        const { id } = context.req.valid('param');
        const { kinds, ...steer } = context.req.valid('json');
        const actor = actorOf(context);
        return context.json(
          {
            data: await guard(() =>
              ideas().request(actor, actor.user.id, id, kinds, steer),
            ),
          },
          202,
        );
      },
    );

    items.post(
      '/:id/ideas/again',
      describeRoute({
        tags: ['Feed'],
        summary: 'Replace one idea with another',
        operationId: 'regenerateFeedItemIdea',
        responses: {
          '202': dataResponse(IdeasStateSchema),
          '400': errors['400'],
          '401': errors['401'],
          '404': errors['404'],
          '409': errors['409'],
          '503': errors['503'],
          '500': errors['500'],
        },
      }),
      apiValidator('param', IdParams),
      apiValidator('json', IdeaAgainBody),
      async (context) => {
        const { id } = context.req.valid('param');
        const { kind, index, ...steer } = context.req.valid('json');
        const actor = actorOf(context);
        return context.json(
          {
            data: await guard(() =>
              ideas().again(actor, actor.user.id, id, kind, index, steer),
            ),
          },
          202,
        );
      },
    );

    items.delete(
      '/:id/ideas',
      describeRoute({
        tags: ['Feed'],
        summary: 'Delete my ideas for an item',
        operationId: 'deleteFeedItemIdeas',
        responses: {
          '200': dataResponse(IdeasDeletedSchema),
          '401': errors['401'],
          '404': errors['404'],
          '409': errors['409'],
          '500': errors['500'],
        },
      }),
      apiValidator('param', IdParams),
      apiValidator('query', IdeasDeleteQuery),
      async (context) => {
        const { id } = context.req.valid('param');
        const { kind } = context.req.valid('query');
        const actor = actorOf(context);
        return context.json({
          data: {
            deleted: await guard(() => ideas().remove(actor.user.id, id, kind)),
          },
        });
      },
    );

    settings.get(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'Get my idea settings',
        operationId: 'getFeedIdeaSettings',
        responses: {
          '200': dataResponse(IdeaSettingsSchema),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      async (context) => {
        const actor = actorOf(context);
        return context.json({
          data: await ideas().getSettings(actor.user.id),
        });
      },
    );

    settings.put(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'Save my idea settings',
        description:
          'A null or default `style` follows the built-in default; a null `xLanguage` writes X posts in English.',
        operationId: 'saveFeedIdeaSettings',
        responses: {
          '200': dataResponse(IdeaSettingsSchema),
          '400': errors['400'],
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      apiValidator('json', IdeaSettingsBody),
      async (context) => {
        const actor = actorOf(context);
        const body = context.req.valid('json');
        return context.json({
          data: await guard(() => ideas().saveSettings(actor.user.id, body)),
        });
      },
    );

    router.route('/feedItems', items);
    router.route('/feedIdeaSettings', settings);
    return router;
  });
