/**
 * UI: views, rendering and event wiring.
 */

import {
  store, connection, publish, testConnection, newId, DATA_PATH,
} from './store.js';
import { fileToDataUrl, dataUrlBytes } from './images.js';
import {
  todayISO, addDays, daysBetween, parseISO, statusFor, duePlants,
  occurrencesInRange, amountText, intervalOn,
} from './schedule.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const VIEWS = ['today', 'garden', 'calendar', 'add', 'settings'];
const PLACEHOLDER = '🪴';

const ui = {
  view: 'today',
  calMonth: null,      // {y, m} — m is 1-12
  calSelected: null,   // 'YYYY-MM-DD'
  formPhotos: { healthy: [], unhealthy: [] },
  editingId: null,
};

/* ── helpers ─────────────────────────────────────────── */

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function today() { return todayISO(); }

function prettyDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const d = parseISO(iso);
  return d ? d.toLocaleDateString(undefined, opts) : iso;
}

function relativeDay(iso, from = today()) {
  const diff = daysBetween(from, iso);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff < 0) return `${-diff} days ago`;
  return `in ${diff} days`;
}

function photoSrc(plant, kind = 'healthy') {
  const list = (plant.photos && plant.photos[kind]) || [];
  return list.length ? list[0] : '';
}

function flash(message, kind = 'info', ms = 4000) {
  const bar = $('#status-bar');
  bar.textContent = message;
  bar.className = `status-bar${kind === 'info' ? '' : ' ' + kind}`;
  bar.hidden = false;
  clearTimeout(flash.timer);
  if (ms) flash.timer = setTimeout(() => { bar.hidden = true; }, ms);
}

function statusBadge(st) {
  const label = {
    overdue: st.daysOverdue === 1 ? 'Overdue 1 day' : `Overdue ${st.daysOverdue} days`,
    today: 'Water today',
    soon: st.daysUntil === 1 ? 'Tomorrow' : `In ${st.daysUntil} days`,
    ok: `In ${st.daysUntil} days`,
  }[st.status];
  return `<span class="badge ${st.status}">${esc(label)}</span>`;
}

/* ── view switching ──────────────────────────────────── */

