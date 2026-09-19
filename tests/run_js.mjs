/** Runs the browser schedule engine over tests/cases.json and prints JSON. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as sched from '../assets/js/schedule.js';

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));

const out = cases.map(({ why, today, plant }) => ({
  why,
  status: sched.statusFor(plant, today),
  occurrences: sched.occurrencesInRange(plant, today, sched.addDays(today, 120), today),
  amount: sched.amountText(plant),
  interval: sched.intervalOn(plant, today),
}));

process.stdout.write(JSON.stringify(out, null, 2));
