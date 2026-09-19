/**
 * Merge tests: the whole point is that no device's work is ever silently lost.
 * Run: node tests/merge.test.mjs
 */
import assert from 'node:assert/strict';
import { mergeDocs, normalizeDoc } from '../assets/js/store.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
};

const plant = (id, name, updatedAt, extra = {}) => ({
  id, name, water: { intervalDays: 7 }, updatedAt, createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const doc = (plants, extra = {}) => ({ version: 1, updatedAt: '2026-09-19T00:00:00.000Z', plants, ...extra });

test('a plant added on one device only is kept', () => {
  const merged = mergeDocs(doc([plant('a', 'Aloe', '2026-09-01T00:00:00Z')]),
                           doc([plant('b', 'Basil', '2026-09-02T00:00:00Z')]));
  assert.deepEqual(merged.plants.map((p) => p.id).sort(), ['a', 'b']);
});

test('the newer edit of the same plant wins', () => {
  const merged = mergeDocs(doc([plant('a', 'Old name', '2026-09-01T00:00:00Z')]),
                           doc([plant('a', 'New name', '2026-09-05T00:00:00Z')]));
  assert.equal(merged.plants.length, 1);
  assert.equal(merged.plants[0].name, 'New name');
});

test('an older local copy does not clobber a newer published one', () => {
  const remote = doc([plant('a', 'Watered on phone', '2026-09-10T00:00:00Z', { lastWatered: '2026-09-10' })]);
  const stale = doc([plant('a', 'Laptop copy', '2026-09-02T00:00:00Z', { lastWatered: '2026-09-02' })]);
  const merged = mergeDocs(remote, stale);
  assert.equal(merged.plants[0].lastWatered, '2026-09-10');
});

test('watering on one device and renaming on another both survive', () => {
  const phone = doc([plant('a', 'Fern', '2026-09-10T00:00:00Z', { lastWatered: '2026-09-10' }),
                     plant('b', 'Ficus', '2026-09-01T00:00:00Z')]);
  const laptop = doc([plant('a', 'Fern', '2026-09-01T00:00:00Z'),
                      plant('b', 'Ficus renamed', '2026-09-11T00:00:00Z')]);
  const merged = mergeDocs(phone, laptop);
  const byId = Object.fromEntries(merged.plants.map((p) => [p.id, p]));
  assert.equal(byId.a.lastWatered, '2026-09-10');
  assert.equal(byId.b.name, 'Ficus renamed');
});

test('a delete is not resurrected by a stale device', () => {
  const afterDelete = doc([], { deleted: { a: '2026-09-10T00:00:00Z' } });
  const stale = doc([plant('a', 'Aloe', '2026-09-01T00:00:00Z')]);
  assert.equal(mergeDocs(afterDelete, stale).plants.length, 0);
  assert.equal(mergeDocs(stale, afterDelete).plants.length, 0);
});

test('an edit made after a delete brings the plant back', () => {
  const afterDelete = doc([], { deleted: { a: '2026-09-10T00:00:00Z' } });
  const edited = doc([plant('a', 'Aloe, revived', '2026-09-12T00:00:00Z')]);
  const merged = mergeDocs(afterDelete, edited);
  assert.equal(merged.plants.length, 1);
  assert.equal(merged.plants[0].name, 'Aloe, revived');
  assert.ok(!merged.deleted.a, 'the tombstone is cleared once the plant is back');
});

test('settings follow the newer document', () => {
  const older = { ...doc([]), updatedAt: '2026-09-01T00:00:00Z', settings: { timezone: 'America/New_York', notifyHour: 8 } };
  const newer = { ...doc([]), updatedAt: '2026-09-09T00:00:00Z', settings: { timezone: 'Europe/Paris', notifyHour: 6 } };
  assert.equal(mergeDocs(older, newer).settings.timezone, 'Europe/Paris');
  assert.equal(mergeDocs(older, newer).settings.notifyHour, 6);
});

test('merging is order independent for disjoint edits', () => {
  const a = doc([plant('a', 'A', '2026-09-03T00:00:00Z')]);
  const b = doc([plant('b', 'B', '2026-09-04T00:00:00Z')]);
  const ids = (d) => d.plants.map((p) => p.id).sort().join(',');
  assert.equal(ids(mergeDocs(a, b)), ids(mergeDocs(b, a)));
});

test('merging is idempotent', () => {
  const a = doc([plant('a', 'A', '2026-09-03T00:00:00Z')], { deleted: { z: '2026-09-01T00:00:00Z' } });
  const once = mergeDocs(a, a);
  const twice = mergeDocs(once, once);
  assert.deepEqual(twice, once);
});

test('garbage input cannot crash the merge', () => {
  assert.equal(mergeDocs(null, undefined).plants.length, 0);
  assert.equal(mergeDocs({ plants: 'nope' }, { plants: [null, 3] }).plants.length, 0);
  assert.equal(mergeDocs(doc([plant('a', 'A', 'not-a-date')]), doc([])).plants.length, 1);
});

test('settings are clamped to sane values', () => {
  const d = normalizeDoc({ settings: { notifyHour: 99, remindAheadDays: -4 } });
  assert.equal(d.settings.notifyHour, 23);
  assert.equal(d.settings.remindAheadDays, 0);
});

console.log(`\n${passed} merge checks passed${process.exitCode ? ' (with failures)' : ''}`);