function setView(name, { push = true } = {}) {
  if (!VIEWS.includes(name)) name = 'today';
  ui.view = name;
  VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== name; });
  $$('.tab').forEach((t) => {
    if (t.dataset.view === name) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  if (push && window.location.hash.slice(1) !== name) {
    window.history.pushState({ view: name }, '', `#${name}`);
  }
  render();
  document.getElementById('main').scrollIntoView({ block: 'start', behavior: 'auto' });
}

/* ── Today ───────────────────────────────────────────── */

function renderToday() {
  const t = today();
  $('#today-date').textContent = prettyDate(t, { weekday: 'long', month: 'long', day: 'numeric' });

  const plants = store.plants();
  const due = duePlants(plants, t);
  const overdue = due.filter((r) => r.status === 'overdue');
  const rows = plants.map((p) => ({ plant: p, ...statusFor(p, t) }));
  const upcoming = rows
    .filter((r) => r.daysUntil > 0 && r.daysUntil <= 7)
    .sort((a, b) => a.daysUntil - b.daysUntil || a.plant.name.localeCompare(b.plant.name));

  $('#today-stats').innerHTML = [
    `<div class="stat ok"><div class="num">${plants.length}</div><div class="lbl">plants tracked</div></div>`,
    `<div class="stat due"><div class="num">${due.length}</div><div class="lbl">need water today</div></div>`,
    `<div class="stat alert"><div class="num">${overdue.length}</div><div class="lbl">overdue</div></div>`,
    `<div class="stat"><div class="num">${upcoming.length}</div><div class="lbl">coming up this week</div></div>`,
  ].join('');

  $('#today-due').innerHTML = due.length
    ? due.map((r) => careItem(r, true)).join('')
    : (plants.length
      ? `<div class="empty">🎉 Nothing needs water today. Next up: ${esc(nextUpText(rows))}</div>`
      : `<div class="empty">No plants yet. <button class="btn small" data-go="add">Add your first plant</button></div>`);

  $('#today-upcoming').innerHTML = upcoming.length
    ? upcoming.map((r) => careItem(r, false)).join('')
    : '<div class="empty">Nothing else due in the next 7 days.</div>';
}

function nextUpText(rows) {
  const future = rows.filter((r) => r.daysUntil > 0).sort((a, b) => a.daysUntil - b.daysUntil);
  if (!future.length) return 'nothing scheduled.';
  const r = future[0];
  return `${r.plant.name}, ${relativeDay(r.dueDate)}.`;
}

function careItem(row, actionable) {
  const p = row.plant;
  const src = photoSrc(p);
  const thumb = src
    ? `<img class="care-thumb" src="${esc(src)}" alt="" loading="lazy">`
    : `<div class="care-thumb" aria-hidden="true" style="display:grid;place-items:center;font-size:1.6rem">${PLACEHOLDER}</div>`;
  const instructions = [amountText(p), p.water.method, p.sun ? `Light: ${p.sun}` : '']
    .filter(Boolean).map(esc).join(' · ');
  return `
    <article class="care-item ${row.status}">
      ${thumb}
      <div class="care-main">
        <h4>${esc(p.name)} ${statusBadge(row)}</h4>
        <div class="care-meta">${esc([p.species, p.location].filter(Boolean).join(' · '))}${p.location || p.species ? ' · ' : ''}due ${esc(prettyDate(row.dueDate))}</div>
        <div class="care-instructions">💧 ${instructions}</div>
      </div>
      <div class="care-actions">
        ${actionable ? `<button class="btn primary small" data-water="${esc(p.id)}">Mark watered</button>` : ''}
        <button class="btn small ghost" data-detail="${esc(p.id)}">Details</button>
      </div>
    </article>`;
}

/* ── Garden ──────────────────────────────────────────── */

function renderGarden() {
  const t = today();
  const q = $('#garden-search').value.trim().toLowerCase();
  const sort = $('#garden-sort').value;
  const includeArchived = $('#garden-archived').checked;

  let plants = store.plants({ includeArchived });
  if (q) {
    plants = plants.filter((p) => [p.name, p.species, p.location, p.notes, p.sun]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }

  plants = plants.slice().sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'added') return String(b.createdAt).localeCompare(String(a.createdAt));
    const sa = statusFor(a, t).dueDate;
    const sb = statusFor(b, t).dueDate;
    return sa.localeCompare(sb) || a.name.localeCompare(b.name);
  });

  $('#garden-grid').innerHTML = plants.length ? plants.map((p) => {
    const st = statusFor(p, t);
    const src = photoSrc(p);
    const photo = src
      ? `<img class="photo" src="${esc(src)}" alt="${esc(p.name)}, healthy" loading="lazy">`
      : `<div class="photo" aria-hidden="true">${PLACEHOLDER}</div>`;
    return `
      <button class="plant-card card" data-detail="${esc(p.id)}">
        ${photo}
        <div class="body">
          <h3>${esc(p.name)}</h3>
          ${p.species ? `<div class="species">${esc(p.species)}</div>` : ''}
          <div>${p.archived ? '<span class="badge archived">Archived</span>' : statusBadge(st)}</div>
          <div class="facts">
            <span>💧 every ${intervalOn(p, t)} days — ${esc(amountText(p))}</span>
            ${p.sun ? `<span>☀️ ${esc(p.sun)}</span>` : ''}
            ${p.location ? `<span>📍 ${esc(p.location)}</span>` : ''}
          </div>
        </div>
      </button>`;
  }).join('') : `<div class="empty">${q ? 'No plants match that search.' : 'No plants yet.'} <button class="btn small" data-go="add">Add a plant</button></div>`;
}

/* ── Calendar ────────────────────────────────────────── */

function currentMonth() {
  if (!ui.calMonth) {
    const d = parseISO(today());
    ui.calMonth = { y: d.getFullYear(), m: d.getMonth() + 1 };
  }
  return ui.calMonth;
}

function shiftMonth(delta) {
  const { y, m } = currentMonth();
  const d = new Date(y, m - 1 + delta, 1);
  ui.calMonth = { y: d.getFullYear(), m: d.getMonth() + 1 };
}

/** Map of 'YYYY-MM-DD' -> [{plant, overdue}] across a date range. */
function scheduleMap(startISO, endISO) {
  const t = today();
  const map = new Map();
  store.plants().forEach((plant) => {
    occurrencesInRange(plant, startISO, endISO, t).forEach((iso) => {
      if (!map.has(iso)) map.set(iso, []);
      map.get(iso).push({ plant, overdue: daysBetween(t, iso) < 0 });
    });
  });
  map.forEach((list) => list.sort((a, b) => a.plant.name.localeCompare(b.plant.name)));
  return map;
}

