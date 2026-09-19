"""Watering schedule math.

Mirror of assets/js/schedule.js -- the browser and the notifier must agree on
what is due. Dates are plain "YYYY-MM-DD" strings; no timezone can shift them.
tests/test_parity.py checks both implementations against the same fixtures.
"""

from __future__ import annotations

from datetime import date, timedelta

WINTER_MONTHS = (11, 12, 1, 2)


def parse_iso(value):
    """'2026-09-19' -> date, or None when the string is not a valid date."""
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


def to_iso(d: date) -> str:
    return d.isoformat()


def add_days(iso: str, n: int):
    d = parse_iso(iso)
    if d is None:
        return None
    return to_iso(d + timedelta(days=n))


def days_between(a: str, b: str) -> int:
    da, db = parse_iso(a), parse_iso(b)
    if da is None or db is None:
        return 0
    return (db - da).days


def is_winter(iso: str) -> bool:
    d = parse_iso(iso)
    return bool(d) and d.month in WINTER_MONTHS


def interval_on(plant: dict, iso: str) -> int:
    water = plant.get("water") or {}
    base = _num(water.get("intervalDays"))
    winter = _num(water.get("winterIntervalDays"))
    n = base if base and base > 0 else 7
    if is_winter(iso) and winter and winter > 0:
        n = winter
    return max(1, round(n))


def _num(value):
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def occurrences_in_range(plant: dict, start_iso: str, end_iso: str, today: str) -> list:
    out = []
    if not plant or plant.get("archived"):
        return out
    start, end = parse_iso(start_iso), parse_iso(end_iso)
    if start is None or end is None or start > end:
        return out

    last = plant.get("lastWatered")
    if parse_iso(last) is None:
        cursor = today
        if start <= parse_iso(cursor) <= end:
            out.append(cursor)
    else:
        cursor = add_days(last, interval_on(plant, last))

    guard = 0
    while guard < 5000:
        guard += 1
        d = parse_iso(cursor)
        if d is None or d > end:
            break
        if d >= start and cursor not in out:
            out.append(cursor)
        cursor = add_days(cursor, interval_on(plant, cursor))
    return out


def next_due_date(plant: dict, from_iso: str, today: str):
    if not plant or plant.get("archived"):
        return None
    last = plant.get("lastWatered")
    if parse_iso(last) is None:
        return today
    cursor = add_days(last, interval_on(plant, last))
    guard = 0
    while guard < 5000 and days_between(from_iso, cursor) < 0:
        guard += 1
        cursor = add_days(cursor, interval_on(plant, cursor))
    return cursor


def status_for(plant: dict, today: str, soon_days: int = 2) -> dict:
    last = plant.get("lastWatered")
    due = add_days(last, interval_on(plant, last)) if parse_iso(last) else today
    diff = days_between(today, due)
    if diff < 0:
        status = "overdue"
    elif diff == 0:
        status = "today"
    elif diff <= soon_days:
        status = "soon"
    else:
        status = "ok"
    return {
        "dueDate": due,
        "nextDue": next_due_date(plant, today, today),
        "daysUntil": diff,
        "daysOverdue": -diff if diff < 0 else 0,
        "status": status,
        "needsWater": diff <= 0,
    }


def due_plants(plants, today: str) -> list:
    rows = []
    for p in plants or []:
        if not p or p.get("archived"):
            continue
        st = status_for(p, today)
        if st["needsWater"]:
            rows.append({"plant": p, **st})
    rows.sort(key=lambda r: (r["dueDate"], (r["plant"].get("name") or "").lower()))
    return rows


def amount_text(plant: dict) -> str:
    water = plant.get("water") or {}
    parts = []
    if water.get("amountMl"):
        parts.append(f"{water['amountMl']} ml")
    if water.get("amountText"):
        parts.append(str(water["amountText"]))
    return " — ".join(parts) or "water until the soil is evenly moist"
