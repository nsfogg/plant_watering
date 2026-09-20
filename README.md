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

> **Before you start:** free GitHub Pages only serves **public** repositories, so everything in `data/plants.json` — plant names, rooms, notes, photos — is visible to anyone who looks. That is usually fine for plants. Your phone number is the one thing that stays private: it goes in a repository secret, never in the repo.

## 1. Turn on GitHub Pages

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.** Do this *first* — if you skip it, the deploy fails with `Get Pages site failed … HttpError: Not Found`, because a workflow is not allowed to enable Pages for you.
2. Push to `main`. The `Deploy site to GitHub Pages` workflow publishes the site.
3. It goes live at **https://nsfogg.github.io/plant_watering/**

### Linking it from nsfogg.github.io

Add a link to your main site — the simplest option, and nothing else changes:

```html
<a href="https://nsfogg.github.io/plant_watering/">🌿 Plant Care</a>
```

**Prefer `nsfogg.github.io/plants/`?** Copy `index.html`, `manifest.webmanifest`, `sw.js`, `assets/` and `data/` into a `plants/` folder in the `nsfogg.github.io` repository — every path in the site is relative, so it runs from any folder. Then, in the site's **Settings**, set:

- *Repository name* → `nsfogg.github.io`
- *Folder inside the repository* → `plants`

Without that folder setting, Publish would write to `data/plants.json` at the **root** of your user site instead of `plants/data/plants.json`, and your changes would seem to disappear. Press **Test connection** afterwards: it tells you exactly which file it found.

For the daily text, keep the Action in whichever repository holds the `plants.json` you actually update.

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

**Turn on "Publish automatically"** in Settings and the site commits for you after every watering or edit, so the daily text is never working from stale data. Without it, a banner across the top of every page reminds you that there are unpublished changes.

Fine-grained tokens **expire** — 30 days by default, and up to a year if you choose. The site reads the expiry date from GitHub and warns you in Settings and after publishing when it is within a week; when it lapses, create a new token and paste it in. Nothing else changes.

**Editing from two devices** is safe: publishing merges with whatever is already on GitHub, plant by plant, using each plant's own timestamp. Watering the fern on your phone and renaming the ficus on your laptop both survive, whichever one publishes second. Deletions are remembered too, so a stale device cannot resurrect a plant you removed.

> ⚠️ This repository is public, so everything in `data/plants.json` is public. That is fine for plants. Your phone number is **not** stored there — it lives in repository secrets.

---

## 3. Reminders

There are two, and you can use either or both.

### Free, no accounts: subscribe your phone's calendar

Every deploy publishes **`https://nsfogg.github.io/plant_watering/data/watering.ics`** — your watering schedule for the next six months, with each plant's amount, method, light and warning signs in the entry, and an alarm at the hour you chose.

- **iPhone:** Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar → paste the link.
- **Android / Google Calendar:** calendar.google.com → Other calendars → **+** → From URL → paste the link.
- **Outlook:** Add calendar → Subscribe from web → paste the link.

Your phone then reminds you with no Twilio account, no app password and no repository secrets. The site's **Settings → Phone calendar** has a button that copies the link for you. Calendar apps re-fetch every few hours, so changes show up on their own.

### The daily text message

`.github/workflows/notify.yml` reads `data/plants.json` and texts you the plants due that day with their watering instructions.

It runs **hourly**, and `scripts/notify.py` sends on the first run at or after the time you choose in **Settings → Send the text at** (8am by default), at most once a day. That is deliberate: GitHub's scheduler only understands UTC and is often 10–60 minutes late, so an hourly check means the text arrives at the right *local* time all year — including across daylight saving — and a run GitHub delays or drops is simply picked up by the next one. You never have to edit the cron line.

**Settings → Warn me this many days early** adds a heads-up line for plants coming due soon, if you want the warning before the day itself.

Pick **one** of the three routes below and add its secrets under **Settings → Secrets and variables → Actions → New repository secret**. If more than one is configured, priority is Twilio, then Discord, then the email gateway — but you only need one.

### Route A — Discord (free, simplest to set up)

No account beyond Discord itself, no bot to create — just one URL.

1. Open Discord (or create a free account). Make a server for yourself if you don't already have one: **+** at the bottom of the server list → **Create My Own** → "For me and my friends" is fine.
2. Pick the channel you want reminders in → the gear icon (Edit Channel) → **Integrations** → **Webhooks** → **New Webhook**.
3. Name it (e.g. "Plant Care"), then **Copy Webhook URL**.

