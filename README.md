# 🌿 Plant Care

A plant watering tracker that runs entirely on GitHub — **no server, no database, no cron machine, nothing to pay for.**

- **The site** is static HTML/CSS/JS served by GitHub Pages.
- **The data** is `data/plants.json`, committed in this repository. The site can write it back to GitHub for you.
- **The reminders** are a scheduled GitHub Action that texts your phone each morning with the plants due that day and how to water them.

---

## What it does

| Where | What you get |
|---|---|
| **Today** | Everything that needs water right now, overdue counts, and the next 7 days. One tap to log a watering. |
| **My Plants** | Every plant as a card with its photo, schedule, light and location. Search, sort, archive. |
| **Calendar** | A month grid showing which plants get watered on which day, plus a 30-day agenda. |
| **Add Plant** | A form for everything worth remembering: water amount and frequency, sun, soil, fertilizer, humidity, temperature, pet safety, healthy-vs-struggling photos, warning signs and notes. |
| **Settings** | Publish to GitHub, download/import your data, and the reminder setup. |

Photos are shrunk in your browser before they are saved, so phone pictures don't bloat the repository.

---

## 1. Turn on GitHub Pages

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Push to `main`. The `Deploy site to GitHub Pages` workflow publishes the site.
3. It goes live at **https://nsfogg.github.io/plant_watering/**

### Linking it from nsfogg.github.io

Add a link to your main site — the simplest option, and nothing else changes:

```html
<a href="https://nsfogg.github.io/plant_watering/">🌿 Plant Care</a>
```

Prefer `nsfogg.github.io/plants/`? Copy `index.html`, `assets/`, and `data/` into a `plants/` folder in the `nsfogg.github.io` repository. Every path in the site is relative, so it works from any folder. Keep the Action in *this* repository for the texts — or copy `scripts/` and `.github/workflows/notify.yml` over too, pointing at whichever `plants.json` you keep up to date.

---

## 2. Saving plants from the website

Your browser holds a working copy, so the site is instant and works offline. **Publish** writes it back to `data/plants.json` in this repository — which is what the daily text reads.

