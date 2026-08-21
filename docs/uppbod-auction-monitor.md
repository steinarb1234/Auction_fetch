# Uppboð auction monitor, SQLite history, and GitHub Pages search

This package extends the scheduled Uppboð monitor with a persistent, searchable history.

It performs one GraphQL fetch every 15 minutes and uses that same response for two independent outputs:

1. **GitHub issue notifications** for `Framhald uppboðs` and `Sölu lokið` only.
2. **A complete SQLite archive and GitHub Pages search site** containing every auction type, including `Byrjun uppboðs`.

The history begins on the first successful run after installation. It does not reconstruct changes that happened before the database was created.

## What is stored

The canonical database is:

```text
site/data/uppbod-history.sqlite
```

It is kept on the dedicated `uppbod-history` branch and is also published as a downloadable file on GitHub Pages.

For every listing, the database stores:

- its stable monitor identity;
- its current or last-known full source snapshot;
- the first time it was seen;
- whether it is currently present in the feed;
- when it was removed;
- every `added`, `changed`, and `removed` event;
- the complete snapshot associated with each event;
- one old/new row for every field changed;
- all source auction types without filtering.

A listing that disappears from a successful source response receives a `removed` event. If it later returns, it receives another `added` event with reason `reappeared`; any differences from its last-known snapshot are retained on that event.

Exact duplicate source rows are collapsed. Listings are primarily identified by `lotId`. When no `lotId` is available, the archive uses a derived fingerprint based on the office, listing name, lot type, location, petitioner, and respondent. A no-`lotId` listing whose identity fields all change can therefore appear as a removal followed by a new addition.

## Database schema

The SQLite file contains these main tables:

### `listings`

One row per known listing. It stores current values, first-seen and last-event timestamps, active/removed state, and the full current JSON snapshot.

### `events`

One row per timeline event:

```text
added
changed
removed
```

The `reason` column distinguishes first appearance, reappearance, source updates, and feed removal.

### `event_changes`

One row per changed field with:

```text
field_name
old_value
new_value
```

### `listing_event_history`

A convenience SQL view joining listings, events, and changed fields.

Example queries:

```sql
-- Find every listing whose name or lot ID contains a house number.
SELECT id, lot_name, lot_id, auction_type, is_active, first_seen_at, removed_at
FROM listings
WHERE lot_name LIKE '%12%'
   OR lot_id LIKE '%12%'
ORDER BY last_event_at DESC;
```

```sql
-- Show the complete event timeline for one listing.
SELECT
  event_type,
  reason,
  observed_at,
  auction_type,
  field_name,
  old_value,
  new_value
FROM listing_event_history
WHERE identity_key = 'lotId:a-100'
ORDER BY observed_at, event_id, field_name;
```

```sql
-- Find auction-type transitions.
SELECT
  listings.lot_name,
  events.observed_at,
  event_changes.old_value,
  event_changes.new_value
FROM event_changes
JOIN events ON events.id = event_changes.event_id
JOIN listings ON listings.id = events.listing_id
WHERE event_changes.field_name = 'auctionType'
ORDER BY events.observed_at DESC;
```

## GitHub Pages interface

The static site is in:

```text
uppbod-pages/
```

At deployment time the workflow combines those version-controlled assets with generated files:

```text
site/data/history.json
site/data/summary.json
site/data/uppbod-history.sqlite
```

The browser interface supports:

- free-text search across current and historical values;
- address and house-number searches through `lotName`;
- searches by lot ID, office, location, lot items, parties, and published text;
- filtering by any auction type that has appeared;
- filtering by active or removed status;
- filtering for listings that have added, changed, or removed events;
- sorting by latest event, first appearance, or address/listing name;
- expandable per-listing timelines with field-by-field before/after values;
- direct SQLite database download;
- shareable search URLs.

The browser uses the generated JSON search index, while SQLite remains the canonical data store. This avoids shipping a browser WebAssembly SQL runtime and keeps the Pages site dependency-free.

## Persistence behavior

Generated data is committed to the orphan-style branch:

```text
uppbod-history
```

The default branch contains only source code and workflows. The history branch contains the deployable `site/` directory and its database.