function renderCalendar() {
  const { y, m } = currentMonth();
  const t = today();
  const first = new Date(y, m - 1, 1);
  const label = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#cal-label').textContent = label;

  const startPad = first.getDay();
  const gridStart = new Date(y, m - 1, 1 - startPad);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    cells.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  }
  const startISO = isoOf(cells[0]);
  const endISO = isoOf(cells[cells.length - 1]);
  const map = scheduleMap(startISO, endISO);

  $('#cal-grid').innerHTML = cells.map((date) => {
    const iso = isoOf(date);
    const inMonth = date.getMonth() === m - 1;
    const list = map.get(iso) || [];
    const shown = list.slice(0, 3);
    const extra = list.length - shown.length;
    const classes = ['cal-cell'];
    if (!inMonth) classes.push('other-month');
    if (iso === t) classes.push('today');
    if (iso === ui.calSelected) classes.push('selected');
    return `
      <button class="${classes.join(' ')}" data-day="${iso}" role="gridcell"
              aria-label="${esc(prettyDate(iso, { weekday: 'long', month: 'long', day: 'numeric' }))}: ${list.length} plant${list.length === 1 ? '' : 's'} to water">
        <span class="daynum">${date.getDate()}</span>
        <span class="chips">
          ${shown.map((e) => `<span class="cal-chip${e.overdue ? ' overdue' : ''}">${esc(e.plant.name)}</span>`).join('')}
          ${extra > 0 ? `<span class="cal-chip more">+${extra} more</span>` : ''}
        </span>
      </button>`;
  }).join('');

  renderCalDetail(map);
  renderAgenda();
}

