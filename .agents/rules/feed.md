# NocoFeed

NocoFeed is a personal interest feed: subscriptions collect items from public platforms, each item is analysed against
the person's topics and experience, and the person keeps their own marks and notes beside the analysis.

## Where it lives

- Schema: `database/main/migrations/202610280001_create_feed.ts` (seven `feed*` tables, all scoped by `ownerId`) and
  `202611020003_feed_analysis_quality.ts` (quality, priority, gates), `202610290001_feed_engagement.ts` (learned word weights, digest settings, dismissal, reply follow-up, source streaks).
  `202611040001_feed_topic_searches.ts` (topic search terms, platforms, schedule; `feedSources.topicId`).
  `202611050001_feed_runner_agent.ts` (`feedProfiles.readerAgentId`, `feedRuns.agentRunId`/`agentResult`).
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
- **Follow-up.** A Hacker News or Reddit `participationUrl` starts following the thread for two weeks
  (`nextFollowUp`: hourly, then every 4 h, then every 12 h). The first check records the baseline; later increases are
  sent once as `followUpNew` and cleared with `followUpSeen`. Reddit refuses most servers, so its checks often fail
  quietly and retry.
- **Source health.** Runs keep `failureStreak` and `emptyStreak`; `sourceHealth` calls a subscription `failing` after
  `FAILURE_ALERT` failures and `quiet` after `EMPTY_ALERT` empty runs spanning three days (single-item sources are never
  quiet). It is notified once until it recovers (`healthNotifiedAt`); configuration statuses (`unconfigured`,
  `unsupported`) do not count.

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
  noise kind, and the feed sorts by `priority` (`priorityOf`). "Analyze again" bypasses both gates. Rule analyses have no
  quality and rank at `NEUTRAL_QUALITY`.
- Measure a change to these before shipping it: `feed evaluate` and `feed export-labels`, see `docs/feed-evaluation.md`.
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
and `tests/client/feed-page.test.tsx` (views, digest, keyboard triage, density). Runner agents:
`tests/server/feed-runner-agent.test.ts` (hand-off, assembly, settling, fallbacks; an `ensureSystem` agent stands in
for a reported one), `tests/database/feed-runner-agent-migration.test.ts` and `tests/client/preferences-page.test.tsx`.
