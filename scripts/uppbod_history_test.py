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

        payload = json.loads((self.site_data / "history.json").read_text())
        self.assertEqual(payload["counts"]["listings"], 3)
        self.assertEqual(
            {item["name"] for item in payload["auctionTypes"]},
            {"Byrjun uppboðs", "Framhald uppboðs", "Sölu lokið"},
        )

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
                "SELECT is_active, removed_at FROM listings WHERE lot_id = 'A-200'"
            ).fetchone()
            self.assertEqual(removed["is_active"], 0)
            self.assertEqual(removed["removed_at"], "2026-08-21T09:15:00Z")

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
