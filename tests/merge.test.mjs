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

test('an edit clearly after a delete brings the plant back', () => {
  const afterDelete = doc([], { deleted: { a: '2026-09-10T00:00:00Z' } });
  const edited = doc([plant('a', 'Aloe, revived', '2026-09-12T00:00:00Z')]);
  const merged = mergeDocs(afterDelete, edited);
  assert.equal(merged.plants.length, 1);
  assert.equal(merged.plants[0].name, 'Aloe, revived');
  assert.ok(merged.deleted.a, 'the tombstone is kept so devices that have not seen the edit still know about the delete');
});

test('a delete survives a clock 10 minutes out of step', () => {
  // Device B's clock runs 10 minutes behind, so its delete is stamped BEFORE
  // an edit that actually happened earlier. The delete must still win.
  const deletedAt = '2026-09-10T09:55:00Z';        // B's clock
  const editedAt = '2026-09-10T10:00:00Z';         // A's clock, really earlier
  const deletedDoc = doc([], { deleted: { a: deletedAt } });
  const editedDoc = doc([plant('a', 'Fern (renamed)', editedAt)]);
  assert.equal(mergeDocs(deletedDoc, editedDoc).plants.length, 0);
  assert.equal(mergeDocs(editedDoc, deletedDoc).plants.length, 0);
});

test('watering history from both devices is kept', () => {
  const phone = doc([plant('a', 'Fern', '2026-09-17T12:00:00Z', {
    lastWatered: '2026-09-17', history: ['2026-09-17', '2026-09-01'],
  })]);
  const laptop = doc([plant('a', 'Fern', '2026-09-18T12:00:00Z', {
    lastWatered: '2026-09-18', history: ['2026-09-18', '2026-09-01'],
  })]);
  const merged = mergeDocs(phone, laptop);
  assert.deepEqual(merged.plants[0].history, ['2026-09-18', '2026-09-17', '2026-09-01']);
  assert.equal(merged.plants[0].lastWatered, '2026-09-18');
});

test('a setting changed here is not reverted by someone else publishing', () => {
  // The other device published later, but it never touched the settings.
  const local = {
    ...doc([]), updatedAt: '2026-09-19T09:00:00Z',
    settings: { timezone: 'Europe/Berlin', notifyHour: 6, updatedAt: '2026-09-19T09:00:00Z' },
  };
  const remotePublishedLater = {
    ...doc([plant('a', 'Fern', '2026-09-19T09:30:00Z')]), updatedAt: '2026-09-19T09:30:00Z',
    settings: { timezone: 'America/New_York', notifyHour: 8, updatedAt: '2026-09-01T00:00:00Z' },
  };
  const merged = mergeDocs(remotePublishedLater, local);
  assert.equal(merged.settings.timezone, 'Europe/Berlin');
  assert.equal(merged.settings.notifyHour, 6);
  assert.equal(merged.plants.length, 1, 'and the other device\'s plant still arrives');
});

test('a plant id of __proto__ can still be deleted', () => {
  const withPlant = doc([plant('__proto__', 'Odd', '2026-09-01T00:00:00Z')]);
  // Built via JSON so "__proto__" is a real key, exactly as it would arrive
  // from a hand-edited plants.json — an object literal would set the prototype.
  const afterDelete = doc([], { deleted: JSON.parse('{"__proto__":"2026-09-05T00:00:00Z"}') });
  const merged = mergeDocs(withPlant, afterDelete);
  assert.equal(merged.plants.length, 0);
  assert.equal({}.polluted, undefined);
});

test('an exact timestamp tie keeps the local edit', () => {
  const when = '2026-09-19T10:00:00Z';
  const remote = doc([plant('a', 'Remote copy', when)]);
  const local = doc([plant('a', 'Local edit', when)]);
  // publish() merges (remote, local), so the later argument must win a tie.
  assert.equal(mergeDocs(remote, local).plants[0].name, 'Local edit');
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
