# NocoFeed

NocoFeed is a personal interest feed: subscriptions collect items from public platforms, each item is analysed against
the person's topics and experience, and the person keeps their own marks and notes beside the analysis.

## Where it lives

- Schema: `database/main/migrations/202610280001_create_feed.ts` (seven `feed*` tables, all scoped by `ownerId`) and
  `202611020003_feed_analysis_quality.ts` (quality, priority, gates), `202610290001_feed_engagement.ts` (learned word weights, digest settings, dismissal, reply follow-up, source streaks).
  `202611040001_feed_topic_searches.ts` (topic search terms, platforms, schedule; `feedSources.topicId`).
  `202611100001_feed_briefs.ts` (`feedBriefs`, `feedProfiles.readingLanguage`).
  `202611050001_feed_runner_agent.ts` (`feedProfiles.readerAgentId`, `feedRuns.agentRunId`/`agentResult`).
  `202611060001_feed_item_media.ts` (`feedItems.media`: images and video links, see "The post first" below).
  `202611070001_feed_time_window.ts` (`feedProfiles.maxAgeDays`, `feedItems.timelineAt`).
  `202611080001_feed_run_window.ts` (`feedRuns.windowFilter`/`windowScanned`: how the Collector applied the window).
  `202611080002_feed_read_state.ts` (`feedItemStates.readAt`, see "Read state" below).
- Domain: `server/providers/feed/` — `catalog.ts` (platforms and operations; the single source of what is native and
  what needs the Collector), `adapters.ts` (fetching and parsing), `analyzer.ts` (rules and model prompt),
  `service.ts` (everything the routes call), `index.ts` (provider, notifications and the `collect-due-sources`,
  `check-follow-ups` and `send-digests` jobs).
- API: `server/routes/feed.ts` with schemas in `feed-schemas.ts`. Every route requires a session and answers only the
  caller's own rows; another person's id is a `404`, never a `403`.
- Pages: `client/pages/{feed,topics,sources,runs,preferences}`; shared types, formatting and badges are in
  `client/pages/feed/`. Copy lives in the `feed`, `topics`, `sources`, `runs` and `preferences` locale groups.
- Configuration: `server/config/feed.ts` (`FEED_COLLECTOR_URL`, `FEED_COLLECTOR_TOKEN`, `FEED_TICK_MINUTES`,
  `notificationChannel`, the in-app Channel notices go to); the Collector contract is `docs/collector.md`.
- Collector client (`createCollectorClient` in `adapters.ts`): requests use `feed.collector.timeoutMs` instead of the
  30 s public-platform limit, a `401`/`403` from the Collector is `collectorUnauthorized`, and long external ids are
  stored as `storedExternalId` hashes. Its tests are `tests/server/feed-collector-client.test.ts`; the reference
  Collector is the private `gchust/feed-collector`.

## Engagement

- **Feedback learns.** "Useful" / "Not relevant" moves the weight of the words that matched the item by ±1 within
  `TERM_WEIGHT_MIN`..`TERM_WEIGHT_MAX` (stored in `feedProfiles.termWeights`); changing or withdrawing feedback undoes
  the earlier step. Recent rule-based analyses mentioning those words are re-scored at once (never spending model
  budget), the reason says which weights applied, and the model prompt lists them.
- **Daily digest.** `GET /feedDigest` returns the top three `discuss` and top one `learn` items collected in the last
  24 hours; the client shows it as `/?view=digest`. `send-digests` sends it once per local day after `digestHour` in the
  person's `timeZone` (saved from the browser), keyed `feed-digest:<owner>:<date>`; a day with nothing sends nothing.
- **Triage.** `dismissed` hides an item from `all`/`discuss`/`learn` and their counts but keeps it in the personal views.
  The feed page has a compact density (remembered per browser) and single-key shortcuts (`use-feed-shortcuts.ts`) that
  never fire while typing or inside another dialog.
- **Read state.** `feedItemStates.readAt` is when the person first read the item; null or no state row is unread.
  Opening the detail sends `PATCH …/state { read: true }` once per opening (the page's `readOpening`, so a detail
  remounted after "Mark unread" or the `u` shortcut does not read it again); reading again keeps the first time.
  `unread=true` on `/feedItems` and `/feedItems/summary` goes through `feedQuery`, and the summary's `unread` object
  counts each view's unread items under the same filters. `POST /feedItems/markRead` marks what one view lists under
  the filters (`feedQuery` again), inserting state rows where none exist. Unread cards are bold with a dot
  (`data-read`). The migration took items already saved, joined, dismissed, noted or judged as read; the rest start
  unread.
