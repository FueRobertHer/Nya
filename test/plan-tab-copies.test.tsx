import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { installDom, trackRoots, click, type, holdPress, fakeClock, FakeElement } from './mini-dom';
import { simulateOnPage } from './plan-on-page';

// The Plan tab with copies (the tax plan's C2), rendered and used as a
// person would (react-dom/client over test/mini-dom.ts), with every plan
// route real on test/fake-redis.ts, so what is checked is what the server
// stored: the Timeline's Try it making a copy of your plan and opening it; the
// forms with a copy open saving to it and never to your plan, and a form
// opened on one plan never saving to another; Also change it in, all or
// none; Make this your plan moving Home; a save refused as stale, read again
// and said; your plan renamed, then saved; the copy's tag on its cards and
// sheets; a copy whose values don't fit your plan now, and Save it this way;
// a life event's preview and notes in a copy; and Delete, through the level
// that asks. Routes that aren't the plans' are answered here, by path;
// nothing reaches a network.
//
// A rendered element never goes into toEqual or another matcher that diffs:
// Bun's diff walks it, and the React fibers on it, whole (a million lines,
// and once more memory than the machine had). Elements are counted, or
// outlined first; toBe and toBeNull print an element's outline.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('Plaid must not be called');
      },
    }
  ),
}));
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
// React's client reads what the document supports once, when it loads: it is
// loaded afresh, after this file put a document there.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: PlanTab } = await import('@/components/PlanTab');
const { default: FiProgressCard } = await import('@/components/FiProgressCard');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { planOf } = await import('@/lib/fire/plan-v2');
const { factsOf } = await import('@/lib/fire/copies');
const { asEvent, incomeOf, itemFromIncome } = await import('@/lib/fire/items');
const { EVENT_PART_TEXT } = await import('@/components/plan-scenario-text');
const { CHANGED } = await import('@/lib/plan-writes');
const { typedAmounts } = await import('@/lib/fire/plan-currency');
const { createPlanInputsStore } = await import('@/lib/plan-inputs-store');
const firePlan = await import('@/app/api/fire-plan/route');
const plansRoute = await import('@/app/api/plans/route');
const planInputs = await import('@/app/api/plan-inputs/route');
type FirePlanV2 = import('@/lib/fire/plan-v2').FirePlanV2;
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type PlanInputsStore = import('@/lib/plan-inputs-store').PlanInputsStore;

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

/** Your plan: every figure typed, in USD. */
const PLAN: FirePlanV2 = planOf({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, savings: 30_000, assets: 300_000 });
const SOCIAL = itemFromIncome({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true });
const eventsOf = (plan: FirePlanV2) => plan.items.flatMap((x) => asEvent(x) ?? []);

