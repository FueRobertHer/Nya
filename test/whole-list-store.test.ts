import { describe, expect, test } from 'bun:test';
import { createWholeListStore, type ListState } from '@/lib/whole-list-store';

type Budgets = Record<string, number>;

/** A fake server holding one list, whose responses the test releases by hand,
 *  so any interleaving of loads and saves can be staged. */
function fakeServer(initial: Budgets) {
  let stored = initial;
  const pending: { resolve: () => void; kind: 'GET' | 'PUT' }[] = [];
  const calls: { method: string; body?: unknown }[] = [];
  let mode: 'ok' | 'fail' | 'unreadable' | 'network' = 'ok';

  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetch = async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, body });
    await new Promise<void>((resolve) => pending.push({ resolve, kind: method as 'GET' | 'PUT' }));
    // Decided when the response is released, not when the request was sent,
    // so a test can fail one request and let the next succeed.
    const outcome = mode;
    if (outcome === 'network') throw new TypeError('network down');
    if (outcome === 'unreadable') return respond(409, { error: 'x', unreadable: true });
    if (outcome === 'fail') return respond(500, { error: 'x' });
    if (method === 'PUT') {
      stored = body.budgets;
      return respond(200, { budgets: stored });
    }
    return respond(200, { budgets: stored });
  };

  return {
    fetch,
    calls,
    get stored() {
      return stored;
    },
    set mode(m: typeof mode) {
      mode = m;
    },
    /** Let the oldest (or a specific index of) pending request answer. */
    async release(index = 0) {
      const [p] = pending.splice(index, 1);
      p.resolve();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
    get pending() {
      return pending.map((p) => p.kind);
    },
  };
}

function setup(initial: Budgets = { Food: 300 }) {
  const server = fakeServer(initial);
  const states: ListState<Budgets>[] = [];
  const store = createWholeListStore<Budgets>({
    url: '/api/budgets',
    field: 'budgets',
    noun: 'budgets',
    empty: {},
    isValid: (v): v is Budgets => typeof v === 'object' && v !== null && !Array.isArray(v),
    onChange: (s) => states.push(s),
    fetch: server.fetch as unknown as typeof fetch,
  });
  return { server, store, states };
}

async function loaded(initial?: Budgets) {
  const s = setup(initial);
  const l = s.store.load();
  await s.server.release();
  await l;
  return s;
}

describe('before a load has succeeded', () => {
  test('the list is loading, not "none", and cannot be saved', async () => {
    const { server, store } = setup();
    expect(store.get().status).toBe('loading');

    expect(await store.save({ Rent: 1000 })).toBe(false);
    expect(store.get().saveError).toContain('still loading');
    expect(server.calls).toEqual([]); // nothing sent
  });

  for (const [mode, text] of [
    ['fail', 'could not be loaded'],
    ['network', 'could not be loaded'],
    ['unreadable', 'could not be read'],
  ] as const) {
    test(`a ${mode} load is an error that blocks saving`, async () => {
      const { server, store } = setup();
      server.mode = mode;
      const l = store.load();
      await server.release();
      await l;

      expect(store.get().status).toBe('error');
      expect(store.get().error).toContain(text);
      expect(await store.save({ Rent: 1000 })).toBe(false);
      expect(server.calls.filter((c) => c.method === 'PUT')).toEqual([]);
      // Never "still loading": nothing is.
      expect(store.get().saveError).toBe('Budgets could not be loaded, so they can’t be saved yet; press Refresh to try again.');
    });
  }

  test('says how to try again: Refresh by default, or what the screen offers instead', async () => {
    const failing = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    const make = (reloadHint?: string) =>
      createWholeListStore<Budgets>({
        url: '/api/budgets',
        field: 'budgets',
        noun: 'budgets',
        empty: {},
        isValid: (v): v is Budgets => typeof v === 'object' && v !== null && !Array.isArray(v),
        onChange: () => {},
        fetch: failing,
        reloadHint,
      });
    const plain = make();
    await plain.load();
    expect(plain.get().error).toBe('Budgets could not be loaded. Editing is paused until they are; press Refresh to try again.');
    const own = make('use Try again below');
    await own.load();
    expect(own.get().error).toBe('Budgets could not be loaded. Editing is paused until they are; use Try again below.');
  });

  test('a response of the wrong shape is an error, not an empty list', async () => {
    const server = fakeServer({});
    const store = createWholeListStore<Budgets>({
      url: '/api/budgets',
      field: 'budgets',
      noun: 'budgets',
      empty: {},
      isValid: (v): v is Budgets => typeof v === 'object' && v !== null && !Array.isArray(v),
      onChange: () => {},
      fetch: (async () => new Response(JSON.stringify({ budgets: [1] }), { status: 200 })) as unknown as typeof fetch,
    });
    await store.load();
    expect(store.get().status).toBe('error');
    void server;
  });
});