- **Follow-up.** A Hacker News or Reddit `participationUrl` starts following the thread for two weeks
  (`nextFollowUp`: hourly, then every 4 h, then every 12 h). The first check records the baseline; later increases are
  sent once as `followUpNew` and cleared with `followUpSeen`. Reddit refuses most servers, so its checks often fail
  quietly and retry.
- **Source health.** Runs keep `failureStreak` and `emptyStreak`; `sourceHealth` calls a subscription `failing` after
  `FAILURE_ALERT` failures and `quiet` after `EMPTY_ALERT` empty runs spanning three days (single-item sources are never
  quiet). It is notified once until it recovers (`healthNotifiedAt`); configuration statuses (`unconfigured`,
  `unsupported`) do not count.

## Briefs and translations

- **A brief comes first.** For every item the feed shows (`discuss`/`learn`, not dismissed, not awaiting material,
  collected in the last three days) `briefPending` asks the default chat model, a few per tick, for a brief in the
  person's reading language: one sentence, then key points, as restricted Markdown (`brief.ts`). Foreign titles are
  translated with it. The card shows the translated title and the brief's first paragraph; the detail shows the brief
  above everything and folds the original. Opening an item without a brief writes one (`POST /feedItems/:id/brief`).
- **Reading language** is `feedProfiles.readingLanguage`: a tag from `READING_LANGUAGES`, `original` (the item's own,
  no translation), or null (follow the interface: `en-US` → `en`, else `zh-CN`). One `feedBriefs` row per item and
  language; changing the language shows nothing until the next ticks write the new ones.
- **Full text** is translated only when asked (`POST /feedItems/:id/translate`), stored in `feedBriefs.body` with the
  item version it came from (`bodyVersion`).
- **Budget.** Scheduled briefs count against `dailyLimit` on their own (rows written today); what the person asks for on
  one item does not.
- **Never HTML.** The material is untrusted, so the model writes Markdown, the server strips tags and any image that is
  not `media:N` of the item, and the client (`client/pages/feed/brief.tsx`) renders without raw HTML, with links as text
  and `media:N` resolved to the item's own image or video cover only.

## Topics and subscriptions

- **Subscriptions** (`feedSources` with `topicId` null) follow a thing that exists without the person's topics: an
  account, a channel, a community, an RSS feed, an HN list. Every topic can judge them.
- **Topics** say what the person wants (goal, avoid, mode). `sourceIds` limits which subscriptions a topic judges;
  empty means all of them. A topic's own searches are always judged by it (`topicsFor`).
- **Search-driven platforms** (every platform with a `keyword` operation: `SEARCH_PLATFORMS` in `catalog.ts`) are
  followed through topics: `searchTerms` × `searchPlatforms` (empty = every search platform) become `feedSources` rows
  with `topicId` set, kept in step by `syncSearches` inside the topic's transaction. Only the topic changes them:
  `/feedSources` lists direct subscriptions only, and PATCH/DELETE on a managed row answers `FEED_MANAGED_BY_TOPIC`.
  `POST /feedTopics/:id/run` starts them in the background (202). Older keyword subscriptions made directly keep
  working; the source form now points keyword searches to topics.
- Inside a transaction use only its connection: on SQLite the transaction holds the only connection, so a query
  through `database` deadlocks. Read what the transaction needs before it starts.
- `UpdateTopicBody` has no defaults on purpose: Zod's `.partial()` still applies `.default()`, which would reset an
  omitted field.

## Recommended subscriptions

- `/sources/recommended` (`client/pages/sources/recommended.tsx`, opened from "Browse recommended" on the subscriptions
  page, its empty state and the create form) lists `SOURCE_PRESETS` from `client/pages/sources/presets.ts` by category
  with a search over name, target and the translated description. "Subscribe" is the ordinary `POST /feedSources`
  (same server validation); a preset whose `presetKey` (platform, operation, normalized target) matches a direct
  subscription shows "Added".
