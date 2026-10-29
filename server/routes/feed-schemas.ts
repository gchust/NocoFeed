import { z } from 'zod';

const PLATFORM = z.enum([
  'reddit',
  'hn',
  'rss',
  'youtube',
  'bilibili',
  'xiaohongshu',
  'x',
]);
const MODE = z.enum(['both', 'participate', 'learn']);
const LOCALE = z.enum(['zh-CN', 'en-US']);
const PART = z.enum(['body', 'comments', 'transcript']);

export const IdParams = z.object({
  id: z.coerce.number().int().positive(),
});

// Profile

export const FeedProfileSchema = z
  .object({
    interests: z.string(),
    expertise: z.string(),
    avoid: z.string(),
    dailyLimit: z.number().int(),
    keepLearning: z.boolean(),
    locale: LOCALE.nullable(),
    configured: z.boolean(),
    termWeights: z.record(z.string(), z.number()).meta({
      description:
        'Words whose weight feedback changed: below zero they count less, above zero more',
    }),
    digestEnabled: z.boolean(),
    digestHour: z.number().int(),
    timeZone: z.string().nullable(),
  })
  .meta({ ref: 'FeedProfile' });

export const SaveProfileBody = z.strictObject({
  interests: z.string().max(2_000),
  expertise: z.string().max(4_000),
  avoid: z.string().max(2_000),
  dailyLimit: z.number().int().min(0).max(500),
  keepLearning: z.boolean(),
  locale: LOCALE.optional(),
  digestEnabled: z.boolean().optional(),
  digestHour: z.number().int().min(0).max(23).optional(),
  timeZone: z.string().max(64).nullable().optional(),
  resetLearning: z
    .boolean()
    .optional()
    .meta({ description: 'Forget the word weights learned from feedback' }),
});

// Topics

export const FeedTopicSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    goal: z.string(),
    avoid: z.string().nullable(),
    mode: MODE,
    sourceIds: z.array(z.number().int()),
    createdAt: z.string(),
  })
  .meta({ ref: 'FeedTopic' });

export const CreateTopicBody = z.strictObject({
  name: z.string().trim().min(1).max(40),
  goal: z.string().trim().min(1).max(2_000),
  avoid: z.string().max(1_000).nullable().optional(),
  mode: MODE,
  sourceIds: z.array(z.number().int().positive()).max(100).default([]),
});

export const UpdateTopicBody = CreateTopicBody.partial();

// Sources

export const FeedSourceSchema = z
  .object({
    id: z.number().int(),
    platform: PLATFORM,
    operation: z.string(),
    name: z.string(),
    target: z.string(),
    frequency: z.number().int(),
    candidateLimit: z.number().int(),
    active: z.boolean(),
    status: z.string().meta({
      description:
        'pending, ok, partial, failed, needsLogin, rateLimited, unconfigured or unsupported',
    }),
    statusMessage: z.string().nullable(),
    lastRunAt: z.string().nullable(),
    lastSuccessAt: z.string().nullable(),
    nextRunAt: z.string().nullable(),
    failureStreak: z.number().int(),
    emptyStreak: z.number().int(),
    health: z.enum(['ok', 'failing', 'quiet']).meta({
      description:
        'failing after several failed runs in a row; quiet when nothing new has arrived for days',
    }),
  })
  .meta({ ref: 'FeedSource' });

const FREQUENCY = z.number().int().min(15).max(10_080);
const CANDIDATES = z.number().int().min(1).max(100);

export const CreateSourceBody = z.strictObject({
  platform: PLATFORM,
  operation: z.string().min(1).max(32),
  name: z.string().trim().min(1).max(60),
  target: z.string().max(500),
  frequency: FREQUENCY,
  candidateLimit: CANDIDATES.default(20),
  topicIds: z.array(z.number().int().positive()).max(50).optional(),
});

export const UpdateSourceBody = z.strictObject({
  name: z.string().trim().min(1).max(60).optional(),
  target: z.string().max(500).optional(),
  frequency: FREQUENCY.optional(),
  candidateLimit: CANDIDATES.optional(),
  active: z.boolean().optional(),
});

export const FeedCatalogSchema = z
  .object({
    collectorConfigured: z.boolean(),
    model: z.object({ available: z.boolean(), name: z.string().nullable() }),
    platforms: z.array(
      z.object({
        platform: PLATFORM,
        experimental: z.boolean(),
        needsLogin: z.boolean(),
        operations: z.array(
          z.object({
            operation: z.string(),
            implementation: z.enum(['native', 'collector']),
            input: z.enum(['text', 'url', 'none']),
            single: z.boolean(),
            capabilities: z.array(z.string()).readonly(),
            targetLength: z
              .object({ min: z.number(), max: z.number() })
              .nullable(),
            available: z.boolean(),
          }),
        ),
      }),
    ),
  })
  .meta({ ref: 'FeedCatalog' });

// Runs

