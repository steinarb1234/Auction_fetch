# Uppboð auction change monitor

This bundle adds a scheduled GitHub Action that fetches `getSyslumennAuctions` from the public Ísland.is GraphQL endpoint and reports changes in one GitHub issue.

## Behavior

- Runs every 15 minutes at `:07`, `:22`, `:37`, and `:52` in `Atlantic/Reykjavik`.
- Can also be started manually with **Actions → Uppboð auction change monitor → Run workflow**.
- Creates one issue named **Uppboð auction monitor** on its first run.
- Tracks only `Framhald uppboðs` and `Sölu lokið` listings.
- Reports auction-type transitions and true removals from the source feed.
- Updates the issue body with the current filtered auction table when relevant data changes.
- Does nothing to the issue when the tracked feed is unchanged.
- Stores a compressed comparison snapshot in an HTML comment in the issue body, so it does not commit generated state into the repository.
- Uses only Node.js built-ins; no dependency installation is required.

## GraphQL request transport

The monitor sends the read-only `GetSyslumennAuctions` operation as a JSON `POST` request to the GraphQL endpoint. Keeping the GraphQL document out of the URL avoids query-string parsing and edge-filtering problems.

Client errors such as HTTP `400` are reported immediately and include the endpoint response in the GitHub Actions step summary. Temporary network failures, HTTP `408`, `425`, `429`, and `5xx` responses are retried with exponential backoff.

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

Run the tests locally with:

```bash
node --test scripts/uppbod-auction-monitor.test.mjs
```

After merging to the default branch, run the workflow manually once to establish the baseline. Scheduled workflows use the latest commit on the default branch.

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
