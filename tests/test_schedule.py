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

import make_ics  # noqa: E402
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
                "calendar": sched.occurrences_in_range(
                    plant, sched.add_days(today, -35), sched.add_days(today, 35), today
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


class TestOverdueScheduling(unittest.TestCase):
    """An overdue plant must be on today's calendar, not only in the past."""

    def setUp(self):
        self.plant = {"name": "Ivy", "water": {"intervalDays": 7}, "lastWatered": "2026-08-20"}

    def test_today_is_included_when_overdue(self):
        got = sched.occurrences_in_range(self.plant, "2026-09-01", "2026-09-30", "2026-09-19")
        self.assertIn("2026-09-19", got, "an overdue plant must show up today")

    def test_missed_dates_are_still_visible(self):
        got = sched.occurrences_in_range(self.plant, "2026-09-01", "2026-09-30", "2026-09-19")
        self.assertIn("2026-09-03", got)
        self.assertIn("2026-09-10", got)

    def test_future_series_restarts_from_today(self):
        got = sched.occurrences_in_range(self.plant, "2026-09-19", "2026-10-10", "2026-09-19")
        self.assertEqual(got, ["2026-09-19", "2026-09-26", "2026-10-03", "2026-10-10"])

    def test_on_time_plant_is_unaffected(self):
        p = {"name": "OK", "water": {"intervalDays": 7}, "lastWatered": "2026-09-17"}
        self.assertEqual(
            sched.occurrences_in_range(p, "2026-09-01", "2026-09-30", "2026-09-19"),
            ["2026-09-24"],
        )

    def test_never_watered_plant_is_due_today_only_once(self):
        p = {"name": "New", "water": {"intervalDays": 4}}
        got = sched.occurrences_in_range(p, "2026-09-01", "2026-09-30", "2026-09-19")
        self.assertEqual(got, ["2026-09-19", "2026-09-23", "2026-09-27"])


class TestStrictDates(unittest.TestCase):
    """The browser's regex and Python's parser must accept exactly the same set."""

    def test_only_canonical_dates_are_accepted(self):
        for bad in ["20260905", "2026-09-05T08:00:00", "2026-9-5", "2026-09-05Z", " ", "2026-13-01"]:
            with self.subTest(value=bad):
                self.assertIsNone(sched.parse_iso(bad))
        self.assertIsNotNone(sched.parse_iso("2026-09-05"))

    def test_rounding_is_half_up_like_javascript(self):
        self.assertEqual(sched.interval_on({"water": {"intervalDays": 10.5}}, "2026-06-01"), 11)
        self.assertEqual(sched.interval_on({"water": {"intervalDays": 2.5}}, "2026-06-01"), 3)
        self.assertEqual(sched.interval_on({"water": {"intervalDays": 3.5}}, "2026-06-01"), 4)


class TestNotifyHour(unittest.TestCase):
    """The hourly workflow must send once a day, at the hour the user picked."""

    def _run_day(self, notify_hour, due=True):
        import contextlib
        import io
        import tempfile
        from unittest import mock

        data = {
            "settings": {"timezone": "America/New_York", "notifyHour": notify_hour},
            "plants": [{
                "id": "x", "name": "Fern", "water": {"intervalDays": 3},
                "lastWatered": "2026-09-01" if due else "2026-09-23",
            }],
        }
        sends = []
        with tempfile.TemporaryDirectory() as tmp:
            data_path = Path(tmp) / "plants.json"
            data_path.write_text(json.dumps(data), encoding="utf-8")
            state_path = Path(tmp) / "state.json"
            with mock.patch.object(notify, "STATE_FILE", state_path):
                for hour in range(24):
                    with mock.patch.object(notify, "local_hour", return_value=hour), \
                         mock.patch.object(notify, "local_today", return_value="2026-09-24"):
                        buf = io.StringIO()
                        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                            notify.main(["--scheduled", "--data", str(data_path)])
                        if "---- message ----" in buf.getvalue():
                            sends.append(hour)
        return sends

    def test_sends_once_at_the_chosen_hour(self):
        for hour in (0, 6, 8, 13, 20, 23):
            with self.subTest(notifyHour=hour):
                self.assertEqual(self._run_day(hour), [hour])

    def test_quiet_day_still_sends_nothing(self):
        self.assertEqual(self._run_day(8, due=False), [])


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

    def test_gateway_message_is_ascii_and_short(self):
        many = [
            {"name": f"Plant {i}", "water": {"intervalDays": 1, "amountMl": 250,
                                             "amountText": "one cup", "method": "Soak it well and drain"},
             "location": "Kitchen windowsill", "lastWatered": "2026-09-01"}
            for i in range(8)
        ]
        rows = sched.due_plants(many, "2026-09-19")
        msg = notify.build_message(rows, "2026-09-19", "https://example.com/#today", "email")
        self.assertLessEqual(len(msg), notify.MAX_GATEWAY_CHARS)
        self.assertTrue(msg.isascii(), f"gateway message must be ASCII: {msg!r}")
        self.assertIn("https://example.com/#today", msg)
        self.assertNotIn("\u2014", msg)
        self.assertFalse(any(line.startswith(" ") for line in msg.split("\n")))

    def test_gateway_keeps_detail_when_there_is_room(self):
        rows = sched.due_plants(
            [{"name": "Fern", "water": {"intervalDays": 3, "amountText": "a splash",
                                        "method": "Mist the leaves"}, "lastWatered": "2026-09-01"}],
            "2026-09-19",
        )
        msg = notify.build_message(rows, "2026-09-19", "", "email")
        self.assertIn("Mist the leaves", msg)

    def test_heads_up_rows_are_labelled(self):
        rows = [{"plant": {"name": "Aloe", "water": {"intervalDays": 7}}, "headsUp": True,
                 "daysUntil": 2, "status": "soon", "daysOverdue": 0, "dueDate": "2026-09-21"}]
        self.assertIn("in 2 days", notify.build_message(rows, "2026-09-19"))

    def test_transport_selection(self):
        twilio = {"TWILIO_ACCOUNT_SID": "AC1", "TWILIO_AUTH_TOKEN": "t",
                  "TWILIO_FROM": "+1", "SMS_TO": "+2"}
        self.assertEqual(notify.resolve_transport(twilio)[0], "twilio")
        telegram = {"TELEGRAM_BOT_TOKEN": "123:ABC", "TELEGRAM_CHAT_ID": "999"}
        self.assertEqual(notify.resolve_transport(telegram)[0], "telegram")
        email = {"SMTP_HOST": "smtp.gmail.com", "SMTP_USER": "a@b.c",
                 "SMTP_PASS": "x", "SMS_TO_EMAIL": "5551234567@vtext.com"}
        self.assertEqual(notify.resolve_transport(email)[0], "email")
        self.assertEqual(notify.resolve_transport({})[0], "none")
        partial = {"TWILIO_ACCOUNT_SID": "AC1", "TWILIO_AUTH_TOKEN": "t"}
        self.assertEqual(notify.resolve_transport(partial)[0], "none")
        partial_telegram = {"TELEGRAM_BOT_TOKEN": "123:ABC"}
        self.assertEqual(notify.resolve_transport(partial_telegram)[0], "none")

    def test_transport_priority_twilio_then_telegram_then_email(self):
        # Twilio wins when several are configured at once; Telegram beats the
        # carrier email gateway, since gateways are progressively being retired.
        all_three = {
            "TWILIO_ACCOUNT_SID": "AC1", "TWILIO_AUTH_TOKEN": "t",
            "TWILIO_FROM": "+1", "SMS_TO": "+2",
            "TELEGRAM_BOT_TOKEN": "123:ABC", "TELEGRAM_CHAT_ID": "999",
            "SMTP_HOST": "h", "SMTP_USER": "u", "SMTP_PASS": "p", "SMS_TO_EMAIL": "x@y.com",
        }
        self.assertEqual(notify.resolve_transport(all_three)[0], "twilio")
        telegram_and_email = {k: v for k, v in all_three.items() if not k.startswith("TWILIO") and k != "SMS_TO"}
        self.assertEqual(notify.resolve_transport(telegram_and_email)[0], "telegram")

    def test_telegram_message_keeps_full_unicode_and_detail(self):
        # Unlike the carrier-gateway route, Telegram supports full unicode and
        # a much longer message, so nothing should be folded or trimmed here.
        rows = sched.due_plants(
            [{"name": "Café Ficus 🌿", "water": {"intervalDays": 7, "amountMl": 500,
              "amountText": "about 2 cups", "method": "Water until it drains"},
              "location": "Living room", "lastWatered": "2026-09-01"}],
            "2026-09-19",
        )
        msg = notify.build_message(rows, "2026-09-19", "https://example.com/#today", "telegram")
        self.assertIn("Café Ficus 🌿", msg)
        self.assertIn("Living room", msg)
        self.assertIn("Water until it drains", msg)
        self.assertLessEqual(len(msg), notify.MAX_TELEGRAM_CHARS)


class TestHostileData(unittest.TestCase):
    """plants.json is hand-editable on github.com. A bad edit must not take the
    daily text down -- a crash also skips the heartbeat that keeps the schedule
    from being auto-disabled after 60 quiet days."""

    def _run(self, content):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "plants.json"
            path.write_text(content, encoding="utf-8")
            return notify.main(["--data", str(path), "--today", "2026-09-19", "--dry-run", "--no-state"])

    def test_survives_every_shape_of_bad_file(self):
        cases = {
            "a JSON list": "[1, 2, 3]",
            "plants as an object": '{"plants": {"a": {}}}',
            "junk entries": '{"plants": [null, "text", 42]}',
            "a numeric name": '{"plants": [{"name": 12345, "water": {"intervalDays": 3}}]}',
            "not JSON at all": "this is not json",
            "empty file": "",
            "null settings": '{"settings": null, "plants": []}',
            "impossible date": '{"plants": [{"name": "X", "water": {"intervalDays": 3}, "lastWatered": "2026-02-30"}]}',
        }
        for why, content in cases.items():
            with self.subTest(case=why):
                self.assertEqual(self._run(content), 0, f"{why} should not crash the notifier")

    def test_missing_file_is_an_empty_garden(self):
        self.assertEqual(
            notify.main(["--data", "/nonexistent/plants.json", "--today", "2026-09-19", "--dry-run", "--no-state"]),
            0,
        )

    def test_names_cannot_forge_extra_lines_in_the_text(self):
        rows = sched.due_plants(
            [{"name": "Fern\nSTOP. Send $500 to http://evil.example now\nFern",
              "water": {"intervalDays": 3}, "lastWatered": "2026-09-01"}],
            "2026-09-19",
        )
        msg = notify.build_message(rows, "2026-09-19")
        self.assertEqual(len(msg.split("\n")), 2, f"one header line and one plant line, got: {msg!r}")

    def test_non_ascii_names_stay_identifiable_on_the_gateway(self):
        rows = sched.due_plants(
            [
                {"name": "Café Ficus", "water": {"intervalDays": 3}, "lastWatered": "2026-09-01"},
                {"name": "龟背竹", "water": {"intervalDays": 3}, "lastWatered": "2026-09-01"},
            ],
            "2026-09-19",
        )
        msg = notify.build_message(rows, "2026-09-19", "", "email")
        self.assertIn("Cafe Ficus", msg, "accents transliterate rather than disappear")
        self.assertTrue(msg.isascii())
        for line in msg.split("\n"):
            if line.startswith("*"):
                label = line.split(":")[0].lstrip("* ").strip()
                self.assertTrue(label, f"every plant line must name something: {line!r}")


class TestCalendarFeed(unittest.TestCase):
    """The .ics feed is the reminder route that needs no accounts at all."""

    def setUp(self):
        self.data = {
            "settings": {"timezone": "America/New_York", "notifyHour": 7,
                         "siteUrl": "https://example.com/plants/"},
            "plants": [{
                "id": "fern", "name": "Fern, the big one",
                "water": {"intervalDays": 7, "amountMl": 500, "amountText": "2 cups",
                          "method": "Soak; drain fully"},
                "sun": "Bright indirect", "lastWatered": "2026-09-15",
            }],
        }

    def test_structure_is_valid_icalendar(self):
        ics = make_ics.build(self.data, "2026-09-19", 30)
        self.assertTrue(ics.startswith("BEGIN:VCALENDAR\r\n"))
        self.assertTrue(ics.endswith("END:VCALENDAR\r\n"))
        self.assertEqual(ics.count("BEGIN:VEVENT"), ics.count("END:VEVENT"))
        self.assertEqual(ics.count("BEGIN:VALARM"), ics.count("END:VALARM"))
        self.assertIn("DTSTART;VALUE=DATE:20260922", ics)
        self.assertIn("SUMMARY:Water Fern\\, the big one", ics)  # comma escaped
        self.assertIn("TRIGGER;RELATED=START:PT7H", ics)           # the chosen hour

    def test_every_line_fits_the_75_octet_limit(self):
        data = dict(self.data)
        data["plants"] = [dict(self.data["plants"][0], notes="x" * 500, name="Ünïcödé " * 12)]
        ics = make_ics.build(data, "2026-09-19", 14)
        for line in ics.split("\r\n"):
            self.assertLessEqual(len(line.encode("utf-8")), 75, f"unfolded line: {line[:60]}…")

    def test_instructions_travel_with_the_event(self):
        ics = make_ics.build(self.data, "2026-09-19", 14)
        self.assertIn("500 ml", ics)
        self.assertIn("2 cups", ics)
        self.assertIn("Soak", ics)
        self.assertIn("Bright indirect", ics)

    def test_archived_plants_are_left_out(self):
        data = dict(self.data)
        data["plants"] = [dict(self.data["plants"][0], archived=True)]
        self.assertEqual(make_ics.build(data, "2026-09-19", 30).count("BEGIN:VEVENT"), 0)

    def test_empty_garden_still_produces_a_valid_feed(self):
        ics = make_ics.build({"plants": []}, "2026-09-19", 30)
        self.assertIn("BEGIN:VCALENDAR", ics)
        self.assertEqual(ics.count("BEGIN:VEVENT"), 0)

    def test_dates_match_the_apps_schedule_exactly(self):
        ics = make_ics.build(self.data, "2026-09-19", 40)
        expected = sched.occurrences_in_range(
            self.data["plants"][0], "2026-09-19", sched.add_days("2026-09-19", 40), "2026-09-19"
        )
        in_feed = [ln.split(":")[1] for ln in ics.split("\r\n") if ln.startswith("DTSTART")]
        self.assertEqual(in_feed, [d.replace("-", "") for d in expected])


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