| Secret | Value |
|---|---|
| `DISCORD_WEBHOOK_URL` | the URL you copied |

Reminders arrive as a message in that channel, with a push notification from the Discord app exactly like a DM.

### Route B — Twilio (paid, pennies per message)

The most universal option — a real SMS, no app required.

| Secret | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from the Twilio console |
| `TWILIO_AUTH_TOKEN` | from the Twilio console |
| `TWILIO_FROM` | your Twilio number, `+15551234567` |
| `SMS_TO` | your phone, `+15551234567` |

### Route C — your carrier's email-to-SMS gateway (free, increasingly unreliable)

No account beyond Gmail, but carriers are actively retiring these. Try Route A instead unless you know your carrier's gateway is still alive. (Or skip the gateway trick entirely and point `SMS_TO_EMAIL` at your own inbox — same secrets, and it always works as long as Gmail does.)

| Secret | Value |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | your Gmail address |
| `SMTP_PASS` | a Gmail **app password** ([myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), requires 2-factor auth) |
| `SMS_TO_EMAIL` | `<your 10-digit number>@<gateway>`, or your own email address |

Gateways: Verizon `vtext.com` · T-Mobile `tmomail.net` · Google Fi `msg.fi.google.com` · US Cellular `email.uscc.net` · Cricket `sms.cricketwireless.net` · Boost `sms.myboostmobile.com` · Metro `mymetropcs.com`

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

**Settings tells you whether it is actually working.** The notifier records every run in `data/notify-state.json`, and the site reads it back: *"Last text sent Sep 19 via Twilio — Monstera, Fern"*, or *"found plants due, but no text could be sent — the secrets are not set up yet"*. There is also a setup checklist that ticks itself off as you go.

> **Two things to know about scheduled workflows**
>
> - GitHub disables them in repositories with no activity for 60 days. The daily run commits `data/notify-state.json` (once a day, whatever happens to the send — including failures), which counts as activity, so the schedule keeps itself alive.
> - That commit is made by `github-actions[bot]`. If you protect `main`, either let GitHub Actions bypass it or expect the "Record the run" step to warn — the text still sends, and a separate Actions-cache marker makes sure a failed record cannot cause a repeat text later the same day.

A send that fails (a Twilio blip, an SMTP timeout) is retried by the next hourly run, so a transient failure costs a few hours, not the day.

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

Only `id`, `name` and `water.intervalDays` are required. The next watering is always `lastWatered + interval`, where the interval switches to `winterIntervalDays` during November–February. A plant with no `lastWatered` is due immediately, and an overdue plant appears on **today** in the calendar with its schedule restarting from the day you actually water it.

Dates must be exactly `YYYY-MM-DD` and intervals must be whole days — both the site and the texter reject anything else, so they can never disagree about which day a plant is due.

`settings` also accepts `notifyHour` (0–23, the local hour the text goes out) and `remindAheadDays` (0–14, how many days of early warning to include).

The two example plants are there to show the shape — delete them once you have added your own.

---

## Repository layout

```
index.html                     the whole site
manifest.webmanifest           makes it installable on a phone
sw.js                          service worker — the site works with no signal
assets/css/style.css
assets/js/app.js               views, rendering, events
assets/js/store.js             localStorage, merging, GitHub commits
assets/js/schedule.js          when is each plant due          ─┐ same rules,
assets/js/images.js            resize photos in the browser     │ two languages,
scripts/schedule.py            when is each plant due          ─┘ kept in sync by tests
scripts/notify.py              builds and sends the text
scripts/make_ics.py            publishes the calendar feed
data/plants.json               your plants
data/watering.ics              calendar feed, rebuilt on every deploy
data/images/                   photos uploaded from the site
.github/workflows/pages.yml    deploys the site
.github/workflows/notify.yml   sends the daily text
tests/                         schedule, merge and message tests
```

On a phone, open the site and use **Add to Home Screen**: it installs like an app, and thanks to `sw.js` it opens and works at the sink even with no signal. Anything you change offline is saved locally and published the next time you have a connection. The 🌗 button in the header switches between matching your device, light and dark.

## Development

```bash
python3 -m http.server 8000       # then open http://localhost:8000
python3 tests/test_schedule.py    # schedule + message tests (node optional, for JS/Python parity)
node tests/merge.test.mjs         # multi-device merge tests
python3 scripts/notify.py --dry-run --no-state
python3 scripts/make_ics.py --out - --days 30     # preview the calendar feed
```

The site uses ES modules, so open it over `http://`, not as a `file://` path.
