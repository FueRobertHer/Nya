import { describe, expect, test, afterEach } from 'bun:test';
import { createPlanInputsStore, FRESH_MS, type PlanInputsCopy, type PlanRow } from '@/lib/plan-inputs-store';
import { contributionsFrom, planId } from '@/components/plan-inputs';

// The copy of the Plan's inputs that Home and the Plan share
// (lib/plan-inputs-store.ts), its timing rules alone: when a copy is taken
// as it is, when a request is joined, what a save's answer and an
// invalidation do, the rows that come later, and what each failure costs;
// then how the screens read the rows (components/plan-inputs.ts
// contributionsFrom), against the mapping each plan's own request had.

type Answer = [number, unknown] | 'throw';
/** A server whose every request waits until the test answers it, or that
 *  answers at once with `auto`. */
function server(auto?: (url: string) => Answer) {
  const sent: { url: string; answer: (a: Answer) => void }[] = [];
  const fetch = (url: string) =>
    new Promise<Response>((resolve, reject) => {
      const answer = (a: Answer) => (a === 'throw' ? reject(new Error('offline')) : resolve(new Response(JSON.stringify(a[1]), { status: a[0] })));
      if (auto) answer(auto(url));
      else sent.push({ url, answer });
    });
  return { sent, fetch, urls: () => sent.map((s) => s.url) };
}
/** Lets every answer given land. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

const PLAN = { plan: { age: 40 }, currency: 'USD' };
const DEFAULT_URL = '/api/plan-inputs?plan=i1%3Ak1&plan=i2%3Ak3';
const SYNC_URL = '/api/plan-inputs?sync=1&plan=i1%3Ak1&plan=i2%3Ak3';
const IDS = ['i1:k1', 'i2:k3'];
const row = (id: string, amount = 1_000) => ({ id, contributions_12m: amount, contributions_12m_from: '2025-11-03', contributions_12m_partial: false, contributions_12m_rows: [{ date: '2026-10-01', amount }], contributions_12m_activity_from: null, note: null });
const pending = (id: string): PlanRow => ({ id, pending: true });
const ok = (rows: PlanRow[] = IDS.map((id) => row(id))): Answer => [200, { ...PLAN, plans: rows }];

let clock = 0;
const make = (s: ReturnType<typeof server>) => createPlanInputsStore({ fetch: s.fetch, now: () => clock });
afterEach(() => {
  clock = 0;
});

describe('when a copy is taken as it is', () => {
  test('for five minutes after its answer, for the same plans; the Plan’s loads always ask', async () => {
    const s = server(() => ok());
    const store = make(s);
    await store.load(IDS);
    await store.load(IDS);
    expect(s.urls()).toEqual([]); // auto: nothing held
    let asked = 0;
    const counted = createPlanInputsStore({ fetch: (u) => (asked++, s.fetch(u)), now: () => clock });
    await counted.load(IDS);
    clock += FRESH_MS - 1;
    await counted.load(IDS);
    expect(asked).toBe(1);
    await counted.load(IDS, { force: true });
    expect(asked).toBe(2);
    clock += FRESH_MS;
    await counted.load(IDS);
    expect(asked).toBe(3);
    await counted.load(['i1:k1']); // other plans
    expect(asked).toBe(4);
  });

  test('a plan that can’t be read counts as answered; a 500, a 404 or a request that never answered never does', async () => {
    for (const [answer, fresh] of [
      [[409, { error: 'Your saved plan could not be read.', unreadable: true, plans: IDS.map((id) => row(id)) }], true],
      [[500, { error: 'no' }], false],
      [[404, { error: 'not here' }], false],
      ['throw', false],
    ] as [Answer, boolean][]) {
      let asked = 0;
      const store = createPlanInputsStore({ fetch: (u) => (asked++, server(() => (u.includes('sync=1') ? ok() : answer)).fetch(u)), now: () => clock });
      await store.load(IDS);
      await settle();
      const before = asked;
      await store.load(IDS);
      expect([answer === 'throw' ? 'throw' : answer[0], asked > before]).toEqual([answer === 'throw' ? 'throw' : answer[0], !fresh]);
    }
  });

  test('a row that failed is never taken as it is', async () => {
    let asked = 0;
    const store = createPlanInputsStore({ fetch: (u) => (asked++, server(() => (u.includes('sync=1') ? [500, { error: 'no' }] : ok([row('i1:k1'), pending('i2:k3')]))).fetch(u)), now: () => clock });
    await store.load(IDS);
    await settle();
    expect(store.get().rows['i2:k3']).toEqual({ id: 'i2:k3', failed: true });
    expect(asked).toBe(2);
    await store.load(IDS);
    await settle();
    expect(asked).toBe(4); // asked again, its row again
  });
});

describe('joining a request', () => {
  test('loads at once share one request, and all get its answer', async () => {
    const s = server();
    const store = make(s);
    const a = store.load(IDS);
    const b = store.load(IDS);
    const c = store.load(IDS, { force: true });
    expect(s.urls()).toEqual([DEFAULT_URL]);
    s.sent[0].answer(ok());
    const answers = await Promise.all([a, b, c]);
    expect(answers.map((x) => x.status)).toEqual([200, 200, 200]);
    expect(answers[0].data).toEqual(PLAN); // the rows taken out
  });

  test('the Plan never joins a request sent before a save’s answer or an invalidation; Home never one sent before an invalidation', async () => {
    const s = server();
    const store = make(s);
    void store.load(IDS);
    store.adopt({ plan: { age: 41 }, currency: 'USD' });
    void store.load(IDS); // Home joins
    expect(s.sent.length).toBe(1);
    void store.load(IDS, { force: true }); // the Plan doesn't
    expect(s.sent.length).toBe(2);
    store.invalidate();
    void store.load(IDS); // nor Home, after an invalidation
    expect(s.sent.length).toBe(3);
  });

  test('an older request answering after a newer one gives nothing: neither its plan nor its rows', async () => {
    const s = server();
    const store = make(s);
    void store.load(IDS);
    void store.load(IDS, { force: true });
    store.adopt({ plan: { age: 41 }, currency: 'USD' });
    void store.load(IDS, { force: true });
    expect(s.sent.length).toBe(2); // the second joined: nothing came between
    void store.load(['i1:k1']);
    s.sent[2].answer(ok([row('i1:k1', 9)]));
    await settle();
    s.sent[0].answer(ok([pending('i1:k1'), pending('i2:k3')]));
    s.sent[1].answer(ok([pending('i1:k1'), pending('i2:k3')]));
    await settle();
    expect(store.get().key).toBe('i1:k1');
    expect(store.get().rows['i1:k1']).toEqual(row('i1:k1', 9));
    expect(s.sent.length).toBe(3); // no sync for the older answers' pending rows
  });

  test('a load while rows sync joins the sync: no second sync for a plan already syncing', async () => {
    const s = server();
    const store = make(s);
    void store.load(IDS);
    s.sent[0].answer(ok([pending('i1:k1'), pending('i2:k3')]));
    await settle();
    expect(s.urls()).toEqual([DEFAULT_URL, SYNC_URL]);
    void store.load(IDS, { force: true });
    s.sent[2].answer(ok([pending('i1:k1'), pending('i2:k3')]));
    await settle();
    void store.load(IDS);
    await settle();
    expect(s.urls()).toEqual([DEFAULT_URL, SYNC_URL, DEFAULT_URL]); // no second sync
    s.sent[1].answer([200, { plans: IDS.map((id) => row(id, 7)) }]);
    await settle();
    expect(store.get().rows['i2:k3']).toEqual(row('i2:k3', 7));
  });
});

describe('a save', () => {
  test('its answer replaces everything but the rows, the currency’s fields together, and leaves freshness alone', async () => {
    let asked = 0;
    const answers: Answer[] = [[200, { plan: { age: 40 }, currency: null, currency_problem: 'stale', currency_was: 'EUR', plans: IDS.map((id) => row(id)) }]];
    const store = createPlanInputsStore({ fetch: (u) => (asked++, server(() => answers[0]).fetch(u)), now: () => clock });
    await store.load(IDS);
    store.adopt({ plan: { age: 41 }, currency: 'USD' });
    expect(store.get().plan).toEqual({ status: 200, body: { plan: { age: 41 }, currency: 'USD' } }); // no stale fields left
    expect(Object.keys(store.get().rows)).toEqual(IDS);
    await store.load(IDS);
    expect(asked).toBe(1); // still fresh
    clock += FRESH_MS;
    store.adopt({ plan: { age: 42 }, currency: 'USD' });
    await store.load(IDS);
    expect(asked).toBe(2); // still not fresh
  });

  test('an answer to a request sent before it gives only its rows', async () => {
    const s = server();
    const store = make(s);
    void store.load(IDS);
    store.adopt({ plan: { age: 41 }, currency: 'USD' });
    s.sent[0].answer(ok(IDS.map((id) => row(id, 5))));
    await settle();
    expect(store.get().plan?.body).toEqual({ plan: { age: 41 }, currency: 'USD' });
    expect(store.get().rows['i1:k1']).toEqual(row('i1:k1', 5));
  });

  test('a load waits for a save under way, and asks once it has ended', async () => {
    const s = server();
    const store = make(s);
    const end = store.beginSave();
    let done = false;
    void store.load(IDS, { force: true }).then(() => (done = true));
    await settle();
    expect(s.sent.length).toBe(0);
    end();
    end(); // twice is once
    await settle();
    expect(s.urls()).toEqual([DEFAULT_URL]);
    s.sent[0].answer(ok());
    await settle();
    expect(done).toBe(true);
  });
});

describe('the rows', () => {
  test('a row pending: one sync=1 for those plans; an older row is kept, and shown, while it refreshes', async () => {
    const s = server();
    const store = make(s);
    void store.load(IDS);
    s.sent[0].answer(ok());
    await settle();
    clock += FRESH_MS;
    void store.load(IDS);
    s.sent[1].answer(ok([row('i1:k1'), pending('i2:k3')]));
    await settle();
    expect(s.urls()[2]).toBe('/api/plan-inputs?sync=1&plan=i2%3Ak3');
    expect(store.get().rows['i2:k3']).toEqual({ ...row('i2:k3'), refreshing: true });
    const plans = [
      { item_id: 'i1', account_id: 'k1', name: 'A', institution: 'X' },
      { item_id: 'i2', account_id: 'k3', name: 'B', institution: 'Y' },
    ];
    expect(contributionsFrom(store.get(), plans)?.map((c) => c.amount)).toEqual([1_000, 1_000]);
    s.sent[2].answer([200, { plans: [row('i2:k3', 2_000)] }]);
    await settle();
    expect(contributionsFrom(store.get(), plans)?.map((c) => c.amount)).toEqual([1_000, 2_000]);
  });

  test('a sync that fails gives its plans "failed"; a default answer that failed still asks for the rows', async () => {
    for (const failure of [[500, { error: 'no' }], [404, { error: 'not here' }], 'throw'] as Answer[]) {
      const s = server();
      const store = make(s);
      void store.load(IDS);
      s.sent[0].answer(failure);
      await settle();
      expect(s.urls()).toEqual([DEFAULT_URL, SYNC_URL]);
      expect(store.get().rows['i1:k1']).toEqual(pending('i1:k1'));
      s.sent[1].answer(failure);
      await settle();
      expect(store.get().rows).toEqual({ 'i1:k1': { id: 'i1:k1', failed: true }, 'i2:k3': { id: 'i2:k3', failed: true } });
    }
  });

  test('a lasting failure costs one request and one sync each time a screen loads, never a loop', async () => {
    for (const failure of [[500, { error: 'no' }], [404, { error: 'not here' }]] as Answer[]) {
      let asked = 0;
      const store = createPlanInputsStore({ fetch: (u) => (asked++, server(() => failure).fetch(u)), now: () => clock });
      let changes = 0;
      store.subscribe(() => changes++);
      await store.load(IDS);
      await settle();
      expect(asked).toBe(2);
      await settle();
      expect(asked).toBe(2);
      await store.load(IDS);
      await settle();
      expect(asked).toBe(4);
      expect(changes).toBeLessThan(10);
    }
  });

  test('a 409 for a plan that can’t be read: its pending rows are synced, so the Plan’s error state keeps them', async () => {
    const s = server();
    const store = make(s);
    void store.load(IDS);
    s.sent[0].answer([409, { error: 'Your saved plan could not be read.', unreadable: true, plans: [row('i1:k1'), pending('i2:k3')] }]);
    await settle();
    expect(s.urls()[1]).toBe('/api/plan-inputs?sync=1&plan=i2%3Ak3');
  });

  test('another set of plans: a request of its own, and the copy for the old set gives no contributions for the new', async () => {
    const s = server(() => ok());
    const store = make(s);
    await store.load(IDS);
    const three = [...IDS, 'i3:k9'];
    const plans = three.map((id) => ({ item_id: id.split(':')[0], account_id: id.split(':')[1], name: id, institution: 'X' }));
    expect(contributionsFrom(store.get(), plans)).toBeNull();
    expect(contributionsFrom(store.get(), plans.slice(0, 2))).not.toBeNull();
  });
});

describe('invalidate()', () => {
  test('the copy goes stale and is still shown; every screen showing it asks once; an answer sent before it fills only its rows', async () => {
    const s = server();
    const store = make(s);
    void store.load(IDS);
    s.sent[0].answer(ok());
    await settle();
    const shown = store.get();
    void store.load(IDS, { force: true });
    store.invalidate();
    expect(store.get().plan).toBe(shown.plan);
    expect(store.get().asked).toBe(shown.asked + 1);
    s.sent[1].answer([200, { plan: { age: 99 }, currency: 'USD', plans: IDS.map((id) => row(id, 3)) }]);
    await settle();
    expect(store.get().plan).toBe(shown.plan); // older than the invalidation
    expect(store.get().rows['i1:k1']).toEqual(row('i1:k1', 3));
    void store.load(IDS);
    expect(s.sent.length).toBe(3); // not fresh: asked
  });
});

test('fetch is read when a request is sent, never kept from when the store was made', async () => {
  const real = globalThis.fetch;
  const store = createPlanInputsStore();
  const urls: string[] = [];
  globalThis.fetch = (async (u: string) => (urls.push(u), new Response(JSON.stringify({ ...PLAN, plans: [] }), { status: 200 }))) as typeof fetch;
  try {
    await store.load([]);
    expect(urls).toEqual(['/api/plan-inputs']);
  } finally {
    globalThis.fetch = real;
  }
});

describe('contributionsFrom: each plan’s row as its own request gave it', () => {
  const plans = [
    { item_id: 'i1', account_id: 'k1', name: 'Acme 401(k)', institution: 'Fidelity' },
    { item_id: 'i2', account_id: 'k3', name: 'Old 401(k)', institution: 'Vanguard' },
  ];
  const copy = (rows: Record<string, unknown>[], key = plans.map(planId).join(',')): PlanInputsCopy => ({
    key,
    plan: { status: 200, body: PLAN },
    rows: Object.fromEntries(rows.map((r) => [r.id as string, r as never])),
    asked: 0,
  });

  test('every field, in the order the plans are given (the order transfers are matched in)', () => {
    const got = contributionsFrom(copy([row('i2:k3', 800), { ...row('i1:k1', 750), contributions_12m_partial: true, contributions_12m_activity_from: '2026-03-01', note: 'Vanguard: showing saved activity' }]), plans);
    expect(got).toEqual([
      { account_id: 'k1', name: 'Acme 401(k)', institution: 'Fidelity', amount: 750, from: '2025-11-03', partial: true, rows: [{ date: '2026-10-01', amount: 750 }], activityFrom: '2026-03-01', note: 'Vanguard: showing saved activity' },
      { account_id: 'k3', name: 'Old 401(k)', institution: 'Vanguard', amount: 800, from: '2025-11-03', partial: false, rows: [{ date: '2026-10-01', amount: 800 }], activityFrom: null, note: null },
    ]);
  });

  test('what isn’t of its type is left out, as before: a malformed row, a partial that isn’t strictly true, a figure that isn’t a number', () => {
    const odd = {
      id: 'i1:k1',
      contributions_12m: '750',
      contributions_12m_from: 20251103,
      contributions_12m_partial: 'true',
      contributions_12m_rows: [{ date: '2026-10-01', amount: 5 }, { date: '2026-10-02', amount: Infinity }, { date: 3, amount: 1 }, null, { date: '2026-10-03' }],
      contributions_12m_activity_from: 7,
      note: { text: 'no' },
    };
    expect(contributionsFrom(copy([odd, row('i2:k3')]), plans)?.[0]).toEqual({
      account_id: 'k1',
      name: 'Acme 401(k)',
      institution: 'Fidelity',
      amount: null,
      from: null,
      partial: false,
      rows: [{ date: '2026-10-01', amount: 5 }],
      activityFrom: null,
      note: null,
    });
    expect(contributionsFrom(copy([{ ...row('i1:k1'), contributions_12m_rows: 'none' }, row('i2:k3')]), plans)?.[0].rows).toEqual([]);
  });

  test('a plan whose row failed measures nothing; one pending, or missing, or a copy for other plans: null, never "nothing"', () => {
    expect(contributionsFrom(copy([{ id: 'i1:k1', failed: true }, row('i2:k3')]), plans)?.[0]).toEqual({
      account_id: 'k1',
      name: 'Acme 401(k)',
      institution: 'Fidelity',
      amount: null,
      from: null,
      partial: false,
      rows: [],
      activityFrom: null,
      note: null,
    });
    expect(contributionsFrom(copy([pending('i1:k1'), row('i2:k3')]), plans)).toBeNull();
    expect(contributionsFrom(copy([row('i2:k3')]), plans)).toBeNull();
    expect(contributionsFrom(copy([row('i1:k1'), row('i2:k3')], 'i1:k1'), plans)).toBeNull();
    expect(contributionsFrom(copy([], ''), [])).toEqual([]);
    expect(contributionsFrom({ key: null, plan: null, rows: {}, asked: 0 }, [])).toBeNull();
  });
});
