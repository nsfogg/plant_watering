#!/usr/bin/env python3
"""Send the daily "water your plants" text.

Runs inside GitHub Actions (.github/workflows/notify.yml) -- no server, no
cron box, no dependencies beyond the standard library.

Three delivery routes, picked automatically from whichever secrets exist, in
this priority order:

  1. Twilio       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, SMS_TO
                   (paid, pennies per text)
  2. Discord      DISCORD_WEBHOOK_URL
                   (free; the simplest to set up -- one URL, no bot to create)
  3. Email->SMS   SMTP_HOST, SMTP_USER, SMTP_PASS, SMS_TO_EMAIL   (free, but
                   depends on your carrier's gateway still being alive --
                   e.g. 5551234567@vtext.com -- and most are shutting these
                   down; point SMS_TO_EMAIL at your own inbox instead of a
                   gateway address for a route that always works)

Usage:
  python scripts/notify.py                 # send if anything is due
  python scripts/notify.py --dry-run       # print the message, send nothing
  python scripts/notify.py --today 2026-09-20 --dry-run
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import smtplib
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import schedule as sched  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "plants.json"
STATE_FILE = ROOT / "data" / "notify-state.json"

# Carrier gateways, for the free email->SMS route. Handy reference for setup.
CARRIER_GATEWAYS = {
    "verizon": "vtext.com",
    "tmobile": "tmomail.net",
    "sprint": "messaging.sprintpcs.com",
    "googlefi": "msg.fi.google.com",
    "uscellular": "email.uscc.net",
    "cricket": "sms.cricketwireless.net",
    "boost": "sms.myboostmobile.com",
    "metropcs": "mymetropcs.com",
}

MAX_SMS_CHARS = 1400
# Carrier gateways choke on long or non-ASCII bodies (Verizon truncates near 160
# and often mangles emoji), so the email route gets a plainer, shorter message.
MAX_GATEWAY_CHARS = 300
# Discord caps a plain message at 2000 characters.
MAX_DISCORD_CHARS = 1900

MAX_CHARS = {
    "twilio": MAX_SMS_CHARS,
    "discord": MAX_DISCORD_CHARS,
    "email": MAX_GATEWAY_CHARS,
}

ASCII_SWAPS = {
    "\u2014": "-", "\u2013": "-", "\u2022": "*", "\u2026": "...",
    "\u201c": '"', "\u201d": '"', "\u2018": "'", "\u2019": "'",
    "\u00b0": " deg", "\U0001f331": "", "\u00bd": "1/2", "\u00bc": "1/4", "\u00be": "3/4",
}


def to_ascii(text: str) -> str:
    """Plain ASCII for carrier gateways, without dropping meaning."""
    for src, dst in ASCII_SWAPS.items():
        text = text.replace(src, dst)
    # Decompose first, so Café -> Cafe and Señora -> Senora rather than
    # "Caf" and "Seora" once the non-ASCII bytes are dropped.
    text = unicodedata.normalize("NFKD", text)
    plain = text.encode("ascii", "ignore").decode("ascii")
    # Dropping a leading emoji must not leave the line starting with a space.
    return "\n".join(line.strip() for line in plain.split("\n"))


def zone(tz_name: str):
    """The garden's timezone, or None (with a warning) when the name is wrong.

    Runners are UTC, so silently falling back would shift the day boundary and
    make the --scheduled hour guard compare the wrong clock.
    """
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(tz_name)
    except Exception:
        print(
            f"::warning::'{tz_name}' is not a known timezone name; using UTC instead. "
            "Fix settings.timezone in data/plants.json (e.g. America/New_York).",
            file=sys.stderr,
        )
        return None


def local_today(tz_name: str) -> str:
    """Today's date in the garden's timezone (Actions runners are UTC)."""
    return datetime.now(zone(tz_name)).date().isoformat()


def local_hour(tz_name: str) -> int:
    """Current hour (0-23) in the garden's timezone.

    PLANTCARE_FAKE_HOUR exists so the scheduling behaviour can be exercised
    without waiting for a particular time of day; it is ignored in normal use.
    """
    override = os.environ.get("PLANTCARE_FAKE_HOUR", "").strip()
    if override.isdigit():
        return max(0, min(23, int(override)))
    return datetime.now(zone(tz_name)).hour


def load_data(path: Path) -> dict:
    """Read plants.json defensively.

    This file is hand-editable on github.com, and a crash here would mean no
    text AND no heartbeat commit -- which is how the schedule quietly dies.
    So anything unusable is dropped with a warning and the run continues.
    """
    if not path.exists():
        print(f"::warning::{path} does not exist; treating it as an empty garden.", file=sys.stderr)
        return {"plants": [], "settings": {}}

    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError) as err:
        print(f"::warning::{path} could not be read ({err}); treating it as empty.", file=sys.stderr)
        return {"plants": [], "settings": {}}

    if not isinstance(data, dict):
        print(f"::warning::{path} is not a JSON object; treating it as empty.", file=sys.stderr)
        return {"plants": [], "settings": {}}

    raw_plants = data.get("plants")
    if not isinstance(raw_plants, list):
        if raw_plants is not None:
            print(f"::warning::'plants' in {path} is not a list; ignoring it.", file=sys.stderr)
        raw_plants = []

    plants = [p for p in raw_plants if isinstance(p, dict)]
    if len(plants) != len(raw_plants):
        print(
            f"::warning::Ignored {len(raw_plants) - len(plants)} entry/entries in "
            f"{path} that were not plant objects.",
            file=sys.stderr,
        )

    settings = data.get("settings")
    data["plants"] = plants
    data["settings"] = settings if isinstance(settings, dict) else {}
    return data


def one_line(text, limit=90):
    """Collapse a multi-line note into something an SMS can carry."""
    if not text:
        return ""
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def build_message(rows, today: str, site_url: str = "", transport: str = "twilio") -> str:
    """One text covering everything due, with the care notes that matter.

    Carrier gateways cut messages off around 160 characters, so rather than
    truncating mid-sentence the message is rebuilt at decreasing levels of
    detail until it fits, and the link home is always kept.
    """
    if not rows:
        return ""

    gateway = transport == "email"
    limit = MAX_CHARS.get(transport, MAX_SMS_CHARS)

    # Richest first: 2 = everything, 1 = drop location, 0 = name + amount only.
    for detail in (2, 1, 0):
        message = _render(rows, today, site_url, gateway, detail)
        if len(message) <= limit:
            return message

    # Still too long: keep as many whole plants as fit, and say how many are left.
    for keep in range(len(rows) - 1, 0, -1):
        message = _render(rows[:keep], today, site_url, gateway, 0, more=len(rows) - keep)
        if len(message) <= limit:
            return message

    return trim(_render(rows[:1], today, site_url, gateway, 0, more=len(rows) - 1), limit)


def _render(rows, today, site_url, gateway, detail, more=0):
    lines = [f"\U0001f331 Plant watering — {today}"]

    for index, row in enumerate(rows):
        plant = row["plant"]
        bits = []
        if row.get("headsUp"):
            days = row["daysUntil"]
            bits.append(f"in {days} day{'s' if days != 1 else ''}")
        elif row["status"] == "overdue":
            days = row["daysOverdue"]
            bits.append(f"OVERDUE {days} day{'s' if days != 1 else ''}")
        bits.append(sched.amount_text(plant))

        water = plant.get("water") or {}
        if detail >= 1 and water.get("method"):
            bits.append(one_line(water["method"], 40 if gateway else 70))
        if detail >= 2 and plant.get("location"):
            bits.append(f"({one_line(plant['location'], 40)})")

        # one_line: a name containing newlines would otherwise forge extra
        # lines in the message, which reads like a scam text.
        name = one_line(plant.get("name"), 60) or "Unnamed plant"
        if gateway and not to_ascii(name).strip():
            # A wholly non-Latin name disappears in the ASCII fold, so give the
            # reader something they can still match to a plant.
            name = f"Plant #{index + 1}"
        if gateway:
            # Fold each part on its own and drop the ones that vanish, or a
            # non-Latin value would leave a dangling "-" in the line.
            bits = [b for b in (to_ascii(str(b)).strip() for b in bits) if b]
        lines.append(f"• {name}: " + " — ".join(b for b in bits if b))

    if more:
        lines.append(f"• +{more} more — see the site")
    if site_url:
        lines.append(f"Log it: {site_url}")

    message = "\n".join(lines)
    return to_ascii(message) if gateway else message


def trim(message: str, limit: int) -> str:
    """Last-resort cut: on a line or word boundary, never mid-word."""
    if len(message) <= limit:
        return message
    cut = message[: limit - 1]
    for sep in ("\n", " "):
        idx = cut.rfind(sep)
        if idx > limit * 0.6:
            cut = cut[:idx]
            break
    return cut.rstrip() + "+"


def send_twilio(message: str, cfg: dict) -> None:
    url = f"https://api.twilio.com/2010-04-01/Accounts/{cfg['sid']}/Messages.json"
    payload = urllib.parse.urlencode(
        {"To": cfg["to"], "From": cfg["from"], "Body": message}
    ).encode()
    auth = base64.b64encode(f"{cfg['sid']}:{cfg['token']}".encode()).decode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode())
        print(f"Twilio accepted message {body.get('sid')} -> {body.get('to')}")
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:500]
        raise SystemExit(f"Twilio rejected the message ({err.code}): {detail}") from err


def send_discord(message: str, cfg: dict) -> None:
    payload = json.dumps({"content": message}).encode()
    req = urllib.request.Request(
        cfg["webhook_url"],
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()  # Discord returns 204 No Content on success.
        print("Discord delivered the message.")
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:500]
        raise SystemExit(f"Discord rejected the message ({err.code}): {detail}") from err


def send_email_sms(message: str, cfg: dict) -> None:
    msg = EmailMessage()
    msg["From"] = cfg["user"]
    msg["To"] = cfg["to_email"]
    # Gateways prepend the subject; an empty one keeps the text clean.
    msg["Subject"] = cfg.get("subject", "")
    msg.set_content(message)

    port = int(cfg.get("port") or 587)
    host = cfg["host"]
    if port == 465:
        server = smtplib.SMTP_SSL(host, port, timeout=30)
    else:
        server = smtplib.SMTP(host, port, timeout=30)
    with server:
        if port != 465:
            server.starttls()
        server.login(cfg["user"], cfg["password"])
        server.send_message(msg)
    print(f"Sent via {host} -> {cfg['to_email']}")


def resolve_transport(env) -> tuple:
    """Return (kind, config) for whichever transport is fully configured."""
    sid = env.get("TWILIO_ACCOUNT_SID", "").strip()
    token = env.get("TWILIO_AUTH_TOKEN", "").strip()
    twilio_from = env.get("TWILIO_FROM", "").strip()
    sms_to = env.get("SMS_TO", "").strip()
    if sid and token and twilio_from and sms_to:
        return "twilio", {"sid": sid, "token": token, "from": twilio_from, "to": sms_to}

    webhook = env.get("DISCORD_WEBHOOK_URL", "").strip()
    if webhook:
        return "discord", {"webhook_url": webhook}

    host = env.get("SMTP_HOST", "").strip()
    user = env.get("SMTP_USER", "").strip()
    password = env.get("SMTP_PASS", "").strip()
    to_email = env.get("SMS_TO_EMAIL", "").strip()
    if host and user and password and to_email:
        return "email", {
            "host": host,
            "port": env.get("SMTP_PORT", "587").strip() or "587",
            "user": user,
            "password": password,
            "to_email": to_email,
            "subject": env.get("SMS_SUBJECT", "").strip(),
        }

    return "none", {}


def read_state(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        with path.open(encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return {}


def write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
        fh.write("\n")


def set_output(name: str, value: str) -> None:
    """Hand a value back to the workflow (GITHUB_OUTPUT), when running in CI."""
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"{name}={value}\n")


def heartbeat(today: str, extra=None, enabled: bool = True) -> None:
    """Record that the workflow ran.

    Committing this file is what keeps GitHub from auto-disabling the schedule
    after 60 quiet days, so it must be written whatever happens to the send --
    a misconfigured or failing notifier is exactly when the heartbeat matters.
    """
    if not enabled:
        return
    state = read_state(STATE_FILE)
    state["lastRun"] = today
    if extra:
        state.update(extra)
    write_state(STATE_FILE, state)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Text me which plants need water today.")
    parser.add_argument("--dry-run", action="store_true", help="print the message, send nothing")
    parser.add_argument("--today", help="pretend today is this YYYY-MM-DD date")
    parser.add_argument("--data", default=str(DATA_FILE), help="path to plants.json")
    parser.add_argument("--force", action="store_true", help="send even if nothing is due")
    parser.add_argument("--no-state", action="store_true", help="do not write notify-state.json")
    parser.add_argument(
        "--scheduled",
        action="store_true",
        help="cron mode: do nothing unless the local hour has reached settings.notifyHour",
    )
    parser.add_argument(
        "--print-date",
        action="store_true",
        help="print today's date in the garden's timezone and exit",
    )
    args = parser.parse_args(argv)

    data = load_data(Path(args.data))
    settings = data.get("settings") or {}
    tz_name = settings.get("timezone") or os.environ.get("TZ_NAME") or "America/New_York"
    today = args.today or local_today(tz_name)
    if sched.parse_iso(today) is None:
        raise SystemExit(f"--today must be YYYY-MM-DD, got {today!r}")

    if args.print_date:
        print(today)
        return 0

    # Dry runs must not touch the working tree, and must not consume the day's
    # heartbeat -- otherwise the real scheduled run later finds nothing to commit.
    keep_state = not args.no_state and not args.dry_run

    # GitHub cron only speaks UTC, so the workflow fires on both candidate hours
    # (one is 8am in summer, the other in winter) and this guard decides which
    # run is the real one. It deliberately does not demand an exact hour match:
    # GitHub's scheduler is routinely 10-60 minutes late, and a strict match
    # would silently drop the whole day. Instead: send once the local hour has
    # arrived, and never twice on the same date.
    if args.scheduled and not args.today:
        want = settings.get("notifyHour")
        want = int(want) if str(want).strip().lstrip("-").isdigit() else 8
        want = max(0, min(23, want))
        have = local_hour(tz_name)
        previous = read_state(STATE_FILE).get("lastNotified")
        if have < want:
            # Deliberately no state write: with an hourly schedule that would
            # rewrite the file (and commit) every hour instead of once a day.
            print(f"It is {have}:00 in {tz_name}; the text goes out at {want}:00. Too early.")
            return 0
        if previous == today:
            print(f"Already handled {today} - not sending twice.")
            return 0

    ahead = settings.get("remindAheadDays")
    try:
        ahead = max(0, min(14, int(ahead)))
    except (TypeError, ValueError):
        ahead = 0

    plants = data.get("plants") or []
    rows = sched.due_plants(plants, today)
    if ahead:
        due_ids = {id(r["plant"]) for r in rows}
        for plant in plants:
            if plant.get("archived") or id(plant) in due_ids:
                continue
            st = sched.status_for(plant, today)
            if 0 < st["daysUntil"] <= ahead:
                rows.append({"plant": plant, "headsUp": True, **st})
        rows.sort(key=lambda r: (r["dueDate"], (r["plant"].get("name") or "").lower()))

    site_url = (settings.get("siteUrl") or os.environ.get("SITE_URL") or "").strip()
    if site_url and not site_url.endswith("#today"):
        site_url = site_url.rstrip("/") + "/#today"

    kind, cfg = resolve_transport(os.environ)
    message = build_message(rows, today, site_url, kind if kind != "none" else "twilio")
    active = len([p for p in plants if not p.get("archived")])
    needing = len([r for r in rows if not r.get("headsUp")])

    print(f"Date: {today} ({tz_name})")
    print(f"Plants tracked: {active}")
    print(f"Needing water: {needing}" + (f" (+{len(rows) - needing} heads-up)" if len(rows) > needing else ""))

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write(f"### \U0001f331 Watering check {today}\n\n")
            fh.write(f"{needing} plant(s) need water.\n\n")
            if message:
                fh.write("```\n" + message + "\n```\n")

    claimed = {"lastNotified": today} if args.scheduled else {}

    if not rows and not args.force:
        print("Nothing due today - no text sent.")
        heartbeat(today, {"lastRunDue": 0, **claimed}, keep_state)
        return 0

    if not message:
        message = f"\U0001f331 Plant watering \u2014 {today}: nothing is due today."

    print("---- message ----")
    print(message)
    print("-----------------")

    if args.dry_run:
        print(f"Dry run - would send via: {kind}")
        return 0

    if kind == "none":
        # Exit 0 on purpose: a repo whose secrets are not set up yet should not
        # mail the owner a failed workflow every single morning. The step summary
        # and this notice say what to do instead.
        print(
            "\n*** No notification transport configured, so nothing was sent. ***\n"
            "Add one of: the Twilio secrets (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, "
            "TWILIO_FROM, SMS_TO), a Discord webhook (DISCORD_WEBHOOK_URL), or the "
            "free email-to-SMS secrets (SMTP_HOST, SMTP_USER, SMTP_PASS, "
            "SMS_TO_EMAIL) under Settings > Secrets and variables > Actions. "
            "See README.md, section 3.",
            file=sys.stderr,
        )
        if summary_path:
            with open(summary_path, "a", encoding="utf-8") as fh:
                fh.write("\n> \u26a0\ufe0f **No SMS transport configured** - no text was sent. "
                         "Add the secrets from README section 3.\n")
        heartbeat(today, {"lastRunDue": needing, "transport": "none", **claimed}, keep_state)
        return 0

    try:
        if kind == "twilio":
            send_twilio(message, cfg)
        elif kind == "discord":
            send_discord(message, cfg)
        else:
            send_email_sms(message, cfg)
    except BaseException:
        # Record the attempt (the heartbeat keeps the schedule alive) but do
        # NOT claim the day: the next hourly run must retry, or one transient
        # Twilio 500 would silently cost that day's reminder.
        heartbeat(today, {"lastRunDue": needing, "transport": kind, "lastError": today}, keep_state)
        raise

    # The workflow turns this into a cache marker, so the day cannot be sent
    # twice even if the run record fails to push (protected branch, say).
    set_output("sent", "true")
    heartbeat(
        today,
        {
            "lastSent": today,
            "lastError": None,
            "lastRunDue": needing,
            "lastPlants": [r["plant"].get("name") for r in rows],
            "transport": kind,
            **claimed,
        },
        keep_state,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