describe('saving', () => {
  test('sends the whole list, shows it at once, and reports success', async () => {
    const { server, store } = await loaded();
    const p = store.save({ Food: 300, Rent: 1000 });
    expect(store.get().value).toEqual({ Food: 300, Rent: 1000 }); // optimistic
    await server.release();

    expect(await p).toBe(true);
    expect(server.stored).toEqual({ Food: 300, Rent: 1000 });
    expect(store.get()).toMatchObject({ saving: false, saveError: null });
  });

  test('a second save while one is in flight is refused, not sent', async () => {
    const { server, store } = await loaded();
    const first = store.save({ Food: 300, Rent: 1000 });
    expect(await store.save({ Food: 300, Rent: 1000, Gas: 100 })).toBe(false);
    expect(store.get().saveError).toContain('Still saving');
    await server.release();
    await first;

    expect(server.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  for (const mode of ['fail', 'network', 'unreadable'] as const) {
    test(`a ${mode} save says so and puts back what is really saved`, async () => {
      const { server, store } = await loaded();
      server.mode = mode;
      const p = store.save({ Food: 300, Rent: 1000 });
      await server.release(); // the PUT fails
      server.mode = 'ok';
      await server.release(); // the reload
      expect(await p).toBe(false);

      expect(store.get().value).toEqual({ Food: 300 });
      expect(store.get().saveError).toContain('Could not save budgets');
      expect(store.get().saving).toBe(false);
    });
  }

  test('the reviewed race: a failed save cannot let a second save desync the screen', async () => {
    // Before: save 1 fails and reloads, save 2 (built on save 1's optimistic
    // list) is in flight, the reload reads the server before save 2 lands, and
    // the screen shows a stale list marked loaded; the next edit drops data.
    const { server, store } = await loaded();
    server.mode = 'fail';
    const one = store.save({ Food: 300, Rent: 1000 });
    const two = store.save({ Food: 300, Rent: 1000, Gas: 100 }); // refused, never sent
    expect(await two).toBe(false);
    await server.release();
    server.mode = 'ok';
    await server.release();
    await one;

    expect(server.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(server.stored).toEqual({ Food: 300 });
    expect(store.get().value).toEqual(server.stored); // screen matches server
  });

  test('a failed save whose reload also fails never leaves the unsaved list in memory', async () => {
    const { server, store } = await loaded();
    server.mode = 'fail';
    const p = store.save({ Food: 300, Rent: 1000 });
    await server.release(); // PUT fails
    await server.release(); // reload fails too
    await p;
    expect(store.get().status).toBe('error');
    expect(store.get().value).toEqual({ Food: 300 });
  });

  test('saves are refused during the reload that follows a failed save', async () => {
    const { server, store } = await loaded();
    server.mode = 'fail';
    const p = store.save({ Rent: 1 });
    await server.release(); // PUT fails; reload now pending
    expect(await store.save({ Rent: 2 })).toBe(false);
    server.mode = 'ok';
    await server.release();
    await p;
    expect(server.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  test('an empty list is a real list: it saves and loads', async () => {
    const { server, store } = await loaded();
    const p = store.save({});
    await server.release();
    expect(await p).toBe(true);
    expect(server.stored).toEqual({});
  });
});

describe('loading', () => {
  test('an older load finishing last does not overwrite a newer one', async () => {
    const { server, store } = setup({ Food: 300 });
    const older = store.load();
    // The server changes between the two loads.
    const newer = (async () => {
      await new Promise((r) => setTimeout(r, 0));
      return store.load();
    })();
    await new Promise((r) => setTimeout(r, 5));
    // Answer the newer one first, with a changed server...
    (server as any).mode = 'ok';
    await server.release(1);
    await newer;
    const afterNewer = store.get().value;
    // ...then the older one; its answer must be ignored.
    await server.release(0);
    await older;
    expect(store.get().value).toBe(afterNewer);
    expect(store.get().status).toBe('ready');
  });

  test('a failed load can be retried', async () => {
    const { server, store } = setup();
    server.mode = 'fail';
    const l = store.load();
    await server.release();
    await l;
    expect(store.get().status).toBe('error');

    server.mode = 'ok';
    const retry = store.load();
    await server.release();
    await retry;
    expect(store.get()).toMatchObject({ status: 'ready', error: null, value: { Food: 300 } });
  });
});

describe('opted in: what the server said about a save (goals)', () => {
  /** A server that answers a PUT as given, at once. */
  const answering = (status: number, body: unknown) => {
    const calls: string[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      calls.push(init?.method ?? 'GET');
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ goals: [{ id: 'a' }] }), { status: 200 });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
  };
  const goals = async (server: ReturnType<typeof answering>, opts: { adoptSaved?: boolean; showRefusal?: boolean }) => {
    const store = createWholeListStore<{ id: string; worked_out?: string }[]>({
      url: '/api/goals',
      field: 'goals',
      noun: 'goals',
      empty: [],
      isValid: (v): v is { id: string }[] => Array.isArray(v),
      onChange: () => {},
      fetch: server.fetch,
      ...opts,
    });
    await store.load();
    return store;
  };

  test('the list the server answered with is kept, with what it worked out', async () => {
    const store = await goals(answering(200, { goals: [{ id: 'a', worked_out: 'by the server' }] }), { adoptSaved: true });
    expect(await store.save([{ id: 'a' }])).toBe(true);
    expect(store.get().value).toEqual([{ id: 'a', worked_out: 'by the server' }]);
  });

  test('without it, or with an answer that isn’t a list, the list sent is kept', async () => {
    expect(await (await goals(answering(200, { goals: [{ id: 'x' }] }), {})).save([{ id: 'a' }])).toBe(true);
    const store = await goals(answering(200, { goals: 'nope' }), { adoptSaved: true });
    await store.save([{ id: 'a' }]);
    expect(store.get().value).toEqual([{ id: 'a' }]);
  });

  test('a refusal says why, and the list goes back to what is saved', async () => {
    const store = await goals(answering(400, { error: 'Allocations on Savings would come to $10.01, more than its balance of $10.00.' }), { showRefusal: true });
    expect(await store.save([{ id: 'b' }])).toBe(false);
    expect(store.get().saveError).toBe('Not saved: Allocations on Savings would come to $10.01, more than its balance of $10.00.');
    expect(store.get().value).toEqual([{ id: 'a' }]);
  });

  test('a 409 not flagged unreadable is a refusal too: what is stored stops it just now, and why', async () => {
    const store = await goals(answering(409, { error: 'A saved account link can’t be read.' }), { showRefusal: true });
    expect(await store.save([{ id: 'b' }])).toBe(false);
    expect(store.get().saveError).toBe('Not saved: A saved account link can’t be read.');
    // Flagged unreadable, it is the list that can't be read: the plain message.
    const flagged = await goals(answering(409, { error: 'x', unreadable: true }), { showRefusal: true });
    await flagged.save([{ id: 'b' }]);
    expect(flagged.get().saveError).toBe('Could not save goals. Showing what is saved.');
  });

  test('anything but a refusal keeps the plain message', async () => {
    const store = await goals(answering(500, { error: 'Failed to save goals' }), { showRefusal: true });
    await store.save([{ id: 'b' }]);
    expect(store.get().saveError).toBe('Could not save goals. Showing what is saved.');
  });

  test('what a save sends beside the list is read as each one is sent, and never takes the list’s place', async () => {
    const bodies: unknown[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ goals: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    let day = '2026-10-11';
    const store = createWholeListStore<{ id: string }[]>({
      url: '/api/goals',
      field: 'goals',
      noun: 'goals',
      empty: [],
      isValid: (v): v is { id: string }[] => Array.isArray(v),
      onChange: () => {},
      fetch,
      extra: () => ({ today: day, goals: 'not the list' }),
    });
    await store.load();
    await store.save([{ id: 'a' }]);
    day = '2026-10-12';
    await store.save([{ id: 'b' }]);
    expect(bodies).toEqual([
      { today: '2026-10-11', goals: [{ id: 'a' }] },
      { today: '2026-10-12', goals: [{ id: 'b' }] },
    ]);
  });
});
