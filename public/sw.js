/**
 * 即庫系統 — Network-First Offline-Capable Service Worker (PWA v3.2.8)
 * - Network-First with cache: 'no-store' for UI shell so code/UI updates take effect immediately
 * - Offline cache fallback when LAN / mobile network is disconnected
 * - Network-Only pass-through for /api/events SSE & /api/* mutations (handled by app Outbox Queue)
 */
const CACHE_NAME = 'jiku-system-shell-v357';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css?v=357',
  '/js/vision-engine.js?v=357',
  '/js/app.js?v=357',
  '/manifest.json?v=357',
  '/icon.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((assetUrl) =>
          fetch(assetUrl, { cache: 'no-store' })
            .then((res) => (res && res.status === 200 ? cache.put(assetUrl, res) : null))
            .catch(() => null)
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((res) => {
        if (res && res.status === 200 && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
