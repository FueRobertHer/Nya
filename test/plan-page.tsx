import { afterAll, afterEach, beforeEach, expect, mock } from 'bun:test';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { installDom, trackRoots, click, type, fakeClock, FakeElement } from './mini-dom';
import { simulateOnPage } from './plan-on-page';

// The Plan tab on the page for the suites of the tax plan's E2 (the Timeline,
// the item sheet, Household and the FI number): rendered and used as a person
// would (react-dom/client over test/mini-dom.ts), with every plan route real
// on test/fake-redis.ts, so what is checked is what the server stored. Called
// once at the top of a test file, since a file's document and storage are its
// own. As test/plan-tab-copies.test.tsx says, a rendered element never goes
// into toEqual or another matcher that diffs.

export async function planPage() {
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
  // React's client reads what the document supports once, when it loads.
  for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
  const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
  const { default: PlanTab } = await import('@/components/PlanTab');
  const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
  const { planOf } = await import('@/lib/fire/plan-v2');
  const { factsOf } = await import('@/lib/fire/copies');
  const firePlan = await import('@/app/api/fire-plan/route');
  const plansRoute = await import('@/app/api/plans/route');
  const planInputs = await import('@/app/api/plan-inputs/route');
  type FirePlanV2 = import('@/lib/fire/plan-v2').FirePlanV2;
  type PlanTabProps = import('@/components/PlanTab').PlanTabProps;

  beforeEach(async () => {
    fake.reset();
    (await import('@/lib/sessions')).forgetEpochs();
    await registerTestContainer(fake);
  });
  afterEach(() => {
    expect(unscopedDataKeys(fake)).toEqual([]);
    dom.document.activeElement = dom.document.body;
  });

  /** Your plan: every figure typed, in USD. FI around 52, stopping at 55. */
  const PLAN: FirePlanV2 = planOf({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, savings: 30_000, assets: 300_000 });

  type Call = { method: string; path: string; body: any };
  let calls: Call[] = [];
  let inflight = 0;
  /** Answers that go before the routes, by "METHOD /path", for this test. */
  const answers: Record<string, () => Response | Promise<Response>> = {};
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
      if (answers[key]) return await answers[key]();
      const route = ROUTES[key];
      if (!route) return Response.json(STUBS[key] ?? { error: 'not here' }, { status: key in STUBS ? 200 : 404 });
      return await route(new Request(url, { method, body: init?.body }));
    } finally {
      inflight--;
    }
  }) as typeof fetch;
  beforeEach(() => {
    calls = [];
    for (const k of Object.keys(answers)) delete answers[k];
  });

  const pass = fakeClock();
  simulateOnPage();
  /** Lets `ms` pass on the fake clock, then more until no route has been
   *  answering for three steps, and what the answers start. A route seals what
   *  it reads and writes on a real thread (crypto.subtle, lib/crypto.ts), so
   *  however busy the machine, this waits for it, with no limit on the steps,
   *  and the clock only creeps meanwhile (for a retry's backoff, lib/repo.ts).
   *  An answer can start another request, so one look finding none answering
   *  may fall between the two. A test that holds a request open takes it out
   *  of `inflight`, or this waits until the test times out. */
  async function settle(ms = 30) {
    await pass(ms);
    for (let quiet = 0; ; ) {
      if (inflight > 0) quiet = 0;
      else if (++quiet > 3) return;
      await pass(quiet > 0 ? 10 : 1);
    }
  }

  const json = async (res: Response) => ({ status: res.status, body: await res.json() });
  /** Your plan saved first, as a page saves it, in USD. */
  async function seedPlan(plan: FirePlanV2 = PLAN): Promise<string> {
    const r = await json(await firePlan.PUT(req('/api/fire-plan', 'PUT', { plan, currency: 'USD', facts_were: factsOf(DEFAULT_PLAN), based_on: null })));
    expect([r.status, r.body.error]).toEqual([200, undefined]);
    return r.body.updated_at;
  }
  /** A copy of your plan (`base`) with `over` in it: its id. */
  async function seedCopy(name: string, over: Partial<FirePlanV2> = {}, base: FirePlanV2 = PLAN): Promise<string> {
    await pass(1000);
    const r = await json(await plansRoute.POST(req('/api/plans', 'POST', { from: 'main', name, plan: { ...base, ...over }, currency: 'USD' })));
    expect([name, r.status, r.body.error]).toEqual([name, 200, undefined]);
    return r.body.plan.id;
  }
  type Row = { id: string; name: string; plan: FirePlanV2; currency: string | null; updated_at: string | null };
  /** What is stored: whose plan is yours, and every plan by name. */
  async function stored(): Promise<{ main: string; byName: Record<string, Row> }> {
    const { body } = await json(await plansRoute.GET());
    return { main: body.main, byName: Object.fromEntries((body.plans as Row[]).map((p) => [p.name, p])) };
  }
  /** The plans' writes and your plan's, in order. */
  const writes = () => calls.filter((c) => c.method !== 'GET' && (c.path === '/api/plans' || c.path === '/api/fire-plan')).map((c) => `${c.method} ${c.path}`);

  const classOf = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');
  const inDialog = (e: FakeElement) => {
    for (let n = e.parentNode; n; n = n.parentNode) if (n instanceof FakeElement && n.getAttribute('role') === 'dialog') return true;
    return false;
  };
  const titleOf = (e: FakeElement) => e.findAll((t) => classOf(t).includes('list-row-title'))[0]?.textContent ?? null;

  /** The Plan tab, with what a test looks for. */
  async function render(props: Partial<PlanTabProps> = {}) {
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const all: PlanTabProps = { txns: [], txnsLoading: false, txnNotes: [], institutions: [], balancesAsOf: null, currency: 'USD', holdings: [], ...props };
    await act(async () => root.render(<PlanTab {...all} />));
    await settle(100);
    const find = (pred: (e: FakeElement) => boolean) => container.findAll(pred)[0] ?? null;
    const dialog = () => find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true');
    return {
      container,
      unmount: async () => {
        await act(async () => root.unmount());
      },
      text: () => container.textContent,
      /** A row on the page, outside any sheet, by its title. */
      row: (title: string) => find((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && !inDialog(e) && (titleOf(e) === title || (titleOf(e)?.startsWith(`${title},`) ?? false))),
      /** The Timeline's card. */
      timeline: () => find((e) => classOf(e).includes('plan-timeline')),
      chip: (label: string) => find((e) => e.tagName === 'BUTTON' && classOf(e).includes('chip') && e.textContent.trim() === label),
      dialog,
      /** A row of the sheet open now, by its title. */
      sheetRow: (title: string) => dialog()?.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && titleOf(e) === title)[0] ?? null,
      title: () => find((e) => e.tagName === 'H2' && classOf(e).includes('plan-title'))?.textContent ?? null,
      plans: () => find((e) => e.tagName === 'BUTTON' && /^Plans(?: \(\d+\))?$/.test(e.textContent.trim())),
      card: () => find((e) => classOf(e).includes('plan-copy-card')),
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
  /** A sheet's close button, its cross. */
  const closeOf = (sheet: FakeElement) => sheet.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Close')[0] ?? null;
  /** A field in an element, by the words its label starts with. */
  const field = (within: FakeElement, words: string) =>
    within.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(words))[0]?.findAll((e) => e.tagName === 'INPUT' || e.tagName === 'SELECT')[0] ?? null;
  const fill = async (within: FakeElement, words: string, value: string) => {
    const el = field(within, words);
    if (!el) throw new Error(`no field ${words}`);
    await act(async () => type(el, value));
    await settle();
  };
  /** A radio or a segment in an element, by its words. */
  const choice = (within: FakeElement, words: string) =>
    within.findAll((e) => (e.tagName === 'LABEL' && e.textContent.startsWith(words)) || (e.tagName === 'BUTTON' && e.textContent.trim() === words))[0] ?? null;
  const pick = async (within: FakeElement, words: string) => {
    const c = choice(within, words);
    if (!c) throw new Error(`no choice ${words}`);
    const input = c.tagName === 'LABEL' ? c.findAll((e) => e.tagName === 'INPUT')[0] : null;
    await act(async () => {
      if (input) input.checked = true;
      click(input ?? c);
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
  /** Add to your Timeline, then a template; the sheet it opens. */
  async function addTemplate(tab: Tab, label: string) {
    await press(button(tab.timeline(), 'Add'));
    await press(tab.sheetRow(label));
    return tab.dialog()!;
  }
  /** What the preview says once typing has rested. */
  const rest = () => settle(250);

  return { dom, act, PLAN, fake, answers, settle, rest, seedPlan, seedCopy, stored, writes, classOf, render, press, button, closeOf, field, fill, choice, pick, openCopy, addTemplate, calls: () => calls, click, type };
}