function isoOf(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function renderCalDetail(map) {
  const box = $('#cal-detail');
  if (!ui.calSelected) { box.innerHTML = ''; return; }
  const list = map.get(ui.calSelected) || [];
  const t = today();
  const isToday = ui.calSelected === t;
  box.innerHTML = `
    <div class="card panel">
      <h3>${esc(prettyDate(ui.calSelected, { weekday: 'long', month: 'long', day: 'numeric' }))} <span class="muted">(${esc(relativeDay(ui.calSelected))})</span></h3>
      ${list.length ? `<div class="care-list">${list.map((e) => {
        const row = { plant: e.plant, ...statusFor(e.plant, t) };
        return careItem(row, isToday || daysBetween(t, ui.calSelected) < 0);
      }).join('')}</div>` : '<p class="muted">Nothing scheduled for this day.</p>'}
    </div>`;
}

function renderAgenda() {
  const t = today();
  const end = addDays(t, 30);
  const map = scheduleMap(t, end);
  const days = Array.from(map.keys()).sort();
  $('#cal-agenda').innerHTML = days.length ? days.map((iso) => `
    <div class="agenda-day">
      <span class="date">${esc(prettyDate(iso))}</span>
      <span class="muted">${esc(relativeDay(iso))}</span>
      <span class="names">${map.get(iso).map((e) => esc(e.plant.name)).join(', ')}</span>
    </div>`).join('') : '<div class="empty">Nothing scheduled in the next 30 days.</div>';
}

/* ── Plant detail dialog ─────────────────────────────── */

function openDetail(id) {
  const p = store.get(id);
  if (!p) return;
  const t = today();
  const st = statusFor(p, t);

  const photoBlock = (kind, title, note) => {
    const list = (p.photos && p.photos[kind]) || [];
    if (!list.length) return '';
    return `<div>
      <h4>${esc(title)}</h4>
      ${list.map((src, i) => `<img src="${esc(src)}" alt="${esc(p.name)} — ${esc(title)} ${i + 1}" data-zoom="${esc(src)}" loading="lazy">`).join('')}
      ${note ? `<p class="hint">${esc(note)}</p>` : ''}
    </div>`;
  };

  const fact = (k, v) => (v ? `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>` : '');

  $('#plant-dialog-body').innerHTML = `
    <h2>${esc(p.name)} ${p.archived ? '<span class="badge archived">Archived</span>' : statusBadge(st)}</h2>
    ${p.species ? `<p class="muted"><em>${esc(p.species)}</em>${p.location ? ' · ' + esc(p.location) : ''}</p>` : (p.location ? `<p class="muted">${esc(p.location)}</p>` : '')}

    <div class="detail-photos">
      ${photoBlock('healthy', 'Healthy', p.healthySigns)}
      ${photoBlock('unhealthy', 'Warning signs', p.warningSigns)}
    </div>

    <div class="detail-facts">
      ${fact('Water', `Every ${p.water.intervalDays} days — ${amountText(p)}`)}
      ${fact('Winter', p.water.winterIntervalDays ? `Every ${p.water.winterIntervalDays} days (Nov–Feb)` : '')}
      ${fact('How', p.water.method)}
      ${fact('Next due', `${prettyDate(st.dueDate)} (${relativeDay(st.dueDate)})`)}
      ${fact('Last watered', p.lastWatered ? `${prettyDate(p.lastWatered)} (${relativeDay(p.lastWatered)})` : 'never recorded')}
      ${fact('Sun', p.sun)}
      ${fact('Soil', p.soil)}
      ${fact('Fertilizer', p.fertilizer)}
      ${fact('Humidity', p.humidity)}
      ${fact('Temperature', p.temperature)}
      ${fact('Safety', p.toxicity)}
      ${!((p.photos.healthy || []).length) ? fact('Looks healthy when', p.healthySigns) : ''}
      ${!((p.photos.unhealthy || []).length) ? fact('Warning signs', p.warningSigns) : ''}
      ${fact('Notes', p.notes)}
    </div>

    ${(p.history || []).length ? `<p class="history-list">Watering log: ${p.history.slice(0, 8).map((d) => esc(prettyDate(d, { month: 'short', day: 'numeric' }))).join(' · ')}</p>` : ''}

    <div class="btn-row">
      <button class="btn primary" data-water="${esc(p.id)}">Mark watered today</button>
      <button class="btn" data-undo="${esc(p.id)}">Undo last watering</button>
      <button class="btn" data-edit="${esc(p.id)}">Edit</button>
      <button class="btn ghost" data-delete="${esc(p.id)}">Delete</button>
    </div>`;
  $('#plant-dialog').showModal();
}

/* ── Add / edit form ─────────────────────────────────── */

function fillForm(plant) {
  ui.editingId = plant ? plant.id : null;
  ui.formPhotos = {
    healthy: plant ? [...(plant.photos.healthy || [])] : [],
    unhealthy: plant ? [...(plant.photos.unhealthy || [])] : [],
  };
  const set = (id, value) => { $(id).value = value == null ? '' : value; };
  set('#f-id', plant ? plant.id : '');
  set('#f-name', plant ? plant.name : '');
  set('#f-species', plant ? plant.species : '');
  set('#f-location', plant ? plant.location : '');
  set('#f-lastWatered', plant ? plant.lastWatered : '');
  set('#f-intervalDays', plant ? plant.water.intervalDays : 7);
  set('#f-winterIntervalDays', plant ? plant.water.winterIntervalDays : '');
  set('#f-amountMl', plant ? plant.water.amountMl : '');
  set('#f-amountText', plant ? plant.water.amountText : '');
  set('#f-method', plant ? plant.water.method : '');
  set('#f-sun', plant ? plant.sun : '');
  set('#f-soil', plant ? plant.soil : '');
  set('#f-fertilizer', plant ? plant.fertilizer : '');
  set('#f-humidity', plant ? plant.humidity : '');
  set('#f-temperature', plant ? plant.temperature : '');
  set('#f-toxicity', plant ? plant.toxicity : '');
  set('#f-healthySigns', plant ? plant.healthySigns : '');
  set('#f-warningSigns', plant ? plant.warningSigns : '');
  set('#f-notes', plant ? plant.notes : '');
  $('#f-archived').checked = plant ? Boolean(plant.archived) : false;
  $('#f-photo-healthy').value = '';
  $('#f-photo-unhealthy').value = '';
  $('#add-heading').textContent = plant ? `Edit ${plant.name}` : 'Add a Plant';
  $('#f-submit').textContent = plant ? 'Save changes' : 'Save plant';
  $('#f-status').textContent = '';
  clearFormErrors();
  renderThumbs();
}

function renderThumbs() {
  ['healthy', 'unhealthy'].forEach((kind) => {
    $(`#preview-${kind}`).innerHTML = ui.formPhotos[kind].map((src, i) => `
      <span class="thumb">
        <img src="${esc(src)}" alt="${kind} photo ${i + 1}">
        <button type="button" data-remove-photo="${kind}:${i}" aria-label="Remove ${kind} photo ${i + 1}">×</button>
      </span>`).join('');
  });
}

function clearFormErrors() {
  $$('.error[data-error-for]').forEach((el) => { el.hidden = true; });
  ['#f-name', '#f-intervalDays'].forEach((id) => $(id).removeAttribute('aria-invalid'));
}

function showFieldError(id) {
  const el = $(`[data-error-for="${id}"]`);
  if (el) el.hidden = false;
  $(`#${id}`).setAttribute('aria-invalid', 'true');
}

function readForm() {
  clearFormErrors();
  const name = $('#f-name').value.trim();
  const interval = Number($('#f-intervalDays').value);
  let ok = true;
  if (!name) { showFieldError('f-name'); ok = false; }
  if (!Number.isFinite(interval) || interval < 1 || interval > 365 || Math.floor(interval) !== interval) {
    showFieldError('f-intervalDays'); ok = false;
  }
  if (!ok) {
    $((!name) ? '#f-name' : '#f-intervalDays').focus();
    return null;
  }

  const num = (sel) => {
    const v = Number($(sel).value);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const text = (sel) => $(sel).value.trim();
  const existing = ui.editingId ? store.get(ui.editingId) : null;

  return {
    id: ui.editingId || newId(),
    name,
    species: text('#f-species'),
    location: text('#f-location'),
    water: {
      intervalDays: interval,
      winterIntervalDays: num('#f-winterIntervalDays'),
      amountMl: num('#f-amountMl'),
      amountText: text('#f-amountText'),
      method: text('#f-method'),
    },
    sun: text('#f-sun'),
    soil: text('#f-soil'),
    fertilizer: text('#f-fertilizer'),
    humidity: text('#f-humidity'),
    temperature: text('#f-temperature'),
    toxicity: text('#f-toxicity'),
    healthySigns: text('#f-healthySigns'),
    warningSigns: text('#f-warningSigns'),
    notes: text('#f-notes'),
    photos: { healthy: [...ui.formPhotos.healthy], unhealthy: [...ui.formPhotos.unhealthy] },
    lastWatered: $('#f-lastWatered').value,
    history: existing ? existing.history : ($('#f-lastWatered').value ? [$('#f-lastWatered').value] : []),
    archived: $('#f-archived').checked,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };
}

async function handlePhotoPick(kind, input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;
  $('#f-status').textContent = `Processing ${files.length} photo${files.length === 1 ? '' : 's'}…`;
  for (const file of files) {
    try {
      const dataUrl = await fileToDataUrl(file);
      ui.formPhotos[kind].push(dataUrl);
    } catch (err) {
      flash(err.message, 'error');
    }
  }
  input.value = '';
  $('#f-status').textContent = '';
  renderThumbs();
  const total = ['healthy', 'unhealthy']
    .flatMap((k) => ui.formPhotos[k])
    .filter((s) => s.startsWith('data:'))
    .reduce((n, s) => n + dataUrlBytes(s), 0);
  if (total > 3 * 1024 * 1024) {
    flash('These photos add up to more than 3 MB. Publish to GitHub so they are stored as image files rather than inside plants.json.', 'warn', 8000);
  }
}

/* ── Settings ────────────────────────────────────────── */

function renderSettings() {
  const cfg = connection.load();
  $('#s-owner').value = cfg.owner;
  $('#s-repo').value = cfg.repo;
  $('#s-branch').value = cfg.branch;
  $('#s-token').value = cfg.token ? '•'.repeat(12) : '';
  $('#s-timezone').value = store.doc.settings.timezone || '';
  $('#s-siteurl').value = store.doc.settings.siteUrl || '';
  renderSyncState();
}

function renderSyncState() {
  const box = $('#sync-state');
  if (!box) return;
  const count = store.plants().length;
  if (store.dirty) {
    box.className = 'sync-state dirty';
    box.innerHTML = `<span class="dot"></span>You have unpublished changes (${count} plant${count === 1 ? '' : 's'} in this browser). Publish so the daily text uses them.`;
  } else if (store.loadError) {
    box.className = 'sync-state bad';
    box.innerHTML = `<span class="dot"></span>${esc(store.loadError)}`;
  } else {
    box.className = 'sync-state clean';
    box.innerHTML = `<span class="dot"></span>In sync with <code>${DATA_PATH}</code> — ${count} plant${count === 1 ? '' : 's'}.`;
  }

  const tokenBox = $('#token-state');
  if (tokenBox) {
    const ready = connection.isReady();
    tokenBox.className = `sync-state ${ready ? 'clean' : ''}`;
    tokenBox.innerHTML = `<span class="dot"></span>${ready ? 'Token saved in this browser — publishing is available.' : 'No token saved yet. You can still use Download / Import below.'}`;
  }
}

async function doPublish() {
  const btn = $('#btn-publish');
  const cfg = connection.load();
  if (!connection.isReady()) {
    flash('Add your repository details and a token first (below).', 'warn', 6000);
    $('#s-owner').focus();
    return;
  }
  btn.disabled = true;
  const original = btn.textContent;
  try {
    const result = await publish(cfg, store.doc, (msg) => { btn.textContent = msg; });
    store.doc = result.doc;
    store.dirty = false;
    store.persist(false);
    flash(`Published to GitHub — ${result.photosUploaded} photo${result.photosUploaded === 1 ? '' : 's'} uploaded. The daily text will use this from now on.`, 'info', 6000);
  } catch (err) {
    flash(err.message, 'error', 12000);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
    renderSyncState();
  }
}

function downloadJson() {
  const blob = new Blob([store.toJSON()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'plants.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash('Downloaded plants.json — commit it to data/plants.json in your repository.', 'info', 7000);
}

/* ── render dispatch ─────────────────────────────────── */

function render() {
  if (ui.view === 'today') renderToday();
  else if (ui.view === 'garden') renderGarden();
  else if (ui.view === 'calendar') renderCalendar();
  else if (ui.view === 'settings') renderSettings();
  renderSyncState();
  const dirtyTabs = $('.tab[data-view="settings"]');
  if (dirtyTabs) dirtyTabs.textContent = store.dirty ? 'Settings •' : 'Settings';
}

/* ── events ──────────────────────────────────────────── */

function wire() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => setView(tab.dataset.view)));

  window.addEventListener('popstate', () => {
    setView(window.location.hash.slice(1) || 'today', { push: false });
  });

  // Delegated clicks: plant actions live inside re-rendered HTML.
  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-water],[data-detail],[data-edit],[data-delete],[data-undo],[data-go],[data-day],[data-zoom],[data-remove-photo]');
    if (!el) return;

    if (el.dataset.water) {
      const plant = store.markWatered(el.dataset.water, today());
      if (plant) flash(`${plant.name} watered today. Next: ${prettyDate(statusFor(plant, today()).dueDate)}.`);
      $('#plant-dialog').close();
      render();
    } else if (el.dataset.undo) {
      const plant = store.undoWatered(el.dataset.undo);
      flash(plant ? `Undid the last watering for ${plant.name}.` : 'Nothing to undo.');
      $('#plant-dialog').close();
      render();
    } else if (el.dataset.detail) {
      openDetail(el.dataset.detail);
    } else if (el.dataset.edit) {
      const plant = store.get(el.dataset.edit);
      $('#plant-dialog').close();
      if (plant) { fillForm(plant); setView('add'); }
    } else if (el.dataset.delete) {
      const plant = store.get(el.dataset.delete);
      if (plant && window.confirm(`Delete ${plant.name}? This cannot be undone.`)) {
        store.remove(plant.id);
        $('#plant-dialog').close();
        flash(`${plant.name} deleted.`);
        render();
      }
    } else if (el.dataset.go) {
      if (el.dataset.go === 'add') fillForm(null);
      setView(el.dataset.go);
    } else if (el.dataset.day) {
      ui.calSelected = ui.calSelected === el.dataset.day ? null : el.dataset.day;
      renderCalendar();
    } else if (el.dataset.zoom) {
      $('#photo-dialog-img').src = el.dataset.zoom;
      $('#photo-dialog').showModal();
    } else if (el.dataset.removePhoto) {
      const [kind, index] = el.dataset.removePhoto.split(':');
      ui.formPhotos[kind].splice(Number(index), 1);
      renderThumbs();
    }
  });

  // Garden controls
  $('#garden-search').addEventListener('input', renderGarden);
  $('#garden-sort').addEventListener('change', renderGarden);
  $('#garden-archived').addEventListener('change', renderGarden);

  // Calendar controls
  $('#cal-prev').addEventListener('click', () => { shiftMonth(-1); renderCalendar(); });
  $('#cal-next').addEventListener('click', () => { shiftMonth(1); renderCalendar(); });
  $('#cal-today').addEventListener('click', () => {
    ui.calMonth = null;
    ui.calSelected = today();
    renderCalendar();
  });

  // Form
  $('#f-photo-healthy').addEventListener('change', (e) => handlePhotoPick('healthy', e.target));
  $('#f-photo-unhealthy').addEventListener('change', (e) => handlePhotoPick('unhealthy', e.target));
  $('#f-reset').addEventListener('click', () => { fillForm(null); flash('Form cleared.'); });
  $('#plant-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = readForm();
    if (!data) { flash('Please fix the highlighted fields.', 'warn'); return; }
    const wasEditing = Boolean(ui.editingId);
    try {
      const saved = store.upsert(data);
      fillForm(null);
      flash(`${saved.name} ${wasEditing ? 'updated' : 'added'}. Remember to Publish so the daily text knows about it.`, 'info', 6000);
      setView('garden');
    } catch (err) {
      flash(err.message, 'error', 10000);
    }
  });

  // Settings
  $('#btn-publish').addEventListener('click', doPublish);
  $('#btn-download').addEventListener('click', downloadJson);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const count = Array.isArray(parsed.plants) ? parsed.plants.length : 0;
      if (!count && !window.confirm('That file has no plants in it. Import anyway?')) return;
      if (!window.confirm(`Replace the plants in this browser with ${count} plant(s) from ${file.name}?`)) return;
      store.replaceDoc(parsed);
      flash(`Imported ${count} plant${count === 1 ? '' : 's'}. Publish to save them to GitHub.`, 'info', 7000);
      render();
    } catch (err) {
      flash(`Could not read that file: ${err.message}`, 'error', 8000);
    } finally {
      event.target.value = '';
    }
  });
  $('#btn-discard').addEventListener('click', async () => {
    if (!window.confirm('Throw away the changes in this browser and reload the published data?')) return;
    await store.discardLocal();
    flash('Reloaded the published data.');
    render();
  });
  $('#btn-save-token').addEventListener('click', () => {
    const current = connection.load();
    const typed = $('#s-token').value;
    const cfg = {
      owner: $('#s-owner').value.trim(),
      repo: $('#s-repo').value.trim(),
      branch: $('#s-branch').value.trim() || 'main',
      // Leaving the masked placeholder alone keeps the stored token.
      token: /^•+$/.test(typed) ? current.token : typed.trim(),
    };
    connection.save(cfg);
    $('#s-token').value = cfg.token ? '•'.repeat(12) : '';
    flash('Connection saved in this browser.');
    renderSyncState();
  });
  $('#btn-test-token').addEventListener('click', async () => {
    const cfg = connection.load();
    if (!connection.isReady()) { flash('Fill in owner, repo, branch and token, then save.', 'warn'); return; }
    try {
      const repo = await testConnection(cfg);
      flash(`Connected to ${repo.full_name} with write access.`);
    } catch (err) {
      flash(err.message, 'error', 10000);
    }
  });
  $('#btn-clear-token').addEventListener('click', () => {
    connection.clearToken();
    $('#s-token').value = '';
    flash('Token removed from this browser.');
    renderSyncState();
  });
  $('#btn-save-settings').addEventListener('click', () => {
    store.setSettings({
      timezone: $('#s-timezone').value.trim() || 'America/New_York',
      siteUrl: $('#s-siteurl').value.trim(),
    });
    flash('Garden settings saved. Publish to apply them to the daily text.');
    render();
  });

  window.addEventListener('beforeunload', (event) => {
    if (store.dirty && connection.isReady()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

/* ── boot ────────────────────────────────────────────── */

async function boot() {
  wire();
  fillForm(null);
  await store.init();
  if (store.loadError) flash(store.loadError, 'warn', 8000);
  const initial = window.location.hash.slice(1);
  setView(VIEWS.includes(initial) ? initial : 'today', { push: false });
}

boot();
