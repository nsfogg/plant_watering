#!/usr/bin/env python3
"""Send the daily "water your plants" text.

Runs inside GitHub Actions (.github/workflows/notify.yml) -- no server, no
cron box, no dependencies beyond the standard library.

Two delivery routes, picked automatically from whichever secrets exist:

  1. Twilio       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, SMS_TO
  2. Email->SMS   SMTP_HOST, SMTP_USER, SMTP_PASS, SMS_TO_EMAIL   (free: your
                  carrier's gateway, e.g. 5551234567@vtext.com)

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
    "att": "txt.att.net",
    "tmobile": "tmomail.net",
    "sprint": "messaging.sprintpcs.com",
    "googlefi": "msg.fi.google.com",
    "uscellular": "email.uscc.net",
    "cricket": "sms.cricketwireless.net",
    "boost": "sms.myboostmobile.com",
    "metropcs": "mymetropcs.com",
}

MAX_SMS_CHARS = 1400


def local_today(tz_name: str) -> str:
    """Today's date in the garden's timezone (Actions runners are UTC)."""
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(tz_name)).date().isoformat()
    except Exception:
        return datetime.now().date().isoformat()


def load_data(path: Path) -> dict:
    if not path.exists():
        return {"plants": [], "settings": {}}
    with path.open(encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    data.setdefault("plants", [])
    data.setdefault("settings", {})
    return data


def one_line(text, limit=90):
    """Collapse a multi-line note into something an SMS can carry."""
    if not text:
        return ""
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def build_message(rows, today: str, site_url: str = "") -> str:
    """One text covering everything due, with the care notes that matter."""
    if not rows:
        return ""

    header = f"🌱 Plant watering — {today}"
    lines = [header]

    for row in rows:
        plant = row["plant"]
        name = plant.get("name") or "Unnamed plant"
        bits = []
        if row["status"] == "overdue":
            days = row["daysOverdue"]
            bits.append(f"OVERDUE {days} day{'s' if days != 1 else ''}")
        bits.append(sched.amount_text(plant))

        water = plant.get("water") or {}
        if water.get("method"):
            bits.append(one_line(water["method"], 70))
        if plant.get("location"):
            bits.append(f"({one_line(plant['location'], 40)})")

        lines.append(f"• {name}: " + " — ".join(b for b in bits if b))

    if site_url:
        lines.append(f"Log it: {site_url}")

    message = "\n".join(lines)
    if len(message) > MAX_SMS_CHARS:
        message = message[: MAX_SMS_CHARS - 1].rstrip() + "…"
    return message


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


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Text me which plants need water today.")
    parser.add_argument("--dry-run", action="store_true", help="print the message, send nothing")
    parser.add_argument("--today", help="pretend today is this YYYY-MM-DD date")
    parser.add_argument("--data", default=str(DATA_FILE), help="path to plants.json")
    parser.add_argument("--force", action="store_true", help="send even if nothing is due")
    parser.add_argument("--no-state", action="store_true", help="do not write notify-state.json")
    args = parser.parse_args(argv)

    data = load_data(Path(args.data))
    settings = data.get("settings") or {}
    tz_name = settings.get("timezone") or os.environ.get("TZ_NAME") or "America/New_York"
    today = args.today or local_today(tz_name)
    if sched.parse_iso(today) is None:
        raise SystemExit(f"--today must be YYYY-MM-DD, got {today!r}")

    rows = sched.due_plants(data.get("plants"), today)
    site_url = (settings.get("siteUrl") or os.environ.get("SITE_URL") or "").strip()
    message = build_message(rows, today, site_url)

    print(f"Date: {today} ({tz_name})")
    print(f"Plants tracked: {len([p for p in data.get('plants', []) if not p.get('archived')])}")
    print(f"Needing water: {len(rows)}")

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write(f"### 🌱 Watering check {today}\n\n")
            fh.write(f"{len(rows)} plant(s) need water.\n\n")
            if message:
                fh.write("```\n" + message + "\n```\n")

    if not rows and not args.force:
        print("Nothing due today — no text sent.")
        if not args.no_state:
            state = read_state(STATE_FILE)
            state.update({"lastRun": today, "lastRunDue": 0})
            write_state(STATE_FILE, state)
        return 0

    if not message:
        message = f"🌱 Plant watering — {today}: nothing is due today."

    print("---- message ----")
    print(message)
    print("-----------------")

    kind, cfg = resolve_transport(os.environ)
    if args.dry_run:
        print(f"Dry run — would send via: {kind}")
        return 0

    if kind == "twilio":
        send_twilio(message, cfg)
    elif kind == "email":
        send_email_sms(message, cfg)
    else:
        print(
            "No SMS transport configured. Add either the Twilio secrets "
            "(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, SMS_TO) or the "
            "email-to-SMS secrets (SMTP_HOST, SMTP_USER, SMTP_PASS, SMS_TO_EMAIL). "
            "See README.md.",
            file=sys.stderr,
        )
        return 2

    if not args.no_state:
        state = read_state(STATE_FILE)
        state.update(
            {
                "lastRun": today,
                "lastSent": today,
                "lastRunDue": len(rows),
                "lastPlants": [r["plant"].get("name") for r in rows],
                "transport": kind,
            }
        )
        write_state(STATE_FILE, state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
