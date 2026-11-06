import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import type { Application } from '@nocobase/app-server/application';
import {
  ApiError,
  apiBodyLimitMiddleware,
  apiErrorResponse,
  apiValidator,
  dataResponse,
  defineApiRoutes,
  describeRoute,
  listResponse,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { feedIngestToken, feedMailToken } from '../providers/feed/index.js';

/**
 * The two ways in that are not a public platform: what the person pushes (`POST /feedItems/ingest`, from a script, a
 * browser extension or by hand) and the mail accounts a mail subscription can read (`GET /feedMailAccounts`). Like
 * every NocoFeed route they require a session — a browser session or an API key in `x-api-key`, which stands for its
 * owner — and only ever read or write the caller's own data: the owner is the session's user, never a request field.
 */
const DOMAIN = 'nocofeed';

/** The largest push body accepted; `content` itself is capped below it. */
export const INGEST_BODY_LIMIT = 256 * 1024;
export const INGEST_CONTENT_LIMIT = 100_000;

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

const httpUrl = z
  .string()
  .trim()
  .max(1_000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'An http or https address');

export const IngestBody = z
  .strictObject({
    url: httpUrl.optional().meta({
      description:
        'The link. Alone, NocoFeed reads it: a YouTube, Bilibili, Xiaohongshu or X post through that platform, any other page as an article',
    }),
    title: z.string().trim().min(1).max(500).optional(),
    content: z
      .string()
      .trim()
      .min(1)
      .max(INGEST_CONTENT_LIMIT)
      .optional()
      .meta({
        description:
          'The text of the post, sent as it is; with it nothing is fetched',
      }),
    summary: z.string().trim().max(2_000).optional(),
    author: z.string().trim().max(200).optional(),
    publishedAt: z.iso.datetime({ offset: true }).optional().meta({
      description: 'When it was published (ISO 8601)',
    }),
    externalId: z.string().trim().min(1).max(500).optional().meta({
      description:
        "The sender's own id for it; pushing the same id again stores nothing new",
    }),
  })
  .refine((body) => body.url || (body.title && body.content), {
    message: 'Send a url, or a title with content',
    path: ['url'],
  })
  .meta({ ref: 'FeedIngestInput' });

const IngestResultSchema = z
  .object({
    itemId: z.number().int(),
    title: z.string(),
    url: z.string().nullable(),
    duplicate: z.boolean().meta({
      description: 'Pushed before: nothing was stored or analysed again',
    }),
    fetched: z.enum(['none', 'platform', 'page', 'failed']).meta({
      description:
        'none: the content came with the request (or it was a duplicate); platform or page: read from the link; failed: the link could not be read and only the link was kept',
    }),
    fetchError: z.string().nullable(),
  })
  .meta({ ref: 'FeedIngestResult' });

const MailAccountSchema = z
  .object({
    id: z.string(),
    address: z.string(),
    displayName: z.string().nullable(),
    provider: z.string(),
    status: z.string(),
  })
  .meta({ ref: 'FeedMailAccount' });

const errors = {
  '400': apiErrorResponse(400),
  '401': apiErrorResponse(401),
  '413': apiErrorResponse(413),
  '500': apiErrorResponse(500),
};

export const feedIngestRoutes: AppApiRouteContribution<Application> =
  defineApiRoutes((app) => {
    const router = new Hono();
    const auth = app.container.resolve(authenticationToken);

    const ingest = new Hono<AuthEnv>();
    ingest.use('*', auth.required());
    ingest.post(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'Push a link or a post into my feed',
        description:
          'Stores it in my push inbox and runs the same prefilter and analysis as collected items (in the background). ' +
          'Send `url` alone to have the page read, or `title` and `content` (with an optional `url`) to store the post as sent. ' +
          'Authenticate with the signed-in session or an API key in the `x-api-key` header. ' +
          'The same `externalId`, link, or title and text is stored once: a repeat answers 200 with `duplicate: true`. ' +
          `Bodies over ${INGEST_BODY_LIMIT / 1024} KB are refused with 413.`,
        operationId: 'ingestFeedItem',
        responses: {
          '201': dataResponse(IngestResultSchema),
          '200': dataResponse(IngestResultSchema),
          ...errors,
        },
      }),
      apiBodyLimitMiddleware(INGEST_BODY_LIMIT),
      apiValidator('json', IngestBody),
      async (context) => {
        const owner = ownerOf(context);
        const data = await app.container
          .resolve(feedIngestToken)
          .ingest(owner, context.req.valid('json'));
        return context.json({ data }, data.duplicate ? 200 : 201);
      },
    );
    router.route('/feedItems/ingest', ingest);

    const mail = new Hono<AuthEnv>();
    mail.use('*', auth.required());
    mail.get(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'List my connected mail accounts',
        description:
          "The accounts a mail subscription can read: the caller's own, connected under Mail accounts. `meta.available` is false when the Mail plugin is not there.",
        operationId: 'listFeedMailAccounts',
        responses: {
          '200': listResponse(MailAccountSchema),
          '401': errors['401'],
          '500': errors['500'],
        },
      }),
      async (context) => {
        const accounts = await app.container
          .resolve(feedMailToken)
          .accounts(ownerOf(context));
        const data = accounts ?? [];
        return context.json({
          data,
          meta: { total: data.length, available: accounts !== null },
        });
      },
    );
    router.route('/feedMailAccounts', mail);

    return router;
  });
