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
  },
  plants: [],
  // id -> ISO timestamp. Without these, a delete made on one device would be
  // resurrected by the next merge from another device.
  deleted: {},
};

const TOMBSTONE_TTL_DAYS = 120;

/* ── tiny localStorage helpers (private browsing can throw) ── */
function lsGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { window.localStorage.setItem(key, value); return true; } catch { return false; }
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
  const deleted = {};
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
    },
    plants: Array.isArray(doc.plants) ? doc.plants.map(normalizePlant).filter(Boolean) : [],
    deleted,
  };
}

/** Drop tombstones old enough that every device has certainly seen them. */
function pruneTombstones(deleted) {
  const cutoff = Date.now() - TOMBSTONE_TTL_DAYS * 86400000;
  const out = {};
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
  [...a.plants, ...b.plants].forEach((plant) => {
    const existing = byId.get(plant.id);
    if (!existing || stamp(plant.updatedAt) > stamp(existing.updatedAt)) {
      byId.set(plant.id, plant);
    }
  });

  const plants = [...byId.values()].filter((plant) => {
    const killedAt = deleted[plant.id];
    // Edited after it was deleted somewhere else? The edit brings it back.
    return !killedAt || stamp(plant.updatedAt) > stamp(killedAt);
  });
  plants.forEach((plant) => { delete deleted[plant.id]; });

  const newest = stamp(a.updatedAt) >= stamp(b.updatedAt) ? a : b;
  return {
    version: 1,
    updatedAt: newest.updatedAt,
    settings: newest.settings,
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
    lastWatered: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.lastWatered)) ? str(raw.lastWatered) : '',
    history: Array.isArray(raw.history) ? raw.history.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s))) : [],
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
      const res = await fetch(`${DATA_PATH}?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) remote = normalizeDoc(await res.json());
      else this.loadError = `Could not read ${DATA_PATH} (HTTP ${res.status}).`;
    } catch (err) {
      this.loadError = `Could not read ${DATA_PATH}: ${err.message}`;
    }
    this.remoteLoaded = Boolean(remote);

    const localRaw = lsGet(LS_DOC);
    const wasDirty = lsGet(LS_DIRTY) === '1';
    let local = null;
    if (localRaw) {
      try { local = normalizeDoc(JSON.parse(localRaw)); } catch { local = null; }
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

    if (!lsSet(LS_DOC, JSON.stringify(next))) {
      // this.doc is untouched, so the UI keeps showing the last good state.
      throw new Error(
        'Your browser could not store this change — it is out of space, most '
        + 'likely because of photos. Publish to GitHub (which moves photos out '
        + 'of the data file), or remove a photo and try again.',
      );
    }
    this.doc = next;
    if (markDirty) this.dirty = true;
    lsSet(LS_DIRTY, this.dirty ? '1' : '0');
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
    this.commit((doc) => { doc.settings = { ...doc.settings, ...patch }; });
  },

  replaceDoc(raw) {
    const incoming = normalizeDoc(raw);
    this.commit((doc) => {
      doc.settings = incoming.settings;
      doc.plants = incoming.plants;
      doc.deleted = incoming.deleted;
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
  if (remoteFile && remoteFile.content) {
    try {
      merged = mergeDocs(JSON.parse(fromBase64(remoteFile.content)), merged);
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

  const removed = await sweepOrphanPhotos(cfg, merged, imageDir, onProgress);
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
async function sweepOrphanPhotos(cfg, doc, imageDir, onProgress) {
  const used = new Set();
  doc.plants.forEach((plant) => {
    ['healthy', 'unhealthy'].forEach((kind) => {
      (plant.photos[kind] || []).forEach((src) => {
        if (!src.startsWith('data:')) used.add(src.split('/').pop());
      });
    });
  });

  try {
    const listing = await ghFetch(
      `/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(imageDir)}?ref=${encodeURIComponent(cfg.branch)}`,
      cfg,
    );
    if (!Array.isArray(listing)) return 0;
    const orphans = listing.filter(
      (item) => item.type === 'file' && item.name !== '.gitkeep' && !used.has(item.name),
    );
    let removed = 0;
    for (const orphan of orphans) {
      onProgress(`Tidying unused photo ${removed + 1} of ${orphans.length}…`);
      await deleteFile(`${imageDir}/${orphan.name}`, orphan.sha, `Remove unused photo ${orphan.name}`, cfg);
      removed += 1;
    }
    return removed;
  } catch {
    return 0; // not worth failing a publish over
  }
}

export { DATA_PATH, IMAGE_DIR, repoPath };