An unchanged poll does not update timestamps in SQLite and does not rewrite JSON. Therefore, the workflow does **not** create a data commit every 15 minutes. It pushes only when:

- a listing is first seen;
- a listing changes;
- a listing is removed;
- a removed listing reappears;
- site source assets change;
- the database or export format is initialized or upgraded.

## Existing notification behavior

The GitHub issue continues to report only these exact `auctionType` values:

```text
Framhald uppboðs
Sölu lokið
```

The archive is intentionally broader than the issue notification.

Notification behavior remains:

- a new monitored listing is reported under **Added to tracked auctions**;
- `Framhald uppboðs` → `Sölu lokið` is reported as a field change;
- a monitored listing changing to `Byrjun uppboðs` is reported as leaving the tracked types;
- a monitored listing missing from the full source response is reported under **Removed from source feed**;
- changes involving only unmonitored listings remain silent in the issue but are still written to SQLite.

## Files to install

Copy these paths into the repository default branch:

```text
.github/workflows/uppbod-auction-monitor.yml
scripts/uppbod-auction-monitor.mjs
scripts/uppbod-fetch-auctions.mjs
scripts/uppbod-history.py
uppbod-pages/index.html
uppbod-pages/app.js
uppbod-pages/styles.css
uppbod-pages/404.html
```

Recommended tests:

```text
scripts/uppbod-auction-monitor.test.mjs
scripts/uppbod_history_test.py
```

Documentation:

```text
docs/uppbod-auction-monitor.md
```

## Repository setup

### 1. Enable workflow write access

The workflow needs to:

- update the monitor issue;
- create and update the `uppbod-history` branch;
- upload and deploy a Pages artifact.

Its declared permissions are:

```yaml
permissions:
  contents: write
  issues: write
  pages: write
```

The deploy job separately uses:

```yaml
permissions:
  contents: read
  pages: write
  id-token: write
```

Organization or repository policy must allow `GITHUB_TOKEN` write access. A ruleset that blocks bot pushes to every branch must allow the `uppbod-history` branch, or the workflow must use an approved GitHub App token instead.

### 2. Enable GitHub Pages

In repository settings, set the Pages build and deployment source to **GitHub Actions**.

The workflow uploads the generated `site/` directory and deploys it through the `github-pages` environment.

### 3. Run the tests

```bash
node --test scripts/uppbod-auction-monitor.test.mjs
python -m unittest -v scripts/uppbod_history_test.py
```

### 4. Run the workflow manually

After the files are on the default branch:

```text
Actions → Uppboð auction monitor and history → Run workflow
```

The first successful run will:

- establish or update the filtered issue snapshot;
- create the `uppbod-history` branch if it does not exist;
- create the SQLite database;
- record every currently returned auction as an `added` event;
- generate the browser search index;
- deploy the GitHub Pages site.

## Schedule

The default schedule runs at:

```yaml
- cron: '7,22,37,52 * * * *'
  timezone: 'Atlantic/Reykjavik'
```

That is every 15 minutes at `:07`, `:22`, `:37`, and `:52`.

## Failure handling

The GraphQL feed is fetched once into a timestamped JSON export. Both the issue monitor and the history updater consume that exact file, so they cannot disagree because of two responses taken at different times.

The GraphQL request is a JSON `POST`. Temporary network failures, HTTP `408`, `425`, `429`, and `5xx` responses are retried. Deterministic request errors such as HTTP `400` are not repeatedly retried, and the response body is written to the Actions summary.

History is updated before the issue report. If the feed fetch and database update succeed but the issue API call fails, the workflow still commits the history and uploads the Pages artifact before marking the collection job failed. The Pages deployment job is allowed to deploy that already-created artifact.

## Data visibility and retention

The exported fields include `petitioners`, `respondent`, and `publishText`, because those fields are part of the public auction response and are useful for historical search. The SQLite file and JSON index retain old values after a listing is removed.

Before enabling Pages, confirm that the repository's Pages visibility and your intended retention policy are appropriate for this data. Removing a listing from the current source feed does not erase its historical record from this archive.