export const FeedRunSchema = z
  .object({
    id: z.number().int(),
    sourceId: z.number().int().nullable(),
    sourceName: z.string().nullable(),
    platform: z.string().nullable(),
    itemId: z.number().int().nullable(),
    stage: z.enum(['collect', 'enrich', 'analyze']),
    trigger: z.enum(['schedule', 'manual']),
    status: z.string(),
    scope: z.string().nullable(),
    found: z.number().int(),
    inserted: z.number().int(),
    analyzed: z.number().int(),
    coverage: z.string().nullable().meta({
      description:
        'baseline, complete, partial or single; null when the run did not succeed',
    }),
    error: z.string().nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .meta({ ref: 'FeedRun' });

export const ListRunsQuery = z.object({
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const FeedRunStatsSchema = z.object({
  found: z.number().int(),
  inserted: z.number().int(),
  analyzed: z.number().int(),
  failed: z.number().int(),
});

// Items

export const ListItemsQuery = z.object({
  view: z
    .enum(['all', 'discuss', 'learn', 'saved', 'later', 'participated'])
    .default('all')
    .meta({
      description:
        'all, discuss and learn leave out dismissed items; the personal views keep them',
    }),
  platform: PLATFORM.optional(),
  topicId: z.coerce.number().int().positive().optional(),
  q: z.string().max(200).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  pageToken: z.string().max(64).optional(),
});

export const FeedListItemSchema = z
  .object({
    id: z.number().int(),
    platform: PLATFORM,
    sourceLabel: z.string().nullable(),
    title: z.string(),
    summary: z.string().nullable(),
    url: z.string().nullable(),
    publishedAt: z.string().nullable(),
    createdAt: z.string(),
    verdict: z.enum(['discuss', 'learn', 'ignore']).nullable(),
    score: z.number(),
    topicId: z.number().int().nullable(),
    lead: z.string().nullable(),
    favorite: z.boolean(),
    later: z.boolean(),
    participated: z.boolean(),
    newReplies: z.number().int(),
  })
  .meta({ ref: 'FeedListItem' });

const PartCoverage = z.object({
  status: z.string(),
  note: z.string().optional(),
  fetchedAt: z.string().optional(),
});

export const FeedItemStateSchema = z
  .object({
    favorite: z.boolean(),
    later: z.boolean(),
    participated: z.boolean(),
    feedback: z.enum(['helpful', 'irrelevant']).nullable(),
    notes: z.string().nullable(),
    participationUrl: z.string().nullable(),
    participationNote: z.string().nullable(),
    dismissed: z.boolean(),
    followUp: z
      .object({
        replies: z.number().int().nullable(),
        newReplies: z.number().int(),
        checkedAt: z.string().nullable(),
        nextCheckAt: z.string().nullable(),
      })
      .nullable()
      .meta({
        description:
          'Reply tracking of the participation link (Hacker News, Reddit) for two weeks after posting',
      }),
  })
  .meta({ ref: 'FeedItemState' });

export const FeedStateChangeSchema = FeedItemStateSchema.extend({
  adjustment: z
    .object({
      direction: z.enum(['up', 'down']),
      terms: z.array(z.string()),
      rescored: z.number().int(),
    })
    .optional()
    .meta({
      description:
        'Present when the feedback changed the weight of the words that matched this item',
    }),
}).meta({ ref: 'FeedStateChange' });

export const FeedItemSchema = FeedListItemSchema.extend({
  externalId: z.string(),
  author: z.string().nullable(),
  body: z.string().nullable(),
  comments: z.array(
    z.object({
      author: z.string().optional(),
      text: z.string(),
      depth: z.number().optional(),
    }),
  ),
  transcript: z.array(
    z.object({
      start: z.number(),
      end: z.number().optional(),
      text: z.string(),
    }),
  ),
  metrics: z.record(z.string(), z.number()),
  coverage: z.object({
    body: PartCoverage,
    comments: PartCoverage,
    transcript: PartCoverage.optional(),
    media: PartCoverage.optional(),
  }),
  contentVersion: z.number().int(),
  fetchedAt: z.string(),
  analysis: z
    .object({
      id: z.number().int(),
      topicId: z.number().int().nullable(),
      verdict: z.enum(['discuss', 'learn', 'ignore']),
      score: z.number(),
      interestLevel: z.string(),
      interestReason: z.string().nullable(),
      experienceLevel: z.string(),
      experienceReason: z.string().nullable(),
      lead: z.string().nullable(),
      steps: z.array(z.object({ title: z.string(), detail: z.string() })),
      evidence: z.string().nullable(),
      uncertainty: z.string().nullable(),
      engine: z.enum(['rules', 'model']),
      model: z.string().nullable(),
      contentVersion: z.number().int(),
      createdAt: z.string(),
    })
    .nullable(),
  analysisStale: z.boolean(),
  state: FeedItemStateSchema,
  enrichable: z.array(PART),
}).meta({ ref: 'FeedItem' });

export const UpdateStateBody = z.strictObject({
  favorite: z.boolean().optional(),
  later: z.boolean().optional(),
  participated: z.boolean().optional(),
  feedback: z.enum(['helpful', 'irrelevant']).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
  participationUrl: z
    .string()
    .max(1_000)
    .refine(
      (value) => value === '' || /^https?:\/\//i.test(value),
      'must be an http(s) URL',
    )
    .nullable()
    .optional(),
  participationNote: z.string().max(5_000).nullable().optional(),
  dismissed: z.boolean().optional(),
  followUpSeen: z
    .literal(true)
    .optional()
    .meta({ description: 'Marks the new replies to my post as seen' }),
});

export const FeedSummarySchema = z
  .object({
    all: z.number().int(),
    discuss: z.number().int(),
    learn: z.number().int(),
    saved: z.number().int(),
    later: z.number().int(),
    participated: z.number().int(),
    newReplies: z.number().int(),
    unhealthySources: z.number().int(),
  })
  .meta({ ref: 'FeedSummary' });

export const FeedDigestSchema = z
  .object({
    since: z.string(),
    discuss: z.array(FeedListItemSchema),
    learn: z.array(FeedListItemSchema),
  })
  .meta({ ref: 'FeedDigest' });
