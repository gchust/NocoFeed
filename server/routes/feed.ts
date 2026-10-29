import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import type { Application } from '@nocobase/app-server/application';
import {
  ApiError,
  apiErrorResponse,
  apiValidator,
  dataResponse,
  defineApiRoutes,
  describeRoute,
  emptyResponse,
  listResponse,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { FeedError, feedServiceToken } from '../providers/feed/index.js';
import {
  CreateSourceBody,
  CreateTopicBody,
  FeedCatalogSchema,
  FeedDigestSchema,
  FeedItemSchema,
  FeedListItemSchema,
  FeedProfileSchema,
  FeedRunSchema,
  FeedRunStatsSchema,
  FeedSourceSchema,
  FeedStateChangeSchema,
  FeedSummarySchema,
  FeedTopicSchema,
  IdParams,
  ListItemsQuery,
  ListRunsQuery,
  SaveProfileBody,
  UpdateSourceBody,
  UpdateStateBody,
  UpdateTopicBody,
} from './feed-schemas.js';

/**
 * NocoFeed's personal API. Every route requires a session and only ever reads or writes the caller's own rows: the
 * owner is the session's user and is applied inside the service, never taken from the request. There is no shared
 * business data here, so a per-record ownership check is the whole authorization model.
 */
const DOMAIN = 'nocofeed';
const errors = {
  '401': apiErrorResponse(401),
  '404': apiErrorResponse(404),
  '500': apiErrorResponse(500),
};

function ownerOf(context: Context<AuthEnv>): string {
  const auth = context.get('auth');
  if (!auth) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: DOMAIN,
      message: 'A session is required.',
    });
  }
  return auth.user.id;
}

function translate(error: unknown): never {
  if (error instanceof FeedError) {
    const map = {
      notFound: ['NOT_FOUND', 'FEED_RECORD_NOT_FOUND'],
      invalid: [
        'INVALID_ARGUMENT',
        `FEED_${error.message.replace(/([A-Z])/g, '_$1').toUpperCase()}`,
      ],
      busy: ['ABORTED', 'FEED_SOURCE_RUNNING'],
      unavailable: [
        'UNAVAILABLE',
        `FEED_UPSTREAM_${error.message.replace(/([A-Z])/g, '_$1').toUpperCase()}`,
      ],
    } as const;
    const [status, reason] = map[error.code];
    throw new ApiError({
      status,
      reason,
      domain: DOMAIN,
      message: error.message,
    });
  }
  throw error;
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return translate(error);
  }
}

