#!/usr/bin/env python3
"""Publish the watering schedule as an iCalendar feed.

This is the zero-setup reminder route: subscribe a phone to
https://<your site>/data/watering.ics from Apple Calendar, Google Calendar or
Outlook and the watering days -- with the instructions in each entry -- turn up
in the calendar the phone already nags you with. No Twilio account, no app
password, no repository secrets.

Regenerated on every deploy, so it always matches data/plants.json.

Usage:
  python scripts/make_ics.py                 # writes data/watering.ics
  python scripts/make_ics.py --out - --days 60
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import schedule as sched  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT / "data" / "plants.json"
DEFAULT_OUT = ROOT / "data" / "watering.ics"
HORIZON_DAYS = 180


def escape(text: str) -> str:
    """RFC 5545 text escaping."""
    return (
        str(text)
        .replace("\\", "\\\\")
        .replace(";", "\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def fold(line: str) -> str:
    """Wrap to 75 octets with a leading space on continuations, as the spec wants."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    out, current = [], b""
    for char in line:
        encoded = char.encode("utf-8")
        limit = 75 if not out else 74
        if len(current) + len(encoded) > limit:
            out.append(current.decode("utf-8"))
            current = b""
        current += encoded
    out.append(current.decode("utf-8"))
    return "\r\n ".join(out)


def build(data: dict, today: str, horizon_days: int = HORIZON_DAYS) -> str:
    settings = data.get("settings") or {}
    tz_name = settings.get("timezone") or "America/New_York"
    hour = settings.get("notifyHour")
    hour = int(hour) if str(hour).strip().isdigit() else 8
    hour = max(0, min(23, hour))
    site = (settings.get("siteUrl") or "").strip()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    end = sched.add_days(today, horizon_days)

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Plant Care//Watering schedule//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Plant watering",
        f"X-WR-TIMEZONE:{tz_name}",
        # Tell subscribers to re-fetch twice a day, so a change shows up quickly.
        "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
        "X-PUBLISHED-TTL:PT12H",
    ]

    for plant in data.get("plants") or []:
        if not isinstance(plant, dict) or plant.get("archived"):
            continue
        name = str(plant.get("name") or "Unnamed plant")
        detail = [sched.amount_text(plant)]
        water = plant.get("water") or {}
        for key, label in (("method", ""), ):
            if water.get(key):
                detail.append(str(water[key]))
        for key, label in (("sun", "Light"), ("location", "Where"),
                           ("warningSigns", "Watch for"), ("notes", "Notes")):
            if plant.get(key):
                detail.append(f"{label}: {plant[key]}" if label else str(plant[key]))
        if site:
            detail.append(f"Log it: {site.rstrip('/')}/#today")
        description = "\n".join(detail)

        for date_iso in sched.occurrences_in_range(plant, today, end, today):
            compact = date_iso.replace("-", "")
            uid = f"{plant.get('id') or name}-{compact}@plant-care"
            lines += [
                "BEGIN:VEVENT",
                f"UID:{escape(uid)}",
                f"DTSTAMP:{stamp}",
                f"DTSTART;VALUE=DATE:{compact}",
                f"DTEND;VALUE=DATE:{sched.add_days(date_iso, 1).replace('-', '')}",
                f"SUMMARY:Water {escape(name)}",
                f"DESCRIPTION:{escape(description)}",
                "TRANSP:TRANSPARENT",
                "BEGIN:VALARM",
                f"TRIGGER;RELATED=START:PT{hour}H",
                "ACTION:DISPLAY",
                f"DESCRIPTION:{escape(f'Water {name} — {sched.amount_text(plant)}')}",
                "END:VALARM",
                "END:VEVENT",
            ]

    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(line) for line in lines) + "\r\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Write the watering schedule as an .ics feed.")
    parser.add_argument("--data", default=str(DEFAULT_DATA))
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="file path, or - for stdout")
    parser.add_argument("--days", type=int, default=HORIZON_DAYS)
    parser.add_argument("--today", help="pretend today is this YYYY-MM-DD date")
    args = parser.parse_args(argv)

    path = Path(args.data)
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (json.JSONDecodeError, OSError) as err:
        print(f"::warning::Could not read {path} ({err}); writing an empty calendar.", file=sys.stderr)
        data = {}
    if not isinstance(data, dict):
        data = {}
    data["plants"] = [p for p in (data.get("plants") or []) if isinstance(p, dict)]

    today = args.today or datetime.now().date().isoformat()
    ics = build(data, today, max(1, min(730, args.days)))

    if args.out == "-":
        sys.stdout.write(ics)
    else:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(ics, encoding="utf-8", newline="")
        events = ics.count("BEGIN:VEVENT")
        print(f"Wrote {out} — {events} watering event(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
