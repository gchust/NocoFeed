# NocoFeed

NocoFeed is a personal interest feed: subscriptions collect items from public platforms, each item is analysed against
the person's topics and experience, and the person keeps their own marks and notes beside the analysis.

## Where it lives

- Schema: `database/main/migrations/202610280001_create_feed.ts` (seven `feed*` tables, all scoped by `ownerId`) and
  `202610290001_feed_engagement.ts` (learned word weights, digest settings, dismissal, reply follow-up, source streaks).
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

## Rules that keep it honest

- Analysis and the person's state are separate tables. Re-analysing never touches favourites, notes or participation.
- Every stored part carries coverage (`available`, `partial`, `missing`, …). The analysis states what it did not read;
  a new part bumps `contentVersion` and marks the analysis stale rather than silently rewriting it.
- Counts that are unknown are absent, never `0`. A run that could not reach items seen before is `partial`.
- Status messages, run errors and coverage notes are short codes translated in `feed.messages`/`feed.notes`; the
  client shows nothing for free text, which may be upstream HTML or an exception.
- The model comes from the agents plugin's default chat model (System settings → AI models) and is capped per person per
  day by `dailyLimit`; beyond it, or without a model, the keyword rules in `analyzer.ts` answer. Bump `RULES_VERSION` or
  `PROMPT_VERSION` when their output changes.
- Reddit refuses the JSON listing from most servers; the adapter falls back to the RSS feed and says so
  (`redditRssFallback`).

## Tests

`tests/database/feed-migration.test.ts` and `feed-engagement-migration.test.ts`, `tests/server/feed-routes.test.ts`
(sessions and owner isolation), `tests/server/feed-engagement.test.ts` (feedback weights, digest, dismissal, follow-up
and health notices with stubbed adapters), `tests/server/feed-analysis.test.ts` (parser, rules, weights and schedules)
and `tests/client/feed-page.test.tsx` (views, digest, keyboard triage, density).
