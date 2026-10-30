// public/service-worker.js
//
// Next.js hashes its built JS/CSS filenames per deploy, so we don't try to
// precache specific asset paths (they'd go stale on every deploy). Instead:
// - API calls always go straight to the network (live financial data)
// - The page shell is network-first with a cache fallback, so the app still
//   opens (showing the last-seen state) if the phone is offline
// - Next's hashed files are answered from the copy kept here once there is
//   one, since a file at such an address never changes
// - Once a day, what no kept page can load any more (an old deploy's files
//   and pages) is let go of (tidy, below)

const CACHE_NAME = 'nya-v3';
// What the daily tidy remembers between runs (tidy, below).
const TIDY_CACHE = 'nya-v3-tidy';
const PRECACHE = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== TIDY_CACHE).map((k) => caches.delete(k)))),
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
    asked.add(url.pathname);
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
            event.waitUntil(event.request.mode === 'navigate' ? write.then(() => tidy(event)) : write);
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

// The tidy. Every deploy brings new files and pages, and without it the
// cache would keep every one ever fetched. Kept pages say what they need:
// Next names each file a page can load, as text, in the page or in a file it
// loads (script tags, the client components in its flight rows, a chunk's
// dynamic imports, a stylesheet's fonts). So, once a day, after a page loaded
// online:
// - Pages of another deploy than that page's are dropped where a page of its
//   deploy shares their path (an old ?tab= beside a fresh /): offline, an
//   address falls back to the fresh page by path, which reads its tab from
//   the address.
// - Built files no kept page can reach are dropped.
// Neither goes at once: only once found so at three tidies on different days
// over at least a week, so a page whose files were still arriving, or a load
// cut short, is put right by the next full load. And nothing goes while the
// page that started it is missing its own scripts or stylesheets, or while
// another window is open (it may be running an older deploy), or if this
// worker has answered it since it started. A file reachable only through a
// file no longer kept can't be loaded offline anyway.

const DAY = 24 * 60 * 60 * 1000;
// Under /api/, which is never answered from a cache, so no page load or
// offline fallback can find it.
const NOTES = '/api/service-worker/tidy';
/** Built files (/_next/static/) asked for since this worker started. */
const asked = new Set();
let tidying = null;

function tidy(event) {
  tidying ??= tidyOnce(event.request, event.resultingClientId)
    .catch(() => {})
    .finally(() => (tidying = null));
  return tidying;
}

async function tidyOnce(request, clientId) {
  const notes = await caches.open(TIDY_CACHE);
  const saved = await notes
    .match(NOTES)
    .then((r) => r?.json())
    .catch(() => null);
  // Anything unreadable starts afresh, rather than stopping every tidy.
  const object = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const state = { tidied: Number(saved?.tidied) || 0, refs: object(saved?.refs), unused: object(saved?.unused) };
  const now = Date.now();
  if (now >= state.tidied && now - state.tidied < DAY) return;
  // After the page's own files, not competing with them.
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const cache = await caches.open(CACHE_NAME);
  const page = await cache.match(request);
  if (!page) return;
  const pageText = await page.text();
  for (const own of ownFiles(pageText, request.url)) if (!(await cache.match(own, { ignoreVary: true }))) return;
  // A browser that doesn't say which window the page opened in: then only
  // when there is one.
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clientId ? windows.some((w) => w.id !== clientId) : windows.length > 1) return;

  const build = buildOf(pageText);
  const day = Math.floor(now / DAY);
  const unused = {};
  // Found unused again; true once it has been for long enough to go.
  const due = (key) => {
    const was = state.unused[key];
    const note = Number.isFinite(was?.since) && Number.isFinite(was?.days) ? { ...was, days: was.days + (was.last === day ? 0 : 1), last: day } : { since: now, days: 1, last: day };
    unused[key] = note;
    return note.days >= 3 && now - note.since >= 7 * DAY;
  };

  const pages = [];
  const built = new Map();
  for (const key of await cache.keys()) {
    const path = new URL(key.url).pathname;
    if (path.startsWith('/_next/static/')) {
      // One file can be kept under more than one address (a ?dpl= per deploy).
      built.set(path, [...(built.get(path) ?? []), key]);
      continue;
    }
    const kept = await cache.match(key);
    const type = kept?.headers.get('Content-Type') ?? '';
    if (!/text\/html|text\/x-component/.test(type)) continue;
    const text = await kept.text();
    pages.push({ key, path, text, group: `${type.includes('html') ? 'html' : 'rsc'} ${path}`, build: buildOf(text) });
  }
  const current = new Set(pages.filter((p) => build && p.build === build).map((p) => p.group));
  const roots = [];
  for (const p of pages) {
    if (build && p.build && p.build !== build && current.has(p.group) && due(p.key.url)) {
      await cache.delete(p.key);
      delete unused[p.key.url];
    } else roots.push(p);
  }

  const reached = new Set();
  const queue = [];
  const reach = (path) => {
    if (reached.has(path)) return;
    reached.add(path);
    queue.push(path);
  };
  for (const p of roots) refsIn(p.text, p.path).forEach(reach);
  // An immutable file never changes, so what it names is read once.
  const refs = {};
  while (queue.length) {
    const path = queue.pop();
    const key = built.get(path)?.[0];
    if (!key || !/\.(js|css)$/.test(path)) continue;
    let named = Array.isArray(state.refs[path]) ? state.refs[path] : null;
    if (!named) {
      const kept = await cache.match(key);
      if (!kept) continue;
      named = refsIn(await kept.text(), path);
      if (!immutable(kept)) {
        named.forEach(reach);
        continue;
      }
    }
    refs[path] = named;
    named.forEach(reach);
  }
  for (const [path, keys] of built) {
    if (reached.has(path)) continue;
    for (const key of keys) {
      if (!due(key.url)) continue;
      // Checked with nothing awaited before the delete starts.
      if (asked.has(path)) continue;
      await cache.delete(key);
      delete unused[key.url];
    }
  }

  await notes.put(NOTES, new Response(JSON.stringify({ tidied: now, refs, unused }), { headers: { 'Content-Type': 'application/json' } }));
}

