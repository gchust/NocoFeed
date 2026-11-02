# Measuring the feed's filtering

Whether a prompt or threshold change helps is measured on items a person labelled, not judged by eye. Each run asks the
same prefilter and analysis the feed uses, writes nothing to the feed, and compares them with the keyword rules.

## 1. Get labelled cases

Start from the "Useful" and "Not relevant" feedback already given:

```bash
pnpm nocobase app feed export-labels --output storage/feed-gold.jsonl
```

Then add 50-100 cases by hand, mostly hard ones: items that nearly belong and items that nearly do not. Easy cases make
the score look better without telling you anything. Each line is one case; `docs/feed-gold.example.jsonl` has examples.

```json
{
  "caseId": "c1",
  "label": "keep",
  "split": "development",
  "item": { "platform": "hn", "title": "…", "summary": "…", "body": "…" }
}
```

`label` is `keep`, `drop` or `either` (reasonable people would split; not counted). Give about a third of the cases
`"split":"holdout"`, tune against `development` only, and look at `holdout` at the end, so that the prompt does not
simply learn these cases. The labels should reflect the person whose topics are being used: the run reads that person's
current topics and profile.

## 2. Run it

```bash
pnpm nocobase app feed evaluate --gold storage/feed-gold.jsonl --split development
```

It prints precision (of what was kept, how much should have been), recall (of what should be kept, how much was),
accuracy, each misjudged case, and what each minimum priority would have kept. Every case with a model calls the
configured model and is priced like any other call. Keep the prompt version beside the figures when comparing runs.
