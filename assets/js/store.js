/**
 * Data layer.
 *
 * data/plants.json in the repo is the long-term store. The browser keeps a
 * working copy in localStorage so the site is fast and works offline; pressing
 * "Publish" commits the working copy back to GitHub through the REST API, so
 * there is no server anywhere in the loop.
 */

const LS_DOC = 'plantcare.doc.v1';
const LS_DIRTY = 'plantcare.dirty.v1';
const LS_CONN = 'plantcare.connection.v1';
const DATA_PATH = 'data/plants.json';
const IMAGE_DIR = 'data/images';

export const EMPTY_DOC = {
  version: 1,
  updatedAt: null,
  settings: {
    timezone: 'America/New_York',
    siteUrl: '',
    notifyHour: 8,
    remindAheadDays: 0,
    // Settings merge on their own timestamp. The document-level updatedAt only
    // says who published last, so using it would let any publish from another
    // device silently revert a setting you just changed here.
    updatedAt: null,
  },
  plants: [],
  // id -> ISO timestamp. Without these, a delete made on one device would be
  // resurrected by the next merge from another device.
  deleted: {},
};

const TOMBSTONE_TTL_DAYS = 120;
// How far two devices' clocks may plausibly disagree.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/* ── tiny localStorage helpers (private browsing can throw) ── */
function lsGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
/** Returns 'ok', 'quota' (full) or 'blocked' (private mode, cookies off). */
function lsSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return 'ok';
  } catch (err) {
    // Browsers disagree on how a full store reports itself: Chrome and Firefox
    // use different names and legacy codes, and some only say so in the message.
    const name = (err && err.name) || '';
    const message = (err && err.message) || '';
    const quota = /quota|exceeded/i.test(name) || /quota|exceeded/i.test(message)
      || err.code === 22 || err.code === 1014;
    return quota ? 'quota' : 'blocked';
  }
}

/** Can this browser store anything at all? Private modes sometimes cannot. */
export function storageAvailable() {
  const probe = 'plantcare.probe';
  const result = lsSet(probe, '1');
  lsRemove(probe);
  return result !== 'blocked';
}
function lsRemove(key) {
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
}

