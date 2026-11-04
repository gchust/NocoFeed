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
const NOISE = z.enum(['none', 'promo', 'routine', 'roundup', 'hype', 'teaser']);
const GATE = z.enum(['prefilter', 'awaitingMaterial']);
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
    readerAgentId: z.string().nullable().meta({
      description:
        'The runner agent "Analyze again" is handed to; null analyses with the model and the rules',
    }),
    maxAgeDays: z.number().int().meta({
      description:
        'Collection keeps items published within this many days; 0 keeps everything',
    }),
  })
  .meta({ ref: 'FeedProfile' });

export const SaveProfileBody = z.strictObject({
  interests: z.string().max(2_000),
  expertise: z.string().max(4_000),
  avoid: z.string().max(2_000),
  dailyLimit: z.number().int().min(0).max(10_000),
  keepLearning: z.boolean(),
  locale: LOCALE.optional(),
  digestEnabled: z.boolean().optional(),
  digestHour: z.number().int().min(0).max(23).optional(),
  timeZone: z.string().max(64).nullable().optional(),
  readerAgentId: z.string().max(200).nullable().optional().meta({
    description:
      'An enabled runner agent id (Agents plugin) to hand "Analyze again" to; null to stop',
  }),
  resetLearning: z
    .boolean()
    .optional()
    .meta({ description: 'Forget the word weights learned from feedback' }),
  maxAgeDays: z.number().int().min(0).max(365).optional().meta({
    description:
      'Keep collected items published within this many days; 0 keeps everything',
  }),
});

// Sources

export const FeedSourceSchema = z
  .object({
    id: z.number().int(),
    topicId: z.number().int().nullable().meta({
      description:
        'The topic whose search this is; null for a subscription made directly',
    }),
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

// Topics

/** Terms a topic searches for itself; each runs on every chosen platform. */
const SEARCH_TERMS = z.array(z.string().trim().min(1).max(200)).max(10);
const SEARCH_PLATFORMS = z.array(PLATFORM).max(10);

export const FeedTopicSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    goal: z.string(),
    avoid: z.string().nullable(),
    mode: MODE,
    sourceIds: z.array(z.number().int()).meta({
      description:
        'Subscriptions the topic is limited to; empty means it judges what every subscription brings',
    }),
    searchTerms: z.array(z.string()),
    searchPlatforms: z.array(PLATFORM).meta({
      description:
        'Platforms to search on; empty means every platform that can search',
    }),
    searchFrequency: z.number().int(),
    searchLimit: z.number().int(),
    searches: z.array(FeedSourceSchema).meta({
      description:
        'The searches running for this topic, one per term and platform',
    }),
    createdAt: z.string(),
  })
  .meta({ ref: 'FeedTopic' });

const TOPIC_FIELDS = {
  name: z.string().trim().min(1).max(40),
  goal: z.string().trim().min(1).max(2_000),
  avoid: z.string().max(1_000).nullable(),
  mode: MODE,
  sourceIds: z.array(z.number().int().positive()).max(100),
  searchTerms: SEARCH_TERMS,
  searchPlatforms: SEARCH_PLATFORMS,
  searchFrequency: FREQUENCY,
  searchLimit: CANDIDATES,
};

export const CreateTopicBody = z.strictObject({
  ...TOPIC_FIELDS,
  avoid: TOPIC_FIELDS.avoid.optional(),
  sourceIds: TOPIC_FIELDS.sourceIds.default([]),
  searchTerms: SEARCH_TERMS.default([]),
  searchPlatforms: SEARCH_PLATFORMS.default([]),
  searchFrequency: FREQUENCY.default(360),
  searchLimit: CANDIDATES.default(20),
});

/** Without defaults: a field left out of an update keeps its value. */
export const UpdateTopicBody = z.strictObject(TOPIC_FIELDS).partial();

