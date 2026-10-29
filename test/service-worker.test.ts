import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// public/service-worker.js run against a stand-in for the browser: a cache
// keyed by address, a network that answers from a table or is offline, and
// fetch events that record what the page was answered and what the worker
// kept working on afterwards.

const ORIGIN = 'https://nya.test';
const IMMUTABLE = 'public, max-age=31536000, immutable';

type Answer = { status?: number; body?: string; cacheControl?: string };

function worker() {
  const store = new Map<string, Response>();
  const without = (url: string) => url.split('?')[0];
  const broken = { match: false };
  const cache = {
    match: async (req: { url: string } | string, opts?: { ignoreSearch?: boolean }) => {
      if (broken.match) throw new Error('UnknownError: Unexpected internal error');
      const url = typeof req === 'string' ? req : req.url;
      const hit = store.get(url) ?? (opts?.ignoreSearch ? [...store].find(([k]) => without(k) === without(url))?.[1] : undefined);
      return hit?.clone();
    },
    put: async (req: { url: string } | string, res: Response) => {
      puts.push(typeof req === 'string' ? req : req.url);
      // A write takes a while: done only if the worker was kept for it.
      await new Promise((r) => setTimeout(r, 5));
      store.set(typeof req === 'string' ? `${ORIGIN}${req}` : req.url, res);
    },
  };
  const caches = {
    open: async () => cache,
    keys: async () => ['nya-v3'],
    delete: async () => true,
    match: cache.match,
  };
  const puts: string[] = [];
  const asked: string[] = [];
  const net = { online: true, answers: new Map<string, Answer>() };
  const fetch = async (req: { url: string }) => {
    asked.push(req.url);
    if (!net.online) throw new TypeError('Failed to fetch');
    const a = net.answers.get(req.url) ?? {};
    return new Response(a.body ?? 'from the network', {
      status: a.status ?? 200,
      headers: a.cacheControl ? { 'Cache-Control': a.cacheControl } : {},
    });
  };
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn),
    skipWaiting: () => {},
    clients: { claim: () => {} },
    registration: { navigationPreload: { enable: async () => {} } },
  };
  new Function('self', 'caches', 'fetch', readFileSync(join(import.meta.dir, '..', 'public', 'service-worker.js'), 'utf8'))(self, caches, fetch);

  /** A fetch event for `path`: what the page was answered (null if the
   *  worker left it to the browser), once the worker has finished. */
  async function request(path: string, init: { mode?: string; method?: string; preload?: Response; refuseWait?: boolean } = {}) {
    const answered: { with?: Promise<Response | undefined> } = {};
    const after: Promise<unknown>[] = [];
    listeners.fetch({
      request: { url: path.startsWith('http') ? path : `${ORIGIN}${path}`, mode: init.mode ?? 'cors', method: init.method ?? 'GET' },
      preloadResponse: init.preload ? Promise.resolve(init.preload) : undefined,
      respondWith: (p: Promise<Response | undefined>) => (answered.with = p),
      waitUntil: (p: Promise<unknown>) => {
        if (init.refuseWait) throw new DOMException('The event handler is already finished.', 'InvalidStateError');
        after.push(p);
      },
    });
    if (!answered.with) return null;
    const res = await answered.with;
    // Work started while answering, then anything that work started.
    for (let i = 0; i < after.length; i++) await after[i];
    return res ? await res.text() : undefined;
  }

  return { request, net, asked, puts, store, broken };
}

const chunk = '/_next/static/chunks/0abc123.js';