export const feedRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono();
    const auth = app.container.resolve(authenticationToken);
    const feed = () => app.container.resolve(feedServiceToken);

    const section = () => {
      const routes = new Hono<AuthEnv>();
      routes.use('*', auth.required());
      return routes;
    };

    // Profile: what I want to follow and what I can genuinely contribute.
    const profile = section();
    profile.get(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'Get my interests and experience',
        operationId: 'getFeedProfile',
        responses: {
          '200': dataResponse(FeedProfileSchema),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      async (context) =>
        context.json({ data: await feed().getProfile(ownerOf(context)) }),
    );
    profile.put(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'Save my interests, experience and digest settings',
        operationId: 'saveFeedProfile',
        responses: {
          '200': dataResponse(FeedProfileSchema),
          '400': apiErrorResponse(400),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      apiValidator('json', SaveProfileBody),
      async (context) =>
        context.json({
          data: await guard(() =>
            feed().saveProfile(ownerOf(context), context.req.valid('json')),
          ),
        }),
    );
    router.route('/feedProfile', profile);

    // Topics
    const topics = section();
    topics.get(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'List my interest topics',
        operationId: 'listFeedTopics',
        responses: {
          '200': listResponse(FeedTopicSchema),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      async (context) => {
        const data = await feed().listTopics(ownerOf(context));
        return context.json({ data, meta: { total: data.length } });
      },
    );
    topics.post(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'Create an interest topic',
        operationId: 'createFeedTopic',
        responses: {
          '201': dataResponse(FeedTopicSchema),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      apiValidator('json', CreateTopicBody),
      async (context) => {
        const body = context.req.valid('json');
        const data = await guard(() =>
          feed().createTopic(ownerOf(context), {
            ...body,
            avoid: body.avoid ?? null,
          }),
        );
        return context.json({ data }, 201);
      },
    );
    topics.patch(
      '/:id',
      describeRoute({
        tags: ['Feed'],
        summary: 'Update an interest topic',
        operationId: 'updateFeedTopic',
        responses: { '200': dataResponse(FeedTopicSchema), ...errors },
      }),
      apiValidator('param', IdParams),
      apiValidator('json', UpdateTopicBody),
      async (context) => {
        const { id } = context.req.valid('param');
        const data = await guard(() =>
          feed().updateTopic(ownerOf(context), id, context.req.valid('json')),
        );
        return context.json({ data });
      },
    );
    topics.delete(
      '/:id',
      describeRoute({
        tags: ['Feed'],
        summary: 'Delete an interest topic',
        operationId: 'deleteFeedTopic',
        responses: { '204': emptyResponse(), ...errors },
      }),
      apiValidator('param', IdParams),
      async (context) => {
        await guard(() =>
          feed().deleteTopic(ownerOf(context), context.req.valid('param').id),
        );
        return context.body(null, 204);
      },
    );
    router.route('/feedTopics', topics);

    // Sources (subscriptions)
    const sources = section();
    sources.get(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'List my subscriptions',
        operationId: 'listFeedSources',
        responses: {
          '200': listResponse(FeedSourceSchema),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      async (context) => {
        const data = await feed().listSources(ownerOf(context));
        return context.json({ data, meta: { total: data.length } });
      },
    );
    sources.post(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'Create a subscription',
        operationId: 'createFeedSource',
        responses: {
          '201': dataResponse(FeedSourceSchema),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      apiValidator('json', CreateSourceBody),
      async (context) => {
        const data = await guard(() =>
          feed().createSource(ownerOf(context), context.req.valid('json')),
        );
        return context.json({ data }, 201);
      },
    );
    sources.patch(
      '/:id',
      describeRoute({
        tags: ['Feed'],
        summary: 'Update, pause or resume a subscription',
        operationId: 'updateFeedSource',
        responses: { '200': dataResponse(FeedSourceSchema), ...errors },
      }),
      apiValidator('param', IdParams),
      apiValidator('json', UpdateSourceBody),
      async (context) => {
        const { id } = context.req.valid('param');
        const data = await guard(() =>
          feed().updateSource(ownerOf(context), id, context.req.valid('json')),
        );
        return context.json({ data });
      },
    );
    sources.delete(
      '/:id',
      describeRoute({
        tags: ['Feed'],
        summary: 'Delete a subscription; collected items and notes are kept',
        operationId: 'deleteFeedSource',
        responses: { '204': emptyResponse(), ...errors },
      }),
      apiValidator('param', IdParams),
      async (context) => {
        await guard(() =>
          feed().deleteSource(ownerOf(context), context.req.valid('param').id),
        );
        return context.body(null, 204);
      },
    );
    sources.post(
      '/:id/run',
      describeRoute({
        tags: ['Feed'],
        summary: 'Collect a subscription now',
        operationId: 'runFeedSource',
        responses: {
          '200': dataResponse(FeedRunSchema),
          ...errors,
          '409': apiErrorResponse(
            409,
            'When the subscription is already running',
          ),
        },
      }),
      apiValidator('param', IdParams),
      async (context) => {
        const { id } = context.req.valid('param');
        const data = await guard(() =>
          feed().runSource(ownerOf(context), id, 'manual'),
        );
        return context.json({ data });
      },
    );
    router.route('/feedSources', sources);

    const catalog = section();
    catalog.get(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'List platforms, operations and what is connected',
        operationId: 'getFeedCatalog',
        responses: {
          '200': dataResponse(FeedCatalogSchema),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      async (context) => {
        ownerOf(context);
        return context.json({ data: await feed().catalogStatus() });
      },
    );
    router.route('/feedCatalog', catalog);

    // Runs
    const runs = section();
    runs.get(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'List my recent collect, enrich and analyze runs',
        operationId: 'listFeedRuns',
        responses: {
          '200': listResponse(
            FeedRunSchema,
            z.object({ stats: FeedRunStatsSchema }),
          ),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      apiValidator('query', ListRunsQuery),
      async (context) => {
        const { runs: data, stats } = await feed().listRuns(
          ownerOf(context),
          context.req.valid('query').pageSize,
        );
        return context.json({ data, meta: { stats } });
      },
    );
    router.route('/feedRuns', runs);

    // Items
    const items = section();
    items.get(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'List my feed',
        operationId: 'listFeedItems',
        responses: {
          '200': listResponse(
            FeedListItemSchema,
            z.object({ nextPageToken: z.string().optional() }),
          ),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      apiValidator('query', ListItemsQuery),
      async (context) => {
        const { items: data, nextPageToken } = await feed().listItems(
          ownerOf(context),
          context.req.valid('query'),
        );
        return context.json({
          data,
          meta: nextPageToken ? { nextPageToken } : {},
        });
      },
    );
    items.get(
      '/summary',
      describeRoute({
        tags: ['Feed'],
        summary: 'Count my feed by view',
        operationId: 'getFeedSummary',
        responses: {
          '200': dataResponse(FeedSummarySchema),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      async (context) =>
        context.json({ data: await feed().summary(ownerOf(context)) }),
    );
    items.get(
      '/:id',
      describeRoute({
        tags: ['Feed'],
        summary: 'Get one item with its material, analysis and my notes',
        operationId: 'getFeedItem',
        responses: { '200': dataResponse(FeedItemSchema), ...errors },
      }),
      apiValidator('param', IdParams),
      async (context) => {
        const data = await guard(() =>
          feed().getItem(ownerOf(context), context.req.valid('param').id),
        );
        return context.json({ data });
      },
    );
    items.patch(
      '/:id/state',
      describeRoute({
        tags: ['Feed'],
        summary:
          'Update my favourite, read-later, dismissal, feedback, notes or participation record',
        description:
          'Feedback moves the weight of the words that matched the item and scores recent items again. A Hacker News or Reddit participation link is followed for new replies.',
        operationId: 'updateFeedItemState',
        responses: { '200': dataResponse(FeedStateChangeSchema), ...errors },
      }),
      apiValidator('param', IdParams),
      apiValidator('json', UpdateStateBody),
      async (context) => {
        const data = await guard(() =>
          feed().updateState(
            ownerOf(context),
            context.req.valid('param').id,
            context.req.valid('json'),
          ),
        );
        return context.json({ data });
      },
    );
    items.post(
      '/:id/enrich',
      describeRoute({
        tags: ['Feed'],
        summary: 'Fetch more material (comments, subtitles) for one item',
        operationId: 'enrichFeedItem',
        responses: {
          '200': dataResponse(FeedItemSchema),
          ...errors,
          '503': apiErrorResponse(
            503,
            'When the platform or the Collector could not provide the material',
          ),
        },
      }),
      apiValidator('param', IdParams),
      async (context) => {
        const data = await guard(() =>
          feed().enrichItem(ownerOf(context), context.req.valid('param').id),
        );
        return context.json({ data });
      },
    );
    items.post(
      '/:id/analyze',
      describeRoute({
        tags: ['Feed'],
        summary:
          'Analyze one item again with the current material and preferences',
        operationId: 'analyzeFeedItem',
        responses: { '200': dataResponse(FeedItemSchema), ...errors },
      }),
      apiValidator('param', IdParams),
      async (context) => {
        const data = await guard(() =>
          feed().reanalyzeItem(ownerOf(context), context.req.valid('param').id),
        );
        return context.json({ data });
      },
    );
    router.route('/feedItems', items);

    const digest = section();
    digest.get(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary:
          'Get my daily digest: the best discussions and learning item of the last 24 hours',
        operationId: 'getFeedDigest',
        responses: {
          '200': dataResponse(FeedDigestSchema),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      async (context) =>
        context.json({ data: await feed().digest(ownerOf(context)) }),
    );
    router.route('/feedDigest', digest);

    return router;
  },
);