// The routes as the app runs them: the plans' real, the rest answered here.
type Call = { method: string; path: string; body: any };
let calls: Call[] = [];
/** Requests a route is still answering. */
let inflight = 0;
/** Run before a request reaches its route: another device's change, say. */
let before: ((call: Call) => Promise<void>) | null = null;
const req = (path: string, method: string, body?: unknown) =>
  new Request(`http://nya.test${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
const ROUTES: Record<string, (r: Request) => Promise<Response>> = {
  'GET /api/plan-inputs': (r) => planInputs.GET(r),
  'GET /api/fire-plan': () => firePlan.GET(),
  'PUT /api/fire-plan': (r) => firePlan.PUT(r),
  'POST /api/fire-plan': (r) => firePlan.POST(r),
  'GET /api/plans': () => plansRoute.GET(),
  'POST /api/plans': (r) => plansRoute.POST(r),
  'PUT /api/plans': (r) => plansRoute.PUT(r),
  'PATCH /api/plans': (r) => plansRoute.PATCH(r),
  'DELETE /api/plans': (r) => plansRoute.DELETE(r),
};
const STUBS: Record<string, unknown> = {
  'GET /api/allocation-settings': { settings: null },
  'GET /api/saved-plan': { saved: null, problem: null },
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://nya.test');
  const method = init?.method ?? 'GET';
  const call: Call = { method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null };
  calls.push(call);
  const key = `${method} ${url.pathname}`;
  inflight++;
  try {
    if (before) await before(call);
    const route = ROUTES[key];
    if (!route) return Response.json(STUBS[key] ?? { error: 'not here' }, { status: key in STUBS ? 200 : 404 });
    return await route(new Request(url, { method, body: init?.body }));
  } finally {
    inflight--;
  }
}) as typeof fetch;
beforeEach(() => {
  calls = [];
  before = null;
});

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
/** Your plan saved first, as a page saves it, in USD: its stamp. */
async function seedPlan(plan: FirePlanV2 = PLAN): Promise<string> {
  const r = await json(await firePlan.PUT(req('/api/fire-plan', 'PUT', { plan, currency: 'USD', facts_were: factsOf(DEFAULT_PLAN), based_on: null })));
  expect(r.status).toBe(200);
  return r.body.updated_at;
}
/** A copy of your plan (`base`) with `over` in it, as New copy makes one,
 *  a second after the last (the copies are listed in the order they were
 *  made, and the fake clock stands still): its id. */
async function seedCopy(name: string, over: Partial<FirePlanV2> = {}, base: FirePlanV2 = PLAN): Promise<string> {
  await pass(1000);
  const r = await json(await plansRoute.POST(req('/api/plans', 'POST', { from: 'main', name, plan: { ...base, ...over }, currency: 'USD' })));
  expect([name, r.status]).toEqual([name, 200]);
  return r.body.plan.id;
}
type Row = { id: string; name: string; plan: FirePlanV2; currency: string | null; updated_at: string | null };
/** What is stored: whose plan is yours, and every plan by name. */
async function stored(): Promise<{ main: string; byName: Record<string, Row> }> {
  const { body } = await json(await plansRoute.GET());
  return { main: body.main, byName: Object.fromEntries((body.plans as Row[]).map((p) => [p.name, p])) };
}

const pass = fakeClock();
simulateOnPage();
/** Lets `ms` pass on the fake clock, then more until no route has been
 *  answering for three steps, and what the answers start. A route seals what
 *  it reads and writes on a real thread (crypto.subtle, lib/crypto.ts), so
 *  however busy the machine, this waits for it, with no limit on the steps,
 *  and the clock only creeps meanwhile (for a retry's backoff, lib/repo.ts).
 *  An answer can start another request (a write refused reads the list
 *  again), so one look finding none answering may fall between the two. */
async function settle(ms = 30) {
  await pass(ms);
  for (let quiet = 0; ; ) {
    if (inflight > 0) quiet = 0;
    else if (++quiet > 3) return;
    await pass(quiet > 0 ? 10 : 1);
  }
}
const classOf = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');
const inDialog = (e: FakeElement) => {
  for (let n = e.parentNode; n; n = n.parentNode) if (n instanceof FakeElement && n.getAttribute('role') === 'dialog') return true;
  return false;
};

/** The Plan tab, and Home's FI line beside it on the same copy of the
 *  plan's inputs (as the dashboard has them), with what a test looks for. */
async function render(props: Partial<PlanTabProps> = {}, store: PlanInputsStore = createPlanInputsStore()) {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const home = dom.document.createElement('ul');
  container.appendChild(home);
  const homeRoot = createRoot(home as unknown as Element);
  const all: PlanTabProps = { txns: [], txnsLoading: false, txnNotes: [], institutions: [], balancesAsOf: null, currency: 'USD', holdings: [], planInputs: store, ...props };
  await act(async () => homeRoot.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={[]} currency="USD" onOpenPlan={() => {}} planInputs={store} />));
  await act(async () => root.render(<PlanTab {...all} />));
  await settle(100);
  const find = (pred: (e: FakeElement) => boolean) => container.findAll(pred)[0] ?? null;
  const titleOf = (e: FakeElement) => e.findAll((t) => classOf(t).includes('list-row-title'))[0]?.textContent ?? null;
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      await act(async () => homeRoot.unmount());
    },
    text: () => container.textContent,
    home: () => home.textContent,
    /** One of Your figures' rows on Your path, by its title. */
    row: (title: string) => find((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && titleOf(e) === title && !inDialog(e)),
    byLabel: (label: string) => find((e) => e.getAttribute('aria-label') === label),
    /** The open drawer: one closing slides out for a third of a second, and
     *  is still on the page meanwhile. */
    dialog: () => find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true'),
    bar: () => find((e) => e.getAttribute('class') === 'plan-bar'),
    title: () => find((e) => e.tagName === 'H2' && classOf(e).includes('plan-title'))?.textContent ?? null,
    /** The pinned bar's arrow back to your plan. */
    arrow: () => find((e) => e.getAttribute('class') === 'plan-bar')?.findAll((e) => e.getAttribute('aria-label') === 'Back to your plan')[0] ?? null,
    /** "Plans (N)": the bar's on your plan, the open copy's card's in one. */
    plans: () => find((e) => e.tagName === 'BUTTON' && /^Plans(?: \(\d+\))?$/.test(e.textContent.trim())),
    /** The open copy's card under the bar. */
    card: () => find((e) => classOf(e).includes('plan-copy-card')),
    /** A row of the Plans sheet open now, by its title. */
    sheetRow: (title: string) => {
      const d = find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true');
      return d?.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && titleOf(e) === title)[0] ?? null;
    },
    said: () => container.findAll((e) => e.getAttribute('role') === 'status').map((e) => e.textContent),
  };
}
type Tab = Awaited<ReturnType<typeof render>>;

const press = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => click(el));
  await settle(100);
};
/** A button in an element, by its words. */
const button = (within: FakeElement | null, words: string) => within?.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
/** A field in an element, by the words its label starts with. */
const field = (within: FakeElement, words: string) =>
  within.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(words))[0]?.findAll((e) => e.tagName === 'INPUT' || e.tagName === 'SELECT')[0] ?? null;
const fill = async (within: FakeElement, words: string, value: string) => {
  const el = field(within, words);
  if (!el) throw new Error(`no field ${words}`);
  await act(async () => type(el, value));
  await settle();
};
/** Also change it in's rows in a sheet: each plan's name and its value there. */
const alsoRows = (sheet: FakeElement) =>
  sheet.findAll((e) => e.tagName === 'LABEL' && classOf(e).includes('check-row')).map((r) => [r.findAll((e) => classOf(e).includes('check-row-title'))[0]?.textContent ?? '', r.findAll((e) => classOf(e).includes('check-row-sub'))[0]?.textContent ?? '']);
/** Checks one of them, by its plan's name. */
const checkAlso = async (sheet: FakeElement, name: string) => {
  const row = sheet.findAll((e) => e.tagName === 'LABEL' && classOf(e).includes('check-row') && e.findAll((t) => classOf(t).includes('check-row-title'))[0]?.textContent === name)[0];
  const box = row?.findAll((e) => e.tagName === 'INPUT')[0];
  if (!box) throw new Error(`no plan ${name} to check`);
  await act(async () => {
    box.checked = true;
    click(box);
  });
  await settle();
};

/** Opens a copy as a person does: the Plans sheet, its row, then Open it. */
async function openCopy(tab: Tab, name: string) {
  await press(tab.plans());
  await press(tab.sheetRow(name));
  await press(button(tab.dialog(), 'Open it'));
  await settle(400);
}
/** The plans' writes and your plan's, in order. */
const writes = () => calls.filter((c) => c.method !== 'GET' && (c.path === '/api/plans' || c.path === '/api/fire-plan')).map((c) => `${c.method} ${c.path}`);

describe('the Timeline’s Try it in a copy', () => {
  test('makes a copy of your plan with the item, named after it, and opens it; your plan stays as it was', async () => {
    const stamp = await seedPlan();
    const tab = await render();
    expect(tab.title()).toBe('Your plan');
    await press(button(tab.container, 'Add'));
    await press(tab.sheetRow('A career break'));
    const sheet = tab.dialog()!;
    await fill(sheet, 'Starts at age', '45');
    await fill(sheet, 'Saved less a year', '30000');
    await press(tab.sheetRow('Ends'));
    await fill(tab.dialog()!, 'For how many years', '2');
    await press(button(tab.dialog(), 'Done'));
    await press(button(tab.dialog(), 'Try it in a copy'));
    await settle(400);
    expect(writes()).toEqual(['POST /api/plans']);
    expect(tab.title()).toBe('Copy: A career break at 45');
    // Focus on the bar's heading, as a copy opened from the Plans sheet.
    expect((dom.document.activeElement as FakeElement).textContent).toBe('Copy: A career break at 45');
    const { main, byName } = await stored();
    expect(main).toBe('main');
    expect(Object.keys(byName)).toEqual(['First plan', 'A career break at 45']);
    const copy = byName['A career break at 45'].plan;
    expect(eventsOf(copy).map(({ id: _, ...e }) => e)).toEqual([{ kind: 'sabbatical', label: 'A career break', fromAge: 45, years: 2, savingsLost: 30_000 }]);
    // Everything else is your plan's.
    expect({ ...copy, items: [] }).toEqual({ ...PLAN, items: [] });
    expect(byName['First plan'].plan).toEqual(PLAN);
    expect(byName['First plan'].updated_at).toBe(stamp);
    await tab.unmount();
  });
});

describe('New copy, from the Plans sheet', () => {
  test('makes a copy of your plan as it is; the sheet closes and the copy opens, with focus on its heading', async () => {
    const stamp = await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await press(tab.plans());
    await press(button(tab.dialog(), 'New copy'));
    const level = tab.dialog()!;
    expect(level.getAttribute('aria-label')).toBe('New copy');
    await fill(level, 'Name', 'Sabbatical');
    await press(button(level, 'Make it'));
    await settle(400);
    expect(writes()).toEqual(['POST /api/plans']);
    expect(tab.dialog()).toBeNull();
    expect(tab.title()).toBe('Copy: Sabbatical');
    expect((dom.document.activeElement as FakeElement).textContent).toBe('Copy: Sabbatical');
    const { byName } = await stored();
    expect(Object.keys(byName)).toEqual(['First plan', 'Retire at 50', 'Sabbatical']);
    expect(byName.Sabbatical.plan).toEqual(byName['First plan'].plan);
    expect(byName['First plan'].updated_at).toBe(stamp);
    await tab.unmount();
  });
});

describe('a form saves only to the plan it was opened for', () => {
  test('with a copy open its forms save the copy, and never your plan', async () => {
    const stamp = await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await openCopy(tab, 'Retire at 50');
    expect(tab.title()).toBe('Copy: Retire at 50');
    await press(tab.row('Household'));
    const sheet = tab.dialog()!;
    expect(sheet.textContent).toContain('Saved to this copy, not your plan.');
    expect(sheet.textContent).toContain('Both ages are the same in every plan: change it on your plan.');
    const [age, stop] = sheet.findAll((e) => e.tagName === 'INPUT');
    expect(age.disabled).toBe(true);
    await act(async () => type(stop, '48'));
    await press(button(sheet, 'Save'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/plans']);
    expect(tab.dialog()).toBeNull();
    const { byName } = await stored();
    expect(byName['Retire at 50'].plan.targetAge).toBe(48);
    expect(byName['First plan'].plan).toEqual(PLAN);
    expect(byName['First plan'].updated_at).toBe(stamp);
    expect(tab.title()).toBe('Copy: Retire at 50');
    await tab.unmount();
  });

  test('with your plan open its forms save your plan, and never a copy', async () => {
    await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await press(tab.row('Household'));
    const sheet = tab.dialog()!;
    expect(sheet.getAttribute('aria-label')).toBe('Household');
    expect(sheet.textContent).not.toContain('Saved to this copy');
    const [, stop] = sheet.findAll((e) => e.tagName === 'INPUT');
    await act(async () => type(stop, '58'));
    await press(button(sheet, 'Save'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/fire-plan']);
    const { byName } = await stored();
    expect(byName['First plan'].plan.targetAge).toBe(58);
    expect(byName['Retire at 50'].plan.targetAge).toBe(50);
    await tab.unmount();
  });

  // The drawer's forms save through the savers of the plan they were opened
  // for (components/PlanTab.tsx saveFor): once another plan is shown the
  // drawer closes, and its Save, pressed as it slides out, saves nothing.
  test('a form opened on a copy saves nothing once your plan is shown, even pressed as it slides out', async () => {
    await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await openCopy(tab, 'Retire at 50');
    await press(tab.row('Household'));
    const sheet = tab.dialog()!;
    const [, stop] = sheet.findAll((e) => e.tagName === 'INPUT');
    await act(async () => type(stop, '48'));
    const late = holdPress(button(sheet, 'Save')!);
    // Back to your plan by the bar's arrow, behind the open drawer.
    await press(tab.arrow());
    expect(tab.title()).toBe('Your plan');
    let answer: unknown;
    await act(async () => void (answer = await late()));
    await settle(400);
    expect(tab.dialog()).toBeNull();
    expect(answer).toBeUndefined();
    expect(sheet.textContent).toContain('This form was opened for another plan than the one shown now, so nothing was saved.');
    expect(writes()).toEqual([]);
    const { byName } = await stored();
    expect([byName['First plan'].plan.targetAge, byName['Retire at 50'].plan.targetAge]).toEqual([55, 50]);
    await tab.unmount();
  });
});

describe('Also change it in', () => {
  test('a figure’s sheet offers every other plan with the figure there, none checked; one checked takes the same change, and the rest of it stays its own', async () => {
    await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    await seedCopy('Spend more', { spending: 55_000 });
    const tab = await render();
    await press(tab.row('Annual spending'));
    const sheet = tab.dialog()!;
    expect(alsoRows(sheet)).toEqual([
      ['Retire at 50', '$40,000 a year'],
      ['Spend more', '$55,000 a year'],
    ]);
    expect(sheet.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'checkbox').map((b) => b.checked)).toEqual([false, false]);
    await fill(sheet, 'Spending a year', '45000');
    await checkAlso(sheet, 'Retire at 50');
    const sent = calls.length;
    await press(button(sheet, 'Save'));
    await settle(400);
    // One write, all together; then your plan is read again, so Home and
    // its store have it.
    expect(writes()).toEqual(['PUT /api/plans']);
    expect(calls.slice(sent).map((c) => `${c.method} ${c.path}`)).toContain('GET /api/plan-inputs');
    expect(tab.dialog()).toBeNull();
    const { byName } = await stored();
    expect([byName['First plan'].plan.spending, byName['First plan'].plan.targetAge]).toEqual([45_000, 55]);
    expect([byName['Retire at 50'].plan.spending, byName['Retire at 50'].plan.targetAge]).toEqual([45_000, 50]);
    expect(byName['Spend more'].plan.spending).toBe(55_000);
    await tab.unmount();
  });

  test('all or none: a plan checked that changed on another device stops the save, and every plan stays as it was', async () => {
    const stamp = await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const other = await seedCopy('Spend more', { spending: 55_000 });
    const tab = await render();
    await press(tab.row('Annual spending'));
    const sheet = tab.dialog()!;
    await fill(sheet, 'Spending a year', '45000');
    await checkAlso(sheet, 'Retire at 50');
    await checkAlso(sheet, 'Spend more');
    // Saved on another device as this one's save is on its way.
    before = async (call) => {
      if (call.method !== 'PUT' || call.path !== '/api/plans') return;
      before = null;
      const there = (await stored()).byName['Spend more'];
      const r = await json(await plansRoute.PUT(req('/api/plans', 'PUT', { saves: [{ id: other, plan: { ...there.plan, savings: 20_000 }, currency: 'USD', based_on: there.updated_at }], facts_were: factsOf(PLAN) })));
      expect(r.status).toBe(200);
    };
    await press(button(sheet, 'Save'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/plans']);
    // Said in the sheet, which stays open with what was typed.
    expect(tab.dialog()).toBe(sheet);
    expect(sheet.textContent).toContain('Changed on another device, so nothing was saved: save again to make your change in what is there now.');
    const { byName } = await stored();
    expect([byName['First plan'].plan.spending, byName['First plan'].updated_at]).toEqual([40_000, stamp]);
    expect(byName['Retire at 50'].plan.spending).toBe(40_000);
    expect([byName['Spend more'].plan.spending, byName['Spend more'].plan.savings]).toEqual([55_000, 20_000]);
    await tab.unmount();
  });

  test('with a copy open, an income’s sheet offers your plan when it holds the same income, and both take the change', async () => {
    const mine: FirePlanV2 = { ...PLAN, items: [SOCIAL] };
    await seedPlan(mine);
    await seedCopy('Retire at 50', { targetAge: 50 }, mine);
    const tab = await render();
    await openCopy(tab, 'Retire at 50');
    await press(tab.row('Social Security'));
    const sheet = tab.dialog()!;
    expect(sheet.textContent).toContain('Saved to this copy, not your plan.');
    const offered = alsoRows(sheet);
    expect(offered.map(([name]) => name)).toEqual(['First plan (your plan)']);
    expect(offered[0][1]).toContain('$24,000');
    await fill(sheet, 'A year', '30000');
    await checkAlso(sheet, 'First plan (your plan)');
    await press(button(sheet, 'Save'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/plans']);
    const { byName } = await stored();
    for (const name of ['First plan', 'Retire at 50']) expect([name, incomeOf(byName[name].plan)]).toEqual([name, [{ id: 'ss', label: 'Social Security', amount: 30_000, fromAge: 67, inflationAdjusted: true }]]);
    expect(byName['First plan'].plan.targetAge).toBe(55);
    // The copy is still the one shown.
    expect(tab.title()).toBe('Copy: Retire at 50');
    await tab.unmount();
  });

  // A copy takes your plan's currency as it is made; your plan's said to be
  // in another since, a copy made before keeps the one its amounts were
  // typed in.
  test('a plan whose amounts are in another currency is never offered; one that holds none is', async () => {
    await seedPlan();
    await seedCopy('In dollars', { targetAge: 50 });
    await seedCopy('Nothing typed', { spending: null, savings: null, assets: null });
    const r = await json(await firePlan.POST(req('/api/fire-plan', 'POST', { currency: 'EUR', amounts: typedAmounts(PLAN), answered: true })));
    expect(r.status).toBe(200);
    const tab = await render();
    await press(tab.row('Annual spending'));
    expect(alsoRows(tab.dialog()!)).toEqual([['Nothing typed', 'Nya’s figure']]);
    await tab.unmount();
  });
});

describe('a save refused for what is stored now', () => {
  test('a copy changed on another device: the list is read again, the drawer closes on the new version, the card says why, and a second Save can’t undo it', async () => {
    await seedPlan();
    const id = await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await openCopy(tab, 'Retire at 50');
    await press(tab.row('Assumptions'));
    const sheet = tab.dialog()!;
    await fill(sheet, 'Withdrawal rate', '4.5');
    const save = button(sheet, 'Save')!;
    const late = holdPress(save);
    before = async (call) => {
      if (call.method !== 'PUT' || call.path !== '/api/plans') return;
      before = null;
      const there = (await stored()).byName['Retire at 50'];
      const r = await json(await plansRoute.PUT(req('/api/plans', 'PUT', { saves: [{ id, plan: { ...there.plan, withdrawalRate: 0.035 }, currency: 'USD', based_on: there.updated_at }], facts_were: factsOf(PLAN) })));
      expect(r.status).toBe(200);
    };
    await press(save);
    await settle(400);
    expect(writes()).toEqual(['PUT /api/plans']);
    expect(tab.dialog()).toBeNull();
    expect(tab.card()?.textContent).toContain('Changed on another device, so nothing of your change was kept: make it again if it still applies.');
    expect(tab.card()?.textContent).not.toContain(CHANGED);
    // The newer version is what is shown.
    expect(tab.row('Assumptions')?.textContent).toContain('3.5%');
    // Pressed again as it slides out: refused, the form being for the
    // version before.
    await act(async () => void (await late()));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/plans']);
    expect((await stored()).byName['Retire at 50'].plan.withdrawalRate).toBe(0.035);
    // Said once, and not again once the copy is left and opened again.
    await press(tab.arrow());
    await openCopy(tab, 'Retire at 50');
    expect(tab.card()?.textContent).not.toContain('Nothing of your change was kept');
    await tab.unmount();
  });

  test('your plan changed on another device: the save is refused, your plan read again, and said', async () => {
    const stamp = await seedPlan();
    const tab = await render();
    before = async (call) => {
      if (call.method !== 'PUT' || call.path !== '/api/fire-plan') return;
      before = null;
      const r = await json(await firePlan.PUT(req('/api/fire-plan', 'PUT', { plan: { ...PLAN, savings: 20_000 }, currency: 'USD', facts_were: factsOf(PLAN), based_on: stamp })));
      expect(r.status).toBe(200);
    };
    await press(tab.row('Household'));
    const sheet = tab.dialog()!;
    const [, stop] = sheet.findAll((e) => e.tagName === 'INPUT');
    await act(async () => type(stop, '58'));
    const sent = calls.length;
    await press(button(sheet, 'Save'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/fire-plan']);
    expect(calls.slice(sent).map((c) => `${c.method} ${c.path}`)).toContain('GET /api/plan-inputs');
    expect(tab.text()).toContain(CHANGED);
    const { byName } = await stored();
    expect([byName['First plan'].plan.targetAge, byName['First plan'].plan.savings]).toEqual([55, 20_000]);
    await tab.unmount();
  });
});

describe('your plan read again after a write', () => {
  /** Holds your plan's next read until `release()`, as a slow network. */
  const holdRead = () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    before = async (call) => {
      if (call.method !== 'GET' || call.path !== '/api/plan-inputs') return;
      before = null;
      // Held on purpose: nothing for settle to wait for until it is let go.
      inflight--;
      await held;
      inflight++;
    };
    return async () => {
      release();
      await settle(200);
    };
  };

  test('an Also save with your plan checked that fails keeps the copy open, and its sheet open with why', async () => {
    await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await openCopy(tab, 'Retire at 50');
    await press(tab.row('Annual spending'));
    const sheet = tab.dialog()!;
    await fill(sheet, 'Spending a year', '45000');
    await checkAlso(sheet, 'First plan (your plan)');
    before = async (call) => {
      if (call.method !== 'PUT' || call.path !== '/api/plans') return;
      before = null;
      throw new Error('offline');
    };
    await press(button(sheet, 'Save'));
    await settle(400);
    expect(tab.dialog()).toBe(sheet);
    expect(sheet.textContent).toContain('It wasn’t saved: check your connection, and try again.');
    expect(tab.title()).toBe('Copy: Retire at 50');
    const { byName } = await stored();
    expect([byName['First plan'].plan.spending, byName['Retire at 50'].plan.spending]).toEqual([40_000, 40_000]);
    await tab.unmount();
  });

  test('a rename of your plan refused keeps the name typed, with why', async () => {
    const stamp = await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await press(tab.plans());
    await press(tab.sheetRow('First plan'));
    await press(tab.sheetRow('Rename'));
    const level = tab.dialog()!;
    await fill(level, 'Name', 'Base plan');
    // Your plan saved on another device just before.
    before = async (call) => {
      if (call.method !== 'PATCH' || call.path !== '/api/plans') return;
      before = null;
      const r = await json(await firePlan.PUT(req('/api/fire-plan', 'PUT', { plan: { ...PLAN, savings: 20_000 }, currency: 'USD', facts_were: factsOf(PLAN), based_on: stamp })));
      expect(r.status).toBe(200);
    };
    await press(button(level, 'Save'));
    await settle(400);
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Rename');
    expect(tab.dialog()!.textContent).toContain(CHANGED);
    expect(field(tab.dialog()!, 'Name')!.value).toBe('Base plan');
    expect(Object.keys((await stored()).byName)).toEqual(['First plan', 'Retire at 50']);
    await tab.unmount();
  });

  test('a rename of your plan with a copy open: the copy stays open, and said once, while your plan is read again', async () => {
    await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await openCopy(tab, 'Retire at 50');
    const said = tab.said().join(' ');
    await press(tab.plans());
    await press(tab.sheetRow('First plan'));
    await press(tab.sheetRow('Rename'));
    await fill(tab.dialog()!, 'Name', 'Base plan');
    const release = holdRead();
    await press(button(tab.dialog(), 'Save'));
    await settle(200);
    expect(tab.title()).toBe('Copy: Retire at 50');
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Base plan');
    expect(tab.sheetRow('Open it')).not.toBeNull();
    await release();
    expect(tab.title()).toBe('Copy: Retire at 50');
    expect(tab.said().join(' ')).toBe(said);
    expect(Object.keys((await stored()).byName)).toEqual(['Base plan', 'Retire at 50']);
    await tab.unmount();
  });

  test('Make this your plan from the sheet: once your plan is read again, focus is on the plan made yours', async () => {
    await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await press(tab.plans());
    await press(tab.sheetRow('Retire at 50'));
    const release = holdRead();
    await press(tab.sheetRow('Make this your plan'));
    await release();
    expect(dom.document.activeElement).toBe(tab.sheetRow('Retire at 50')!);
    await tab.unmount();
  });

  test('Duplicate of your plan while it is read again after an Also save: nothing is made from what it held before, and once read the copy has the change', async () => {
    await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await openCopy(tab, 'Retire at 50');
    await press(tab.row('Annual spending'));
    const sheet = tab.dialog()!;
    await fill(sheet, 'Spending a year', '45000');
    await checkAlso(sheet, 'First plan (your plan)');
    const release = holdRead();
    await press(button(sheet, 'Save'));
    await settle(400);
    await press(tab.plans());
    await press(tab.sheetRow('First plan'));
    await press(tab.sheetRow('Duplicate'));
    const level = tab.dialog()!;
    expect(level.getAttribute('aria-label')).toBe('Duplicate');
    await press(button(level, 'Make it'));
    await settle(200);
    expect(level.textContent).toContain('Still loading your plan after the last change. Try again in a moment.');
    expect(Object.keys((await stored()).byName)).toEqual(['First plan', 'Retire at 50']);
    await release();
    await press(button(tab.dialog(), 'Make it'));
    await settle(400);
    const { byName } = await stored();
    expect(Object.keys(byName)).toEqual(['First plan', 'Retire at 50', 'First plan (copy)']);
    expect(byName['First plan (copy)'].plan.spending).toBe(45_000);
    await tab.unmount();
  });
});

describe('Make this your plan', () => {
  test('from the copy’s card: it is your plan at once on Home too, the copy closes, and it is said', async () => {
    await seedPlan();
    const id = await seedCopy('Spend less', { spending: 30_000 });
    const tab = await render();
    const home = tab.home();
    expect(home).toContain('FI');
    await openCopy(tab, 'Spend less');
    await press(button(tab.card(), 'Make this your plan'));
    await settle(400);
    expect(writes()).toEqual(['PATCH /api/plans']);
    expect(tab.title()).toBe('Your plan');
    expect(tab.card()).toBeNull();
    expect(tab.said()).toContain('“Spend less” is your plan now.');
    // Focus on the bar's Plans, where the copy was left from.
    expect((dom.document.activeElement as FakeElement).textContent).toBe('Plans (2)');
    // Your figures are its now, and so is Home's line: as a page opened now
    // shows it, on a copy of the inputs of its own.
    expect(tab.row('Annual spending')?.textContent).toContain('$30,000');
    const { main, byName } = await stored();
    expect(main).toBe(id);
    expect(byName['First plan'].plan).toEqual(PLAN);
    expect(tab.home()).not.toBe(home);
    const fresh = await render();
    expect(tab.home()).toBe(fresh.home());
    await fresh.unmount();
    await tab.unmount();
  });

  test('from the Plans sheet: your plan’s level offers no Make this your plan, and can’t be deleted', async () => {
    await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await press(tab.plans());
    await press(tab.sheetRow('First plan'));
    const level = tab.dialog()!;
    expect(level.getAttribute('aria-label')).toBe('First plan');
    expect(tab.sheetRow('Make this your plan')).toBeNull();
    expect(tab.sheetRow('Delete')).toBeNull();
    expect(level.textContent).toContain('Your plan can’t be deleted: make another your plan first.');
    await press(level.findAll((e) => e.getAttribute('aria-label') === 'Back')[0]);
    await press(tab.sheetRow('Retire at 50'));
    await press(tab.sheetRow('Make this your plan'));
    await settle(400);
    expect(writes()).toEqual(['PATCH /api/plans']);
    // Back on the sheet's list, which leads with the plan that is yours now.
    const rows = tab.dialog()!.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row'));
    expect(rows.map((r) => [r.findAll((t) => classOf(t).includes('list-row-title'))[0]?.textContent ?? '', r.findAll((t) => classOf(t).includes('badge'))[0]?.textContent ?? ''])).toEqual([
      ['Retire at 50', 'Your plan'],
      ['First plan', ''],
    ]);
    expect(tab.row('Household')?.textContent).toContain('stop at 50');
    await tab.unmount();
  });
});

describe('your plan renamed', () => {
  test('then saved: its version moved with its name, and the save names the new one', async () => {
    await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await press(tab.plans());
    await press(tab.sheetRow('First plan'));
    await press(tab.sheetRow('Rename'));
    await fill(tab.dialog()!, 'Name', 'Base plan');
    await press(button(tab.dialog(), 'Save'));
    await settle(400);
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Base plan');
    await press(tab.dialog()!.findAll((e) => e.getAttribute('aria-label') === 'Close')[0]);
    await settle(400);
    await press(tab.row('Household'));
    const sheet = tab.dialog()!;
    const [, stop] = sheet.findAll((e) => e.tagName === 'INPUT');
    await act(async () => type(stop, '58'));
    await press(button(sheet, 'Save'));
    await settle(400);
    expect(writes()).toEqual(['PATCH /api/plans', 'PUT /api/fire-plan']);
    expect(tab.dialog()).toBeNull();
    const { byName } = await stored();
    expect(byName['Base plan'].plan.targetAge).toBe(58);
    expect(byName['First plan']).toBeUndefined();
    await tab.unmount();
  });
});

describe('the copy’s tag', () => {
  test('atop every card and editing sheet while a copy is open, and nowhere with your plan', async () => {
    const mine: FirePlanV2 = { ...PLAN, items: [SOCIAL] };
    await seedPlan(mine);
    await seedCopy('Retire at 50', { targetAge: 50 }, mine);
    const tab = await render();
    const tags = () => tab.container.findAll((e) => classOf(e).includes('plan-copy-tag'));
    expect(tags().length).toBe(0);
    await openCopy(tab, 'Retire at 50');
    const path = tab.container.findAll((e) => e.getAttribute('role') === 'tabpanel')[0];
    const onPath = path.findAll((e) => classOf(e).includes('plan-copy-tag'));
    // The FI card, Your figures and the Timeline, at least.
    expect(onPath.length).toBeGreaterThanOrEqual(3);
    expect(new Set(tags().map((t) => t.textContent))).toEqual(new Set(['Copy: Retire at 50']));
    await press(tab.row('Social Security'));
    expect(tab.dialog()!.findAll((e) => classOf(e).includes('plan-copy-tag')).map((t) => t.textContent)).toEqual(['Copy: Retire at 50']);
    await press(button(tab.dialog(), 'Cancel'));
    await settle(400);
    await press(tab.arrow());
    expect(tags().length).toBe(0);
    await tab.unmount();
  });
});

describe('a copy whose values don’t fit your plan now', () => {
  test('says so on its card, pauses its forms, and Save it this way saves it as shown', async () => {
    const stamp = await seedPlan();
    await seedCopy('Stop at 45', { targetAge: 45 });
    // Your age moved past its stop age since.
    const r = await json(await firePlan.PUT(req('/api/fire-plan', 'PUT', { plan: { ...PLAN, age: 47 }, currency: 'USD', facts_were: factsOf(PLAN), based_on: stamp })));
    expect(r.status).toBe(200);
    const tab = await render();
    await openCopy(tab, 'Stop at 45');
    const card = tab.card()!;
    expect(card.textContent).toContain('This copy has a value that doesn’t fit your plan as it is now: your stop age. It shows the defaults instead');
    expect(card.textContent).toContain('nothing is saved to it until you choose Save it this way.');
    await press(tab.row('Household'));
    expect(button(tab.dialog(), 'Save')?.disabled).toBe(true);
    await press(button(tab.dialog(), 'Cancel'));
    await settle(400);
    expect(writes()).toEqual([]);
    await press(button(tab.card(), 'Save it this way'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/plans']);
    expect(tab.card()?.textContent).not.toContain('fit your plan as it is now');
    const { byName } = await stored();
    expect(byName['Stop at 45'].plan.targetAge).toBe(DEFAULT_PLAN.targetAge);
    expect(byName['Stop at 45'].plan.age).toBe(47);
    await tab.unmount();
  });
});

describe('the Timeline in a copy', () => {
  test('an item added is previewed against the copy as it is typed, saved to it, said, and its notes said on its row', async () => {
    await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await openCopy(tab, 'Retire at 50');
    await press(button(tab.container, 'Add'));
    expect(tab.dialog()!.textContent).toContain('Everything here goes in Copy: Retire at 50.');
    await press(tab.sheetRow('A career break'));
    const sheet = tab.dialog()!;
    // A copy of a copy is the Plans sheet's Duplicate.
    expect(button(sheet, 'Try it in a copy')).toBeNull();
    await fill(sheet, 'Starts at age', '45');
    await fill(sheet, 'Saved less a year', '30000');
    await press(tab.sheetRow('Ends'));
    await fill(tab.dialog()!, 'For how many years', '2');
    await press(button(tab.dialog(), 'Done'));
    await settle(300);
    expect(sheet.textContent).toMatch(/This copy’s FI dateFrom around \d+ to around \d+/);
    // Starting after the copy's stop age, it changes nothing, and says why.
    await fill(sheet, 'Starts at age', '52');
    await settle(300);
    expect(sheet.textContent).toMatch(/This copy’s FI dateStays around \d+/);
    await press(button(sheet, 'Add to this copy'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/plans']);
    const { byName } = await stored();
    expect(eventsOf(byName['Retire at 50'].plan).map((e) => [e.kind, e.label])).toEqual([['sabbatical', 'A career break']]);
    expect(eventsOf(byName['First plan'].plan)).toEqual([]);
    expect(tab.said()).toContain('Added to Copy: Retire at 50');
    expect(tab.text()).toContain(EVENT_PART_TEXT.retired);
    await tab.unmount();
  });
});

describe('Delete, from a plan’s level', () => {
  test('a destructive row that asks first: Delete there deletes the copy, and your plan isn’t changed', async () => {
    const stamp = await seedPlan();
    await seedCopy('Retire at 50', { targetAge: 50 });
    const tab = await render();
    await press(tab.plans());
    await press(tab.sheetRow('Retire at 50'));
    const row = tab.sheetRow('Delete')!;
    expect(classOf(row)).toContain('neg');
    expect(row.textContent).toBe('DeleteAsks before it deletes');
    await press(row);
    const level = tab.dialog()!;
    expect(level.textContent).toContain('Delete “Retire at 50”? Your plan isn’t changed. This can’t be undone.');
    // Cancel goes back to the plan's level, and deletes nothing.
    await press(button(level, 'Cancel'));
    expect(tab.sheetRow('Delete')).not.toBeNull();
    expect(writes()).toEqual([]);
    await press(tab.sheetRow('Delete'));
    const danger = tab.dialog()!.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('danger'))[0];
    expect(danger.textContent.trim()).toBe('Delete');
    await press(danger);
    await settle(400);
    expect(writes()).toEqual(['DELETE /api/plans']);
    const { byName } = await stored();
    expect(Object.keys(byName)).toEqual(['First plan']);
    expect(byName['First plan'].updated_at).toBe(stamp);
    // Back on the list, with your plan alone; the bar's button says no number.
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Plans');
    expect(tab.sheetRow('Retire at 50')).toBeNull();
    expect(tab.plans()?.textContent).toBe('Plans');
    await tab.unmount();
  });
});
