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
  settings: { timezone: 'America/New_York', siteUrl: '', remindAheadDays: 0 },
  plants: [],
};

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
  return {
    version: 1,
    updatedAt: doc.updatedAt || null,
    settings: {
      timezone: settings.timezone || 'America/New_York',
      siteUrl: settings.siteUrl || '',
      remindAheadDays: Number(settings.remindAheadDays) || 0,
    },
    plants: Array.isArray(doc.plants) ? doc.plants.map(normalizePlant).filter(Boolean) : [],
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
  return {
    id: str(raw.id) || newId(),
    name: str(raw.name) || 'Unnamed plant',
    species: str(raw.species),
    location: str(raw.location),
    water: {
      intervalDays: num(water.intervalDays) || 7,
      winterIntervalDays: num(water.winterIntervalDays),
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

    if (local && wasDirty) {
      this.doc = local;
      this.dirty = true;
    } else if (remote) {
      this.doc = remote;
      this.dirty = false;
      this.persist(false);
    } else if (local) {
      this.doc = local;
      this.dirty = wasDirty;
    }
    this.emit();
    return this;
  },

  persist(markDirty = true) {
    if (markDirty) {
      this.dirty = true;
      this.doc.updatedAt = new Date().toISOString();
    }
    const ok = lsSet(LS_DOC, JSON.stringify(this.doc));
    lsSet(LS_DIRTY, this.dirty ? '1' : '0');
    this.emit();
    if (!ok) {
      throw new Error('Your browser would not store this much data — the photos are probably too large. Publish to GitHub, or use smaller pictures.');
    }
  },

  plants({ includeArchived = false } = {}) {
    return this.doc.plants.filter((p) => includeArchived || !p.archived);
  },

  get(id) { return this.doc.plants.find((p) => p.id === id) || null; },

  upsert(plant) {
    const clean = normalizePlant(plant);
    clean.updatedAt = new Date().toISOString();
    const i = this.doc.plants.findIndex((p) => p.id === clean.id);
    if (i >= 0) this.doc.plants[i] = { ...this.doc.plants[i], ...clean };
    else this.doc.plants.push(clean);
    this.persist();
    return clean;
  },

  remove(id) {
    const before = this.doc.plants.length;
    this.doc.plants = this.doc.plants.filter((p) => p.id !== id);
    if (this.doc.plants.length !== before) this.persist();
  },

  /** Record a watering. Keeps the 40 most recent dates. */
  markWatered(id, dateISO) {
    const plant = this.get(id);
    if (!plant) return null;
    plant.lastWatered = dateISO;
    plant.history = [dateISO, ...(plant.history || []).filter((d) => d !== dateISO)].slice(0, 40);
    plant.updatedAt = new Date().toISOString();
    this.persist();
    return plant;
  },

  /** Undo a watering by restoring the previous date in the history. */
  undoWatered(id) {
    const plant = this.get(id);
    if (!plant || !plant.history || plant.history.length === 0) return null;
    const [, ...rest] = plant.history;
    plant.history = rest;
    plant.lastWatered = rest[0] || '';
    plant.updatedAt = new Date().toISOString();
    this.persist();
    return plant;
  },

  setSettings(patch) {
    this.doc.settings = { ...this.doc.settings, ...patch };
    this.persist();
  },

  replaceDoc(raw) {
    this.doc = normalizeDoc(raw);
    this.persist();
  },

  async discardLocal() {
    lsRemove(LS_DOC);
    lsSet(LS_DIRTY, '0');
    this.dirty = false;
    await this.init();
  },

  toJSON() { return JSON.stringify(this.doc, null, 2) + '\n'; },
};

/* ── GitHub connection ── */
export const connection = {
  load() {
    try {
      const raw = lsGet(LS_CONN);
      const cfg = raw ? JSON.parse(raw) : {};
      return {
        owner: cfg.owner || guessOwner(),
        repo: cfg.repo || guessRepo(),
        branch: cfg.branch || 'main',
        token: cfg.token || '',
      };
    } catch {
      return { owner: guessOwner(), repo: guessRepo(), branch: 'main', token: '' };
    }
  },
  save(cfg) { lsSet(LS_CONN, JSON.stringify(cfg)); },
  clearToken() {
    const cfg = this.load();
    cfg.token = '';
    this.save(cfg);
  },
  isReady() {
    const c = this.load();
    return Boolean(c.owner && c.repo && c.branch && c.token);
  },
};

/** nsfogg.github.io/plant_watering/ -> owner "nsfogg" */
function guessOwner() {
  const host = window.location.hostname || '';
  const m = /^([^.]+)\.github\.io$/i.exec(host);
  return m ? m[1] : '';
}
/** …/plant_watering/ -> repo "plant_watering" (user sites have no path) */
function guessRepo() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const first = parts[0] || '';
  if (!first || first.endsWith('.html')) return '';
  return first;
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
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.message || '';
      if (Array.isArray(body.errors) && body.errors.length) {
        detail += ` (${body.errors.map((e) => e.message || e.code).join(', ')})`;
      }
    } catch { /* no JSON body */ }
    const err = new Error(`GitHub ${res.status}: ${detail || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

export async function testConnection(cfg) {
  const repo = await ghFetch(`/repos/${cfg.owner}/${cfg.repo}`, cfg);
  // A read succeeds with a read-only token; confirm we can actually write.
  if (!repo.permissions || !repo.permissions.push) {
    throw new Error('That token can read the repository but cannot write to it. Give it "Contents: Read and write".');
  }
  return repo;
}

async function getFileSha(path, cfg) {
  try {
    const info = await ghFetch(
      `/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(cfg.branch)}`,
      cfg,
    );
    return info && info.sha ? info.sha : null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function putFile(path, base64, message, cfg, sha) {
  const body = {
    message,
    content: base64,
    branch: cfg.branch,
    ...(sha ? { sha } : {}),
  };
  return ghFetch(`/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(path)}`, cfg, {
    method: 'PUT',
    body: JSON.stringify(body),
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

function dataUrlParts(dataUrl) {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[m[1].toLowerCase()] || 'jpg';
  return { ext, base64: m[2] };
}

/**
 * Commit the working copy to GitHub: inline photos become real files under
 * data/images/, then data/plants.json is written.
 * onProgress(text) is called between steps so the UI can narrate.
 */
export async function publish(cfg, doc, onProgress = () => {}) {
  if (!cfg.owner || !cfg.repo || !cfg.branch || !cfg.token) {
    throw new Error('Add your repository owner, name, branch and token in Settings first.');
  }

  const working = normalizeDoc(structuredClone(doc));
  let uploaded = 0;
  const totalInline = working.plants.reduce(
    (n, p) => n + ['healthy', 'unhealthy'].reduce((k, kind) => k + p.photos[kind].filter((s) => s.startsWith('data:')).length, 0),
    0,
  );

  for (const plant of working.plants) {
    for (const kind of ['healthy', 'unhealthy']) {
      const list = plant.photos[kind];
      for (let i = 0; i < list.length; i += 1) {
        const value = list[i];
        if (!value.startsWith('data:')) continue;
        const parts = dataUrlParts(value);
        if (!parts) { list[i] = ''; continue; }
        uploaded += 1;
        onProgress(`Uploading photo ${uploaded} of ${totalInline}…`);
        const safeId = plant.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'plant';
        const path = `${IMAGE_DIR}/${safeId}-${kind}-${Date.now().toString(36)}-${i}.${parts.ext}`;
        await putFile(path, parts.base64, `Add photo for ${plant.name}`, cfg, null);
        list[i] = path;
      }
      plant.photos[kind] = list.filter(Boolean);
    }
  }

  working.updatedAt = new Date().toISOString();
  const json = JSON.stringify(working, null, 2) + '\n';

  onProgress('Saving plants.json…');
  let sha = await getFileSha(DATA_PATH, cfg);
  const count = working.plants.filter((p) => !p.archived).length;
  const message = `Update plant data (${count} plant${count === 1 ? '' : 's'})`;
  try {
    await putFile(DATA_PATH, toBase64(json), message, cfg, sha);
  } catch (err) {
    if (err.status === 409 || err.status === 422) {
      // Someone else (or another device) wrote first — take the newest sha and retry once.
      onProgress('Retrying with the latest version…');
      sha = await getFileSha(DATA_PATH, cfg);
      await putFile(DATA_PATH, toBase64(json), message, cfg, sha);
    } else {
      throw err;
    }
  }

  return { doc: working, photosUploaded: uploaded };
}

export { DATA_PATH, IMAGE_DIR };