/** The deploy a page or RSC payload belongs to: Next's build id, or the
 *  deployment id it carries instead when there is one. */
function buildOf(text) {
  // The build id is the last key of the payload's root row (row 0):
  // ..."b":"<id>"} and the row's end. Read by scanning, not one regular
  // expression over the row, which can be too long for one.
  const id = (row) => row.match(/\\?"b\\?":\\?"([\w-]+)\\?"\}$/)?.[1];
  // A payload's rows end at a newline.
  for (let at = text.startsWith('0:{') ? 0 : text.indexOf('\n0:{'); at !== -1; at = text.indexOf('\n0:{', at + 1)) {
    const start = text[at] === '\n' ? at + 1 : at;
    const end = text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start);
    const found = id(text.slice(Math.max(start, end - 200), end));
    if (found) return found;
  }
  // A page's are in its scripts' strings, where a row ends at the escape \n
  // and other escapes (a line break in some text, \\n) are part of it, and
  // a row can go on in the next script's string.
  const PUSH = 'self.__next_f.push([1,"';
  // Where the last row read ended: what looks like a row's start before
  // there was inside that row (text holding "\n0:{"), so each part of the
  // page is read once.
  let read = 0;
  for (let at = text.indexOf('0:{'); at !== -1; at = text.indexOf('0:{', at + 1)) {
    if (at < read || (!text.endsWith('[1,"', at) && !text.endsWith('\\n', at))) continue;
    let tail = '';
    let i = at;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\' && text[i + 1] === 'n') break;
      if (c === '\\') {
        tail += text.slice(i, i + 2);
        i += 2;
      } else if (c === '"') {
        const next = text.indexOf(PUSH, i);
        if (next === -1) break;
        i = next + PUSH.length;
      } else {
        tail += c;
        i++;
      }
      if (tail.length > 400) tail = tail.slice(-200);
    }
    const found = id(tail);
    if (found) return found;
    read = i;
  }
  // A segment prefetch names it "buildId".
  return text.match(/\\?"buildId\\?":\\?"([\w-]+)/)?.[1] ?? text.match(/data-dpl-id="([^"]+)"/)?.[1] ?? null;
}

/** The scripts and stylesheets a page loads itself (not a noModule
 *  polyfill, which current browsers never fetch). */
function ownFiles(html, base) {
  const files = [];
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    if (/\bnomodule\b/i.test(tag)) continue;
    const src = /^<script/i.test(tag) ? tag.match(/\ssrc="([^"]+)"/i) : /\srel="stylesheet"/i.test(tag) ? tag.match(/\shref="([^"]+)"/i) : null;
    if (!src) continue;
    const url = new URL(src[1].replaceAll('&amp;', '&'), base);
    if (url.origin === self.location.origin) files.push(url.href);
  }
  return files;
}

/** The built files `text` names: as a path (`static/chunks/x.js`, with or
 *  without /_next/ before it), or in a stylesheet's url(), which may be
 *  relative to `base`. Matching loosely only keeps more. */
function refsIn(text, base) {
  const found = new Set();
  for (const m of text.match(/static\/[^\s"'`()\\<>{}|^,;?#&]+/g) ?? []) found.add(`/_next/${m}`);
  for (const [, ref] of text.matchAll(/url\(\s*['"]?([^'")\s]+)/g)) {
    try {
      const url = new URL(ref, `${self.location.origin}${base}`);
      if (url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')) found.add(url.pathname);
    } catch {}
  }
  return [...found];
}
