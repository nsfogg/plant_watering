#!/usr/bin/env python3
"""Tests for the watering schedule.

The browser (assets/js/schedule.js) and the texter (scripts/schedule.py) are two
implementations of the same rules. If they ever drift, the site would show one
date and the SMS would use another -- so the main test runs both over the same
fixtures and demands identical output.

Run:  python3 tests/test_schedule.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import notify  # noqa: E402
import schedule as sched  # noqa: E402

CASES = json.loads((ROOT / "tests" / "cases.json").read_text(encoding="utf-8"))


def python_results():
    out = []
    for case in CASES:
        plant, today = case["plant"], case["today"]
        out.append(
            {
                "why": case["why"],
                "status": sched.status_for(plant, today),
                "occurrences": sched.occurrences_in_range(
                    plant, today, sched.add_days(today, 120), today
                ),
                "amount": sched.amount_text(plant),
                "interval": sched.interval_on(plant, today),
            }
        )
    return out


class TestParity(unittest.TestCase):
    def test_js_and_python_agree(self):
        try:
            proc = subprocess.run(
                ["node", str(ROOT / "tests" / "run_js.mjs")],
                capture_output=True, text=True, check=True, cwd=ROOT,
            )
        except FileNotFoundError:
            self.skipTest("node is not installed; skipping cross-language parity check")
            return
        js = json.loads(proc.stdout)
        py = python_results()
        self.assertEqual(len(js), len(py))
        for a, b in zip(js, py):
            with self.subTest(case=a["why"]):
                self.assertEqual(a, b, f"JS and Python disagree on: {a['why']}")


class TestSchedule(unittest.TestCase):
    def test_due_in_two_days(self):
        p = {"name": "A", "water": {"intervalDays": 7}, "lastWatered": "2026-09-14"}
        st = sched.status_for(p, "2026-09-19")
        self.assertEqual(st["dueDate"], "2026-09-21")
        self.assertEqual(st["daysUntil"], 2)
        self.assertFalse(st["needsWater"])
        self.assertEqual(st["status"], "soon")

    def test_overdue_counts_days(self):
        p = {"name": "A", "water": {"intervalDays": 7}, "lastWatered": "2026-09-01"}
        st = sched.status_for(p, "2026-09-19")
        self.assertEqual(st["status"], "overdue")
        self.assertEqual(st["daysOverdue"], 11)
        self.assertTrue(st["needsWater"])

    def test_never_watered_is_due_now(self):
        st = sched.status_for({"name": "N", "water": {"intervalDays": 9}}, "2026-09-19")
        self.assertEqual(st["dueDate"], "2026-09-19")
        self.assertTrue(st["needsWater"])

    def test_winter_interval_applies_in_january(self):
        p = {"name": "W", "water": {"intervalDays": 7, "winterIntervalDays": 21}}
        self.assertEqual(sched.interval_on(p, "2027-01-15"), 21)
        self.assertEqual(sched.interval_on(p, "2027-06-15"), 7)

    def test_occurrences_step_forward(self):
        p = {"name": "A", "water": {"intervalDays": 7}, "lastWatered": "2026-09-14"}
        self.assertEqual(
            sched.occurrences_in_range(p, "2026-09-01", "2026-10-05", "2026-09-19"),
            ["2026-09-21", "2026-09-28", "2026-10-05"],
        )

    def test_occurrences_respect_the_season_change(self):
        # Weekly in autumn, every 21 days once November starts.
        p = {"name": "S", "water": {"intervalDays": 7, "winterIntervalDays": 21}, "lastWatered": "2026-10-20"}
        got = sched.occurrences_in_range(p, "2026-10-20", "2026-12-31", "2026-10-20")
        self.assertEqual(got, ["2026-10-27", "2026-11-03", "2026-11-24", "2026-12-15"])

    def test_archived_plants_are_skipped(self):
        p = {"name": "Z", "water": {"intervalDays": 2}, "lastWatered": "2026-09-01", "archived": True}
        self.assertEqual(sched.occurrences_in_range(p, "2026-09-01", "2026-09-30", "2026-09-19"), [])
        self.assertEqual(sched.due_plants([p], "2026-09-19"), [])

    def test_invalid_dates_do_not_crash(self):
        self.assertIsNone(sched.parse_iso("2026-02-31"))
        self.assertIsNone(sched.parse_iso("nonsense"))
        self.assertIsNone(sched.parse_iso(None))
        st = sched.status_for({"name": "x", "water": {"intervalDays": 3}, "lastWatered": "nope"}, "2026-09-19")
        self.assertEqual(st["dueDate"], "2026-09-19")

    def test_interval_is_never_below_one_day(self):
        self.assertEqual(sched.interval_on({"water": {"intervalDays": 0}}, "2026-06-01"), 7)
        self.assertEqual(sched.interval_on({"water": {"intervalDays": -5}}, "2026-06-01"), 7)
        self.assertEqual(sched.interval_on({"water": {"intervalDays": "bad"}}, "2026-06-01"), 7)

    def test_due_plants_are_sorted_most_overdue_first(self):
        plants = [
            {"name": "late", "water": {"intervalDays": 7}, "lastWatered": "2026-09-01"},
            {"name": "just due", "water": {"intervalDays": 7}, "lastWatered": "2026-09-12"},
        ]
        rows = sched.due_plants(plants, "2026-09-19")
        self.assertEqual([r["plant"]["name"] for r in rows], ["late", "just due"])


class TestMessage(unittest.TestCase):
    def setUp(self):
        self.rows = sched.due_plants(
            [
                {
                    "name": "Monstera",
                    "location": "Living room",
                    "water": {"intervalDays": 7, "amountMl": 500, "amountText": "2 cups",
                              "method": "Water until it drains"},
                    "lastWatered": "2026-09-01",
                },
                {
                    "name": "Fern",
                    "water": {"intervalDays": 3, "amountText": "a splash"},
                    "lastWatered": "2026-09-16",
                },
            ],
            "2026-09-19",
        )

    def test_message_lists_every_due_plant_with_instructions(self):
        msg = notify.build_message(self.rows, "2026-09-19", "https://example.com/")
        self.assertIn("Monstera", msg)
        self.assertIn("Fern", msg)
        self.assertIn("500 ml", msg)
        self.assertIn("2 cups", msg)
        self.assertIn("Water until it drains", msg)
        self.assertIn("OVERDUE 11 days", msg)
        self.assertIn("https://example.com/", msg)
        self.assertIn("2026-09-19", msg)

    def test_empty_when_nothing_is_due(self):
        self.assertEqual(notify.build_message([], "2026-09-19"), "")

    def test_message_is_capped_for_sms(self):
        many = [
            {"name": f"Plant number {i} with a long descriptive name",
             "water": {"intervalDays": 1, "amountText": "a generous pour of water"},
             "lastWatered": "2026-09-01"}
            for i in range(60)
        ]
        msg = notify.build_message(sched.due_plants(many, "2026-09-19"), "2026-09-19")
        self.assertLessEqual(len(msg), notify.MAX_SMS_CHARS)

    def test_singular_day_wording(self):
        rows = sched.due_plants(
            [{"name": "Aloe", "water": {"intervalDays": 7}, "lastWatered": "2026-09-11"}],
            "2026-09-19",
        )
        self.assertIn("OVERDUE 1 day —", notify.build_message(rows, "2026-09-19"))

    def test_transport_selection(self):
        twilio = {"TWILIO_ACCOUNT_SID": "AC1", "TWILIO_AUTH_TOKEN": "t",
                  "TWILIO_FROM": "+1", "SMS_TO": "+2"}
        self.assertEqual(notify.resolve_transport(twilio)[0], "twilio")
        email = {"SMTP_HOST": "smtp.gmail.com", "SMTP_USER": "a@b.c",
                 "SMTP_PASS": "x", "SMS_TO_EMAIL": "5551234567@vtext.com"}
        self.assertEqual(notify.resolve_transport(email)[0], "email")
        self.assertEqual(notify.resolve_transport({})[0], "none")
        partial = {"TWILIO_ACCOUNT_SID": "AC1", "TWILIO_AUTH_TOKEN": "t"}
        self.assertEqual(notify.resolve_transport(partial)[0], "none")


class TestRepoData(unittest.TestCase):
    def test_plants_json_is_valid_and_complete(self):
        data = json.loads((ROOT / "data" / "plants.json").read_text(encoding="utf-8"))
        self.assertIn("plants", data)
        self.assertIsInstance(data["plants"], list)
        ids = set()
        for plant in data["plants"]:
            self.assertTrue(plant.get("id"), "every plant needs an id")
            self.assertNotIn(plant["id"], ids, "plant ids must be unique")
            ids.add(plant["id"])
            self.assertTrue(plant.get("name"))
            self.assertGreaterEqual(int(plant["water"]["intervalDays"]), 1)
            if plant.get("lastWatered"):
                self.assertIsNotNone(sched.parse_iso(plant["lastWatered"]))

    def test_notifier_runs_against_the_real_data_file(self):
        rc = notify.main(["--today", "2026-09-30", "--dry-run", "--no-state"])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