1. Create a **fine-grained personal access token**: [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   - *Repository access* → Only select repositories → `plant_watering`
   - *Permissions* → Repository permissions → **Contents: Read and write**
2. In the site, open **Settings**, fill in owner / repo / branch, paste the token, press **Save connection**, then **Test connection**.
3. From then on, press **Publish changes to GitHub** after adding or watering plants.

The token is stored only in your own browser's `localStorage` and is sent only to `api.github.com`. Nothing else ever sees it. On a shared computer, press **Forget token** when you are done.

**No token?** Use **Download plants.json** and commit the file to `data/plants.json` yourself — or just edit `data/plants.json` by hand; the format is plain and documented below.

> ⚠️ This repository is public, so everything in `data/plants.json` is public. That is fine for plants. Your phone number is **not** stored there — it lives in repository secrets.

---

## 3. Daily text message

`.github/workflows/notify.yml` runs every morning at **12:00 UTC (8am EDT / 7am EST)**, reads `data/plants.json`, and texts you the plants due that day with their watering instructions. Change the `cron:` line to move the time — GitHub schedules in UTC only, so pick UTC = local + 4 (EDT) or + 5 (EST).

Pick **one** of the two routes and add its secrets under **Settings → Secrets and variables → Actions → New repository secret**.

### Route A — free, via your carrier's email-to-SMS gateway

No account, no cost. Send an email to `<your-number>@<carrier-gateway>` and it arrives as a text.

| Secret | Value |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | your Gmail address |
| `SMTP_PASS` | a Gmail **app password** ([myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), requires 2-factor auth) |
| `SMS_TO_EMAIL` | `<your 10-digit number>@<gateway>` |

Gateways: Verizon `vtext.com` · AT&T `txt.att.net` · T-Mobile `tmomail.net` · Google Fi `msg.fi.google.com` · US Cellular `email.uscc.net` · Cricket `sms.cricketwireless.net` · Boost `sms.myboostmobile.com` · Metro `mymetropcs.com`

So a Verizon number `5551234567` becomes `5551234567@vtext.com`.

*Carriers throttle and occasionally drop gateway mail, and a few are retiring these gateways. If texts stop arriving, switch to Route B.*

### Route B — Twilio (reliable, pennies per message)

| Secret | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from the Twilio console |
| `TWILIO_AUTH_TOKEN` | from the Twilio console |
| `TWILIO_FROM` | your Twilio number, `+15551234567` |
| `SMS_TO` | your phone, `+15551234567` |

If both routes are configured, Twilio wins.

### Trying it out

**Actions → Daily watering text → Run workflow.** Tick *dry run* to see the exact message without sending it, or set *today* to a date where something is due.

From a terminal:

```bash
python3 scripts/notify.py --dry-run                  # what would go out today
python3 scripts/notify.py --today 2026-10-05 --dry-run
```

A sent text looks like:

```
🌱 Plant watering — 2026-09-24
• Monstera: OVERDUE 2 days — 500 ml — about 2 cups — Water slowly until it drains, then empty the saucer — (Living room)
• Snake Plant: 300 ml — about 1 1/4 cups — Soak, then let it dry out completely — (Bedroom corner)
Log it: https://nsfogg.github.io/plant_watering/
```

Nothing due? No text is sent.

> GitHub disables scheduled workflows in repositories with no activity for 60 days. Each scheduled run commits `data/notify-state.json`, which counts as activity — so the schedule keeps itself alive.

---

## The data format

`data/plants.json`:

```jsonc
{
  "version": 1,
  "settings": {
    "timezone": "America/New_York",   // the day boundary used by the text
    "siteUrl": "https://nsfogg.github.io/plant_watering/"
  },
  "plants": [
    {
      "id": "unique-string",
      "name": "Monstera",
      "species": "Monstera deliciosa",
      "location": "Living room, near the south window",
      "water": {
        "intervalDays": 7,            // water every 7 days
        "winterIntervalDays": 12,     // ...but every 12 from Nov-Feb (optional)
        "amountMl": 500,
        "amountText": "about 2 cups",
        "method": "Water until it drains, then empty the saucer"
      },
      "sun": "Bright indirect light",
      "soil": "Chunky aroid mix",
      "fertilizer": "Half-strength balanced feed monthly, Apr-Sep",
      "humidity": "50%+",
      "temperature": "65-85°F",
      "toxicity": "Toxic to cats and dogs",
      "healthySigns": "Firm glossy leaves, regular new growth",
      "warningSigns": "Yellow lower leaves = overwatered. Crispy edges = too dry.",
      "notes": "Rotate a quarter turn each watering.",
      "photos": {
        "healthy": ["data/images/monstera-healthy-1.jpg"],
        "unhealthy": ["data/images/monstera-unhealthy-1.jpg"]
      },
      "lastWatered": "2026-09-15",
      "history": ["2026-09-15", "2026-09-08"],
      "archived": false
    }
  ]
}
```

Only `id`, `name` and `water.intervalDays` are required. The next watering is always `lastWatered + interval`, where the interval switches to `winterIntervalDays` during November–February. A plant with no `lastWatered` is due immediately.

The two example plants are there to show the shape — delete them once you have added your own.

---

## Repository layout

```
index.html                     the whole site
assets/css/style.css
assets/js/app.js               views, rendering, events
assets/js/store.js             localStorage + GitHub commits
assets/js/schedule.js          when is each plant due          ─┐ same rules,
assets/js/images.js            resize photos in the browser     │ two languages,
scripts/schedule.py            when is each plant due          ─┘ kept in sync by tests
scripts/notify.py              builds and sends the text
data/plants.json               your plants
data/images/                   photos uploaded from the site
.github/workflows/pages.yml    deploys the site
.github/workflows/notify.yml   sends the daily text
tests/                         schedule + message tests, incl. JS/Python parity
```

## Development

```bash
python3 -m http.server 8000     # then open http://localhost:8000
python3 tests/test_schedule.py  # run the tests (node optional, for parity)
```

The site uses ES modules, so open it over `http://`, not as a `file://` path.
