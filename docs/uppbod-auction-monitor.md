# Uppboð auction change monitor

This bundle adds a scheduled GitHub Action that fetches `getSyslumennAuctions` from the public Ísland.is GraphQL endpoint and reports changes in one GitHub issue.

## Tracked auction types

The monitor reports only these exact `auctionType` values:

```text
Framhald uppboðs
Sölu lokið
```

`Byrjun uppboðs` listings are ignored unless a listing that was previously tracked changes back to that type. In that case, the notification reports the auction-type change and states that the listing left the tracked types.

## Change behavior

- A new listing whose type is `Framhald uppboðs` or `Sölu lokið` is reported under **Added to tracked auctions**.
- A transition such as `Framhald uppboðs` → `Sölu lokið` is reported under **Changed**, including both the old and new auction types.
- All other field changes remain tracked while the listing is in either monitored type.
- A tracked listing that changes to an unmonitored type is reported as a type change and as having left the tracked types. It is not mislabeled as deleted.
- A tracked listing that is absent from the complete GraphQL response is reported under **Removed from source feed**, including its last known auction type.
- Additions, edits, and removals involving only `Byrjun uppboðs` listings do not produce notifications.

The current issue table includes separate **Auction type** and **Lot type** columns. The auction type is also included in every added, changed, and removed notification item.

## Schedule and reporting

- Runs every 15 minutes at `:07`, `:22`, `:37`, and `:52` in `Atlantic/Reykjavik`.
- Can also be started manually with **Actions → Uppboð auction change monitor → Run workflow**.
- Creates one issue named **Uppboð auction monitor** on its first run.
- Updates the issue body with the current filtered auction table when a relevant change occurs.
- Adds a comment showing relevant added, changed, and removed listings.
- Does not comment when the tracked data is unchanged.
- Stores a compressed filtered snapshot in an HTML comment in the issue body, so generated state is not committed to the repository.
- Uses only Node.js built-ins; no dependency installation is required.

## GraphQL request transport and failures

The monitor sends the read-only `GetSyslumennAuctions` operation as a JSON `POST` request. This matches the transport used by the Ísland.is server-side GraphQL client and avoids placing the complete GraphQL document in the URL.

The retry policy distinguishes temporary failures from request errors:

- Network failures, HTTP `408`, `425`, `429`, and `5xx` responses are retried with exponential backoff.
- Other HTTP `4xx` responses are not retried because repeating the same invalid request cannot resolve them.
- The endpoint response body is preserved in the workflow log and GitHub Actions step summary, making GraphQL validation and edge-policy errors visible.

## Upgrading the earlier monitor

The script can read the earlier `UPPBOD_AUCTION_SNAPSHOT_V1` state. On its first run after this upgrade, it rewrites that state to the filtered V2 format without reporting excluded `Byrjun uppboðs` listings as removals.

## Install

Copy these paths into the repository default branch:

```text
.github/workflows/uppbod-auction-monitor.yml
scripts/uppbod-auction-monitor.mjs
```

The test file is optional but recommended:

```text
scripts/uppbod-auction-monitor.test.mjs
```

Run the tests locally with:

```bash
node --test scripts/uppbod-auction-monitor.test.mjs
```

After merging to the default branch, run the workflow manually once to establish or upgrade the baseline. Scheduled workflows use the latest commit on the default branch.

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
