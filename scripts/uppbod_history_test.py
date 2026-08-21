from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("uppbod-history.py")
SPEC = importlib.util.spec_from_file_location("uppbod_history", MODULE_PATH)
assert SPEC and SPEC.loader
history = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(history)


def auction(
    lot_id: str,
    lot_name: str,
    auction_type: str,
    *,
    time: str = "10:00",
    publish_text: str = "Initial text",
) -> dict[str, str]:
    return {
        "office": "Sýslumaðurinn á höfuðborgarsvæðinu",
        "location": "Reykjavík",
        "auctionType": auction_type,
        "lotType": "Fasteign",
        "lotName": lot_name,
        "lotId": lot_id,
        "lotItems": "Íbúð",
        "auctionDate": "20.08.2026",
        "auctionTime": time,
        "petitioners": "Example petitioner",
        "respondent": "Example respondent",
        "publishText": publish_text,
        "auctionTakesPlaceAt": "Borgartún 7",
    }


class UppbodHistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="uppbod-history-")
        self.root = Path(self.temp.name)
        self.database = self.root / "site" / "data" / "uppbod-history.sqlite"
        self.site_data = self.root / "site" / "data"

        self.start = auction("A-100", "Laugavegur 1", "Byrjun uppboðs")
        self.continuation = auction(
            "A-200", "Austurvegur 12", "Framhald uppboðs"
        )
        self.sold = auction("A-300", "Kirkjubraut 5", "Sölu lokið")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def update(self, observed_at: str, auctions: list[dict[str, str]]):
        result = history.update_database(self.database, observed_at, auctions)
        site = history.generate_site_data(self.database, self.site_data)
        return {**result, **site}

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        return connection

    def create_v1_database(
        self,
        rows: list[tuple[dict[str, str], bool, str | None]],
        *,
        observed_at: str = "2026-08-21T08:00:00Z",
    ) -> None:
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.database) as connection:
            connection.executescript(
                """
                PRAGMA user_version = 1;

                CREATE TABLE metadata (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );

                CREATE TABLE listings (
                  id INTEGER PRIMARY KEY,
                  identity_key TEXT NOT NULL UNIQUE,
                  stable_fingerprint TEXT NOT NULL,
                  content_hash TEXT NOT NULL,
                  first_seen_at TEXT NOT NULL,
                  last_event_at TEXT NOT NULL,
                  removed_at TEXT,
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

                CREATE TABLE events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  listing_id INTEGER NOT NULL,
                  event_type TEXT NOT NULL,
                  reason TEXT NOT NULL,
                  observed_at TEXT NOT NULL,
                  auction_type TEXT NOT NULL,
                  lot_name TEXT NOT NULL,
                  lot_id TEXT NOT NULL,
                  snapshot_json TEXT NOT NULL,
                  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
                );

                CREATE TABLE event_changes (
                  event_id INTEGER NOT NULL,
                  field_name TEXT NOT NULL,
                  old_value TEXT NOT NULL,
                  new_value TEXT NOT NULL,
                  PRIMARY KEY (event_id, field_name),
                  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
                );
                """
            )
            connection.executemany(
                "INSERT INTO metadata(key, value) VALUES (?, ?)",
                (
                    ("schema_version", "1"),
                    ("export_version", "1"),
                    ("last_event_at", observed_at),
                    ("updated_at", observed_at),
                ),
            )

            for raw, was_present, removed_at in rows:
                fields = history.normalize_auction(raw)
                fingerprint = history.stable_fingerprint(fields)
                identity_key = history.base_identity_key(fields, fingerprint)
                serialized = history.stable_json(fields)
                content_hash = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
                cursor = connection.execute(
                    """
                    INSERT INTO listings(
                      identity_key, stable_fingerprint, content_hash,
                      first_seen_at, last_event_at, removed_at, is_active,
                      current_json, office, location, auction_type, lot_type,
                      lot_name, lot_id, lot_items, auction_date, auction_time,
                      petitioners, respondent, publish_text, auction_takes_place_at
                    ) VALUES (
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                    """,
                    (
                        identity_key,
                        fingerprint,
                        content_hash,
                        observed_at,
                        observed_at,
                        removed_at,
                        int(was_present),
                        serialized,
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
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO events(
                      listing_id, event_type, reason, observed_at,
                      auction_type, lot_name, lot_id, snapshot_json
                    ) VALUES (?, 'added', 'first_seen', ?, ?, ?, ?, ?)
                    """,
                    (
                        cursor.lastrowid,
                        observed_at,
                        fields["auctionType"],
                        fields["lotName"],
                        fields["lotId"],
                        serialized,
                    ),
                )

    def test_first_run_records_every_auction_type(self) -> None:
        result = self.update(
            "2026-08-21T09:00:00Z",
            [self.start, self.continuation, self.sold],
        )

        self.assertTrue(result["changed"])
        self.assertEqual(result["added"], 3)
        with self.connect() as connection:
            types = {
                row[0]
                for row in connection.execute(
                    "SELECT DISTINCT auction_type FROM events"
                )
            }
            self.assertEqual(
                types,
                {"Byrjun uppboðs", "Framhald uppboðs", "Sölu lokið"},
            )
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM listings").fetchone()[0],
                3,
            )
            statuses = {
                row["lot_id"]: row
                for row in connection.execute(
                    """
                    SELECT lot_id, is_present, is_active, lifecycle_status
                    FROM listing_current_status
                    """
                )
            }
            self.assertEqual(
                (statuses["A-100"]["is_present"], statuses["A-100"]["is_active"]),
                (1, 1),
            )
            self.assertEqual(statuses["A-100"]["lifecycle_status"], "active")
            self.assertEqual(
                (statuses["A-300"]["is_present"], statuses["A-300"]["is_active"]),
                (1, 0),
            )
            self.assertEqual(statuses["A-300"]["lifecycle_status"], "finished")

        payload = json.loads((self.site_data / "history.json").read_text())
        self.assertEqual(payload["version"], 2)
        self.assertEqual(payload["counts"]["listings"], 3)
        self.assertEqual(payload["counts"]["active"], 2)
        self.assertEqual(payload["counts"]["finished"], 1)
        self.assertEqual(payload["counts"]["removed"], 0)
        self.assertEqual(payload["counts"]["sourcePresent"], 3)
        self.assertEqual(
            {item["name"] for item in payload["auctionTypes"]},
            {"Byrjun uppboðs", "Framhald uppboðs", "Sölu lokið"},
        )

        by_lot_id = {item["current"]["lotId"]: item for item in payload["listings"]}
        self.assertEqual(by_lot_id["A-100"]["status"], "active")
        self.assertTrue(by_lot_id["A-100"]["isActive"])
        self.assertEqual(by_lot_id["A-300"]["status"], "finished")
        self.assertFalse(by_lot_id["A-300"]["isActive"])
        self.assertTrue(by_lot_id["A-300"]["isFinished"])
        self.assertTrue(by_lot_id["A-300"]["sourcePresent"])

    def test_finished_listing_becomes_removed_when_it_leaves_the_feed(self) -> None:
        self.update("2026-08-21T09:00:00Z", [self.sold])
        self.update("2026-08-21T09:15:00Z", [])

        payload = json.loads((self.site_data / "history.json").read_text())
        listing = payload["listings"][0]
        self.assertEqual(listing["status"], "removed")
        self.assertFalse(listing["isActive"])
        self.assertFalse(listing["isFinished"])
        self.assertFalse(listing["sourcePresent"])
        self.assertEqual(payload["counts"]["active"], 0)
        self.assertEqual(payload["counts"]["finished"], 0)
        self.assertEqual(payload["counts"]["removed"], 1)

    def test_v1_database_migrates_presence_and_finished_state_without_new_events(
        self,
    ) -> None:
        removed_start = auction("A-400", "Hlíðarvegur 9", "Byrjun uppboðs")
        self.create_v1_database(
            [
                (self.continuation, True, None),
                (self.sold, True, None),
                (removed_start, False, "2026-08-21T08:00:00Z"),
            ]
        )

        result = self.update(
            "2026-08-21T09:00:00Z",
            [self.continuation, self.sold],
        )

        self.assertTrue(result["changed"])
        self.assertEqual(result["added"], 0)
        self.assertEqual(result["changedListings"], 0)
        self.assertEqual(result["removed"], 0)

        with self.connect() as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
            columns = {
                row[1] for row in connection.execute("PRAGMA table_info(listings)")
            }
            self.assertIn("is_present", columns)
            states = {
                row["lot_id"]: (row["is_present"], row["is_active"])
                for row in connection.execute(
                    "SELECT lot_id, is_present, is_active FROM listings"
                )
            }
            self.assertEqual(states["A-200"], (1, 1))
            self.assertEqual(states["A-300"], (1, 0))
            self.assertEqual(states["A-400"], (0, 0))
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM events").fetchone()[0], 3)
            self.assertEqual(
                connection.execute(
                    "SELECT value FROM metadata WHERE key = 'last_event_at'"
                ).fetchone()[0],
                "2026-08-21T08:00:00Z",
            )

        payload = json.loads((self.site_data / "history.json").read_text())
        statuses = {
            item["current"]["lotId"]: item["status"]
            for item in payload["listings"]
        }
        self.assertEqual(statuses["A-200"], "active")
        self.assertEqual(statuses["A-300"], "finished")
        self.assertEqual(statuses["A-400"], "removed")

    def test_changed_fields_and_removal_are_stored_separately(self) -> None:
        self.update(
            "2026-08-21T09:00:00Z",
            [self.start, self.continuation],
        )
        changed_start = {
            **self.start,
            "auctionType": "Sölu lokið",
            "auctionTime": "11:30",
            "publishText": "Updated text",
        }
        result = self.update(
            "2026-08-21T09:15:00Z",
            [changed_start, self.sold],
        )

        self.assertEqual(result["added"], 1)
        self.assertEqual(result["changedListings"], 1)
        self.assertEqual(result["removed"], 1)

        with self.connect() as connection:
            changed_event = connection.execute(
                """
                SELECT events.id
                FROM events
                JOIN listings ON listings.id = events.listing_id
                WHERE listings.lot_id = 'A-100' AND events.event_type = 'changed'
                """
            ).fetchone()
            self.assertIsNotNone(changed_event)
            changes = {
                row["field_name"]: (row["old_value"], row["new_value"])
                for row in connection.execute(
                    "SELECT * FROM event_changes WHERE event_id = ?",
                    (changed_event["id"],),
                )
            }
            self.assertEqual(
                changes["auctionType"], ("Byrjun uppboðs", "Sölu lokið")
            )
            self.assertEqual(changes["auctionTime"], ("10:00", "11:30"))
            self.assertEqual(
                changes["publishText"], ("Initial text", "Updated text")
            )

            removed = connection.execute(
                """
                SELECT is_present, is_active, removed_at
                FROM listings WHERE lot_id = 'A-200'
                """
            ).fetchone()
            self.assertEqual(removed["is_present"], 0)
            self.assertEqual(removed["is_active"], 0)
            self.assertEqual(removed["removed_at"], "2026-08-21T09:15:00Z")

            finished = connection.execute(
                """
                SELECT is_present, is_active
                FROM listings WHERE lot_id = 'A-100'
                """
            ).fetchone()
            self.assertEqual((finished["is_present"], finished["is_active"]), (1, 0))

    def test_unchanged_poll_does_not_rewrite_database_or_json(self) -> None:
        auctions = [self.start, self.continuation]
        self.update("2026-08-21T09:00:00Z", auctions)
        before_db = hashlib.sha256(self.database.read_bytes()).hexdigest()
        before_json = hashlib.sha256(
            (self.site_data / "history.json").read_bytes()
        ).hexdigest()

        result = self.update("2026-08-21T09:15:00Z", auctions)

        after_db = hashlib.sha256(self.database.read_bytes()).hexdigest()
        after_json = hashlib.sha256(
            (self.site_data / "history.json").read_bytes()
        ).hexdigest()
        self.assertFalse(result["changed"])
        self.assertFalse(result["historyJsonChanged"])
        self.assertEqual(before_db, after_db)
        self.assertEqual(before_json, after_json)

    def test_reappearance_is_an_added_event_with_prior_changes(self) -> None:
        self.update("2026-08-21T09:00:00Z", [self.start])
        self.update("2026-08-21T09:15:00Z", [])
        reappeared = {**self.start, "auctionTime": "12:00"}
        result = self.update("2026-08-21T09:30:00Z", [reappeared])

        self.assertEqual(result["added"], 1)
        with self.connect() as connection:
            event = connection.execute(
                """
                SELECT * FROM events
                WHERE event_type = 'added' AND reason = 'reappeared'
                ORDER BY id DESC LIMIT 1
                """
            ).fetchone()
            self.assertIsNotNone(event)
            change = connection.execute(
                "SELECT * FROM event_changes WHERE event_id = ? AND field_name = 'auctionTime'",
                (event["id"],),
            ).fetchone()
            self.assertEqual((change["old_value"], change["new_value"]), ("10:00", "12:00"))

    def test_pages_search_text_contains_historical_values(self) -> None:
        self.update("2026-08-21T09:00:00Z", [self.start])
        renamed = {**self.start, "lotName": "Laugavegur 1A"}
        self.update("2026-08-21T09:15:00Z", [renamed])

        payload = json.loads((self.site_data / "history.json").read_text())
        listing = payload["listings"][0]
        self.assertIn("laugavegur 1", listing["searchText"])
        self.assertIn("laugavegur 1a", listing["searchText"])
        self.assertEqual(listing["events"][0]["type"], "changed")



if __name__ == "__main__":
    unittest.main()
