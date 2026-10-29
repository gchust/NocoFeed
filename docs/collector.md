# NocoFeed Collector protocol

NocoFeed fetches Hacker News, RSS/Atom, Reddit, YouTube channel uploads and single YouTube/Bilibili videos itself.
Anything that needs a search page or a signed-in browser — YouTube and Bilibili search, Xiaohongshu, X, and YouTube
subtitles — is delegated to a separate **Collector**: a small HTTP service, usually a Docker container running a
headless browser with the operator's own sessions. The application never stores platform cookies.

Configure it with `FEED_COLLECTOR_URL` and `FEED_COLLECTOR_TOKEN` (or `feed.collector` in `config.yml`). Without it,
those subscriptions stay in the status "Collector missing" and never report an empty result as a successful sync.

A ready-made implementation for Bilibili, YouTube, Xiaohongshu and X is [gchust/feed-collector](https://github.com/gchust/feed-collector)
(private): a Docker image with a dedicated browser you sign in to over noVNC.

Every request carries `Authorization: Bearer <FEED_COLLECTOR_TOKEN>` and a JSON body. Requests time out after
`feed.collector.timeoutMs` (180 s by default: a Collector runs one browser operation at a time, so a request may
wait in its queue first).

## `POST /v1/collect`

Lists new candidates for one subscription.

```json
{
  "platform": "xiaohongshu",
  "operation": "keyword",
  "target": "独立开发",
  "limit": 20,
  "cursor": null
}
```

Answer:

```json
{
  "status": "ok",
  "message": null,
  "truncated": false,
  "cursor": { "any": "state the Collector wants back next time" },
  "items": [
    {
      "externalId": "64f0…",
      "url": "https://www.xiaohongshu.com/explore/64f0…",
      "title": "…",
      "author": "…",
      "summary": "…",
      "body": "…",
      "comments": [{ "author": "…", "text": "…", "depth": 0 }],
      "transcript": [{ "start": 12.5, "end": 15, "text": "…" }],
      "metrics": { "likes": 120, "comments": 8 },
      "publishedAt": "2026-10-28T08:00:00Z",
      "coverage": {
        "body": { "status": "available" },
        "comments": { "status": "partial", "note": "topLevel:8/40" },
        "media": { "status": "unavailable", "note": "mediaNotAnalyzed" }
      }
    }
  ]
}
```

- `status` is one of `ok`, `partial`, `needsLogin`, `blocked`, `rateLimited`, `unsupported`, `failed`. Anything but
  `ok`/`partial` backs the subscription off (6 h for `needsLogin`/`unsupported`, twice the frequency when rate limited).
- `message` should be a short code, not prose; the interface shows known codes translated and hides anything else.
  Known codes: `collectorBusy`, `loginRequired`, `securityBlock`, `browserUnavailable`, `timeout`, `toolError`,
  `toolMissing`, `invalidTarget`, `notFound`, `upstreamError`, `networkError`, `outputLimit`, `unsupportedOperation`,
  `unsupportedPart`, `missingUrl`, `invalidResponse`; notes add `noTranscript` and `topLevel:<read>/<total>` (or
  `topLevel:<read>` when the total is unknown).
- Return items newest first. Set `truncated` when the page was full, so more may lie behind it. NocoFeed drops ids it
  already stores and marks a run `partial` when the page was full (`truncated`, or as many items as `limit`) and no
  stored item was reached, so it never claims completeness it does not have.
- Answer HTTP `401`/`403` only for a wrong token; NocoFeed reports that as `unconfigured`/`collectorUnauthorized`, not as
  a platform sign-in. A platform that needs signing in is `200` with `needsLogin`.
- Text targets are checked against `targetLength` in `server/providers/feed/catalog.ts` before a subscription is saved;
  keep those limits equal to what the Collector accepts.
- Counts that are unknown are **omitted**, never `0`. `coverage` states, per part, what was read (`available`,
  `partial`, `missing`, `unavailable`, `notRequested`, `failed`) and why (`note`). The analysis only reasons about parts
  marked as read.

## `POST /v1/enrich`

Fetches more material for one stored item when the person asks for it.

```json
{
  "platform": "youtube",
  "externalId": "abc123",
  "url": "https://www.youtube.com/watch?v=abc123",
  "want": ["transcript"]
}
```

Answer `{ "status": "ok", "message": null, "item": { "body": "…", "comments": […], "transcript": […], "coverage": {…} } }`
with only the parts it obtained. A part that could not be fetched is reported in `coverage` with its reason; earlier
material is kept. An empty `comments` list replaces stored comments only when `coverage.comments` is `available`
(the thread was read and has none); report an unreadable post as `failed`/`notFound`, not as an empty thread.