- It is static client data, not a seed: nothing is written until the person subscribes. Descriptions and category names
  are in `sources.presets` in both locales; `name` is the publisher's own name. Only list operations that are
  subscriptions appear (RSS, Reddit, HN, YouTube channels by `UC…` id, X accounts); Bilibili and Xiaohongshu only
  search, which belongs to topics. The list is NocoFeed's own, built from each publisher's feed address; it took the
  category idea, not data, from horizon1123.top (whose robots.txt reserves AI use). Check new feed addresses with one
  request each before adding them.
- `resolveChannelId` reads a handle page's own channel (canonical link, `externalId`, `itemprop="identifier"`) before
  any `"channelId"`, which is often a recommended channel.
- Tests: `tests/client/source-presets.test.ts` (catalog support, target forms, duplicates, both locales, filtering,
  "Added"), `tests/client/sources-recommended.test.tsx` (the dialog) and `tests/server/feed-youtube-channel.test.ts`.

## The post first

- **Text and media are fetched, not only titles.** An operation with `prefetch` in `catalog.ts` (Xiaohongshu search,
  which lists only titles) gets the body of its title-only items without being asked: `prefetchWaiting` fetches up to
  `PREFETCH_PER_RUN` right after the run that brought them and `PREFETCH_PER_TICK` more on every `collect-due-sources`
  tick, for items collected in the last two days, within `PREFETCH_BUDGET_MS`. Each is an `enrich` run, and the analysis
  the item waited for (`gate: awaitingMaterial`) runs on the text. `needsLogin`/`blocked`/`rateLimited`/`unconfigured`
  stop it and leave the coverage untouched (tried again next tick); any other failure is recorded on the item and only
  the person's "Fetch" tries again.
- **Media** (`feedItems.media`, `MediaEntry` in `types.ts`) comes from the Collector with the body; `cleanMedia`
  (`media.ts`) keeps https links only. Links are the platform's signed CDN links: never downloaded or analysed, shown
  with `referrerPolicy='no-referrer'`, and a picture that fails says so. The prompt only says how many there are
  (`mediaLine`). The list item carries `excerpt`, `cover` and `video` so a card can show the post.
- **Pages show the original.** The card shows title, the opening of the text and the cover, with the analysis as one
  line; the detail shows the analysis as one collapsed line (`Collapsible`) above the media gallery and the text in its
  paragraphs (`content.tsx`); the analysis details, feedback and the material read open from that line.
