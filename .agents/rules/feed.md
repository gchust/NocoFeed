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
  `202611200001_feed_source_options.ts` (`feedSources.options`: a mail subscription's folder and filters, see "Mail
  and push" below).
  `202611210001_feed_reply_drafts.ts` (`feedReplyDrafts`, `feedProfiles.replyGuidelines`/`replyPlatformGuidelines`,
  see "Reply drafts" below).
  `202611250001_feed_ideas.ts` (`feedIdeas`, `feedIdeaSettings`: see "Ideas" below).
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

## Mail and push

Two ways in that are not public platforms (issue #13); both are the person's own, scoped by `ownerId` like the rest.

- **Mail** (`platform` `mail`, operation `messages`, `input: 'account'` in `catalog.ts`) reads one of the person's
  accounts through the Mail plugin (`mail.ts`): `MailService` resolved from `mailServiceToken`, always with
  `actorId` = the subscription's owner, using only `listAccounts`, `listFolders`, `listMessages` and `getMessage` — so
  collecting never marks, moves or deletes anything, and another person's account id reads nothing. `target` is the
  Mail account id, `feedSources.options` holds `folder` (type or name; empty = inbox), `senders` and
  `subjectKeywords`. Messages come newest first and stop at the run's `since`, so the time window works as for any
  list; the filters apply locally. Each message becomes an item: Message-ID as `externalId` (else
  `mail:<account>:<id>`), subject as title, plain text or cleaned HTML as body, sender as author, received time as
  `publishedAt`. The Mail plugin syncs mailboxes on its own schedule; a NocoFeed run reads what it has synced. `withMail`
  wraps the adapters, `deps.mailAccounts` checks a new subscription's account belongs to the caller
  (`FEED_MAIL_ACCOUNT_MISSING`). People connect accounts at `/mail/accounts` (the plugin's `MailAccountsPage`, behind
  its `mail.workspace` page grant; `mail.oauthReturnUrl` points there). `GET /feedMailAccounts` lists the caller's own.
- **Push** (`POST /feedItems/ingest`, `server/routes/feed-ingest.ts`, `ingest.ts`) stores what a script, a bookmark or
  a future browser extension sends into the person's push inbox: one `feedSources` row with `platform` `inbox`, made
  on the first push, `active: false` and never due, hidden from `/feedSources`; run/PATCH/DELETE on it answer
  `FEED_PUSH_SOURCE`. A `url` alone is read: YouTube/Bilibili/Xiaohongshu/X single items through their adapters
  (`platformOfUrl`), anything else as an article (`page.ts`: public http(s) addresses only, every redirect checked
  again, 2 MB, HTML or text); a link that cannot be read is still kept with the failure on its coverage. `title` and
  `content` store a post as sent. Duplicates (by `externalId`, else the link — any platform's item with the same link —
  else a hash of title and text) answer 200 `duplicate: true`. Items are `platform` `inbox`; the prefilter and the
  analysis run in the background. The route takes a session or an API key (`x-api-key`, the API Keys plugin), refuses
  bodies over 256 KB (413) and never takes an owner from the request. `/sources/push` explains it with curl examples
  and manages the person's API keys.
- Tests: `tests/server/feed-mail-source.test.ts` (fake `MailService`; filters, window, dedupe, read-only, isolation),
  `tests/server/feed-ingest.test.ts` (page extraction, address checks, platform links, dedupe),
  `tests/server/feed-ingest-routes.test.ts` (session, API key, unauthenticated, other people, size, validation),
  `tests/database/feed-source-options-migration.test.ts`, `tests/client/sources-mail-push.test.tsx`.

## Engagement

- **Feedback learns.** "Useful" / "Not relevant" moves the weight of the words that matched the item by ±1 within
  `TERM_WEIGHT_MIN`..`TERM_WEIGHT_MAX` (stored in `feedProfiles.termWeights`); changing or withdrawing feedback undoes
  the earlier step. The weights are saved with the feedback; the recent rule-based analyses mentioning those words are
  re-scored after the response by the `nocofeed.rescore-feedback` job (`rescore-job.ts`, a `JobExecutor` one-off task;
  without the executor the service runs it detached), one person's re-scores one after another, yielding to requests
  between items (SQLite answers synchronously). Never spends model budget; the reason says which weights applied, and the
  model prompt lists them. The list shows the new scores on its next load.
- **Marks answer at once.** Save, later, joined, read, dismiss and feedback go through the page's mark writer
  (`use-item-state.ts`): the card, the detail and the view counts change on click, the `PATCH …/state` follows in the
  background, one request at a time per item and mark (a `SubmissionController` each, sending `Idempotency-Key`; the
  route then applies the change once through `executeIdempotentMutation`), quick clicks collapse to the last value, and a
  failure puts the mark back with a toast and a retry. A request whose outcome is unknown is retried with its original
  key before any newer value is sent. Nothing reloads the list; the counts are fetched again quietly once every mark is
  saved. Notes and the participation record are forms with their own save button.
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

## Reply drafts

Replies the person can copy to join a discussion (issue #15): `server/providers/feed/replies.ts` (its own service,
`feedRepliesToken`), `server/routes/feed-replies.ts`, `client/pages/feed/replies.tsx` (the "Join the discussion" card
under the analysis on the detail) and `client/pages/preferences/reply-guidelines.tsx` (the "Reply style" card).

- **Language of the post, not of the reader.** Drafts are written in the language of the post and its site
  (`postLanguage` guesses it from the script and tells the model plainly; Xiaohongshu and Bilibili default to Chinese),
  in the platform's style (`PLATFORM_STYLES`). Only the notes beside each draft (`tone`, `image` idea) follow the
  interface language. Briefs follow the reading language; do not mix the two.
- **The person's rules.** `feedProfiles.replyGuidelines` (null = `DEFAULT_REPLY_GUIDELINES` for their interface
  language, the issue's own text) plus `replyPlatformGuidelines[platform]`, added after the general rules for that
  platform (`effectiveGuidelines`). They go into the prompt as trusted text; the material stays untrusted.
  `GET|PUT /feedReplyGuidelines` reads and saves them apart from `/feedProfile`, so other features can add their own
  rules beside them; saving empty text or a default keeps following the default. Each row keeps `guidelinesVersion`
  (a hash of the rules it was written with) and the card says when the rules changed since.
- **When they are written.** `pending()` runs on the `collect-due-sources` tick after the briefs: recent (3 days)
  `discuss` items, not dismissed, not waiting for their text, with no row yet, `REPLY_PER_TICK` per tick, counted
  against `dailyLimit` (rows with `trigger: auto` updated today). A failed automatic attempt is not retried until the
  person asks. Any item gets drafts on demand: `POST /feedItems/:id/replies` answers 202 `pending` and the model writes
  in the background (one run per item in this process; a pending row older than `PENDING_STALE_MS` counts as failed);
  the card polls `GET /feedItems/:id/replies`. Asked drafts do not count against the limit. A failure keeps the earlier
  drafts. At least `MIN_DRAFTS` (3) usable replies, else one retry, else `failed`.
- **Copy.** Copying never changes the person's marks; the toast offers "Mark as joined", which goes through the mark
  writer. Drafts render as plain text (tags stripped on the server), never Markdown or HTML; no images are generated.
- Tests: `tests/server/feed-replies.test.ts` (prompt language, rules, parsing, discuss-only ticks, background requests,
  limit, owner, routes), `tests/database/feed-reply-drafts-migration.test.ts`, `tests/client/feed-replies.test.tsx`.

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
- **Heat is attention, not worth.** `heat.ts` turns a platform's counts into 0–100 (weights per platform on a log scale,
  `HOT_HEAT` 60 ≈ the platform's front page); null when the platform gives no counts it can weigh. `feedItems.heat` is
  the latest, `heatAtCollection` the value at collection (to check later whether what was recommended went on to trend),
  `metricsCheckedAt` the last read (`202611110001_feed_item_heat.ts`). The `collect-due-sources` tick runs `refreshHeat`:
  items published in the last `HEAT_WINDOW_MS` (3 days) on `REFRESHABLE_PLATFORMS` (HN, Reddit, Bilibili — read
  natively through `adapters.metrics`; Collector platforms keep the counts from collection) are read again every
  30 min / 2 h / 6 h by age, one lookup per external id for every owner. An item that crosses `HOT_HEAT` and was only
  judged by the rules or stopped at a gate has its comments fetched and gets the full analysis past both gates
  (`lookAtHotItem`, at most `HOT_ANALYSES_PER_TICK`, counted against `dailyLimit`). The model prompt shows the counts
  as ENGAGEMENT and is told never to raise quality for them.
- **Two ways in: `hot` and `solid`.** Both views list only recommended items (`discuss`/`learn`, not dismissed).
  `hot` adds `heat >= HOT_HEAT` within the heat window and sorts by heat under `sort=priority`; `solid` adds
  `quality >= SOLID_QUALITY` (60, so only model analyses) and sorts by quality. The client opens both in that order
  (`defaultSort`). The digest leads with the three hottest recommendations published in the last day and does not
  repeat them below. HN `top` and `best` are ranked lists: they are never `truncated`, since they are not in time order.
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

## Ask about an item

The detail has an "Ask about this item" section (`client/pages/feed/ask.tsx`, `server/providers/feed/ask.ts`,
`server/routes/feed-ask.ts`): a conversation per person and item about what the item says and what it mentions.

- **No table of ours.** The Agents plugin keeps the conversation (OnlineAgent native session, hidden from its chat
  list); NocoFeed ties it to the item with a `feedItem` conversation link (`conversations.links.registerKind`, resolved
  to the owner's items only). "The person's conversation about an item" is `links.linkedTo` filtered by owner, newest.
- **Routes.** `GET|POST|DELETE /feedItems/:id/ask` (state; open, which creates the session on the first question;
  clear, which deletes the conversations and cancels open runner questions) and `POST /feedItems/:id/ask/runner`. They
  need a session plus the authorization middleware (the session's `OnlineAgentContext`), and another person's item is a
  `404`. Messages, streaming, history and Stop go to the plugin's own `/api/agents/conversations/:id/…` routes through
  `ChatApi` (`@nocobase/app-plugin-agents/client/chat`) and `useChat` from `@ai-sdk/react`; the plugin checks ownership.
- **Context.** `askSystemPrompt` (title, link, brief, body, subtitles, comments, our analysis, the person's interests;
  material marked untrusted) is passed as the trusted `systemPromptTemplate` when NocoFeed creates the session, so it
  is the snapshot of the item at the first question. Scope `nocofeed-ask` (`agentId: 'online'`) replaces the default
  tools with `feed_read_item`, `feed_read_original` and `feed_read_comments`, which find the item through the
  conversation's own link (never model input) and read it as its owner.
  `webSearch` is on when the default model's provider supports native search (`models.services.capabilities`); without
  it (DeepSeek and OpenAI-compatible services today) the prompt tells the model it cannot check outside facts. There is
  no substitute `web_search` tool: neither NocoFeed nor the Collector has a search backend for the open web.
- **Material before the first question** (`prepare`). Opening the conversation fetches the parts the item lacks —
  those its platform's catalog operations list in `enrich` whose coverage is not `available`/`partial` — through the
  service's `fetchParts` (the same `fetchMaterial` as the person's "Fetch": stored on the item with a `feedRuns`
  `enrich` row, so the next conversation finds them; unasked failure rules, so a sign-in, block, rate limit or missing
  Collector leaves the coverage alone). A link-only item whose text is not `available` gets its page read by `page.ts`
  into the prompt (not stored). It waits at most `ASK_PREPARE_MS` (20 s); a slower fetch goes on in the background and
  is stored when it lands (`fetchFor` dedupes by owner, item and parts). Nothing here fails the conversation. The prompt's
  `MATERIAL STATUS` (`describeMaterial`) lists each part as stored, fetched just now, or not read with its reason, and
  the model is told to say briefly what it could not read and why.
- **Where the original is read** (`originalRoute`). A link that is the platform's own post (X, Xiaohongshu, Reddit,
  YouTube, Bilibili, a Hacker News discussion; `PLATFORM_HOSTS`) goes through the adapters or the Collector —
  `['body', 'comments']`, `['transcript']` for a video, narrowed to what `enrichableFor` allows — and the answer is the
  item as stored afterwards. Any other link is a web page read by `readPageText` (`page.ts`: public addresses only,
  every redirect checked). `feed_read_comments` fetches the discussion unless comments were read in the last 30 minutes.
- **Failures are structured** (`ReadFailure`: `reason` — `needsLogin`, `blocked`, `rateLimited`, `timeout`,
  `unconfigured`, `unsupported`, `notFound`, `notPublic`, `noLink`, `failed` — plus `retryable`, `detail` and an
  `explanation` for the model). Tool answers carry `status` (`ok`, `stored` when only what was stored before could be
  given, `unavailable`), `via` (`native`, `collector`, `page`) and `failure`; the public output (`url`, `status`,
  `reason`, `count`) lets the page say "Could not read the discussion: …" (`feed.ask.tools.reasons`).
- **Reddit from a server.** Reddit answers its JSON with 403 to many server addresses (the 252 deployment included,
  through its proxy) but serves a post's RSS (`/r/<sub>/comments/<id>/.rss?limit=100`): `enrichReddit` falls back to it
  (`enrichRedditFeed`) — the post is the `t3_` entry, each comment a `t1_` entry, flat (`depth: 0`), so comments are
  `partial` with note `redditRss`. Reddit rate-limits that feed quickly (429 → `rateLimited`, retryable). The
  Collector does not read Reddit.
- **Runner.** With a workable `readerAgentId`, "Ask … to dig deeper" queues a run on the `feedItem` subject in thread
  `ask` (`ASK_THREAD`, trigger `ask`; `feedItemSubject` dispatches the claim's assembly and `onRunFinished` by thread).
  The question is delivered into the conversation as a `news` notice `nocofeed.askQueued`; when the run ends its
  summary arrives as `nocofeed.askAnswer` (`conversations.deliver` in the run's transaction). One open runner question
  per item (`409`); the page polls while `runnerPending`. The native model does not see runner answers in later turns.
- **Unconfigured.** Without a chat model the section shows a notice linking to `/settings/models` and Preferences; the
  runner path also needs the model, because the conversation it answers into is a native session.
- Answers render as Markdown without raw HTML or images; links open in a new tab with `noopener noreferrer`.
- **No silent gaps** (feedback #18). An answer that failed, came back with nothing to show, or never came (the last
  message is the question) says so with "Retry", which is the plugin's resend (`regenerate` with `resendInput`: the
  question stays, what follows it is replaced). Loading the section shows a spinner line; a section that cannot be
  read says so with "Retry" instead of disappearing. On the detail, sibling sections need distinct keys
  (`ask:<id>`, `ideas:<id>`): with the same key React lost track of the Ask section on every redraw and left dead
  copies of it on the page (`feed-page.test.tsx` checks there is one and that React reports no duplicate keys).
- Tests: `tests/server/feed-ask.test.ts` (sessions, other owner's 404, unconfigured, context, a fake OpenAI-compatible
  model calling `feed_read_item` — and `feed_read_comments` on an X post without a Collector, whose structured failure
  reaches the model — through the real chat route, persistence and clearing, runner queue/assembly/answer),
  `tests/server/feed-ask-material.test.ts` (routing by platform, failures, preparation with its deadline and failures,
  the page of a link-only item, the Reddit RSS fallback, comments stored and not fetched again) and
  `tests/client/feed-ask.test.tsx`.

## Ideas

The detail has an "Ideas" section (issue #16; `client/pages/feed/ideas.tsx`, `server/providers/feed/ideas.ts`,
`server/routes/feed-ideas.ts`): things the person could publish from the item — Xiaohongshu notes (title, body with
emoji and tags, cover), X posts or threads, 30–60 s short-video scripts (shots with visual / line / caption / seconds),
Bilibili plans (title, description, 3–5 outline parts) and memes (caption, picture composition, the trend it plays
on; never an image). Two per kind.

- **Tables.** `feedIdeas`: one row per person, item and kind with the ideas as JSON, `status` (`pending` / `ready` /
  `failed` + code `noModel` / `ideasFailed`; a pending row older than `IDEAS_PENDING_TIMEOUT_MS` reads as `timeout`),
  `styleVersion` (hash of the style), `model`, `webSearch`, `trigger` (`manual`/`auto`), `generatedAt`.
  `feedIdeaSettings`: per person `style` (null = `DEFAULT_IDEA_STYLE`; saving the default unchanged stores null),
  `kinds` (null = all), `auto`, `xLanguage` (null = English). Kept apart from `feedProfiles` on purpose.
- **Routes.** `GET|POST|DELETE /feedItems/:id/ideas` (state; start generating the given or chosen kinds → `202`, `409`
  while one runs for the item, `503` without a model; delete all or `?kind=`), `POST /feedItems/:id/ideas/again`
  (`{ kind, index }`: one new idea in place of that one, the others kept and shown to the model as "already
  suggested"), `GET|PUT /feedIdeaSettings`. Session plus the authorization middleware (the online agent acts as the
  caller); another person's item is a `404`.
- **Background.** The route marks rows pending and answers; the work runs detached (`settled()` awaits it in tests); the
  card polls every `IDEAS_POLL_MS` while a set is pending. Answers are normalized per kind (`normalizeIdea`): tags
  stripped, X posts over `X_POST_LIMIT` (280) split at sentence ends (`splitPost`), script shots scaled into 30–60 s,
  outlines cut to five; a kind with nothing usable is `ideasFailed`. One retry when the answer is cut off.
- **Model.** The prompt has the item (title, link, brief, analysis lead, summary, body), up to six related items (the
  latest favourites and the best recent recommendations), the style, and the reading language (Xiaohongshu/Bilibili
  always Simplified Chinese, X in `xLanguage`). When the person asks and the default model supports native web search
  (`models.services.capabilities`), a background OnlineAgent session (`onlineAgent.background`, `webSearch: true`,
  `tool: []`, JSON Schema `ideasSchema`) writes them and is deleted afterwards; if that fails, or search is not
  supported, `models.gateway.generate` writes them from the item alone and the card says so. Manual generation does
  not count against `dailyLimit`.
- **Automatic.** With `auto` on, the `collect-due-sources` tick runs `ideasPending`: `discuss` items collected in the
  last two days, not dismissed, without ideas, best first, `IDEAS_PER_TICK` per tick and at most
  `min(10, dailyLimit)` items a day per person; gateway only (no person to act as, so no web search).
- **Preferences.** `client/pages/preferences/ideas.tsx` (`IdeaSettingsCard`) saves on its own: style textarea with
  "Use the default", kind checkboxes (at least one), X language, automatic switch. Changing the style marks earlier
  ideas `stale`.
- Copy is in `feed.ideas` and `preferences.ideas`. Tests: `tests/server/feed-ideas.test.ts` (prompt, structure per
  kind, routes with a fake OpenAI-compatible model, other owner's 404, settings, automatic, online/gateway choice),
  `tests/client/feed-ideas.test.tsx`, `tests/database/feed-ideas-migration.test.ts`.

## Tests

`tests/database/feed-migration.test.ts` and `feed-engagement-migration.test.ts`, `tests/server/feed-routes.test.ts`
(sessions and owner isolation), `tests/server/feed-engagement.test.ts` (feedback weights, digest, dismissal, follow-up
and health notices with stubbed adapters), `tests/server/feed-analysis.test.ts` (parser, rules, weights and schedules)
`tests/server/feed-heat.test.ts` and `feed-heat-adapters.test.ts` (heat, refresh, hot/solid views, digest),
`tests/server/feed-topic-searches.test.ts` and `tests/database/feed-topic-searches-migration.test.ts` (topic searches,
which topics judge what), `tests/client/topics-page.test.tsx` (topic searches in the form and on the card)
and `tests/client/feed-page.test.tsx` (views, digest, keyboard triage, density, read state, the brief first, then the post: excerpt,
cover, gallery, video, paragraphs, the YouTube player and card thumbnail; `tests/client/feed-youtube.test.ts` reads
video ids). Briefs: `tests/server/feed-briefs.test.ts` and `tests/database/feed-briefs-migration.test.ts`. Read state and the default order: `tests/server/feed-read-state.test.ts` and
`tests/database/feed-read-state-migration.test.ts`. Text and media: `tests/server/feed-media-prefetch.test.ts`,
`tests/database/feed-item-media-migration.test.ts` and the media case in `feed-collector-client.test.ts`. Runner agents:
`tests/server/feed-runner-agent.test.ts` (hand-off, assembly, settling, fallbacks; an `ensureSystem` agent stands in
for a reported one), `tests/database/feed-runner-agent-migration.test.ts` and `tests/client/preferences-page.test.tsx`.
