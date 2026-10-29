# NocoFeed

English | [简体中文](docs/README.zh-CN.md)

NocoFeed is an open-source personal interest feed built on [NocoBase 3](https://www.nocobase.com). It watches Hacker
News, Reddit, RSS, YouTube and Bilibili for you, and tells you which discussions you can usefully join and what is
worth learning from — and on which material each judgement rests.

## What it does

- **One feed, ranked for you.** Subscriptions bring in new posts; each is matched against your topics and your real
  experience, and marked "join in", "learn" or "skip".
- **Honest analysis.** Keyword rules by default, or your own AI model when configured. Every analysis says what it read
  and what it could not.
- **Today's digest.** The three best discussions and the best thing to learn from in the last 24 hours, in your inbox
  at the hour you choose.
- **Learns from feedback.** "Useful" and "Not relevant" reweigh the words that matched, and the feed re-ranks at once.
- **Fast triage.** A compact list with keyboard shortcuts: `j`/`k` move, `s` save, `l` later, `x` dismiss, `o` open.
- **Follows up for you.** Paste the link to your Hacker News or Reddit reply, and get told when someone answers.
- **Watches your sources.** Subscriptions that keep failing or go quiet are flagged.

## Quick start

You need Node.js 24 or later and pnpm 11 (`corepack enable`).

```bash
git clone https://github.com/gchust/NocoFeed.git
cd NocoFeed
pnpm install
pnpm nocobase config init --dialect sqlite
pnpm dev
```

Open the `Local:` address `pnpm dev` prints, normally `http://127.0.0.1:13000/main/`, and sign in as `nocobase` with
the password `admin123` (change it before exposing the app). Then:

1. Describe yourself under **Interests & skills**.
2. Add what you follow under **Topics**.
3. Add sources under **Subscriptions** and press **Run now**.

Optional: add an AI model under **System settings → AI models** for model-written analysis, and see
[`docs/collector.md`](docs/collector.md) to connect platforms that need a signed-in browser (Xiaohongshu, X, video
search and subtitles).

[Development and deployment](docs/development.md) covers configuration, upgrades, building and Docker.