export const TopicRunSchema = z
  .object({
    started: z.number().int().meta({
      description:
        'Searches started now; they run one after another in the background',
    }),
  })
  .meta({ ref: 'FeedTopicRun' });

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
    windowFilter: z.enum(['platform', 'local']).nullable().meta({
      description:
        'How the time window was applied: platform (the platform searched by date) or local (it could not; the Collector read windowScanned results and kept those published inside the window); null when unknown',
    }),
    windowScanned: z.number().int().nullable(),
    windowShort: z.boolean().meta({
      description:
        'A first run filtered locally found fewer items than the subscription asks for; widening the time window would bring more',
    }),
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
  period: z.enum(['day', 'week', 'month']).optional().meta({
    description:
      'Only items published (or, when the date is unknown, collected) in the last day, week or month',
  }),
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true')
    .meta({ description: 'true: only items I have not read' }),
  sort: z.enum(['newest', 'priority']).default('newest').meta({
    description:
      'newest (default): most recently published first; priority: most worth reading first',
  }),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  pageToken: z.string().max(64).optional(),
});

export const FeedSummaryQuery = ListItemsQuery.pick({
  platform: true,
  topicId: true,
  q: true,
  period: true,
  unread: true,
});

export const MarkAllReadBody = z.strictObject({
  view: ListItemsQuery.shape.view,
  platform: PLATFORM.optional(),
  topicId: z.number().int().positive().optional(),
  q: z.string().max(200).optional(),
  period: ListItemsQuery.shape.period,
});

export const MarkAllReadSchema = z
  .object({
    marked: z
      .number()
      .int()
      .meta({ description: 'How many unread items are now read' }),
  })
  .meta({ ref: 'FeedMarkAllRead' });

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
    quality: z.number().nullable(),
    noise: NOISE,
    gate: GATE.nullable(),
    topicId: z.number().int().nullable(),
    lead: z.string().nullable(),
    excerpt: z.string().nullable().meta({
      description:
        "The opening of the post's own text (body, else a summary beyond the title)",
    }),
    cover: z.string().nullable().meta({
      description:
        "The first image or a video's cover, a link on the platform's CDN",
    }),
    video: z.boolean().meta({ description: 'The post is a video' }),
    favorite: z.boolean(),
    later: z.boolean(),
    participated: z.boolean(),
    read: z
      .boolean()
      .meta({ description: 'I have opened the item or marked it read' }),
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
    read: z.boolean(),
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
  media: z
    .array(
      z.object({
        type: z.enum(['image', 'video']),
        url: z.string(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        cover: z.string().optional(),
        duration: z.number().optional(),
      }),
    )
    .meta({
      description:
        "Images and videos in display order: https links on the platform's CDN, never downloaded or analysed",
    }),
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
      quality: z.number().nullable(),
      qualityDetail: z
        .object({
          contentType: z.string(),
          substance: z.number(),
          novelty: z.number(),
          evidence: z.number(),
          usefulness: z.number(),
          noise: NOISE,
        })
        .nullable(),
      gate: GATE.nullable(),
      interestLevel: z.string(),
      interestReason: z.string().nullable(),
      experienceLevel: z.string(),
      experienceReason: z.string().nullable(),
      lead: z.string().nullable(),
      steps: z.array(z.object({ title: z.string(), detail: z.string() })),
      evidence: z.string().nullable(),
      uncertainty: z.string().nullable(),
      engine: z.enum(['rules', 'model', 'agent']),
      model: z.string().nullable(),
      contentVersion: z.number().int(),
      createdAt: z.string(),
    })
    .nullable(),
  analysisStale: z.boolean(),
  state: FeedItemStateSchema,
  enrichable: z.array(PART),
  agentReading: z
    .object({
      runId: z.number().int(),
      agentId: z.string(),
      startedAt: z.string(),
    })
    .nullable()
    .meta({
      description:
        'A runner agent is reading the item for a new analysis; null when none is',
    }),
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
  read: z
    .boolean()
    .optional()
    .meta({ description: 'Marks the item read (opening it does) or unread' }),
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
    unread: z
      .object({
        all: z.number().int(),
        discuss: z.number().int(),
        learn: z.number().int(),
        saved: z.number().int(),
        later: z.number().int(),
        participated: z.number().int(),
      })
      .meta({
        description: "How many of each view's items I have not read",
      }),
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