export function normalizeDoc(raw) {
  const doc = raw && typeof raw === 'object' ? raw : {};
  const settings = doc.settings && typeof doc.settings === 'object' ? doc.settings : {};
  const clampInt = (value, min, max, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const deleted = Object.create(null);
  if (doc.deleted && typeof doc.deleted === 'object') {
    Object.entries(doc.deleted).forEach(([id, when]) => {
      if (typeof id === 'string' && typeof when === 'string') deleted[id] = when;
    });
  }
  return {
    version: 1,
    updatedAt: doc.updatedAt || null,
    settings: {
      timezone: settings.timezone || 'America/New_York',
      siteUrl: settings.siteUrl || '',
      notifyHour: clampInt(settings.notifyHour, 0, 23, 8),
      remindAheadDays: clampInt(settings.remindAheadDays, 0, 14, 0),
      updatedAt: settings.updatedAt || null,
    },
    plants: Array.isArray(doc.plants) ? doc.plants.map(normalizePlant).filter(Boolean) : [],
    deleted,
  };
}

/** True for a canonical YYYY-MM-DD that is also a date that exists. */
function isRealDate(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** Drop tombstones old enough that every device has certainly seen them. */
function pruneTombstones(deleted) {
  const cutoff = Date.now() - TOMBSTONE_TTL_DAYS * 86400000;
  // Object.create(null): a plant whose id is "__proto__" must be deletable too.
  const out = Object.create(null);
  Object.entries(deleted || {}).forEach(([id, when]) => {
    const t = Date.parse(when);
    if (!Number.isFinite(t) || t >= cutoff) out[id] = when;
  });
  return out;
}

const stamp = (value) => {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
};

/**
 * Combine two versions of the data without losing anyone's work.
 *
 * Plants are merged one by one on their own `updatedAt`, so watering the fern
 * on a phone and renaming the ficus on a laptop both survive, whichever device
 * publishes second. A delete only wins over an edit that is older than it.
 */
export function mergeDocs(base, incoming) {
  const a = normalizeDoc(base);
  const b = normalizeDoc(incoming);

  const deleted = pruneTombstones({ ...a.deleted, ...b.deleted });
  Object.keys(deleted).forEach((id) => {
    const at = a.deleted[id];
    const bt = b.deleted[id];
    deleted[id] = stamp(at) > stamp(bt) ? at : (bt || at);
  });

  const byId = new Map();
  const seen = new Map();
  [...a.plants, ...b.plants].forEach((plant) => {
    const previous = byId.get(plant.id);
    // Ties go to the later argument: publish() merges (remote, local), so an
    // edit made here is not thrown away by a same-millisecond collision.
    if (!previous || stamp(plant.updatedAt) >= stamp(previous.updatedAt)) {
      byId.set(plant.id, plant);
    }
    seen.set(plant.id, [...(seen.get(plant.id) || []), plant]);
  });

  const plants = [...byId.values()]
    .filter((plant) => {
      const killedAt = deleted[plant.id];
      if (!killedAt) return true;
      // Two devices' clocks rarely agree to the second. Only an edit clearly
      // later than the delete revives a plant; a marginal ordering stays
      // deleted, because resurrecting something on a drifting clock is worse
      // than losing the last few minutes of an edit.
      return stamp(plant.updatedAt) > stamp(killedAt) + CLOCK_SKEW_MS;
    })
    .map((plant) => {
      // Watering dates only ever accumulate, so union them rather than letting
      // the winning copy's list replace the other's.
      const copies = seen.get(plant.id) || [plant];
      if (copies.length < 2) return plant;
      const history = [...new Set(copies.flatMap((c) => c.history || []))]
        .sort((x, y) => y.localeCompare(x))
        .slice(0, 40);
      return { ...plant, history, lastWatered: history[0] || plant.lastWatered };
    });

  // A tombstone is kept even when the plant came back, so the delete is not
  // forgotten by the device that has not seen the reviving edit yet.
  const settings = stamp(b.settings.updatedAt) >= stamp(a.settings.updatedAt) ? b.settings : a.settings;
  const newest = stamp(a.updatedAt) >= stamp(b.updatedAt) ? a : b;
  return {
    version: 1,
    updatedAt: newest.updatedAt,
    settings,
    plants,
    deleted,
  };
}

export function normalizePlant(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const water = raw.water && typeof raw.water === 'object' ? raw.water : {};
  const photos = raw.photos && typeof raw.photos === 'object' ? raw.photos : {};
  const str = (v) => (v == null ? '' : String(v));
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // Intervals are whole days: a fractional value would round differently in
  // the browser and in the Python notifier.
  const days = (v) => {
    const n = num(v);
    return n === null ? null : Math.min(365, Math.max(1, Math.round(n)));
  };
  return {
    id: str(raw.id) || newId(),
    name: str(raw.name) || 'Unnamed plant',
    species: str(raw.species),
    location: str(raw.location),
    water: {
      intervalDays: days(water.intervalDays) || 7,
      winterIntervalDays: days(water.winterIntervalDays),
      amountMl: num(water.amountMl),
      amountText: str(water.amountText),
      method: str(water.method),
    },
    sun: str(raw.sun),
    soil: str(raw.soil),
    fertilizer: str(raw.fertilizer),
    humidity: str(raw.humidity),
    temperature: str(raw.temperature),
    toxicity: str(raw.toxicity),
    healthySigns: str(raw.healthySigns),
    warningSigns: str(raw.warningSigns),
    notes: str(raw.notes),
    photos: {
      healthy: Array.isArray(photos.healthy) ? photos.healthy.filter((s) => typeof s === 'string') : [],
      unhealthy: Array.isArray(photos.unhealthy) ? photos.unhealthy.filter((s) => typeof s === 'string') : [],
    },
    // A real date, not just the right shape: "2026-02-30" would otherwise make
    // the plant permanently "due today" and put it in every daily text.
    lastWatered: isRealDate(raw.lastWatered) ? str(raw.lastWatered) : '',
    history: Array.isArray(raw.history)
      ? [...new Set(raw.history.filter(isRealDate).map(String))].sort((a, b) => b.localeCompare(a)).slice(0, 40)
      : [],
    archived: Boolean(raw.archived),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

export function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/* ── the store ── */
export const store = {
  doc: structuredClone(EMPTY_DOC),
  dirty: false,
  remoteLoaded: false,
  loadError: null,
  listeners: new Set(),

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { this.listeners.forEach((fn) => fn(this)); },

  /** Load the repo copy, then prefer local edits that have not been published. */
  async init() {
    let remote = null;
    try {
      const res = await fetch(DATA_PATH, { cache: 'no-store' });
      if (res.ok) {
        const raw = await res.json();
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.plants)) {
          remote = normalizeDoc(raw);
        } else {
          // A 404 page or a hand-mangled file must not read as "no plants".
          this.loadError = `${DATA_PATH} does not look like plant data, so it was ignored.`;
        }
      } else {
        this.loadError = `Could not read ${DATA_PATH} (HTTP ${res.status}).`;
      }
    } catch (err) {
      this.loadError = `Could not read ${DATA_PATH}: ${err.message}`;
    }
    this.remoteLoaded = Boolean(remote);

    const localRaw = lsGet(LS_DOC);
    const wasDirty = lsGet(LS_DIRTY) === '1';
    let local = null;
    if (localRaw) {
      try {
        local = normalizeDoc(JSON.parse(localRaw));
      } catch {
        local = null;
        if (wasDirty) {
          // Unpublished work was in there. Keep the bytes so they can be
          // recovered by hand, and say so instead of quietly moving on.
          lsSet(`plantcare.doc.corrupt.${Date.now()}`, localRaw);
          this.loadError = 'The unpublished copy stored in this browser was damaged and could not be read. '
            + 'A backup of it was kept under plantcare.doc.corrupt.* in this browser\'s storage.';
        }
      }
    }

    if (local && wasDirty && remote) {
      // Unpublished edits here AND a published version: keep both, plant by plant.
      this.doc = mergeDocs(remote, local);
      this.dirty = true;
      this.cache();
    } else if (local && wasDirty) {
      this.doc = local;
      this.dirty = true;
    } else if (remote && local) {
      // Nothing local to protect — but GitHub Pages can serve a stale copy for
      // a minute or two after publishing, so never step backwards in time.
      this.doc = stamp(remote.updatedAt) >= stamp(local.updatedAt) ? remote : local;
      this.dirty = false;
      this.cache();
    } else if (remote) {
      this.doc = remote;
      this.dirty = false;
      this.cache();
    } else if (local) {
      this.doc = local;
      this.dirty = wasDirty;
    }
    this.emit();
    return this;
  },

  /**
   * Save to localStorage, then adopt the change.
   *
   * The order matters: photos can fill the ~5 MB quota, and a change that
   * cannot be stored must not be left sitting in memory pretending to be
   * saved -- it would vanish on the next reload. So every mutation runs
   * against a copy, and only a successful write makes that copy current.
   */
  commit(mutator, { markDirty = true } = {}) {
    const next = structuredClone(this.doc);
    const result = mutator(next);
    if (markDirty) next.updatedAt = new Date().toISOString();

    // The dirty flag goes first: if only the one-byte write failed, the
    // document would look published when it is not.
    if (lsSet(LS_DIRTY, markDirty || this.dirty ? '1' : '0') === 'blocked') {
      throw new Error(
        'This browser is blocking site storage (private browsing, or cookies '
        + 'turned off), so changes cannot be saved here. Use a normal window, '
        + 'or publish to GitHub from a browser that allows storage.',
      );
    }
    const wrote = lsSet(LS_DOC, JSON.stringify(next));
    if (wrote !== 'ok') {
      // this.doc is untouched, so the UI keeps showing the last good state.
      lsSet(LS_DIRTY, this.dirty ? '1' : '0');
      throw new Error(wrote === 'quota'
        ? 'Your browser could not store this change — it is out of space, most '
          + 'likely because of photos. Publish to GitHub (which moves photos out '
          + 'of the data file), or remove a photo and try again.'
        : 'This browser is blocking site storage, so changes cannot be saved here.');
    }
    this.doc = next;
    if (markDirty) this.dirty = true;
    this.emit();
    return result;
  },

  /** Re-save the current document (used after a publish clears the dirty flag). */
  persist(markDirty = true) {
    return this.commit(() => {}, { markDirty });
  },

  /**
   * Best-effort cache write. Used where a failure is not worth interrupting
   * the user: startup, and after a successful publish (GitHub already has it).
   */
  cache() {
    lsSet(LS_DOC, JSON.stringify(this.doc));
    lsSet(LS_DIRTY, this.dirty ? '1' : '0');
    this.emit();
  },

  plants({ includeArchived = false } = {}) {
    return this.doc.plants.filter((p) => includeArchived || !p.archived);
  },

  get(id) { return this.doc.plants.find((p) => p.id === id) || null; },

  upsert(plant) {
    const clean = normalizePlant(plant);
    clean.updatedAt = new Date().toISOString();
    return this.commit((doc) => {
      const i = doc.plants.findIndex((p) => p.id === clean.id);
      if (i >= 0) doc.plants[i] = { ...doc.plants[i], ...clean };
      else doc.plants.push(clean);
      return clean;
    });
  },

  remove(id) {
    if (!this.get(id)) return;
    this.commit((doc) => {
      doc.plants = doc.plants.filter((p) => p.id !== id);
      // Remember the deletion, or a merge from another device would undo it.
      doc.deleted = { ...(doc.deleted || {}), [id]: new Date().toISOString() };
    });
  },

  /** Record a watering. Keeps the 40 most recent dates. */
  markWatered(id, dateISO) {
    if (!this.get(id)) return null;
    return this.commit((doc) => {
      const plant = doc.plants.find((p) => p.id === id);
      plant.lastWatered = dateISO;
      plant.history = [dateISO, ...(plant.history || []).filter((d) => d !== dateISO)]
        .sort((a, b) => b.localeCompare(a))
        .slice(0, 40);
      plant.updatedAt = new Date().toISOString();
      return plant;
    });
  },

  /** Undo a watering by restoring the previous date in the history. */
  undoWatered(id) {
    const current = this.get(id);
    if (!current || !current.history || current.history.length === 0) return null;
    return this.commit((doc) => {
      const plant = doc.plants.find((p) => p.id === id);
      const [, ...rest] = plant.history;
      plant.history = rest;
      plant.lastWatered = rest[0] || '';
      plant.updatedAt = new Date().toISOString();
      return plant;
    });
  },

  setSettings(patch) {
    this.commit((doc) => {
      doc.settings = { ...doc.settings, ...patch, updatedAt: new Date().toISOString() };
    });
  },

  /**
   * Replace everything with an imported file. Every plant is re-stamped: an
   * import is a deliberate "use this version", and without the new timestamps
   * the next publish would merge the restored plants straight back out again.
   */
  replaceDoc(raw) {
    const incoming = normalizeDoc(raw);
    const now = new Date().toISOString();
    this.commit((doc) => {
      doc.settings = { ...incoming.settings, updatedAt: now };
      doc.plants = incoming.plants.map((plant) => ({ ...plant, updatedAt: now }));
      // Tombstones from the backup would delete plants it is meant to restore.
      doc.deleted = Object.create(null);
    });
  },

  async discardLocal() {
    lsRemove(LS_DOC);
    lsSet(LS_DIRTY, '0');
    this.dirty = false;
    await this.init();
  },

  toJSON() { return JSON.stringify(this.doc, null, 2) + '\n'; },

  /** All photo values currently in use, for the orphan sweep on publish. */
  usedPhotoPaths() {
    const used = new Set();
    this.doc.plants.forEach((p) => {
      ['healthy', 'unhealthy'].forEach((kind) => {
        (p.photos[kind] || []).forEach((src) => { if (!src.startsWith('data:')) used.add(src); });
      });
    });
    return used;
  },
};

/* ── GitHub connection ── */
export const connection = {
  load() {
    let cfg = {};
    try {
      const raw = lsGet(LS_CONN);
      cfg = raw ? JSON.parse(raw) : {};
    } catch { cfg = {}; }
    const guess = guessLocation();
    return {
      owner: cfg.owner != null && cfg.owner !== '' ? cfg.owner : guess.owner,
      repo: cfg.repo != null && cfg.repo !== '' ? cfg.repo : guess.repo,
      branch: cfg.branch || 'main',
      // Folder inside the repo that holds index.html. Empty for this repo;
      // "plants" when the site is copied into nsfogg.github.io/plants/.
      dir: typeof cfg.dir === 'string' ? cfg.dir.replace(/^\/+|\/+$/g, '') : guess.dir,
      token: cfg.token || '',
      tokenExpiry: cfg.tokenExpiry || '',
    };
  },
  save(cfg) {
    const current = this.load();
    lsSet(LS_CONN, JSON.stringify({ ...current, ...cfg }));
  },
  clearToken() { this.save({ token: '', tokenExpiry: '' }); },
  isReady() {
    const c = this.load();
    return Boolean(c.owner && c.repo && c.branch && c.token);
  },
  /** Days until the token expires, or null when unknown / no expiry. */
  daysUntilExpiry() {
    const { tokenExpiry } = this.load();
    if (!tokenExpiry) return null;
    const when = Date.parse(tokenExpiry);
    if (!Number.isFinite(when)) return null;
    return Math.floor((when - Date.now()) / 86400000);
  },
};

/**
 * Work out the repository from the URL.
 *   nsfogg.github.io/plant_watering/  -> owner nsfogg, repo plant_watering
 *   nsfogg.github.io/                 -> owner nsfogg, repo nsfogg.github.io
 * A user site with the app in a subfolder (nsfogg.github.io/plants/) cannot be
 * told apart from a project page by URL alone, so the guess assumes a project
 * page and Settings lets you correct the repo and folder.
 */
function guessLocation() {
  const host = (window.location.hostname || '').toLowerCase();
  const m = /^([^.]+)\.github\.io$/.exec(host);
  const owner = m ? m[1] : '';
  const parts = window.location.pathname.split('/').filter(Boolean)
    .filter((part) => !part.endsWith('.html'));
  if (!owner) return { owner: '', repo: '', dir: '' };
  if (!parts.length) return { owner, repo: `${owner}.github.io`, dir: '' };
  return { owner, repo: parts[0], dir: parts.slice(1).join('/') };
}

/** Repo-relative path, honouring the configured folder. */
function repoPath(cfg, path) {
  const dir = (cfg.dir || '').replace(/^\/+|\/+$/g, '');
  return dir ? `${dir}/${path}` : path;
}

/* ── GitHub REST helpers ── */
async function ghFetch(path, cfg, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  // Fine-grained tokens expire (30 days by default) and publishing would then
  // fail quietly forever. GitHub tells us when, so remember it and warn early.
  const expiry = res.headers.get('github-authentication-token-expiration');
  if (expiry) connection.save({ tokenExpiry: expiry });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.message || '';
      if (Array.isArray(body.errors) && body.errors.length) {
        detail += ` (${body.errors.map((e) => e.message || e.code).join(', ')})`;
      }
    } catch { /* no JSON body */ }
    const err = new Error(friendlyError(res.status, detail, res));
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function friendlyError(status, detail, res) {
  if (status === 401) return 'GitHub rejected the token. It may have expired — create a new one and paste it into Settings.';
  if (status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    return 'GitHub rate limit reached. Wait a few minutes and try again.';
  }
  if (status === 403) return `GitHub refused the write (403). Check the token has "Contents: Read and write" on this repository. ${detail}`;
  if (status === 404) return 'GitHub could not find that repository or branch. Check the owner, repository name and branch in Settings.';
  return `GitHub ${status}: ${detail || res.statusText}`;
}

export async function testConnection(cfg) {
  const repo = await ghFetch(`/repos/${cfg.owner}/${cfg.repo}`, cfg);
  // A read succeeds with a read-only token; confirm we can actually write.
  if (!repo.permissions || !repo.permissions.push) {
    throw new Error('That token can read the repository but cannot write to it. Give it "Contents: Read and write".');
  }
  // Catch a wrong folder now rather than at publish time.
  const path = repoPath(cfg, DATA_PATH);
  const found = await getFile(path, cfg);
  return { repo, dataFound: Boolean(found), path };
}

async function getFile(path, cfg) {
  try {
    const info = await ghFetch(
      `/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(cfg.branch)}`,
      cfg,
    );
    return info && info.sha ? info : null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function putFile(path, base64, message, cfg, sha) {
  return ghFetch(`/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(path)}`, cfg, {
    method: 'PUT',
    body: JSON.stringify({ message, content: base64, branch: cfg.branch, ...(sha ? { sha } : {}) }),
  });
}

async function deleteFile(path, sha, message, cfg) {
  return ghFetch(`/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(path)}`, cfg, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch: cfg.branch }),
  });
}

/** UTF-8 safe base64 (btoa alone mangles °, é, emoji…). */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(base64) {
  const binary = atob(String(base64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function dataUrlParts(dataUrl) {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[m[1].toLowerCase()] || 'jpg';
  return { ext, base64: m[2] };
}

/**
 * Commit the working copy to GitHub.
 *
 * Order matters: read what is on GitHub *now* (not the possibly-stale copy the
 * page loaded), merge it with what is in this browser, then write. That is what
 * stops a laptop that has been asleep from wiping out changes published from a
 * phone. Inline photos become real files under data/images/ first, so plants.json
 * never carries megabytes of base64.
 *
 * onProgress(text) is called between steps so the UI can narrate.
 */
export async function publish(cfg, doc, onProgress = () => {}) {
  if (!cfg.owner || !cfg.repo || !cfg.branch || !cfg.token) {
    throw new Error('Add your repository owner, name, branch and token in Settings first.');
  }

  const dataPath = repoPath(cfg, DATA_PATH);
  const imageDir = repoPath(cfg, IMAGE_DIR);

  onProgress('Checking GitHub for newer changes…');
  const remoteFile = await getFile(dataPath, cfg);
  let merged = normalizeDoc(structuredClone(doc));
  let previousDoc = null;
  if (remoteFile && remoteFile.content) {
    try {
      previousDoc = normalizeDoc(JSON.parse(fromBase64(remoteFile.content)));
      merged = mergeDocs(previousDoc, merged);
    } catch (err) {
      throw new Error(`The copy of plants.json on GitHub could not be read (${err.message}). Fix or delete it, then publish again.`);
    }
  }

  let uploaded = 0;
  const unreadable = [];
  const totalInline = merged.plants.reduce(
    (n, p) => n + ['healthy', 'unhealthy'].reduce((k, kind) => k + p.photos[kind].filter((src) => src.startsWith('data:')).length, 0),
    0,
  );

  for (const plant of merged.plants) {
    for (const kind of ['healthy', 'unhealthy']) {
      const list = plant.photos[kind];
      for (let i = 0; i < list.length; i += 1) {
        const value = list[i];
        if (!value.startsWith('data:')) continue;
        const parts = dataUrlParts(value);
        if (!parts) {
          // Unreadable photo: keep it where it is and tell the caller, rather
          // than quietly deleting something the user chose.
          unreadable.push(plant.name);
          continue;
        }
        uploaded += 1;
        onProgress(`Uploading photo ${uploaded} of ${totalInline}…`);
        const safeId = plant.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'plant';
        const name = `${safeId}-${kind}-${Date.now().toString(36)}-${i}.${parts.ext}`;
        await putFile(`${imageDir}/${name}`, parts.base64, `Add photo for ${plant.name}`, cfg, null);
        // Store the path the *site* uses, which is relative to index.html.
        list[i] = `${IMAGE_DIR}/${name}`;
      }
      plant.photos[kind] = list.filter(Boolean);
    }
  }

  merged.updatedAt = new Date().toISOString();
  const json = JSON.stringify(merged, null, 2) + '\n';
  const count = merged.plants.filter((p) => !p.archived).length;
  const message = `Update plant data (${count} plant${count === 1 ? '' : 's'})`;

  onProgress('Saving plants.json…');
  try {
    await putFile(dataPath, toBase64(json), message, cfg, remoteFile ? remoteFile.sha : null);
  } catch (err) {
    if (err.status === 409 || err.status === 422) {
      // Something landed between the read and the write — merge again and retry.
      onProgress('Someone else just published — merging…');
      const latest = await getFile(dataPath, cfg);
      if (latest && latest.content) {
        merged = mergeDocs(JSON.parse(fromBase64(latest.content)), merged);
        merged.updatedAt = new Date().toISOString();
      }
      await putFile(
        dataPath,
        toBase64(JSON.stringify(merged, null, 2) + '\n'),
        message,
        cfg,
        latest ? latest.sha : null,
      );
    } else {
      throw err;
    }
  }

  const removed = await sweepOrphanPhotos(cfg, merged, previousDoc, imageDir, onProgress);
  return {
    doc: merged,
    photosUploaded: uploaded,
    photosRemoved: removed,
    unreadablePhotos: [...new Set(unreadable)],
  };
}

/**
 * Delete image files no plant points at any more. Best effort: a failure here
 * leaves junk behind but must never make a successful publish look broken.
 */
const GENERATED_PHOTO = /^[A-Za-z0-9_-]{1,40}-(healthy|unhealthy)-[a-z0-9]+-\d+\.(jpg|png|webp|gif)$/;

/**
 * Delete image files nothing points at any more.
 *
 * Two rules keep this from destroying things it should not:
 *   - only files this app generated (the name pattern) are ever considered, so
 *     anything else in data/images/ is left alone;
 *   - only files the PREVIOUS published data referenced are swept, so a photo
 *     another device uploaded seconds ago -- which is on GitHub but not yet in
 *     any plants.json -- is never mistaken for an orphan.
 * Best effort throughout: junk left behind is much cheaper than a lost photo.
 */
async function sweepOrphanPhotos(cfg, doc, previousDoc, imageDir, onProgress) {
  const nameOf = (src) => String(src).split('/').pop();
  const used = new Set();
  doc.plants.forEach((plant) => {
    ['healthy', 'unhealthy'].forEach((kind) => {
      (plant.photos[kind] || []).forEach((src) => {
        if (!src.startsWith('data:')) used.add(nameOf(src));
      });
    });
  });

  const wasUsed = new Set();
  ((previousDoc && previousDoc.plants) || []).forEach((plant) => {
    ['healthy', 'unhealthy'].forEach((kind) => {
      (((plant.photos || {})[kind]) || []).forEach((src) => {
        if (typeof src === 'string' && !src.startsWith('data:')) wasUsed.add(nameOf(src));
      });
    });
  });
  if (!wasUsed.size) return 0;

  try {
    const listing = await ghFetch(
      `/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(imageDir)}?ref=${encodeURIComponent(cfg.branch)}`,
      cfg,
    );
    if (!Array.isArray(listing)) return 0;
    const orphans = listing.filter((item) => item.type === 'file'
      && GENERATED_PHOTO.test(item.name)
      && wasUsed.has(item.name)
      && !used.has(item.name));
    let removed = 0;
    for (const orphan of orphans) {
      onProgress(`Tidying unused photo ${removed + 1} of ${orphans.length}…`);
      try {
        await deleteFile(`${imageDir}/${orphan.name}`, orphan.sha, `Remove unused photo ${orphan.name}`, cfg);
        removed += 1;
      } catch {
        // Someone else may have removed it already; keep going.
      }
    }
    return removed;
  } catch {
    return 0; // not worth failing a publish over
  }
}

export { DATA_PATH, IMAGE_DIR, repoPath };
