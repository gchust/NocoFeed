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
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { FeedError, feedRepliesToken } from '../providers/feed/index.js';
import {
  REPLY_GUIDELINES_MAX,
  REPLY_PLATFORMS,
} from '../providers/feed/replies.js';
import { IdParams } from './feed-schemas.js';

/**
 * Reply drafts (`server/providers/feed/replies.ts`, issue #15): replies to copy when joining a discussion, and the
 * person's own rules for them. Every route requires a session and reads or writes only the caller's own rows; another
 * person's item is a `404`, as everywhere in NocoFeed.
 */
const DOMAIN = 'nocofeed';

const ReplyDraftSchema = z.object({
  text: z.string().meta({ description: "The reply, in the post's language" }),
  tone: z.string().meta({
    description: "Its angle, in the person's interface language",
  }),
  emoji: z.string().meta({ description: 'Emoji that fit; empty when none' }),
  image: z.string().meta({
    description: 'A picture or meme idea to post with it; empty when none',
  }),
});

const ReplyStateSchema = z
  .object({
    status: z.enum(['none', 'pending', 'ready', 'failed']),
    drafts: z.array(ReplyDraftSchema),
    language: z.string().nullable().meta({
      description:
        'The language the drafts are written in: the post’s own, not the reading language',
    }),
    trigger: z.enum(['auto', 'asked']).nullable(),
    guidelinesVersion: z.string().nullable(),
    currentGuidelinesVersion: z.string(),
    guidelinesChanged: z.boolean(),
    stale: z.boolean(),
    available: z.boolean(),
    model: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .meta({ id: 'FeedReplyState' });

const PlatformGuidelines = z.partialRecord(
  z.enum(REPLY_PLATFORMS),
  z.string().max(REPLY_GUIDELINES_MAX),
);

const ReplyGuidelinesSchema = z
  .object({
    guidelines: z.string().nullable().meta({
      description: 'The person’s own rules; null keeps defaultGuidelines',
    }),
    platformGuidelines: PlatformGuidelines,
    defaultGuidelines: z.string(),
  })
  .meta({ id: 'FeedReplyGuidelines' });

const SaveReplyGuidelinesBody = z
  .strictObject({
    guidelines: z.string().max(REPLY_GUIDELINES_MAX).nullable().meta({
      description: 'Empty or null goes back to the default',
    }),
    platformGuidelines: PlatformGuidelines.optional().meta({
      description: 'Rules added for one platform on top of the general ones',
    }),
  })
  .meta({ id: 'SaveFeedReplyGuidelines' });

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
      const code = error.message.replace(/([A-Z])/g, '_$1').toUpperCase();
      throw new ApiError({
        status: status[error.code],
        reason:
          error.code === 'notFound'
            ? 'FEED_RECORD_NOT_FOUND'
            : error.code === 'unavailable'
              ? `FEED_UPSTREAM_${code}`
              : `FEED_${code}`,
        domain: DOMAIN,
        message: error.message,
      });
    }
    throw error;
  }
}

export const feedReplyRoutes: AppApiRouteContribution<Application> =
  defineApiRoutes((app) => {
    const router = new Hono();
    const auth = app.container.resolve(authenticationToken);
    const replies = () => app.container.resolve(feedRepliesToken);

    const items = new Hono<AuthEnv>();
    // Scoped to the paths this file owns; the rest of `/feedItems` is `feed.ts`'s.
    items.use('/:id/replies', auth.required());
    items.get(
      '/:id/replies',
      describeRoute({
        tags: ['Feed'],
        summary: 'Get the reply drafts for one of my items',
        operationId: 'getFeedItemReplies',
        responses: { '200': dataResponse(ReplyStateSchema), ...errors },
      }),
      apiValidator('param', IdParams),
      async (context) => {
        const { id } = context.req.valid('param');
        return context.json({
          data: await guard(() => replies().state(ownerOf(context), id)),
        });
      },
    );
    items.post(
      '/:id/replies',
      describeRoute({
        tags: ['Feed'],
        summary: 'Write the reply drafts for one of my items again',
        description:
          'Answers at once with status `pending`; the configured model writes them in the background. Poll the GET until it is `ready` or `failed`.',
        operationId: 'writeFeedItemReplies',
        responses: {
          '202': dataResponse(ReplyStateSchema),
          ...errors,
          '503': apiErrorResponse(503, 'When no chat model is configured'),
        },
      }),
      apiValidator('param', IdParams),
      async (context) => {
        const { id } = context.req.valid('param');
        const data = await guard(() => replies().request(ownerOf(context), id));
        return context.json({ data }, 202);
      },
    );
    router.route('/feedItems', items);

    const rules = new Hono<AuthEnv>();
    // This sub-app is mounted at `/feedReplyGuidelines` only.
    rules.use('*', auth.required());
    rules.get(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'Get my rules for reply drafts',
        operationId: 'getFeedReplyGuidelines',
        responses: {
          '200': dataResponse(ReplyGuidelinesSchema),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      async (context) =>
        context.json({
          data: await replies().guidelines(ownerOf(context)),
        }),
    );
    rules.put(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'Save my rules for reply drafts',
        operationId: 'saveFeedReplyGuidelines',
        responses: {
          '200': dataResponse(ReplyGuidelinesSchema),
          '400': apiErrorResponse(400),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      apiValidator('json', SaveReplyGuidelinesBody),
      async (context) =>
        context.json({
          data: await guard(() =>
            replies().saveGuidelines(
              ownerOf(context),
              context.req.valid('json'),
            ),
          ),
        }),
    );
    router.route('/feedReplyGuidelines', rules);

    return router;
  });