describe('Next’s hashed files', () => {
  test('once kept, are answered from the copy: no network, nothing written back', async () => {
    const w = worker();
    w.net.answers.set(`${ORIGIN}${chunk}`, { body: 'chunk', cacheControl: IMMUTABLE });
    expect(await w.request(chunk)).toBe('chunk');
    expect(w.asked).toEqual([`${ORIGIN}${chunk}`]);
    expect(w.puts).toEqual([`${ORIGIN}${chunk}`]);

    for (let i = 0; i < 3; i++) expect(await w.request(chunk)).toBe('chunk');
    expect(w.asked).toHaveLength(1);
    expect(w.puts).toHaveLength(1);
  });

  test('the worker is kept until the copy is written', async () => {
    const w = worker();
    w.net.answers.set(`${ORIGIN}${chunk}`, { body: 'chunk', cacheControl: IMMUTABLE });
    await w.request(chunk);
    expect(w.store.has(`${ORIGIN}${chunk}`)).toBe(true);
  });

  test('a cache that can’t be read leaves them to the network, as before', async () => {
    const w = worker();
    w.net.answers.set(`${ORIGIN}${chunk}`, { body: 'chunk', cacheControl: IMMUTABLE });
    await w.request(chunk);
    w.broken.match = true;
    expect(await w.request(chunk)).toBe('chunk');
    expect(w.asked).toHaveLength(2);
  });

  test('offline, the kept copy still answers', async () => {
    const w = worker();
    w.net.answers.set(`${ORIGIN}${chunk}`, { body: 'chunk', cacheControl: IMMUTABLE });
    await w.request(chunk);
    w.net.online = false;
    expect(await w.request(chunk)).toBe('chunk');
  });

  test('in development (not immutable) they are fetched each time, as before, and kept for offline', async () => {
    const w = worker();
    w.net.answers.set(`${ORIGIN}${chunk}`, { body: 'v1', cacheControl: 'no-cache, must-revalidate' });
    expect(await w.request(chunk)).toBe('v1');
    w.net.answers.set(`${ORIGIN}${chunk}`, { body: 'v2', cacheControl: 'no-cache, must-revalidate' });
    expect(await w.request(chunk)).toBe('v2');
    expect(w.asked).toHaveLength(2);
    w.net.online = false;
    expect(await w.request(chunk)).toBe('v2');
  });

  test('a failed answer is not kept, so the next request fetches again', async () => {
    const w = worker();
    w.net.answers.set(`${ORIGIN}${chunk}`, { status: 500, body: 'error', cacheControl: IMMUTABLE });
    await w.request(chunk);
    w.net.answers.set(`${ORIGIN}${chunk}`, { body: 'chunk', cacheControl: IMMUTABLE });
    expect(await w.request(chunk)).toBe('chunk');
    expect(w.asked).toHaveLength(2);
  });

  test('other files, even immutable ones, stay network first', async () => {
    const w = worker();
    w.net.answers.set(`${ORIGIN}/icons/icon-192.png`, { body: 'v1', cacheControl: IMMUTABLE });
    await w.request('/icons/icon-192.png');
    w.net.answers.set(`${ORIGIN}/icons/icon-192.png`, { body: 'v2', cacheControl: IMMUTABLE });
    expect(await w.request('/icons/icon-192.png')).toBe('v2');
  });
});

describe('pages', () => {
  test('use the browser’s own request when there is one, and are kept for offline', async () => {
    const w = worker();
    expect(await w.request('/', { mode: 'navigate', preload: new Response('preloaded') })).toBe('preloaded');
    expect(w.asked).toEqual([]);
    w.net.online = false;
    expect(await w.request('/', { mode: 'navigate' })).toBe('preloaded');
  });

  test('offline, a tab’s address finds the page kept for another; other files don’t', async () => {
    const w = worker();
    w.net.answers.set(`${ORIGIN}/`, { body: 'home' });
    w.net.answers.set(`${ORIGIN}/x.png`, { body: 'png' });
    await w.request('/', { mode: 'navigate' });
    await w.request('/x.png');
    w.net.online = false;
    expect(await w.request('/?tab=budgets', { mode: 'navigate' })).toBe('home');
    expect(await w.request('/x.png?v=2')).toBeUndefined();
  });

  test('a browser that won’t wait for the copy still gets the network’s answer', async () => {
    const w = worker();
    expect(await w.request('/', { mode: 'navigate', preload: new Response('preloaded'), refuseWait: true })).toBe('preloaded');
    w.net.answers.set(`${ORIGIN}${chunk}`, { body: 'chunk', cacheControl: IMMUTABLE });
    expect(await w.request(chunk, { refuseWait: true })).toBe('chunk');
  });

  test('a cache that can’t be written to doesn’t fail the answer', async () => {
    const w = worker();
    w.store.set = () => {
      throw new Error('quota');
    };
    expect(await w.request('/', { mode: 'navigate' })).toBe('from the network');
  });
});

describe('left to the network', () => {
  test('API calls and writes go to the network uncached; other sites and Clerk’s path are left to the browser', async () => {
    const w = worker();
    expect(await w.request('/api/accounts')).toBe('from the network');
    expect(await w.request('/x', { method: 'POST' })).toBe('from the network');
    expect(w.puts).toEqual([]);
    expect(await w.request('https://clerk.example.com/v1/client')).toBeNull();
    expect(await w.request('/__clerk/v1/client')).toBeNull();
  });
});
