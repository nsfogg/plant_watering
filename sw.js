/**
 * Service worker: makes the site usable at the kitchen sink with no signal,
 * and installable on a phone home screen.
 *
 * Navigations -> network first. A deploy must never leave someone running last
 *                week's code; the cached page is only for when there is no signal.
 * Assets      -> cache first, refreshed in the background, and the cache name
 *                carries a build stamp so a deploy retires the old one.
 * plants.json -> network first, cached under a stable key so the offline copy
 *                can actually be found again.
 */

// BUILD is rewritten at deploy time (see .github/workflows/pages.yml), so every
// deploy gets its own cache and the previous one is deleted on activate.
const BUILD = 'dev';
const VERSION = `v4-${BUILD}`;
const SHELL_CACHE = `plantcare-shell-${VERSION}`;
const DATA_CACHE = `plantcare-data-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './assets/css/style.css',
  './assets/js/app.js',
  './assets/js/store.js',
  './assets/js/schedule.js',
  './assets/js/images.js',
  './assets/icon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // One bad URL must not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch api.github.com

  // The page itself: always try the network, so a deploy takes effect at once.
  if (request.mode === 'navigate') {
    event.respondWith(navigationFirst(request));
    return;
  }

  if (url.pathname.endsWith('/data/plants.json')) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }
  if (url.pathname.includes('/data/images/')) {
    event.respondWith(cacheFirst(request, DATA_CACHE));
    return;
  }
  event_waitUntil = (promise) => event.waitUntil(promise);
  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

async function navigationFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(new Request('./index.html'), fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match('./index.html') || await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  // A stable key: the page adds no cache-busting query, but even if something
  // did, one entry must not become one entry per page load.
  const key = new Request(new URL(request.url).pathname);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) await cache.put(key, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

/** Set by the fetch handler so the revalidation can outlive the response. */
let event_waitUntil = () => {};

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) return cache.put(request, res.clone()).then(() => res);
      return res;
    })
    .catch(() => null);
  if (cached) {
    // Keep the worker alive until the background refresh has actually landed.
    if (self.registration && network) event_waitUntil(network);
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  // Offline, never cached: fall back to the app shell for navigations.
  if (request.mode === 'navigate') {
    const shell = await cache.match('./index.html');
    if (shell) return shell;
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}
