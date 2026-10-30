import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// public/service-worker.js run against a stand-in for the browser: a cache
// keyed by address, a network that answers from a table or is offline, and
// fetch events that record what the page was answered and what the worker
// kept working on afterwards.

const ORIGIN = 'https://nya.test';
const IMMUTABLE = 'public, max-age=31536000, immutable';

type Answer = { status?: number; body?: string; cacheControl?: string; type?: string; vary?: string };

type Stores = Map<string, Map<string, { req: { url: string }; res: Response }>>;

/** A worker; given another's caches and clock, the same browser after the
 *  worker was stopped and started again. */
function worker(from?: { stores: Stores; clock: { now: number } }) {
  const stores: Stores = from?.stores ?? new Map();
  const without = (url: string) => url.split('?')[0];
  const broken = { match: false, put: false };
  const full = (req: { url: string } | string) => (typeof req === 'string' ? (req.startsWith('http') ? req : `${ORIGIN}${req}`) : req.url);
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name)!;
    return {
      match: async (req: { url: string; mode?: string } | string, opts?: { ignoreSearch?: boolean; ignoreVary?: boolean }) => {
        if (broken.match) throw new Error('UnknownError: Unexpected internal error');
        const url = full(req);
        // A page load never matches an RSC payload: Next sends those with
        // Vary: RSC, a header page loads don't carry. A bare address carries
        // no headers, so it misses whatever varies on one.
        const fits = (e: { res: Response }) =>
          typeof req === 'string' ? !!opts?.ignoreVary || !e.res.headers.get('Vary') : req.mode !== 'navigate' || !e.res.headers.get('Content-Type')?.includes('x-component');
        const exact = entries.get(url);
        const hit = (exact && fits(exact) ? exact : undefined) ?? (opts?.ignoreSearch ? [...entries].find(([k, e]) => without(k) === without(url) && fits(e))?.[1] : undefined);
        return hit?.res.clone();
      },
      put: async (req: { url: string } | string, res: Response) => {
        if (name === 'nya-v3') puts.push(full(req));
        // A write takes a while: done only if the worker was kept for it.
        await new Promise((r) => setTimeout(r, 5));
        if (broken.put) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        entries.set(full(req), { req: { url: full(req) }, res });
      },
      keys: async () => [...entries.values()].map((e) => e.req),
      delete: async (req: { url: string } | string) => {
        if (name === 'nya-v3') deleted.push(full(req));
        return entries.delete(full(req));
      },
    };
  };
  const caches = {
    open: async (name: string) => open(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    // Every cache, as the browser's does, the tidy's notes included.
    match: async (req: { url: string; mode?: string } | string, opts?: { ignoreSearch?: boolean; ignoreVary?: boolean }) => {
      for (const name of stores.keys()) {
        const hit = await open(name).match(req, opts);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const puts: string[] = [];
  const deleted: string[] = [];
  const asked: string[] = [];
  const net = { online: true, answers: new Map<string, Answer>() };
  const fetch = async (req: { url: string }) => {
    asked.push(req.url);
    if (!net.online) throw new TypeError('Failed to fetch');
    const a = net.answers.get(req.url) ?? {};
    return new Response(a.body ?? 'from the network', {
      status: a.status ?? 200,
      headers: { ...(a.cacheControl ? { 'Cache-Control': a.cacheControl } : {}), ...(a.type ? { 'Content-Type': a.type } : {}), ...(a.vary ? { Vary: a.vary } : {}) },
    });
  };
  const clock = from?.clock ?? { now: Date.parse('2026-10-01T12:00:00Z') };
  const windows = { others: 0, uncontrolled: 0, said: true };
  let clientIds = 0;
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn),
    skipWaiting: () => {},
    clients: {
      claim: () => {},
      matchAll: async (opts?: { includeUncontrolled?: boolean }) => [
        { id: `window-${clientIds}` },
        ...Array.from({ length: windows.others }, (_, i) => ({ id: `other-${i}` })),
        ...Array.from({ length: opts?.includeUncontrolled ? windows.uncontrolled : 0 }, (_, i) => ({ id: `uncontrolled-${i}` })),
      ],
    },
    registration: { navigationPreload: { enable: async () => {} } },
  };
  // The tidy's wait for the page's own files ends once the test's page has
  // asked for them.
  const waiting: (() => void)[] = [];
  const gate = { open: true };
  const timer = (fn: () => void, ms: number) => (ms < 1000 || gate.open ? setTimeout(fn, Math.min(ms, 1)) : waiting.push(fn));
  new Function('self', 'caches', 'fetch', 'setTimeout', 'Date', readFileSync(join(import.meta.dir, '..', 'public', 'service-worker.js'), 'utf8'))(self, caches, fetch, timer, { now: () => clock.now });

  /** A fetch event for `path`: what the page was answered (null if the
   *  worker left it to the browser), once the worker has finished. */
  async function request(path: string, init: { mode?: string; method?: string; preload?: Response; refuseWait?: boolean; then?: () => Promise<unknown> } = {}) {
    const answered: { with?: Promise<Response | undefined> } = {};
    if (init.mode === 'navigate') gate.open = false;
    const after: Promise<unknown>[] = [];
    listeners.fetch({
      request: { url: path.startsWith('http') ? path : `${ORIGIN}${path}`, mode: init.mode ?? 'cors', method: init.method ?? 'GET' },
      resultingClientId: init.mode === 'navigate' ? (++clientIds, windows.said ? `window-${clientIds}` : undefined) : '',
      preloadResponse: init.preload ? Promise.resolve(init.preload) : undefined,
      respondWith: (p: Promise<Response | undefined>) => (answered.with = p),
      waitUntil: (p: Promise<unknown>) => {
        if (init.refuseWait) throw new DOMException('The event handler is already finished.', 'InvalidStateError');
        after.push(p);
      },
    });
    if (!answered.with) return null;
    const res = await answered.with;
    // What the page asks for once it has its answer.
    await init.then?.();
    gate.open = true;
    for (const fn of waiting.splice(0)) fn();
    // Work started while answering, then anything that work started.
    for (let i = 0; i < after.length; i++) await after[i];
    return res ? await res.text() : undefined;
  }

    /** The page at `path` loaded online, and the files it asks for. */
  const load = (path: string, files: string[] = []) =>
    request(path, {
      mode: 'navigate',
      then: async () => {
        for (const f of files) await request(f);
      },
    });

  return { request, load, net, asked, puts, deleted, broken, clock, windows, open, listeners, stores };
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
    expect(await w.open('nya-v3').match(chunk)).toBeDefined();
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
    w.broken.put = true;
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

// A deploy: its pages carry its build id as Next writes it (the last key of
// the flight data's first row), and name the files they load.
const DAY = 24 * 60 * 60 * 1000;
const at = (path: string) => `${ORIGIN}${path}`;
const js = (name: string) => `/_next/static/chunks/${name}.js`;

function html(build: string, scripts: string[], extra = '') {
  const tags = scripts.map((s) => `<script src="${s}" async=""></script>`).join('');
  return `<!DOCTYPE html><html><head>${tags}<script src="${js('polyfill')}" noModule=""></script></head><body>${extra}<script>self.__next_f.push([1,"0:{\\"P\\":null,\\"f\\":[],\\"b\\":\\"${build}\\"}\\n"])</script></body></html>`;
}

/** Puts a deploy on the network: its pages, and its files (`files` maps a
 *  file to what its text names). */
function deploy(w: ReturnType<typeof worker>, build: string, pages: Record<string, string[]>, files: Record<string, string> = {}) {
  for (const [path, scripts] of Object.entries(pages)) w.net.answers.set(at(path), { body: html(build, scripts), type: 'text/html; charset=utf-8' });
  for (const [path, body] of Object.entries(files)) w.net.answers.set(at(path), { body, cacheControl: IMMUTABLE, type: 'application/javascript' });
}

const kept = async (w: ReturnType<typeof worker>, path: string) => (await w.open('nya-v3').match(at(path))) !== undefined;
const notes = async (w: ReturnType<typeof worker>) => (await (await w.open('nya-v3-tidy').match(at('/api/service-worker/tidy')))?.json()) as { tidied: number; unused: Record<string, unknown> } | undefined;

/** Later, the worker started again (as it is after being idle). */
function later(w: ReturnType<typeof worker>, days: number) {
  w.clock.now += days * DAY;
  const next = worker({ stores: w.stores, clock: w.clock });
  next.net.answers = w.net.answers;
  return next;
}

describe('the daily tidy', () => {
  // Deploy 1: Home loads a1, which names the Plan tab's chunk (shared by
  // both deploys) and the payoff sheet's chunk (deploy 1 only).
  function twoDeploys() {
    const w = worker();
    deploy(w, 'build-1', { '/': [js('a1')] }, { [js('a1')]: 'l("static/chunks/plan.js");l("static/chunks/payoff1.js")', [js('plan')]: 'plan', [js('payoff1')]: 'payoff 1' });
    deploy(w, 'build-2', {}, { [js('a2')]: 'l("static/chunks/plan.js");l("static/chunks/payoff2.js")', [js('payoff2')]: 'payoff 2' });
    return w;
  }

  test('lets go of a replaced deploy’s files only after a week of tidies on three days', async () => {
    let w = twoDeploys();
    await w.load('/', [js('a1'), js('plan'), js('payoff1')]);
    expect(await notes(w)).toMatchObject({ unused: {} });

    w = later(w, 1);
    deploy(w, 'build-2', { '/': [js('a2')] });
    await w.load('/', [js('a2'), js('payoff2')]);
    const noted = Object.keys((await notes(w))!.unused);
    expect(noted.sort()).toEqual([at(js('a1')), at(js('payoff1'))]);

    for (const day of [3, 3]) {
      w = later(w, day);
      await w.load('/', [js('a2')]);
      expect(await kept(w, js('a1'))).toBe(true);
    }
    // Day 8, the fourth tidy that found them unused.
    w = later(w, 1);
    await w.load('/', [js('a2')]);
    expect(await kept(w, js('a1'))).toBe(false);
    expect(await kept(w, js('payoff1'))).toBe(false);
    // What deploy 2's Home can load stays, though this visit never asked for
    // it: the Plan tab, opened only on day 0, and the payoff sheet.
    expect(await kept(w, js('a2'))).toBe(true);
    expect(await kept(w, js('plan'))).toBe(true);
    expect(await kept(w, js('payoff2'))).toBe(true);
    expect(Object.keys((await notes(w))!.unused)).toEqual([]);
  });

  test('two tidies a week apart are not enough, nor three inside a week', async () => {
    let w = twoDeploys();
    await w.load('/', [js('a1')]);
    w = later(w, 1);
    deploy(w, 'build-2', { '/': [js('a2')] });
    await w.load('/', [js('a2')]);
    w = later(w, 8);
    await w.load('/', [js('a2')]);
    expect(await kept(w, js('a1'))).toBe(true);
    w = later(w, 1);
    await w.load('/', [js('a2')]);
    expect(await kept(w, js('a1'))).toBe(false);

    let v = twoDeploys();
    await v.load('/', [js('a1')]);
    v = later(v, 1);
    deploy(v, 'build-2', { '/': [js('a2')] });
    for (let day = 0; day < 6; day++) {
      await v.load('/', [js('a2')]);
      expect(await kept(v, js('a1'))).toBe(true);
      v = later(v, 1);
    }
  });

  test('a file found reachable again is forgotten', async () => {
    let w = twoDeploys();
    await w.load('/', [js('a1')]);
    w = later(w, 1);
    deploy(w, 'build-2', { '/': [js('a2')] });
    await w.load('/', [js('a2')]);
    expect((await notes(w))!.unused).toHaveProperty([at(js('a1'))]);
    // Rolled back to deploy 1.
    w = later(w, 1);
    deploy(w, 'build-1', { '/': [js('a1')] });
    await w.load('/', [js('a1')]);
    expect((await notes(w))!.unused).not.toHaveProperty([at(js('a1'))]);
  });

  test('follows what pages and files name: flight rows, chunk literals, a stylesheet’s fonts', async () => {
    let w = worker();
    const css = '/_next/static/chunks/site.css';
    const font = '/_next/static/media/inter.0a1.woff2';
    const page = html('build-1', [js('main')], '<script>self.__next_f.push([1,"2:I[1,[\\"/_next/static/chunks/client.js\\"],\\"default\\"]\\n"])</script>') + `<link rel="stylesheet" href="${css}"/>`;
    w.net.answers.set(at('/'), { body: page, type: 'text/html' });
    deploy(w, 'build-1', {}, { [js('main')]: 'x', [js('client')]: 'l("static/chunks/deep.js")', [js('deep')]: 'l("static/chunks/deeper.js")', [js('deeper')]: '', [js('stray')]: '' });
    w.net.answers.set(at(css), { body: `@font-face{src:url(../media/inter.0a1.woff2) format("woff2")}`, cacheControl: IMMUTABLE, type: 'text/css' });
    w.net.answers.set(at(font), { body: 'font', cacheControl: IMMUTABLE });
    await w.load('/', [js('main'), css, js('client'), js('deep'), js('deeper'), js('stray'), font]);
    w = later(w, 1);
    await w.load('/', [js('main'), css]);
    expect(Object.keys((await notes(w))!.unused)).toEqual([at(js('stray'))]);
  });

  test('drops an old deploy’s page beside a fresh one of the same path, after the same wait', async () => {
    let w = worker();
    deploy(w, 'build-1', { '/': [js('a1')], '/?tab=budgets': [js('a1')], '/reports': [js('r1')] }, { [js('a1')]: '', [js('r1')]: '' });
    await w.load('/?tab=budgets', [js('a1')]);
    await w.load('/reports', [js('r1')]);
    w.net.answers.set(at('/?_rsc=1'), { body: '0:{"f":[],"b":"build-1"}\n', type: 'text/x-component' });
    await w.request('/?_rsc=1');
    w = later(w, 1);
    deploy(w, 'build-2', { '/': [js('a2')], '/?tab=plan': [js('a2')] }, { [js('a2')]: '' });
    await w.load('/', [js('a2')]);
    await w.load('/?tab=plan', [js('a2')]);
    for (const day of [3, 3, 2]) {
      expect(await kept(w, '/?tab=budgets')).toBe(true);
      w = later(w, day);
      await w.load('/', [js('a2')]);
    }
    expect(await kept(w, '/?tab=budgets')).toBe(false);
    // Deploy 1's file, needed by no kept page now, starts its own wait; not
    // so a path with no newer page, nor an RSC payload with none of the
    // current deploy.
    expect((await notes(w))!.unused).toHaveProperty([at(js('a1'))]);
    expect(await kept(w, '/?tab=plan')).toBe(true);
    expect(await kept(w, '/reports')).toBe(true);
    expect(await kept(w, js('r1'))).toBe(true);
    expect(await kept(w, '/?_rsc=1')).toBe(true);
    // Offline, the old tab's address opens the fresh page.
    w.net.online = false;
    expect(await w.request('/?tab=budgets', { mode: 'navigate' })).toContain('build-2');
  });

  test('reads the deployment id when a page carries one instead of the build id', async () => {
    let w = worker();
    const page = (dpl: string, src: string) => `<html data-dpl-id="${dpl}"><script src="${src}"></script></html>`;
    w.net.answers.set(at('/?tab=plan'), { body: page('dpl_1', js('a1')), type: 'text/html' });
    w.net.answers.set(at(js('a1')), { body: '', cacheControl: IMMUTABLE });
    await w.load('/?tab=plan', [js('a1')]);
    w = later(w, 1);
    w.net.answers.set(at('/'), { body: page('dpl_2', js('a2')), type: 'text/html' });
    w.net.answers.set(at(js('a2')), { body: '', cacheControl: IMMUTABLE });
    await w.load('/', [js('a2')]);
    expect((await notes(w))!.unused).toHaveProperty([at('/?tab=plan')]);
  });

  test('waits while the page is missing its own scripts, or another window is open', async () => {
    let w = twoDeploys();
    await w.load('/', [js('a1')]);
    w = later(w, 1);
    deploy(w, 'build-2', { '/': [js('a2')] });
    // Cut short before a2 arrived: no tidy today, and the next load tries.
    await w.load('/');
    expect((await notes(w))!.unused).toEqual({});
    w.windows.others = 1;
    await w.load('/', [js('a2')]);
    expect((await notes(w))!.unused).toEqual({});
    w.windows.others = 0;
    await w.load('/', [js('a2')]);
    expect((await notes(w))!.unused).toHaveProperty([at(js('a1'))]);
  });

  test('runs once a day, only after a page loaded online', async () => {
    let w = twoDeploys();
    await w.load('/', [js('a1')]);
    const first = (await notes(w))!.tidied;
    w.clock.now += 60 * 1000;
    await w.load('/', [js('a1')]);
    expect((await notes(w))!.tidied).toBe(first);
    w = later(w, 1);
    w.net.online = false;
    await w.request('/', { mode: 'navigate' });
    await w.request('/?tab=plan', { mode: 'navigate' });
    expect((await notes(w))!.tidied).toBe(first);
  });

  test('never deletes a file this worker has answered since it started', async () => {
    let w = twoDeploys();
    await w.load('/', [js('a1')]);
    w = later(w, 1);
    deploy(w, 'build-2', { '/': [js('a2')] });
    await w.load('/', [js('a2')]);
    for (const day of [3, 3]) {
      w = later(w, day);
      await w.load('/', [js('a2')]);
    }
    w = later(w, 1);
    // An old tab, closed since, asked for a1 just before this load.
    await w.request(js('a1'));
    await w.load('/', [js('a2')]);
    expect(await kept(w, js('a1'))).toBe(true);
  });

  test('a kept RSC payload keeps what it names', async () => {
    let w = twoDeploys();
    w.net.answers.set(at('/reports?_rsc=1'), { body: '1:I[5,["/_next/static/chunks/report.js"],"default"]\n0:{"f":[],"b":"build-1"}\n', type: 'text/x-component' });
    w.net.answers.set(at(js('report')), { body: '', cacheControl: IMMUTABLE });
    await w.load('/', [js('a1')]);
    await w.request('/reports?_rsc=1');
    await w.request(js('report'));
    w = later(w, 1);
    await w.load('/', [js('a1')]);
    expect((await notes(w))!.unused).toEqual({});
  });

  test('waits for the page’s stylesheets too, read with &amp; as written in the page', async () => {
    let w = worker();
    const css = '/_next/static/chunks/site.css?dpl=1&v=2';
    w.net.answers.set(at('/'), { body: html('build-1', [js('a1')], '<link rel="stylesheet" href="/_next/static/chunks/site.css?dpl=1&amp;v=2"/>'), type: 'text/html' });
    deploy(w, 'build-1', {}, { [js('a1')]: '', [js('stray')]: '' });
    w.net.answers.set(at(css), { body: '', cacheControl: IMMUTABLE, type: 'text/css' });
    await w.request(js('stray'));
    await w.load('/', [js('a1')]);
    expect(await notes(w)).toBeUndefined();
    await w.load('/', [js('a1'), css]);
    expect((await notes(w))!.unused).toHaveProperty([at(js('stray'))]);
  });

  test('counts windows not yet controlled, and without the page’s window id, waits for one window', async () => {
    let w = twoDeploys();
    await w.load('/', [js('a1')]);
    w = later(w, 1);
    deploy(w, 'build-2', { '/': [js('a2')] });
    w.windows.uncontrolled = 1;
    await w.load('/', [js('a2')]);
    expect((await notes(w))!.unused).toEqual({});
    w.windows.uncontrolled = 0;
    w.windows.said = false;
    w.windows.others = 1;
    await w.load('/', [js('a2')]);
    expect((await notes(w))!.unused).toEqual({});
    w.windows.others = 0;
    await w.load('/', [js('a2')]);
    expect((await notes(w))!.unused).toHaveProperty([at(js('a1'))]);
  });

  test('reads the build from the root row, not another row ending the same way', async () => {
    let w = worker();
    const decoy = '<script>self.__next_f.push([1,"1:{\\"b\\":\\"not-a-build\\"}\\n"])</script>';
    w.net.answers.set(at('/?tab=plan'), { body: html('build-1', [js('a1')], decoy), type: 'text/html' });
    w.net.answers.set(at('/'), { body: html('build-1', [js('a1')]), type: 'text/html' });
    deploy(w, 'build-1', {}, { [js('a1')]: '' });
    await w.load('/?tab=plan', [js('a1')]);
    await w.load('/', [js('a1')]);
    w = later(w, 1);
    await w.load('/', [js('a1')]);
    expect((await notes(w))!.unused).toEqual({});
  });

  test('a clock set back, or unreadable notes, don’t stop the tidy', async () => {
    let w = twoDeploys();
    await w.load('/', [js('a1')]);
    w.clock.now -= 3 * DAY;
    w = later(w, 1);
    deploy(w, 'build-2', { '/': [js('a2')] });
    await w.load('/', [js('a2')]);
    expect((await notes(w))!.unused).toHaveProperty([at(js('a1'))]);

    w = later(w, 1);
    await w.open('nya-v3-tidy').put(at('/api/service-worker/tidy'), new Response('{"tidied":"x","refs":null,"unused":null}'));
    await w.load('/', [js('a2')]);
    expect((await notes(w))!.unused).toHaveProperty([at(js('a1'))]);
  });

  test('what a file that may change names is read again each time', async () => {
    let w = worker();
    const dev = { cacheControl: 'no-cache, must-revalidate' };
    w.net.answers.set(at('/'), { body: html('build-1', [js('main')]), type: 'text/html' });
    w.net.answers.set(at(js('main')), { body: '', ...dev });
    w.net.answers.set(at(js('later')), { body: '', ...dev });
    await w.load('/', [js('main')]);
    await w.request(js('later'));
    w = later(w, 1);
    // An edit: main now imports later.
    w.net.answers.set(at(js('main')), { body: 'l("static/chunks/later.js")', ...dev });
    await w.load('/', [js('main')]);
    expect((await notes(w))!.unused).toEqual({});
  });

  test('reads the build from a root row holding a line break, in a page or a payload', async () => {
    let w = worker();
    const row = (build: string) => `0:{"t":"a\\nb","b":"${build}"}`;
    const page = (build: string, src: string) => `<html><script src="${src}"></script><script>self.__next_f.push([1,${JSON.stringify(`${row(build)}\n`)}])</script></html>`;
    w.net.answers.set(at('/?tab=plan'), { body: page('build-1', js('a1')), type: 'text/html' });
    w.net.answers.set(at('/?_rsc=1'), { body: `${row('build-1')}\n`, type: 'text/x-component' });
    w.net.answers.set(at('/?_rsc=2'), { body: `${row('build-2')}\n`, type: 'text/x-component' });
    deploy(w, 'build-1', {}, { [js('a1')]: '', [js('a2')]: '' });
    await w.load('/?tab=plan', [js('a1')]);
    await w.request('/?_rsc=1');
    w = later(w, 1);
    w.net.answers.set(at('/'), { body: page('build-2', js('a2')), type: 'text/html' });
    await w.load('/', [js('a2')]);
    await w.request('/?_rsc=2');
    w = later(w, 1);
    await w.load('/', [js('a2')]);
    expect(Object.keys((await notes(w))!.unused).sort()).toEqual([at('/?_rsc=1'), at('/?tab=plan')]);
  });

  test('reads the build from a root row split across two scripts, or of any length', async () => {
    let w = worker();
    const push = (text: string) => `<script>self.__next_f.push([1,${JSON.stringify(text)}])</script>`;
    const row = (build: string, text: string) => `0:${JSON.stringify({ t: text, b: build })}\n`;
    const split = (build: string, src: string) => {
      const r = row(build, 'y'.repeat(50));
      return `<html><script src="${src}"></script>${push(r.slice(0, r.length - 6))}${push(r.slice(-6))}</html>`;
    };
    // Longer than one regular expression can take in some browsers.
    const long = (build: string, src: string) => `<html><script src="${src}"></script>${push(row(build, 'z\n"'.repeat(600_000)))}</html>`;
    w.net.answers.set(at('/?tab=plan'), { body: split('build-1', js('a1')), type: 'text/html' });
    w.net.answers.set(at('/?tab=home'), { body: long('build-1', js('a1')), type: 'text/html' });
    deploy(w, 'build-1', {}, { [js('a1')]: '', [js('a2')]: '' });
    await w.load('/?tab=plan', [js('a1')]);
    await w.load('/?tab=home', [js('a1')]);
    w = later(w, 1);
    w.net.answers.set(at('/'), { body: split('build-2', js('a2')), type: 'text/html' });
    await w.load('/', [js('a2')]);
    expect(Object.keys((await notes(w))!.unused).sort()).toEqual([at('/?tab=home'), at('/?tab=plan')]);
  });

  test('reads each part of a page once, however much of its text looks like a row’s start', async () => {
    let w = worker();
    const push = (text: string) => `<script>self.__next_f.push([1,${JSON.stringify(text)}])</script>`;
    // Text someone typed, with "0:{" after line breaks, in a row before the root row.
    const typed = `${'z'.repeat(1000)}\n0:{`.repeat(1000);
    const page = (build: string, src: string) =>
      `<html><script src="${src}"></script>${push(`3:${JSON.stringify({ children: typed })}\n0:{"P":null,"b":"${build}"}\n`)}</html>`;
    w.net.answers.set(at('/?tab=plan'), { body: page('build-1', js('a1')), type: 'text/html' });
    deploy(w, 'build-1', {}, { [js('a1')]: '', [js('a2')]: '' });
    await w.load('/?tab=plan', [js('a1')]);
    w = later(w, 1);
    w.net.answers.set(at('/'), { body: page('build-2', js('a2')), type: 'text/html' });
    const started = performance.now();
    await w.load('/', [js('a2')]);
    // Reading a candidate's row afresh each time took seconds here.
    expect(performance.now() - started).toBeLessThan(3000);
    expect((await notes(w))!.unused).toHaveProperty([at('/?tab=plan')]);
  });

  test('reads rows only in Next’s scripts, not page text that looks like them, and after a long text', async () => {
    let w = worker();
    const push = (text: string) => `<script>self.__next_f.push([1,${JSON.stringify(text)}])</script>`;
    // A note someone typed, shown in the page, with no quote after it
    // before the root row's script; a later row ending as the root row does.
    const page = (build: string, src: string) =>
      `<html><script src="${src}"></script><p>see \\n0:{ here</p><script>(self.__next_f=self.__next_f||[]).push([0])</script>` +
      push(`0:{"P":null,"b":"${build}"}\n`) +
      push(`5:{"t":"a","b":"not-a-build"}\n`) +
      '</html>';
    // A long text before the root row, written as a text row with no line end.
    const long = (build: string, src: string) =>
      `<html><script src="${src}"></script>${push('6:T800,')}${push('t'.repeat(2048))}${push(`0:{"P":null,"b":"${build}"}\n`)}</html>`;
    w.net.answers.set(at('/?tab=home'), { body: long('build-1', js('a1')), type: 'text/html' });
    w.net.answers.set(at('/?tab=plan'), { body: page('build-1', js('a1')), type: 'text/html' });
    w.net.answers.set(at('/'), { body: page('build-1', js('a1')), type: 'text/html' });
    deploy(w, 'build-1', {}, { [js('a1')]: '' });
    await w.load('/', [js('a1')]);
    await w.load('/?tab=plan', [js('a1')]);
    await w.load('/?tab=home', [js('a1')]);
    w = later(w, 1);
    w.net.answers.set(at('/'), { body: long('build-2', js('a1')), type: 'text/html' });
    await w.load('/', [js('a1')]);
    expect(Object.keys((await notes(w))!.unused).sort()).toEqual([at('/?tab=home'), at('/?tab=plan')]);
  });

  test('reads a segment prefetch’s build, so an old one doesn’t keep its files', async () => {
    let w = twoDeploys();
    const segment = (build: string) => `1:I[1,[],"x"]\n0:{"buildId":"${build}","rsc":"$@1"}\n`;
    w.net.answers.set(at('/?_rsc=seg'), { body: segment('build-1'), type: 'text/x-component' });
    await w.load('/', [js('a1')]);
    await w.request('/?_rsc=seg');
    w = later(w, 1);
    deploy(w, 'build-2', { '/': [js('a2')] });
    w.net.answers.set(at('/?_rsc=seg2'), { body: segment('build-2'), type: 'text/x-component' });
    await w.load('/', [js('a2')]);
    await w.request('/?_rsc=seg2');
    w = later(w, 1);
    await w.load('/', [js('a2')]);
    expect((await notes(w))!.unused).toHaveProperty([at('/?_rsc=seg')]);
  });

  test('follows names with any characters a path can hold', async () => {
    let w = worker();
    const img = '/_next/static/media/logo@2x+[dark].0a1.png';
    deploy(w, 'build-1', { '/': [js('main')] }, { [js('main')]: `"static/media/logo@2x+[dark].0a1.png"` });
    w.net.answers.set(at(img), { body: 'png', cacheControl: IMMUTABLE });
    await w.load('/', [js('main')]);
    await w.request(img);
    w = later(w, 1);
    await w.load('/', [js('main')]);
    expect((await notes(w))!.unused).toEqual({});
  });

  test('a file kept under two addresses goes under both', async () => {
    let w = twoDeploys();
    await w.load('/', [js('a1')]);
    w.net.answers.set(at(`${js('a1')}?dpl=2`), { body: '', cacheControl: IMMUTABLE });
    await w.request(`${js('a1')}?dpl=2`);
    w = later(w, 1);
    deploy(w, 'build-2', { '/': [js('a2')] });
    await w.load('/', [js('a2')]);
    for (const day of [3, 3, 1]) {
      w = later(w, day);
      await w.load('/', [js('a2')]);
    }
    expect(await kept(w, js('a1'))).toBe(false);
    expect(await kept(w, `${js('a1')}?dpl=2`)).toBe(false);
  });

  test('finds the page’s own files whatever they vary on', async () => {
    let w = twoDeploys();
    w.net.answers.set(at(js('a1')), { body: '', cacheControl: IMMUTABLE, vary: 'Accept' });
    await w.load('/', [js('a1')]);
    expect(await notes(w)).toBeDefined();
  });

  test('a tidy that fails leaves the page’s answer alone', async () => {
    const w = twoDeploys();
    w.broken.put = true;
    expect(await w.load('/', [js('a1')])).toContain('build-1');
  });

  test('a new worker keeps the tidy’s notes and drops other caches', async () => {
    const w = twoDeploys();
    await w.load('/', [js('a1')]);
    await w.open('nya-v2').put(at('/'), new Response('old'));
    const done: Promise<unknown>[] = [];
    w.listeners.activate({ waitUntil: (p: Promise<unknown>) => done.push(p) });
    await Promise.all(done);
    expect([...w.stores.keys()].sort()).toEqual(['nya-v3', 'nya-v3-tidy']);
  });
});