- **YouTube plays in place** (`youtube.ts`, `YouTubePlayer` in `content.tsx`). The video id comes from the item's
  `url` (`watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `live/`, with `t=`/`start=` kept as the start) — on any
  platform, so a linked video plays too — and, for YouTube items, from `externalId` (`yt:video:<id>` or the bare id).
  Nothing is stored: the card's thumbnail (`i.ytimg.com/vi/<id>/hqdefault.jpg`, used only when the item has no
  `cover`) and the player are derived in the page. The detail shows the thumbnail and a play button; only the click
  loads the `youtube-nocookie.com/embed/<id>` iframe (sandboxed, `referrerPolicy='strict-origin-when-cross-origin'`,
  which YouTube's player needs). Shorts are 9:16, the rest 16:9. Without a readable id the item keeps only its link.
- **Content-Security-Policy.** The application sets none today (no header from the server or the dev server, no
  `<meta>` in `index.html`). Whoever adds one must keep the post first working:
  `frame-src https://www.youtube-nocookie.com`, `img-src https://i.ytimg.com` plus the platforms' https CDNs,
  `media-src` for their video links; and must not send `Cross-Origin-Embedder-Policy: require-corp`, which blocks the player.

## Time window

- A feed is about what is new. `feedProfiles.maxAgeDays` (Preferences, 7 by default, 0 = keep everything) is how far
  back a collected item may have been published. `collectWindow` in `service.ts` gives each list run a `cutoff` and a
  `since`: the cutoff on the first run, afterwards a day before `lastSuccessAt` (`SINCE_OVERLAP_MS`), never before the
  cutoff. Single-item operations have no window.
- `since` goes to the adapters (`CollectRequest.since`); the Collector narrows platform searches with it (see
  `docs/collector.md`), native lists are already newest first. `withinWindow` then drops every item published before
  the cutoff (undated items stay) and, when it dropped one, clears `truncated`: the list reached past the window.
- The Collector may say how it applied `since` (`CollectResult.window`, `collectWindowOf` in `adapters.ts`):
  `platform` or `local` (the platform could not search by date, e.g. Xiaohongshu's AI search page; it read
  `scanned` results and kept the dated ones inside the window). `runSource` stores it on the run, and `toRun` adds
  `windowShort` (a first run filtered locally found fewer than `candidateLimit`); the runs page shows both and links
  to Preferences to widen the window. Unknown or absent values are null.
- An item already stored (`ownerId`, `platform`, `externalId`) is never inserted or analysed again; only the run's new
  ids go to `analyzeItems`.
- `feedItems.timelineAt` is `publishedAt`, else the collection time; every insert sets it. The feed's `sort=newest`
  (the default, in the API and on the page; `sort=priority` is asked for) and `period` (`day`/`week`/`month`, also on
  `/feedItems/summary`) use it, because the query builder has no `COALESCE`. The digest picks by priority and shows its
  picks newest first.
- Tests: `tests/server/feed-time-window.test.ts`, `tests/database/feed-time-window-migration.test.ts`,
  `tests/database/feed-run-window-migration.test.ts`, `tests/client/runs-page.test.tsx`, the `since` and `window`
  cases in `feed-collector-client.test.ts`.

## Rules that keep it honest

- Analysis and the person's state are separate tables. Re-analysing never touches favourites, notes or participation.
- Every stored part carries coverage (`available`, `partial`, `missing`, …). The analysis states what it did not read;
  a new part bumps `contentVersion` and marks the analysis stale rather than silently rewriting it.
- Counts that are unknown are absent, never `0`. A run that could not reach items seen before is `partial`.
- The feed rail's view counts come from `GET /feedItems/summary` with the list's `platform`, `topicId` and `q`, and
  `listItems` and `summary` share one query (`feedQuery`), so a count is always what that view lists under the filters.
- Status messages, run errors and coverage notes are short codes translated in `feed.messages`/`feed.notes`; the
  client shows nothing for free text, which may be upstream HTML or an exception.
- The model comes from the agents plugin's default chat model (System settings → AI models) and is capped per person per
  day by `dailyLimit`; beyond it, or without a model, the keyword rules in `analyzer.ts` answer. Bump `RULES_VERSION` or
  `PROMPT_VERSION` when their output changes.
- Filtering has three stages. A keyword miss goes to a batched **prefilter** that only stops what the text shows to be
  unrelated and fails open; it does not count against `dailyLimit`. A **bare title** with something left to fetch gets the
  rules and `gate: awaitingMaterial`, and enriching it runs the analysis it was waiting for. The **full analysis** rates
  relevance (`score`) and worth (`quality`) apart: the server computes `quality` from the model's axes and caps it by
  noise kind, and `sort=priority` and the digest's picks use `priority` (`priorityOf`). "Analyze again" bypasses both gates. Rule analyses have no
  quality and rank at `NEUTRAL_QUALITY`.
- **Unproven is worthless.** Worth has to be shown by the material: the prompt tells the model that what it cannot tell
  to be useful is not, and a launch of the author's own product (free or not, "Show HN") without a method or results
  is `promo`. `promo`, `teaser` and `hype` are capped below `LOW_QUALITY` (35), so they are hidden; `roundup` and
  `routine` only rank low. Low worth hides an item whether the body was read or only a blurb. After changing a cap or
  the threshold, run `feed reapply-worth` (`--dry-run` first): it recomputes stored quality from the model's axes and
  only ever hides, calling no model.
- Measure a change to these before shipping it: `feed evaluate` and `feed export-labels`, see `docs/feed-evaluation.md`.
- **Publication times.** `publishedAt` is null when the platform gave none; `timelineAt` then holds the collection time
  so the item can still be placed, and the feed labels it "collected …" — never as the publication time.
  `publishedApproximate` marks a time worked out from relative text (YouTube search, "about 3 weeks ago"). The
  `collect-due-sources` tick runs `resolvePublishedTimes`: for YouTube items collected in the last 30 days with no or an
  approximate time, it asks the Collector (`want: ["published"]`, the video page) for the exact time, a few videos per
  tick, and moves every owner's copy to it; `publishedCheckedAt` keeps a video from being asked again within a day
  (`202611090001_feed_published_precision.ts`, `tests/server/feed-published-times.test.ts`).
- Reddit refuses the JSON listing from most servers; the adapter falls back to the RSS feed and says so
  (`redditRssFallback`).

## Runner agents

The Agents plugin (`@nocobase/app-plugin-agents`, read its Skill in `.agents/skills/nocobase-app-plugin-agents/`)
serves two things here: the model gateway above, and **runner agents** — coding tools (Claude Code, Codex, …) on a
runtime someone connects, which can open pages themselves. NocoFeed hands one task to them:

- **"Analyze again" on one item** (`agent-reader.ts`). When the person picks a runner agent under Interests & skills
  (`feedProfiles.readerAgentId`, offered from the plugin's `useAgentOptions`), `reanalyzeItem` queues a run on the
  `feedItem` subject instead of calling the model: the brief is `buildPrompt`'s system and prompt plus "open the original
  and its discussion", carried in the run's input payload, so the claim's `assemble` only reads that input and the item
  row (database reads on the claim connection, as the plugin requires). A `feedRuns` row (`stage: analyze`,
  `agentRunId`) waits for it and the item detail shows `agentReading`; asking again while it reads queues nothing more.
- The run's last message (`Run.summary`) must be the analysis JSON. `onRunFinished` only stores how the run ended on
  `feedRuns.agentResult` inside the plugin's transaction; `settleAgentReads` (one second later, and on every
  `collect-due-sources` tick) claims the row with a guarded `running → settling` update, parses the answer with
  `parseModelAnswer` into an analysis with `engine: 'agent'`, or **falls back** to `analyzeItems` (model gateway, then
  rules) with run status `fellBack` and the code `agentFailed` / `agentCancelled` / `agentAnswerUnreadable`.
- Falls back at once, with no run queued, when no agent is chosen, the plugin is missing, or the agent is not workable
  (disabled, removed). A queued run no runner takes fails `queuedExpired` after `AGENT_QUEUE_EXPIRY_MS` (30 min) and
  falls back too. Agent analyses do not count against `dailyLimit`, which caps model-gateway calls.
- Administration lives under System settings (`client/routes.ts`): AI models, **Agents** (enable what runtimes report),
  **Runtimes** (connect a machine; `runtimes-connect` is labelled in `page-permission-titles.ts`) and **Agent usage**,
  each behind the plugin's own page grant. Runs on `feedItem` are `private`: only the person who asked sees them.
- Candidates not moved yet: topic searches on login-bound platforms (today the Collector) and the prefilter/batch
  analysis, which stay on the model gateway because they run unattended in bulk.

## Tests

`tests/database/feed-migration.test.ts` and `feed-engagement-migration.test.ts`, `tests/server/feed-routes.test.ts`
(sessions and owner isolation), `tests/server/feed-engagement.test.ts` (feedback weights, digest, dismissal, follow-up
and health notices with stubbed adapters), `tests/server/feed-analysis.test.ts` (parser, rules, weights and schedules)
`tests/server/feed-topic-searches.test.ts` and `tests/database/feed-topic-searches-migration.test.ts` (topic searches,
which topics judge what), `tests/client/topics-page.test.tsx` (topic searches in the form and on the card)
and `tests/client/feed-page.test.tsx` (views, digest, keyboard triage, density, read state, the brief first, then the post: excerpt,
cover, gallery, video, paragraphs, the YouTube player and card thumbnail; `tests/client/feed-youtube.test.ts` reads
video ids). Briefs: `tests/server/feed-briefs.test.ts` and `tests/database/feed-briefs-migration.test.ts`. Read state and the default order: `tests/server/feed-read-state.test.ts` and
`tests/database/feed-read-state-migration.test.ts`. Text and media: `tests/server/feed-media-prefetch.test.ts`,
`tests/database/feed-item-media-migration.test.ts` and the media case in `feed-collector-client.test.ts`. Runner agents:
`tests/server/feed-runner-agent.test.ts` (hand-off, assembly, settling, fallbacks; an `ensureSystem` agent stands in
for a reported one), `tests/database/feed-runner-agent-migration.test.ts` and `tests/client/preferences-page.test.tsx`.
