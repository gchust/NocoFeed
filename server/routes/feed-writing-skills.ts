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

import { FeedError, feedWritingSkillsToken } from '../providers/feed/index.js';
import {
  SKILL_LANGUAGES,
  SKILL_USES,
} from '../providers/feed/skills-prompt.js';

/**
 * Writing skills (`server/providers/feed/writing-skills.ts`): which skill of the Agents plugin's library the caller
 * uses for reply drafts, ideas and briefs, per language. Requires a session; reads and writes only the caller's own
 * choice. The skills offered are the library's names and descriptions; their contents stay with the plugin, whose
 * own pages and permissions govern who may change them.
 */
const DOMAIN = 'nocofeed';

const SkillId = z.string().min(1).max(64);

const LanguageBindings = z.partialRecord(z.enum(SKILL_LANGUAGES), SkillId);

const Bindings = z.partialRecord(z.enum(SKILL_USES), LanguageBindings).meta({
  description:
    'Skill ids by use (`replies`, `ideas`, `briefs`) and language of the text (`en`, `zh`, `other`); a missing entry uses no skill',
});

const WritingSkillSettingsSchema = z
  .object({
    bindings: Bindings,
    skills: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        version: z.number().int(),
        size: z.number().int(),
      }),
    ),
    available: z.boolean().meta({
      description:
        'The skill library is there; without it nothing can be chosen',
    }),
  })
  .meta({ id: 'FeedWritingSkillSettings' });

const SaveWritingSkillsBody = z
  .strictObject({ bindings: Bindings })
  .meta({ id: 'SaveFeedWritingSkills' });

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
    if (error instanceof FeedError && error.code === 'invalid') {
      throw new ApiError({
        status: 'INVALID_ARGUMENT',
        reason: 'FEED_WRITING_SKILL_MISSING',
        domain: DOMAIN,
        message: 'A chosen skill is not in the skill library.',
      });
    }
    throw error;
  }
}

export const feedWritingSkillRoutes: AppApiRouteContribution<Application> =
  defineApiRoutes((app) => {
    const router = new Hono();
    const auth = app.container.resolve(authenticationToken);
    const skills = () => app.container.resolve(feedWritingSkillsToken);

    const settings = new Hono<AuthEnv>();
    // This sub-app is mounted at `/feedWritingSkills` only.
    settings.use('*', auth.required());
    settings.get(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'Get the writing skills I use',
        operationId: 'getFeedWritingSkills',
        responses: {
          '200': dataResponse(WritingSkillSettingsSchema),
          '401': apiErrorResponse(401),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) =>
        context.json({ data: await skills().settings(ownerOf(context)) }),
    );
    settings.put(
      '/',
      describeRoute({
        tags: ['Feed'],
        summary: 'Choose the writing skills I use',
        description:
          'Replaces the whole choice. Every id must be a skill of the library, else `400` `FEED_WRITING_SKILL_MISSING`.',
        operationId: 'saveFeedWritingSkills',
        responses: {
          '200': dataResponse(WritingSkillSettingsSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', SaveWritingSkillsBody),
      async (context) =>
        context.json({
          data: await guard(() =>
            skills().save(ownerOf(context), context.req.valid('json').bindings),
          ),
        }),
    );
    router.route('/feedWritingSkills', settings);

    return router;
  });
