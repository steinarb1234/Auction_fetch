# Uppboð auction change monitor

This bundle adds a scheduled GitHub Action that fetches `getSyslumennAuctions` from the public Ísland.is GraphQL endpoint and reports changes in one GitHub issue.

It tracks only auctions whose `auctionType` is:

- `Framhald uppboðs`
- `Sölu lokið`

Type matching is case-insensitive and ignores repeated surrounding whitespace.

## Behavior

- Runs every 15 minutes at `:07`, `:22`, `:37`, and `:52` in `Atlantic/Reykjavik`.
- Can also be started manually with **Actions → Uppboð auction change monitor → Run workflow**.
- Creates one issue named **Uppboð auction monitor** on its first run.
- Updates the issue body with the current filtered auction table when data changes.
- Shows **auction type** and **lot type** in separate report columns.
- Adds a change comment showing added, changed, and removed auctions, with the auction type included on every auction line.
- Treats a change between `Framhald uppboðs` and `Sölu lokið` as a changed auction and shows the old and new type.
- Treats an auction entering the tracked types as added, and an auction leaving the tracked types as removed.
- Does nothing to the issue when the feed is unchanged.
- Stores a compressed comparison snapshot in an HTML comment in the issue body, so it does not commit generated state into the repository.
- Migrates an older unfiltered monitor snapshot silently on the first run after this version is installed, avoiding a bulk removal notification.
- Uses only Node.js built-ins; no dependency installation is required.

## Install

Copy these paths into the repository default branch:

```text
.github/workflows/uppbod-auction-monitor.yml
scripts/uppbod-auction-monitor.mjs
```

The test file is optional:

```text
scripts/uppbod-auction-monitor.test.mjs
```

Run the test locally with:

```bash
node --test scripts/uppbod-auction-monitor.test.mjs
```

After merging to the default branch, run the workflow manually once to establish the baseline. Scheduled workflows use the latest commit on the default branch. For an existing installation, the first run upgrades the stored snapshot to the filtered format without posting an auction-change comment.

## Permissions and reporting destination

The workflow grants the built-in `GITHUB_TOKEN` only:

```yaml
permissions:
  contents: read
  issues: write
```

By default, the report issue is created in the repository running the workflow. If that repository has Issues disabled, put the workflow in a small monitoring repository instead.

To report into a different repository, set `REPORT_REPOSITORY=owner/repository` and replace `GITHUB_TOKEN` with a GitHub App token or fine-grained token that has Issues write access to the target repository. The built-in token normally cannot write to another repository.

## Change the frequency

Every 30 minutes:

```yaml
- cron: '7,37 * * * *'
  timezone: 'Atlantic/Reykjavik'
```

Every hour:

```yaml
- cron: '17 * * * *'
  timezone: 'Atlantic/Reykjavik'
```

GitHub Actions schedules are not guaranteed to start at the exact minute. Keeping the cron away from minute `0` reduces common congestion delays.
