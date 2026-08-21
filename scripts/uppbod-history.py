#!/usr/bin/env python3
"""Persist Uppboð auction changes in SQLite and build GitHub Pages data."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 2
EXPORT_VERSION = 2
SOLD_AUCTION_TYPE = "Sölu lokið"

AUCTION_FIELDS = (
    "office",
    "location",
    "auctionType",
    "lotType",
    "lotName",
    "lotId",
    "lotItems",
    "auctionDate",
    "auctionTime",
    "petitioners",
    "respondent",
    "publishText",
    "auctionTakesPlaceAt",
)

IDENTITY_FIELDS = (
    "office",
    "lotName",
    "lotType",
    "location",
    "petitioners",
    "respondent",
)

FIELD_LABELS = {
    "office": "Office",
    "location": "Location",
    "auctionType": "Auction type",
    "lotType": "Lot type",
    "lotName": "Lot name",
    "lotId": "Lot ID",
    "lotItems": "Lot items",
    "auctionDate": "Auction date",
    "auctionTime": "Auction time",
    "petitioners": "Petitioners",
    "respondent": "Respondent",
    "publishText": "Published text",
    "auctionTakesPlaceAt": "Auction venue",
}


def clean_value(value: Any) -> str:
    return str(value if value is not None else "").replace("\r\n", "\n").strip()


def normalize_search(value: str) -> str:
    value = unicodedata.normalize("NFKC", clean_value(value)).casefold()
    return " ".join(value.split())


def is_sold_auction(auction_type: str) -> bool:
    return normalize_search(auction_type) == normalize_search(SOLD_AUCTION_TYPE)


def is_active_auction(
    fields: dict[str, str], *, is_present: bool = True
) -> bool:
    return is_present and not is_sold_auction(fields["auctionType"])


def short_hash(value: str, length: int = 24) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def normalize_auction(raw: dict[str, Any]) -> dict[str, str]:
    return {field: clean_value(raw.get(field)) for field in AUCTION_FIELDS}


def stable_fingerprint(auction: dict[str, str]) -> str:
    material = "\x1f".join(normalize_search(auction[field]) for field in IDENTITY_FIELDS)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def base_identity_key(auction: dict[str, str], fingerprint: str) -> str:
    lot_id = normalize_search(auction["lotId"])
    return f"lotId:{lot_id}" if lot_id else f"derived:{fingerprint[:24]}"


def prepare_current_auctions(raw_auctions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen_content: set[str] = set()

    for raw in raw_auctions:
        if not isinstance(raw, dict):
            raise TypeError("Every auction entry must be an object")
        auction = normalize_auction(raw)
        serialized = stable_json(auction)
        content_hash = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
        if content_hash in seen_content:
            # Exact duplicate rows carry no additional history information.
            continue
        seen_content.add(content_hash)
        fingerprint = stable_fingerprint(auction)
        normalized.append(
            {
                "fields": auction,
                "content_hash": content_hash,
                "stable_fingerprint": fingerprint,
                "base_key": base_identity_key(auction, fingerprint),
            }
        )

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in normalized:
        groups[record["base_key"]].append(record)

    prepared: list[dict[str, Any]] = []
    for base_key, group in groups.items():
        group.sort(
            key=lambda item: (
                item["stable_fingerprint"],
                normalize_search(item["fields"]["auctionDate"]),
                normalize_search(item["fields"]["auctionTime"]),
                item["content_hash"],
            )
        )
        for index, record in enumerate(group, start=1):
            if len(group) == 1:
                identity_key = base_key
            else:
                discriminator = short_hash(
                    "\x1f".join(
                        (
                            record["stable_fingerprint"],
                            normalize_search(record["fields"]["auctionDate"]),
                            normalize_search(record["fields"]["auctionTime"]),
                        )
                    ),
                    16,
                )
                identity_key = f"{base_key}:variant:{discriminator}:{index}"
            prepared.append({**record, "identity_key": identity_key})

    prepared.sort(key=lambda item: item["identity_key"])
    return prepared


def parse_export(path: Path) -> tuple[str, list[dict[str, Any]]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not read auction export {path}: {error}") from error

    if isinstance(payload, list):
        raw_auctions = payload
        fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    elif isinstance(payload, dict):
        raw_auctions = payload.get("auctions")
        fetched_at = payload.get("fetchedAt")
    else:
        raise ValueError("Auction export must be an array or an object")

    if not isinstance(raw_auctions, list):
        raise ValueError("Auction export must contain an auctions array")
    if not isinstance(fetched_at, str):
        raise ValueError("Auction export must contain a fetchedAt timestamp")

    try:
        parsed = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"Invalid fetchedAt timestamp: {fetched_at}") from error
    if parsed.tzinfo is None:
        raise ValueError("fetchedAt must include a timezone")

    canonical_time = parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return canonical_time, raw_auctions


def connect_database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = DELETE")
    connection.execute("PRAGMA synchronous = FULL")
    return connection


def ensure_schema(connection: sqlite3.Connection) -> bool:
    current_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
    if current_version > SCHEMA_VERSION:
        raise RuntimeError(
            f"Database schema {current_version} is newer than supported schema {SCHEMA_VERSION}"
        )

    schema_changed = current_version == 0
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS listings (
          id INTEGER PRIMARY KEY,
          identity_key TEXT NOT NULL UNIQUE,
          stable_fingerprint TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_event_at TEXT NOT NULL,
          removed_at TEXT,
          is_present INTEGER NOT NULL CHECK (is_present IN (0, 1)),
          is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
          current_json TEXT NOT NULL,
          office TEXT NOT NULL,
          location TEXT NOT NULL,
          auction_type TEXT NOT NULL,
          lot_type TEXT NOT NULL,
          lot_name TEXT NOT NULL,
          lot_id TEXT NOT NULL,
          lot_items TEXT NOT NULL,
          auction_date TEXT NOT NULL,
          auction_time TEXT NOT NULL,
          petitioners TEXT NOT NULL,
          respondent TEXT NOT NULL,
          publish_text TEXT NOT NULL,
          auction_takes_place_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          listing_id INTEGER NOT NULL,
          event_type TEXT NOT NULL CHECK (event_type IN ('added', 'changed', 'removed')),
          reason TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          auction_type TEXT NOT NULL,
          lot_name TEXT NOT NULL,
          lot_id TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS event_changes (
          event_id INTEGER NOT NULL,
          field_name TEXT NOT NULL,
          old_value TEXT NOT NULL,
          new_value TEXT NOT NULL,
          PRIMARY KEY (event_id, field_name),
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS listings_lot_name_idx ON listings(lot_name);
        CREATE INDEX IF NOT EXISTS listings_lot_id_idx ON listings(lot_id);
        CREATE INDEX IF NOT EXISTS listings_status_idx ON listings(is_active, removed_at);
        CREATE INDEX IF NOT EXISTS listings_auction_type_idx ON listings(auction_type);
        CREATE INDEX IF NOT EXISTS listings_fingerprint_idx ON listings(stable_fingerprint);
        CREATE INDEX IF NOT EXISTS events_listing_time_idx ON events(listing_id, observed_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS events_type_time_idx ON events(event_type, observed_at DESC);
        CREATE INDEX IF NOT EXISTS events_auction_type_idx ON events(auction_type);

        CREATE VIEW IF NOT EXISTS listing_event_history AS
        SELECT
          listings.identity_key,
          listings.lot_name,
          listings.lot_id,
          events.id AS event_id,
          events.event_type,
          events.reason,
          events.observed_at,
          events.auction_type,
          event_changes.field_name,
          event_changes.old_value,
          event_changes.new_value
        FROM events
        JOIN listings ON listings.id = events.listing_id
        LEFT JOIN event_changes ON event_changes.event_id = events.id;
        """
    )

    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(listings)")
    }
    added_presence_column = False
    if "is_present" not in columns:
        connection.execute(
            """
            ALTER TABLE listings
            ADD COLUMN is_present INTEGER NOT NULL DEFAULT 1
            CHECK (is_present IN (0, 1))
            """
        )
        # Schema v1 used is_active to mean presence in the source feed.
        connection.execute("UPDATE listings SET is_present = is_active")
        added_presence_column = True
        schema_changed = True

    if current_version < 2 or added_presence_column:
        rows = list(
            connection.execute(
                "SELECT id, is_present, auction_type FROM listings"
            )
        )
        connection.executemany(
            "UPDATE listings SET is_active = ? WHERE id = ?",
            (
                (
                    int(
                        bool(row["is_present"])
                        and not is_sold_auction(row["auction_type"])
                    ),
                    int(row["id"]),
                )
                for row in rows
            ),
        )
        schema_changed = True

    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS listings_presence_status_idx
        ON listings(is_present, is_active, removed_at)
        """
    )
    connection.execute(
        """
        CREATE VIEW IF NOT EXISTS listing_current_status AS
        SELECT
          listings.*,
          CASE
            WHEN is_present = 0 THEN 'removed'
            WHEN is_active = 0 THEN 'finished'
            ELSE 'active'
          END AS lifecycle_status
        FROM listings
        """
    )

    if current_version != SCHEMA_VERSION:
        connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        schema_changed = True

    metadata_changed = False
    for key, value in (
        ("schema_version", str(SCHEMA_VERSION)),
        ("export_version", str(EXPORT_VERSION)),
    ):
        current = connection.execute(
            "SELECT value FROM metadata WHERE key = ?", (key,)
        ).fetchone()
        if current is None or current["value"] != value:
            connection.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
                (key, value),
            )
            metadata_changed = True
    return schema_changed or metadata_changed


def row_to_fields(row: sqlite3.Row) -> dict[str, str]:
    return json.loads(row["current_json"])


def listing_values(
    record: dict[str, Any],
    observed_at: str,
    *,
    first_seen_at: str,
    is_present: int,
    is_active: int,
    removed_at: str | None,
) -> tuple[Any, ...]:
    fields = record["fields"]
    return (
        record["identity_key"],
        record["stable_fingerprint"],
        record["content_hash"],
        first_seen_at,
        observed_at,
        removed_at,
        is_present,
        is_active,
        stable_json(fields),
        fields["office"],
        fields["location"],
        fields["auctionType"],
        fields["lotType"],
        fields["lotName"],
        fields["lotId"],
        fields["lotItems"],
        fields["auctionDate"],
        fields["auctionTime"],
        fields["petitioners"],
        fields["respondent"],
        fields["publishText"],
        fields["auctionTakesPlaceAt"],
    )


def insert_event(
    connection: sqlite3.Connection,
    *,
    listing_id: int,
    event_type: str,
    reason: str,
    observed_at: str,
    snapshot: dict[str, str],
    changes: Iterable[tuple[str, str, str]] = (),
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO events(
          listing_id, event_type, reason, observed_at,
          auction_type, lot_name, lot_id, snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            listing_id,
            event_type,
            reason,
            observed_at,
            snapshot["auctionType"],
            snapshot["lotName"],
            snapshot["lotId"],
            stable_json(snapshot),
        ),
    )
    event_id = int(cursor.lastrowid)
    connection.executemany(
        """
        INSERT INTO event_changes(event_id, field_name, old_value, new_value)
        VALUES (?, ?, ?, ?)
        """,
        ((event_id, field, old_value, new_value) for field, old_value, new_value in changes),
    )
    return event_id


def unique_candidate(
    rows: Iterable[sqlite3.Row], matched_ids: set[int]
) -> sqlite3.Row | None:
    available = [row for row in rows if int(row["id"]) not in matched_ids]
    present = [row for row in available if int(row["is_present"]) == 1]
    if len(present) == 1:
        return present[0]
    if len(available) == 1:
        return available[0]
    return None


def update_database(
    database_path: Path,
    observed_at: str,
    raw_auctions: list[dict[str, Any]],
) -> dict[str, Any]:
    current_records = prepare_current_auctions(raw_auctions)
    database_existed = database_path.exists()
    connection = connect_database(database_path)

    counts = Counter()
    database_changed = False
    event_changed = False
    try:
        with connection:
            schema_changed = ensure_schema(connection)
            database_changed = schema_changed or not database_existed

            existing_rows = list(connection.execute("SELECT * FROM listings"))
            by_identity = {row["identity_key"]: row for row in existing_rows}
            by_lot_id: dict[str, list[sqlite3.Row]] = defaultdict(list)
            by_fingerprint: dict[str, list[sqlite3.Row]] = defaultdict(list)
            for row in existing_rows:
                if row["lot_id"]:
                    by_lot_id[normalize_search(row["lot_id"])].append(row)
                by_fingerprint[row["stable_fingerprint"]].append(row)

            matched_ids: set[int] = set()

            for record in current_records:
                fields = record["fields"]
                row = by_identity.get(record["identity_key"])
                if row is not None and int(row["id"]) in matched_ids:
                    row = None

                if row is None and fields["lotId"]:
                    row = unique_candidate(
                        by_lot_id.get(normalize_search(fields["lotId"]), []),
                        matched_ids,
                    )
                if row is None:
                    row = unique_candidate(
                        by_fingerprint.get(record["stable_fingerprint"], []),
                        matched_ids,
                    )

                if row is None:
                    cursor = connection.execute(
                        """
                        INSERT INTO listings(
                          identity_key, stable_fingerprint, content_hash,
                          first_seen_at, last_event_at, removed_at, is_present,
                          is_active, current_json, office, location, auction_type,
                          lot_type, lot_name, lot_id, lot_items, auction_date,
                          auction_time, petitioners, respondent, publish_text,
                          auction_takes_place_at
                        ) VALUES (
                          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                        )
                        """,
                        listing_values(
                            record,
                            observed_at,
                            first_seen_at=observed_at,
                            is_present=1,
                            is_active=int(is_active_auction(fields)),
                            removed_at=None,
                        ),
                    )
                    listing_id = int(cursor.lastrowid)
                    insert_event(
                        connection,
                        listing_id=listing_id,
                        event_type="added",
                        reason="first_seen",
                        observed_at=observed_at,
                        snapshot=fields,
                    )
                    matched_ids.add(listing_id)
                    counts["added"] += 1
                    database_changed = True
                    event_changed = True
                    continue

                listing_id = int(row["id"])
                matched_ids.add(listing_id)
                previous_fields = row_to_fields(row)
                field_changes = [
                    (field, previous_fields.get(field, ""), fields[field])
                    for field in AUCTION_FIELDS
                    if previous_fields.get(field, "") != fields[field]
                ]
                was_present = int(row["is_present"]) == 1

                # Adopt a more useful current identity only alongside a real
                # source event. This keeps internal key reconciliation from
                # changing last-event timestamps on an otherwise unchanged poll.
                identity_key = row["identity_key"]
                proposed_identity = record["identity_key"]
                if (field_changes or not was_present) and proposed_identity != identity_key:
                    conflict = connection.execute(
                        "SELECT id FROM listings WHERE identity_key = ? AND id <> ?",
                        (proposed_identity, listing_id),
                    ).fetchone()
                    if conflict is None:
                        identity_key = proposed_identity
                record = {**record, "identity_key": identity_key}

                if not was_present:
                    insert_event(
                        connection,
                        listing_id=listing_id,
                        event_type="added",
                        reason="reappeared",
                        observed_at=observed_at,
                        snapshot=fields,
                        changes=field_changes,
                    )
                    counts["added"] += 1
                    database_changed = True
                    event_changed = True
                elif field_changes:
                    insert_event(
                        connection,
                        listing_id=listing_id,
                        event_type="changed",
                        reason="source_update",
                        observed_at=observed_at,
                        snapshot=fields,
                        changes=field_changes,
                    )
                    counts["changed"] += 1
                    database_changed = True
                    event_changed = True

                if not was_present or field_changes or identity_key != row["identity_key"]:
                    connection.execute(
                        """
                        UPDATE listings SET
                          identity_key = ?, stable_fingerprint = ?, content_hash = ?,
                          last_event_at = ?, removed_at = NULL, is_present = 1,
                          is_active = ?, current_json = ?, office = ?, location = ?,
                          auction_type = ?, lot_type = ?, lot_name = ?, lot_id = ?,
                          lot_items = ?, auction_date = ?, auction_time = ?,
                          petitioners = ?, respondent = ?, publish_text = ?,
                          auction_takes_place_at = ?
                        WHERE id = ?
                        """,
                        (
                            record["identity_key"],
                            record["stable_fingerprint"],
                            record["content_hash"],
                            observed_at,
                            int(is_active_auction(fields)),
                            stable_json(fields),
                            fields["office"],
                            fields["location"],
                            fields["auctionType"],
                            fields["lotType"],
                            fields["lotName"],
                            fields["lotId"],
                            fields["lotItems"],
                            fields["auctionDate"],
                            fields["auctionTime"],
                            fields["petitioners"],
                            fields["respondent"],
                            fields["publishText"],
                            fields["auctionTakesPlaceAt"],
                            listing_id,
                        ),
                    )

            for row in existing_rows:
                listing_id = int(row["id"])
                if listing_id in matched_ids or int(row["is_present"]) == 0:
                    continue
                previous_fields = row_to_fields(row)
                insert_event(
                    connection,
                    listing_id=listing_id,
                    event_type="removed",
                    reason="missing_from_feed",
                    observed_at=observed_at,
                    snapshot=previous_fields,
                )
                connection.execute(
                    """
                    UPDATE listings
                    SET is_present = 0, is_active = 0,
                        removed_at = ?, last_event_at = ?
                    WHERE id = ?
                    """,
                    (observed_at, observed_at, listing_id),
                )
                counts["removed"] += 1
                database_changed = True
                event_changed = True

            if event_changed:
                connection.executemany(
                    "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
                    (
                        ("last_event_at", observed_at),
                        ("source_count_at_last_event", str(len(current_records))),
                        ("updated_at", observed_at),
                    ),
                )

        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"SQLite integrity check failed: {integrity}")
    finally:
        connection.close()

    return {
        "changed": database_changed,
        "observedAt": observed_at,
        "sourceCount": len(current_records),
        "added": counts["added"],
        "changedListings": counts["changed"],
        "removed": counts["removed"],
    }


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_if_changed(path: Path, content: bytes) -> bool:
    if path.exists() and path.read_bytes() == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_bytes(content)
    os.replace(temporary, path)
    return True


def build_site_payload(database_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    uri = f"file:{database_path.resolve().as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        metadata = {
            row["key"]: row["value"]
            for row in connection.execute("SELECT key, value FROM metadata")
        }
        listings = list(
            connection.execute(
                "SELECT * FROM listings ORDER BY last_event_at DESC, lot_name COLLATE NOCASE"
            )
        )
        events = list(
            connection.execute(
                "SELECT * FROM events ORDER BY observed_at DESC, id DESC"
            )
        )
        changes = list(
            connection.execute(
                "SELECT * FROM event_changes ORDER BY event_id DESC, field_name"
            )
        )
    finally:
        connection.close()

    changes_by_event: dict[int, list[dict[str, str]]] = defaultdict(list)
    for row in changes:
        changes_by_event[int(row["event_id"])].append(
            {
                "field": row["field_name"],
                "label": FIELD_LABELS.get(row["field_name"], row["field_name"]),
                "oldValue": row["old_value"],
                "newValue": row["new_value"],
            }
        )

    events_by_listing: dict[int, list[dict[str, Any]]] = defaultdict(list)
    auction_type_counter: Counter[str] = Counter()
    event_type_counter: Counter[str] = Counter()
    for row in events:
        snapshot = json.loads(row["snapshot_json"])
        event = {
            "id": int(row["id"]),
            "type": row["event_type"],
            "reason": row["reason"],
            "observedAt": row["observed_at"],
            "auctionType": row["auction_type"],
            "snapshot": snapshot,
            "changes": changes_by_event.get(int(row["id"]), []),
        }
        events_by_listing[int(row["listing_id"])].append(event)
        event_type_counter[row["event_type"]] += 1
        if row["auction_type"]:
            auction_type_counter[row["auction_type"]] += 1

    payload_listings: list[dict[str, Any]] = []
    active_count = 0
    finished_count = 0
    removed_count = 0
    for row in listings:
        listing_events = events_by_listing.get(int(row["id"]), [])
        current = json.loads(row["current_json"])
        historical_values: list[str] = list(current.values())
        for event in listing_events:
            historical_values.extend(event["snapshot"].values())
            for change in event["changes"]:
                historical_values.extend((change["oldValue"], change["newValue"]))
        search_text = " ".join(
            sorted({normalize_search(value) for value in historical_values if clean_value(value)})
        )
        is_present_in_feed = bool(row["is_present"])
        is_active = bool(row["is_active"])
        is_finished = is_present_in_feed and not is_active
        if not is_present_in_feed:
            status = "removed"
        elif is_finished:
            status = "finished"
        else:
            status = "active"

        active_count += int(status == "active")
        finished_count += int(status == "finished")
        removed_count += int(status == "removed")
        payload_listings.append(
            {
                "id": int(row["id"]),
                "identityKey": row["identity_key"],
                "status": status,
                "isActive": is_active,
                "isFinished": is_finished,
                "sourcePresent": is_present_in_feed,
                "firstSeenAt": row["first_seen_at"],
                "lastEventAt": row["last_event_at"],
                "removedAt": row["removed_at"],
                "current": current,
                "searchText": search_text,
                "events": listing_events,
            }
        )

    database_hash = file_sha256(database_path)
    last_event_at = metadata.get("last_event_at")
    summary = {
        "version": EXPORT_VERSION,
        "generatedAt": last_event_at,
        "database": {
            "filename": database_path.name,
            "sha256": database_hash,
            "sizeBytes": database_path.stat().st_size,
            "schemaVersion": SCHEMA_VERSION,
        },
        "counts": {
            "listings": len(payload_listings),
            "active": active_count,
            "finished": finished_count,
            "removed": removed_count,
            "sourcePresent": active_count + finished_count,
            "events": len(events),
            "addedEvents": event_type_counter["added"],
            "changedEvents": event_type_counter["changed"],
            "removedEvents": event_type_counter["removed"],
        },
        "auctionTypes": [
            {"name": name, "eventCount": count}
            for name, count in sorted(auction_type_counter.items(), key=lambda item: item[0])
        ],
    }
    history = {**summary, "listings": payload_listings}
    return history, summary


def generate_site_data(database_path: Path, site_data_dir: Path) -> dict[str, Any]:
    history, summary = build_site_payload(database_path)
    history_bytes = (
        json.dumps(history, ensure_ascii=False, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    summary_bytes = (
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    history_changed = write_if_changed(site_data_dir / "history.json", history_bytes)
    summary_changed = write_if_changed(site_data_dir / "summary.json", summary_bytes)
    return {
        "historyJsonChanged": history_changed,
        "summaryJsonChanged": summary_changed,
        "listingCount": summary["counts"]["listings"],
        "eventCount": summary["counts"]["events"],
        "databaseSha256": summary["database"]["sha256"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Update the Uppboð SQLite history and GitHub Pages search data."
    )
    parser.add_argument("--input", required=True, type=Path, help="Auction export JSON")
    parser.add_argument("--database", required=True, type=Path, help="SQLite database")
    parser.add_argument(
        "--site-data-dir",
        required=True,
        type=Path,
        help="Directory for history.json and summary.json",
    )
    args = parser.parse_args(argv)

    observed_at, raw_auctions = parse_export(args.input)
    update = update_database(args.database, observed_at, raw_auctions)
    site = generate_site_data(args.database, args.site_data_dir)
    result = {**update, **site, "database": str(args.database)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - CLI needs a concise failure.
        print(f"uppbod-history: {error}", file=sys.stderr)
        raise
