// public/service-worker.js
//
// Next.js hashes its built JS/CSS filenames per deploy, so we don't try to
// precache specific asset paths (they'd go stale on every deploy). Instead:
// - API calls always go straight to the network (live financial data)
// - The page shell is network-first with a cache fallback, so the app still
//   opens (showing the last-seen state) if the phone is offline

const CACHE_NAME = 'nya-v2';
const PRECACHE = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls and non-GET requests always go straight to the network,
  // uncached -- cache.put() throws on non-GET anyway.
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
