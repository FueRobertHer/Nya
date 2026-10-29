// public/service-worker.js
//
// Next.js hashes its built JS/CSS filenames per deploy, so we don't try to
// precache specific asset paths (they'd go stale on every deploy). Instead:
// - API calls always go straight to the network (live financial data)
// - The page shell is network-first with a cache fallback, so the app still
//   opens (showing the last-seen state) if the phone is offline
// - Next's hashed files are answered from the copy kept here once there is
//   one, since a file at such an address never changes

const CACHE_NAME = 'nya-v3';
const PRECACHE = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))),
      // Page loads are sent by the browser itself (see the fetch handler).
      self.registration.navigationPreload?.enable(),
    ])
  );
  self.clients.claim();
});

const immutable = (response) => /\bimmutable\b/.test(response.headers.get('Cache-Control') ?? '');

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Other sites (the sign-in provider's API among them) are left to the
  // browser: a cached copy of someone's session must never be served back.
  // So is Clerk's same-origin path, which it uses on some production domains.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/__clerk/')) return;

  // API calls and non-GET requests always go straight to the network,
  // uncached -- cache.put() throws on non-GET anyway.
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }

  // Next's built files (/_next/static/) are named by their contents, and the
  // server says so (Cache-Control: immutable), so the copy kept here is the
  // file: answer with it, with no trip to the network and no copy written
  // back on every page load. In development they aren't immutable, and are
  // fetched as below, as is everything when the cache can't be read.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches
        .match(event.request)
        .catch(() => undefined)
        .then((kept) => (kept && immutable(kept) ? kept : networkFirst(event)))
    );
    return;
  }

  event.respondWith(networkFirst(event));
});

function networkFirst(event) {
  // A page load uses the browser's own request (navigation preload), not a
  // copy made here: the sign-in check only renews an expired or half-missing
  // session for a request that reads as a page load (Sec-Fetch-Dest:
  // document), and treats anything else as signed out, sending a reload to
  // the sign-in page. Without preload, or for anything else, fetch it here.
  return (
    Promise.resolve(event.preloadResponse)
      .then((preloaded) => preloaded ?? fetch(event.request))
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          const write = caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .catch(() => {});
          // Kept until written, rather than left to a worker the browser
          // may stop as soon as the page has its answer. A browser that
          // won't wait still has the answer.
          try {
            event.waitUntil(write);
          } catch {}
        }
        return response;
      })
      // Offline, the page kept for this address, or for a page whose
      // address differs only in its query: the dashboard keeps its tab in
      // ?tab= (lib/dashboard-tab.ts), and a tab never opened online is
      // still the same page, which reads its tab from the address.
      .catch(() =>
        caches
          .match(event.request)
          .then((hit) => hit ?? (event.request.mode === 'navigate' ? caches.match(event.request, { ignoreSearch: true }) : undefined))
      )
  );
}
