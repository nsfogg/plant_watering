/**
 * Watering schedule math.
 *
 * Everything works on plain "YYYY-MM-DD" strings so that no timezone ever
 * shifts a due date by a day. The identical rules are implemented in
 * scripts/schedule.py -- keep the two files in sync (tests/ checks them).
 */

const DAY_MS = 86400000;
export const WINTER_MONTHS = [11, 12, 1, 2]; // Nov, Dec, Jan, Feb

/** "2026-09-19" -> Date at local midnight (never UTC-shifted). */
export function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    return null; // e.g. 2026-02-31
  }
  return d;
}

export function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Today's date. `timeZone` (an IANA name from the garden settings) keeps the
 * site's idea of "today" identical to the notifier's, even when the laptop is
 * travelling or its clock is set to another zone.
 */
export function todayISO(now = new Date(), timeZone = null) {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(now).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
      }, {});
      if (parts.year && parts.month && parts.day) {
        return `${parts.year}-${parts.month}-${parts.day}`;
      }
    } catch {
      // Unknown timezone name — fall back to the device's own date.
    }
  }
  return toISO(now);
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a, b) {
  const da = parseISO(a), db = parseISO(b);
  if (!da || !db) return 0;
  // Compare UTC-noon timestamps so DST transitions cannot round to 0.9 days.
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / DAY_MS);
}

export function isWinter(iso) {
  const d = parseISO(iso);
  if (!d) return false;
  return WINTER_MONTHS.includes(d.getMonth() + 1);
}

/** Days between waterings for this plant on a given date (seasonal aware). */
export function intervalOn(plant, iso) {
  const water = (plant && plant.water) || {};
  const base = Number(water.intervalDays);
  const winter = Number(water.winterIntervalDays);
  let n = base > 0 ? base : 7;
  if (isWinter(iso) && winter > 0) n = winter;
  return Math.max(1, Math.round(n));
}

/**
 * Every watering date for `plant` that falls inside [startISO, endISO].
 * The series is anchored on lastWatered and steps forward using the interval
 * that applies on each occurrence, so it adapts across seasons.
 */
export function occurrencesInRange(plant, startISO, endISO, today = todayISO()) {
  const out = [];
  if (!plant || plant.archived) return out;
  const start = parseISO(startISO), end = parseISO(endISO);
  if (!start || !end || start > end) return out;

  const push = (iso) => {
    const d = parseISO(iso);
    if (d && d >= start && d <= end && !out.includes(iso)) out.push(iso);
  };

  const anchored = plant.lastWatered && parseISO(plant.lastWatered);
  let cursor = anchored ? addDays(plant.lastWatered, intervalOn(plant, plant.lastWatered)) : today;

  // Overdue: show the dates that were missed, then put the plant on today --
  // it needs water NOW, and the schedule restarts from the day it gets it.
  if (daysBetween(today, cursor) < 0) {
    let guard = 0;
    while (guard++ < 5000 && daysBetween(today, cursor) < 0) {
      push(cursor);
      cursor = addDays(cursor, intervalOn(plant, cursor));
    }
    push(today);
    cursor = addDays(today, intervalOn(plant, today));
  }

  let guard = 0;
  while (guard++ < 5000) {
    const d = parseISO(cursor);
    if (!d || d > end) break;
    push(cursor);
    cursor = addDays(cursor, intervalOn(plant, cursor));
  }
  return out;
}

/** The first watering date on or after `fromISO`. */
export function nextDueDate(plant, fromISO = todayISO(), today = todayISO()) {
  if (!plant || plant.archived) return null;
  if (!plant.lastWatered || !parseISO(plant.lastWatered)) return today;
  let cursor = addDays(plant.lastWatered, intervalOn(plant, plant.lastWatered));
  let guard = 0;
  while (guard++ < 5000 && daysBetween(fromISO, cursor) < 0) {
    cursor = addDays(cursor, intervalOn(plant, cursor));
  }
  return cursor;
}

/**
 * Current watering status.
 * status: 'overdue' | 'today' | 'soon' (<= soonDays away) | 'ok'
 */
export function statusFor(plant, today = todayISO(), soonDays = 2) {
  const due = plant && plant.lastWatered && parseISO(plant.lastWatered)
    ? addDays(plant.lastWatered, intervalOn(plant, plant.lastWatered))
    : today;
  const diff = daysBetween(today, due); // negative = past due
  let status = 'ok';
  if (diff < 0) status = 'overdue';
  else if (diff === 0) status = 'today';
  else if (diff <= soonDays) status = 'soon';
  return {
    dueDate: due,
    nextDue: nextDueDate(plant, today, today),
    daysUntil: diff,
    daysOverdue: diff < 0 ? -diff : 0,
    status,
    needsWater: diff <= 0,
  };
}

/** Plants that need water on `today` (overdue first, then most thirsty). */
export function duePlants(plants, today = todayISO()) {
  return (plants || [])
    .filter((p) => p && !p.archived)
    .map((p) => ({ plant: p, ...statusFor(p, today) }))
    .filter((r) => r.needsWater)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.plant.name.localeCompare(b.plant.name));
}

/** Human summary of how much water to give. */
export function amountText(plant) {
  const w = (plant && plant.water) || {};
  const parts = [];
  if (w.amountMl) parts.push(`${w.amountMl} ml`);
  if (w.amountText) parts.push(w.amountText);
  return parts.join(' — ') || 'water until the soil is evenly moist';
}
