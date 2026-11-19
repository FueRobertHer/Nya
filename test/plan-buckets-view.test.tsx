import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, fakeClock, FakeElement, FakeNode } from './mini-dom';
import { simulateOnPage } from './plan-on-page';
import { copyRow, plansListing } from './plans-listing';

// Invested assets by tax bucket, and where savings go (components/PlanBuckets.tsx),
// used as a person would: the groups in order, each row's words, the gaps said
// quietly and never as a caution (the flat model draws none of the detailed
// model's: the tax plan's Honesty), a row opening a level of the drawer with what
// is shared about the account, one save each, a failed one staying open, a save
// holding the drawer, facts locked in a copy and until they are known, the other
// accounts' rows asked for only when a sheet opens, and Home and the Plan moving
// together on a fact; an account's own growth handed from its level to the
// sheet, which keeps it on Save, in a copy too, and a taxable account's own
// dividends the same way where tax is worked out. Every request is answered here.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: PlanTab } = await import('@/components/PlanTab');
const { default: FiProgressCard } = await import('@/components/FiProgressCard');
const { DEFAULT_PLAN_V2 } = await import('@/lib/fire/plan-v2');
const { createPlanInputsStore } = await import('@/lib/plan-inputs-store');
const { DEFAULT_TAX_FACTS, applyTaxFactOp, parseTaxFactOp } = await import('@/lib/fire/tax-facts');
const { DEFAULT_TAX_CHOICES } = await import('@/lib/fire/tax-choices');
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type TaxFacts = import('@/lib/fire/tax-facts').TaxFacts;
type TaxChoices = import('@/lib/fire/tax-choices').TaxChoices;
type AssetInstitution = import('@/lib/fire/inputs').AssetInstitution;

const pass = fakeClock();
simulateOnPage();
const settle = (ms = 30) => pass(ms);

const acct = (account_id: string, name: string, subtype: string, balance: number) => ({ account_id, name, type: 'investment', subtype, balance, currency: 'USD' });
const INSTITUTIONS: AssetInstitution[] = [
  {
    name: 'Fidelity',
    item_id: 'i1',
    error: false,
    staleAsOf: null,
    staleAsOfAt: null,
    missing: 0,
    accounts: [acct('brk', 'Brokerage', 'brokerage', 140_000), acct('k', '401(k)', '401k', 260_000), acct('r', 'Roth IRA', 'roth', 50_000), acct('h', 'HSA', 'hsa', 25_000), acct('o', 'Mystery', 'other', 10_000)],
  },
  { name: 'NY Saves', item_id: 'i2', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [acct('c', 'NY 529 plan', '529', 48_000)] },
];
const HOLDINGS = [{ account_id: 'brk', name: 'Fund', ticker: 'VTI', security_type: 'etf', is_cash_equivalent: false, value: 140_000, cost_basis: 105_000 }];
const PLAN = { ...DEFAULT_PLAN_V2, age: 41, targetAge: 50, spending: 40_000, savings: 30_000 };
const yearRow = (id: string, income: number, contributions: number) => ({ id, dividends_12m: income, contributions_12m: contributions, contributions_12m_from: '2025-11-05', contributions_12m_partial: false, contributions_12m_rows: [], contributions_12m_activity_from: null, note: null });

type Call = { method: string; url: string; body: any };
/** An account's balance on the 1st of each month from `from` to `to`, growing
 *  `yearly` a year with nothing put in, and the activity that says so. */
function grown(from: string, to: string, yearly: number) {
  const points: { date: string; value: number }[] = [];
  let value = 100_000;
  for (let d = from; d <= to; ) {
    points.push({ date: d, value: Math.round(value * 100) / 100 });
    const [y, m] = d.split('-').map(Number);
    const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    value *= (1 + yearly) ** ((Date.parse(`${next}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000 / 365);
    d = next;
  }
  return { points, activity: { txns: [], ytd_contributions: 0, ytd_rollovers: 0, flows: [], flows_from: from, flows_to: to, note: null } };
}
/** An account with no investment activity at all. */
const NO_ACTIVITY = { txns: [], ytd_contributions: 0, ytd_rollovers: 0, flows: null, note: null };

function serve(over: { tax?: TaxFacts; plan?: typeof PLAN; refuse?: string; rows?: Record<string, ReturnType<typeof yearRow>>; hold?: Promise<void>; copies?: boolean; currency?: string; choices?: TaxChoices; histories?: Record<string, ReturnType<typeof grown> | 'fails'> } = {}) {
  const calls: Call[] = [];
  const state = { tax: over.tax ?? DEFAULT_TAX_FACTS, plan: over.plan ?? PLAN, refuse: over.refuse ?? null, settings: { version: 1, target: null, buckets: [], funds: [], accounts: [] } as any };
  const rows = over.rows ?? { 'i1:brk': yearRow('i1:brk', 2_800, 6_000), 'i1:k': yearRow('i1:k', 0, 20_000) };
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = new URL(url, 'http://nya.test');
    const call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const plan = () => ({ plan: state.plan, currency: over.currency ?? 'USD', tax_facts: state.tax, ...(over.choices ? { tax: over.choices } : {}) });
    if (u.pathname === '/api/plan-inputs') {
      if (u.searchParams.get('sync') === '1') {
        await over.hold;
        return json({ plans: u.searchParams.getAll('plan').map((id) => rows[id] ?? { id, failed: true }) });
      }
      return json({ ...plan(), plans: u.searchParams.getAll('plan').map((id) => ({ id, pending: true })) });
    }
    if (u.pathname === '/api/plan-facts') {
      if (state.refuse) return json({ error: state.refuse }, 409);
      const parsed = parseTaxFactOp(call.body);
      if ('error' in parsed) return json({ error: parsed.error }, 400);
      state.tax = applyTaxFactOp(state.tax, parsed.op);
      return json(plan());
    }
    if (u.pathname === '/api/fire-plan' && method === 'PUT') {
      state.plan = call.body.plan;
      // As the route answers (lib/plan-copies.ts mainAnswer): the household's facts too.
      return json({ ...plan(), updated_at: '2026-11-01T00:00:00.000Z' });
    }
    if (u.pathname === '/api/plans' && method === 'PUT') {
      const saved = call.body.saves.map((x: { id: string; plan: typeof PLAN; currency: string | null }) => ({ ...copyRow(state.plan, x.id, 'Stop at 52', x.plan, x.currency, 2) }));
      return json({ plans: saved, main: null });
    }
    if (u.pathname === '/api/plans' && method === 'GET') {
      const [status, body] = plansListing(state.plan, over.copies ? [copyRow(state.plan, 'a', 'Stop at 52', { targetAge: 52 })] : []);
      return json(body, status as number);
    }
    // Each account's history and activity, for its rate of return (by
    // "item:account"); none recorded for any other.
    if (u.pathname === '/api/account-history' || u.pathname === '/api/investment-activity') {
      const id = u.searchParams.get('id');
      const held = Object.entries(over.histories ?? {}).find(([k]) => k.endsWith(`:${id}`) && (u.pathname === '/api/account-history' || k === `${u.searchParams.get('item_id')}:${id}`))?.[1];
      if (held === 'fails') return json({ error: 'no' }, 500);
      if (u.pathname === '/api/account-history') return json({ points: held?.points ?? [] });
      return json(held?.activity ?? NO_ACTIVITY);
    }
    if (u.pathname === '/api/allocation-settings') {
      if (method === 'PUT') state.settings = call.body.settings ?? call.body;
      return json({ settings: state.settings });
    }
    return json({ error: 'not here' }, 404);
  };
  return {
    calls,
    state,
    facts: () => calls.filter((c) => c.url === '/api/plan-facts'),
    asked: () => calls.filter((c) => c.url.startsWith('/api/plan-inputs')).map((c) => c.url),
    /** The plans each save sent: your plan's, or a copy's. */
    saved: () => calls.flatMap((c) => (c.method !== 'PUT' ? [] : c.url === '/api/fire-plan' ? [c.body.plan] : c.url === '/api/plans' ? c.body.saves.map((x: { plan: unknown }) => x.plan) : [])),
  };
}

const has = (e: FakeNode | null, cls: string) => e instanceof FakeElement && (e.getAttribute('class') ?? '').split(' ').includes(cls);
const part = (el: FakeElement, cls: string) => el.findAll((e) => has(e, cls))[0] ?? null;
const button = (within: FakeElement, words: string) => within.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
const rowIn = (within: FakeElement, title: string) => within.findAll((e) => e.tagName === 'BUTTON' && has(e, 'list-row') && part(e, 'list-row-title')?.textContent === title)[0] ?? null;
const field = (sheet: FakeElement, label: string) => sheet.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(label))[0]?.findAll((e) => e.tagName === 'INPUT')[0] ?? null;
/** A button a person can see: the levels under the one open stay, hidden. */
const inView = (e: FakeElement) => {
  for (let n: FakeElement | null = e; n; n = n.parentElement as FakeElement | null) if (n.hasAttribute('hidden')) return false;
  return true;
};
const buttonShown = (within: FakeElement, words: string) => within.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words && inView(e))[0] ?? null;
/** What goes to this path waits until the function returned is called. */
function holdRequests(path: string) {
  const inner = globalThis.fetch;
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    if (String(url).startsWith(path) && (init?.method ?? 'GET') !== 'GET') await held;
    return inner(url, init);
  };
  return async () => {
    await act(async () => release());
    await settle(60);
  };
}
/** The plan's answer fails while `down`. */
function planCanFail(down: boolean) {
  const inner = globalThis.fetch;
  const gate = { down };
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    if (gate.down && String(url).startsWith('/api/plan-inputs') && !String(url).includes('sync=1')) return new Response(JSON.stringify({ error: 'down' }), { status: 500, headers: { 'content-type': 'application/json' } });
    return inner(url, init);
  };
  return gate;
}
const press = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => {
    el.focus();
    click(el);
  });
  await settle();
};

async function mount(props: Partial<PlanTabProps> = {}) {
  const store = props.planInputs ?? createPlanInputsStore();
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const all = { txns: [], txnsLoading: false, txnNotes: [], institutions: INSTITUTIONS, balancesAsOf: '2026-10-31T13:41:00.000Z', currency: 'USD', holdings: HOLDINGS, planInputs: store, ...props } as PlanTabProps;
  await act(async () => root.render(<PlanTab {...all} />));
  await settle();
  const find = (t: (e: FakeElement) => boolean) => container.findAll(t);
  const dialog = () => find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  return {
    store,
    container: container as unknown as FakeElement,
    dialog,
    row: (title: string) => find((e) => e.tagName === 'BUTTON' && has(e, 'list-row') && part(e, 'list-row-title')?.textContent === title)[0] ?? null,
    /** The sheet's main part, or the level over it: what a person sees. */
    shown: () => {
      const d = dialog()!;
      const body = part(d, 'sheet-body')!;
      const copy: string[] = [];
      const walk = (n: FakeElement) => {
        for (const c of n.childNodes) {
          if (!(c instanceof FakeElement)) copy.push(c.textContent);
          else if (!c.hasAttribute('hidden')) walk(c);
        }
      };
      walk(body);
      return copy.join('');
    },
    title: () => part(dialog()!, 'sheet-header')!.findAll((e) => e.tagName === 'H2')[0].textContent,
    unmount: () => act(async () => root.unmount()),
  };
}
type Tab = Awaited<ReturnType<typeof mount>>;
const openAssets = async (tab: Tab) => {
  await press(tab.row('Invested assets'));
  await settle(60);
};
const openRow = async (tab: Tab, title: string) => {
  const d = tab.dialog()!;
  await press(rowIn(d, title));
};
const arrow = (tab: Tab) => press(tab.dialog()!.findAll((e) => e.getAttribute('aria-label') === 'Back')[0]);
const closeDrawer = (tab: Tab) => press(tab.dialog()!.findAll((e) => e.getAttribute('aria-label') === 'Close')[0]);
const subOf = (tab: Tab, title: string) => part(rowIn(tab.dialog()!, title)!, 'list-row-sub')!.textContent;
/** The one box a level has, ticked. */
const tick = async (tab: Tab) => {
  const box = tab.dialog()!.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'checkbox').find((e) => has(e.parentElement, 'check-row'))!;
  await act(async () => {
    box.checked = true;
    click(box);
  });
  await settle();
};

describe('the Invested assets sheet', () => {
  test('groups in order with their totals; the words of each row; what the form had stays', async () => {
    serve();
    const tab = await mount();
    await openAssets(tab);
    const d = tab.dialog()!;
    expect(d.findAll((e) => has(e, 'bucket-head')).map((h) => h.textContent)).toEqual(['Taxable$140,000', 'Tax-deferred$260,000', 'Roth$50,000', 'HSA$25,000', 'Unclassified$10,000']);
    expect(part(rowIn(d, 'Brokerage')!, 'list-row-sub')!.textContent).toBe('Cost basis $105,000 · gain $35,000');
    expect(part(rowIn(d, '401(k)')!, 'list-row-sub')).toBeNull();
    expect(tab.shown()).toContain('$485,000 in 5 accounts, as of ');
    expect(tab.shown()).toContain('Each account’s tax bucket comes from its type, and each grows at the plan’s 5% after inflation unless you give it its own. Open an account to change either.');
    expect(tab.shown()).not.toContain('together');
    expect(tab.shown()).not.toContain('is kept when you save');
    expect(tab.shown()).toContain('counts them as tax-deferred until you say');
    expect(tab.shown()).toContain('Nya’s figure');
    expect(tab.shown()).toContain('Count checking and savings accounts too');
    expect(button(d, 'Save')).not.toBeNull();
    expect(d.findAll((e) => e.tagName === 'SUMMARY').map((s) => s.textContent)).toContain('Why do buckets matter?');
    await tab.unmount();
  });

  test('the left-out group: the line, its row, and the total without it', async () => {
    serve();
    const tab = await mount();
    await openAssets(tab);
    expect(tab.shown()).toContain('Left out: a child’s education');
    expect(tab.shown()).toContain('Leaves out 1 account for a child’s education, $48,000: it isn’t there for your years after work.');
    expect(part(rowIn(tab.dialog()!, 'NY 529 plan')!, 'list-row-sub')!.textContent).toBe('Count it in your plan');
    await tab.unmount();
  });

  test('gaps are quiet in the flat model: a neutral badge, and no caution at all', async () => {
    serve();
    const tab = await mount();
    await openAssets(tab);
    const d = tab.dialog()!;
    const roth = rowIn(d, 'Your Roth contributions')!;
    const badge = part(roth, 'badge')!;
    expect(badge.textContent).toBe('Not set yet');
    expect(badge.getAttribute('class')).toBe('badge');
    expect(d.findAll((e) => has(e, 'notice')).length).toBe(0);
    await tab.unmount();
  });

  test('the projected mix, in a line', async () => {
    serve();
    const tab = await mount();
    await openAssets(tab);
    expect(tab.shown()).toMatch(/At \d+, about \d+% [a-zA-Z-]+/);
    await tab.unmount();
  });

  test('your own figure: the accounts stay, and it says how the figure is shared', async () => {
    serve({ plan: { ...PLAN, assets: 200_000 } });
    const tab = await mount();
    await openAssets(tab);
    expect(tab.shown()).toContain('Your own figure is shared out as these accounts are.');
    expect(rowIn(tab.dialog()!, 'Brokerage')).not.toBeNull();
    await tab.unmount();
  });

  test('two accounts of one name keep their institutions in the row', async () => {
    serve();
    const twin = [{ ...INSTITUTIONS[0], accounts: [acct('a', 'Brokerage', 'brokerage', 1)] }, { ...INSTITUTIONS[1], name: 'Schwab', accounts: [acct('b', 'Brokerage', 'brokerage', 2)] }];
    const tab = await mount({ institutions: twin, holdings: [] });
    await openAssets(tab);
    expect(rowIn(tab.dialog()!, 'Fidelity Brokerage')).not.toBeNull();
    expect(rowIn(tab.dialog()!, 'Schwab Brokerage')).not.toBeNull();
    await tab.unmount();
  });
});

describe('the account level', () => {
  test('opens over the form, which keeps what was typed; the arrow comes back', async () => {
    serve();
    const tab = await mount();
    await openAssets(tab);
    await press(button(tab.dialog()!, 'My own'));
    await act(async () => type(field(tab.dialog()!, 'Invested assets')!, '123456'));
    await openRow(tab, 'Brokerage');
    expect(tab.title()).toBe('Brokerage');
    expect(tab.shown()).not.toContain('Why do buckets matter?');
    expect(tab.shown()).toContain('Fidelity · $140,000');
    await press(tab.dialog()!.findAll((e) => e.getAttribute('aria-label') === 'Back')[0]);
    expect(tab.title()).toBe('Invested assets');
    expect(field(tab.dialog()!, 'Invested assets')!.value).toBe('123456');
    await tab.unmount();
  });

  test('a cost basis: one save with the account’s whole fact, and the row moves at once', async () => {
    const server = serve();
    const store = createPlanInputsStore();
    const tab = await mount({ planInputs: store });
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('From its positions. Type your own if you know better.');
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '120000'));
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts().map((c) => c.body)).toEqual([{ kind: 'account', account_id: 'brk', owner: 'you', basis: 120_000, count: false }]);
    expect(tab.title()).toBe('Invested assets');
    expect(part(rowIn(tab.dialog()!, 'Brokerage')!, 'list-row-sub')!.textContent).toBe('Cost basis $120,000 · gain $20,000');
    expect((store.get().plan?.body as any).tax_facts.basis).toEqual([{ account_id: 'brk', amount: 120_000 }]);
    await tab.unmount();
  });

  test('emptied, it goes back to the positions', async () => {
    const server = serve({ tax: { ...DEFAULT_TAX_FACTS, basis: [{ account_id: 'brk', amount: 120_000 }] } });
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('Your own figure. Leave it empty to use what its positions say.');
    expect(field(tab.dialog()!, 'Cost basis')!.value).toBe('120000');
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, ''));
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts()[0].body.basis).toBeNull();
    expect(part(rowIn(tab.dialog()!, 'Brokerage')!, 'list-row-sub')!.textContent).toBe('Cost basis $105,000 · gain $35,000');
    await tab.unmount();
  });

  test('what isn’t a figure is said under the field and nothing is sent', async () => {
    const server = serve();
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '-5'));
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts()).toEqual([]);
    expect(tab.shown()).toContain('Cost basis must be a number, zero or more.');
    expect(tab.title()).toBe('Brokerage');
    await tab.unmount();
  });

  test('a plain field: what it can’t read is said and the figure held stays, and a figure typed with commas is read', async () => {
    const server = serve({ tax: { ...DEFAULT_TAX_FACTS, basis: [{ account_id: 'brk', amount: 120_000 }] } });
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    // A number field would report these as empty in some browsers, and empty
    // clears the figure.
    expect(field(tab.dialog()!, 'Cost basis')!.getAttribute('type')).toBeNull();
    for (const text of ['12x', '0x10', '1,2,3']) {
      await act(async () => type(field(tab.dialog()!, 'Cost basis')!, text));
      await press(button(tab.dialog()!, 'Save'));
      expect([text, server.facts().length]).toEqual([text, 0]);
      expect(tab.shown()).toContain('Cost basis must be a number, zero or more.');
      expect(tab.title()).toBe('Brokerage');
    }
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '105,000'));
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts()[0].body.basis).toBe(105_000);
    await tab.unmount();
  });

  test('what was typed is there after a trip to Change its bucket', async () => {
    const server = serve({ plan: { ...PLAN, partnerAge: 40 } });
    const tab = await mount();
    await settle(60);
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '120000'));
    await press(button(tab.dialog()!, 'Your partner'));
    await openRow(tab, 'Change its bucket');
    expect(tab.title()).toBe('Change its bucket');
    expect(tab.shown()).not.toContain('Cost basis');
    await arrow(tab);
    expect(tab.title()).toBe('Brokerage');
    expect(field(tab.dialog()!, 'Cost basis')!.value).toBe('120000');
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts()[0].body).toEqual({ kind: 'account', account_id: 'brk', owner: 'partner', basis: 120_000, count: false });
    await tab.unmount();
  });

  test('a save under way holds the drawer: the arrow and Close wait, then it goes back', async () => {
    const server = serve();
    const release = holdRequests('/api/plan-facts');
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '120000'));
    await press(button(tab.dialog()!, 'Save'));
    expect(button(tab.dialog()!, 'Saving…')).not.toBeNull();
    await arrow(tab);
    expect(tab.title()).toBe('Brokerage');
    await closeDrawer(tab);
    expect(tab.dialog()).not.toBeNull();
    expect(tab.title()).toBe('Brokerage');
    // Nor is its bucket a way out meanwhile.
    expect(rowIn(tab.dialog()!, 'Change its bucket')!.disabled).toBe(true);
    await release();
    expect(server.facts().length).toBe(1);
    expect(tab.title()).toBe('Invested assets');
    // And it is free again.
    await closeDrawer(tab);
    expect(tab.dialog()).toBeNull();
    await tab.unmount();
  });

  test('so a refusal is said on the level it belongs to', async () => {
    serve({ refuse: 'Refused for a reason.' });
    const release = holdRequests('/api/plan-facts');
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '120000'));
    await press(button(tab.dialog()!, 'Save'));
    await arrow(tab);
    await release();
    expect(tab.title()).toBe('Brokerage');
    expect(part(tab.dialog()!, 'notice')!.textContent).toContain('Refused for a reason.');
    expect(field(tab.dialog()!, 'Cost basis')!.value).toBe('120000');
    await tab.unmount();
  });

  test('a bucket’s save holds it too, and comes back to its account', async () => {
    const server = serve();
    server.state.settings = { v: 1, buckets: [], funds: [], accounts: [], target: null };
    const release = holdRequests('/api/allocation-settings');
    const tab = await mount();
    await settle(60);
    await openAssets(tab);
    await openRow(tab, '401(k)');
    await openRow(tab, 'Change its bucket');
    await press(tab.dialog()!.findAll((e) => e.getAttribute('type') === 'radio')[2]);
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(buttonShown(tab.dialog()!, 'Saving…')).not.toBeNull();
    await closeDrawer(tab);
    expect(tab.dialog()).not.toBeNull();
    expect(tab.title()).toBe('Change its bucket');
    await arrow(tab);
    expect(tab.title()).toBe('Change its bucket');
    await release();
    expect(tab.title()).toBe('401(k)');
    expect(server.facts()).toEqual([]);
    await tab.unmount();
  });

  test('a partner since removed: the choice stays, to take the account back', async () => {
    const server = serve({ tax: { ...DEFAULT_TAX_FACTS, owners: [{ account_id: 'k', owner: 'partner' }] } });
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, '401(k)');
    expect(tab.shown()).toContain('Whose it is');
    await press(button(tab.dialog()!, 'You'));
    expect(tab.shown()).toContain('Whose it is');
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts()[0].body.owner).toBe('you');
    await tab.unmount();
  });

  test('a save that fails stays open, keeps what was typed and says why', async () => {
    const server = serve({ refuse: 'Nya keeps these for at most 500 accounts.' });
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '120000'));
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts().length).toBe(1);
    expect(tab.title()).toBe('Brokerage');
    expect(field(tab.dialog()!, 'Cost basis')!.value).toBe('120000');
    const notice = part(tab.dialog()!, 'notice')!;
    expect(notice.textContent).toContain('Nya keeps these for at most 500 accounts.');
    expect(notice.getAttribute('class')).toContain('critical');
    await tab.unmount();
  });

  test('cancel leaves everything as it was', async () => {
    const server = serve();
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '120000'));
    await press(button(tab.dialog()!, 'Cancel'));
    expect(server.facts()).toEqual([]);
    expect(tab.title()).toBe('Invested assets');
    await tab.unmount();
  });

  test('whose it is, once a partner is set: nothing said before, and the row says so after', async () => {
    const server = serve({ plan: { ...PLAN, partnerAge: 40 } });
    const tab = await mount();
    await openAssets(tab);
    expect(part(rowIn(tab.dialog()!, '401(k)')!, 'list-row-sub')!.textContent).toBe('Yours');
    await openRow(tab, '401(k)');
    await press(button(tab.dialog()!, 'Your partner'));
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts()[0].body).toEqual({ kind: 'account', account_id: 'k', owner: 'partner', basis: null, count: false });
    expect(part(rowIn(tab.dialog()!, '401(k)')!, 'list-row-sub')!.textContent).toBe('Your partner’s');
    await tab.unmount();
  });

  test('no partner set: no such choice', async () => {
    serve();
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, '401(k)');
    expect(tab.shown()).not.toContain('Whose it is');
    expect(tab.shown()).not.toContain('Cost basis');
    await tab.unmount();
  });

  test('a child’s account: Count it, with Save, and it moves into the plan', async () => {
    const server = serve();
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'NY 529 plan');
    await tick(tab);
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts()[0].body).toEqual({ kind: 'account', account_id: 'c', owner: 'you', basis: null, count: true });
    expect(tab.shown()).not.toContain('Left out');
    expect(tab.dialog()!.findAll((e) => has(e, 'bucket-head')).map((h) => h.textContent)).toContain('Education$48,000');
    await tab.unmount();
  });

  test('yield: known, still coming, and not known; never a zero', async () => {
    serve();
    const tab = await mount();
    await openAssets(tab);
    await settle(60);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('$2,800 a year, 2.0%');
    expect(tab.shown()).toContain('A dividend its institution reports only as reinvested isn’t counted.');
    await tab.unmount();
    serve({ rows: {} });
    const none = await mount();
    await openAssets(none);
    await settle(60);
    await openRow(none, 'Brokerage');
    expect(none.shown()).toContain('Not known yet');
    await none.unmount();
  });

  test('its bucket opens Portfolio’s form, and its choice shows on the row’s group', async () => {
    const server = serve();
    const tab = await mount();
    await settle(60);
    await openAssets(tab);
    await openRow(tab, '401(k)');
    await openRow(tab, 'Change its bucket');
    expect(tab.title()).toBe('Change its bucket');
    expect(tab.shown()).toContain('How the money in 401(k) is taxed.');
    await press(tab.dialog()!.findAll((e) => e.getAttribute('aria-label') === 'Back')[0]);
    expect(tab.title()).toBe('401(k)');
    expect(server.calls.filter((c) => c.method === 'PUT')).toEqual([]);
    await tab.unmount();
  });
});

describe('each account’s growth', () => {
  const growthField = (tab: Tab) => field(tab.dialog()!, 'Its growth after inflation');
  /** Opens an account, sets its own growth, and hands it to the sheet. */
  async function setOwn(tab: Tab, title: string, rate: string, button = 'Save') {
    await openRow(tab, title);
    await press(buttonShown(tab.dialog()!, 'Its own'));
    await act(async () => type(growthField(tab)!, rate));
    await press(buttonShown(tab.dialog()!, button));
  }

  test('the plan’s rate or its own: handed to the sheet, said on its row and together, kept by the sheet’s Save', async () => {
    const server = serve();
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('Growth after inflation');
    expect(buttonShown(tab.dialog()!, 'The plan’s 5%')!.getAttribute('aria-checked')).toBe('true');
    expect(growthField(tab)).toBeNull();
    await press(buttonShown(tab.dialog()!, 'Its own'));
    // It starts from the plan's.
    expect(growthField(tab)!.value).toBe('5');
    await act(async () => type(growthField(tab)!, '7'));
    await press(buttonShown(tab.dialog()!, 'Save'));
    // Its facts didn't change: nothing is sent for them, and nothing is saved yet.
    expect(server.facts()).toEqual([]);
    expect(server.saved()).toEqual([]);
    expect(tab.title()).toBe('Invested assets');
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $105,000 · gain $35,000 · grows 7%');
    // 5% + 140,000 × 2% / 485,000, the 529 left out.
    expect(tab.shown()).toContain('With 1 account’s own rate, they grow 5.58% a year together.');
    expect(tab.shown()).toContain('An account’s growth is kept when you save. Cancel or close this, and what you set is dropped.');
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(server.saved().map((p: any) => p.accounts)).toEqual([[{ account_id: 'brk', growth: 0.07, yield: null }]]);
    expect(tab.dialog()).toBeNull();
    // After the save: the plan runs at it, and the sheet opens on it.
    expect(tab.container.textContent).toContain('5.58% growth after inflation until FI, 1 account at its own');
    await openAssets(tab);
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $105,000 · gain $35,000 · grows 7%');
    expect(tab.shown()).toContain('With 1 account’s own rate, they grow 5.58% a year together.');
    expect(tab.shown()).not.toContain('is kept when you save');
    await openRow(tab, 'Brokerage');
    expect(buttonShown(tab.dialog()!, 'Its own')!.getAttribute('aria-checked')).toBe('true');
    expect(growthField(tab)!.value).toBe('7');
    await tab.unmount();
  });

  test('two of their own, and the 401(k)’s row, with nothing else to say, says only that', async () => {
    const server = serve();
    const tab = await mount();
    await openAssets(tab);
    await setOwn(tab, 'Brokerage', '7');
    await setOwn(tab, '401(k)', '4');
    expect(subOf(tab, '401(k)')).toBe('grows 4%');
    // 5% + (140,000 × 2% − 260,000 × 1%) / 485,000.
    expect(tab.shown()).toContain('With 2 accounts’ own rates, they grow 5.04% a year together.');
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(server.saved().map((p: any) => p.accounts)).toEqual([
      [
        { account_id: 'brk', growth: 0.07, yield: null },
        { account_id: 'k', growth: 0.04, yield: null },
      ],
    ]);
    await tab.unmount();
  });

  test('the level’s Cancel hands nothing over, and the sheet’s Cancel drops what was', async () => {
    const server = serve();
    const tab = await mount();
    await openAssets(tab);
    await setOwn(tab, 'Brokerage', '7', 'Cancel');
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $105,000 · gain $35,000');
    await setOwn(tab, 'Brokerage', '7');
    expect(subOf(tab, 'Brokerage')).toContain('grows 7%');
    await press(buttonShown(tab.dialog()!, 'Cancel'));
    expect(server.saved()).toEqual([]);
    await openAssets(tab);
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $105,000 · gain $35,000');
    await tab.unmount();
  });

  test('back to the plan’s rate: its growth goes, and dividends held stay', async () => {
    const server = serve({ plan: { ...PLAN, accounts: [{ account_id: 'brk', growth: 0.07, yield: 0.02 }, { account_id: 'gone', growth: 0.09, yield: null }] } });
    const tab = await mount();
    await openAssets(tab);
    expect(subOf(tab, 'Brokerage')).toContain('grows 7%');
    await openRow(tab, 'Brokerage');
    await press(buttonShown(tab.dialog()!, 'The plan’s 5%'));
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $105,000 · gain $35,000');
    expect(tab.shown()).not.toContain('together');
    expect(tab.shown()).toContain('is kept when you save');
    await press(buttonShown(tab.dialog()!, 'Save'));
    // An account no longer listed keeps its own, ignored.
    expect(server.saved().map((p: any) => p.accounts)).toEqual([
      [
        { account_id: 'brk', growth: null, yield: 0.02 },
        { account_id: 'gone', growth: 0.09, yield: null },
      ],
    ]);
    await tab.unmount();
  });

  test('a growth out of range is said under its field, and nothing is handed over', async () => {
    serve();
    const tab = await mount();
    await openAssets(tab);
    await setOwn(tab, 'Brokerage', '20');
    expect(tab.title()).toBe('Brokerage');
    expect(tab.shown()).toContain('Its growth must be from -5% to 15%.');
    expect(growthField(tab)!.getAttribute('aria-invalid')).toBe('true');
    // Going back to the plan's takes the field and what was said of it.
    await press(buttonShown(tab.dialog()!, 'The plan’s 5%'));
    expect(tab.shown()).not.toContain('Its growth must be');
    await press(buttonShown(tab.dialog()!, 'Its own'));
    await act(async () => type(growthField(tab)!, ''));
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(tab.shown()).toContain('Its growth is needed.');
    await press(buttonShown(tab.dialog()!, 'Cancel'));
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $105,000 · gain $35,000');
    await setOwn(tab, 'Brokerage', '-5');
    expect(subOf(tab, 'Brokerage')).toContain('grows -5%');
    await tab.unmount();
  });

  test('a fact changed and a growth together: the fact is sent once, and the growth handed over once it is saved', async () => {
    const server = serve();
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '120000'));
    await press(buttonShown(tab.dialog()!, 'Its own'));
    await act(async () => type(growthField(tab)!, '7'));
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(server.facts().map((c) => c.body)).toEqual([{ kind: 'account', account_id: 'brk', owner: 'you', basis: 120_000, count: false }]);
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $120,000 · gain $20,000 · grows 7%');
    await tab.unmount();
  });

  test('a fact’s save that fails hands nothing over: the level stays, and says why', async () => {
    serve({ refuse: 'Your accounts changed on another device.' });
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '120000'));
    await press(buttonShown(tab.dialog()!, 'Its own'));
    await act(async () => type(growthField(tab)!, '7'));
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(tab.title()).toBe('Brokerage');
    expect(tab.shown()).toContain('Your accounts changed on another device.');
    await press(buttonShown(tab.dialog()!, 'Cancel'));
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $105,000 · gain $35,000');
    await tab.unmount();
  });

  test('a plan keeps its own growth for 50 accounts: another is refused, and one of them can still change', async () => {
    const many = Array.from({ length: 51 }, (_, i) => acct(`a${String(i).padStart(2, '0')}`, `Fund ${i}`, '401k', 10_000));
    const held = many.slice(0, 50).map((a) => ({ account_id: a.account_id, growth: 0.06, yield: null }));
    serve({ plan: { ...PLAN, accounts: held } });
    const tab = await mount({ institutions: [{ ...INSTITUTIONS[0], accounts: many }], holdings: [] });
    await openAssets(tab);
    await setOwn(tab, 'Fund 50', '7');
    expect(tab.title()).toBe('Fund 50');
    expect(tab.shown()).toContain('A plan keeps its own growth or dividends for 50 accounts at most: set one of them back to the plan’s first.');
    await press(buttonShown(tab.dialog()!, 'Cancel'));
    await setOwn(tab, 'Fund 0', '8');
    expect(subOf(tab, 'Fund 0')).toBe('grows 8%');
    await tab.unmount();
  });

  test('with your own figure every account grows at the plan’s rate: the level says so, and no row says otherwise', async () => {
    serve({ plan: { ...PLAN, assets: 200_000, accounts: [{ account_id: 'brk', growth: 0.07, yield: null }] } });
    const tab = await mount();
    await openAssets(tab);
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $105,000 · gain $35,000');
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('With your own figure for invested assets, every account grows at the plan’s 5% after inflation.');
    expect(buttonShown(tab.dialog()!, 'Its own')).toBeNull();
    await tab.unmount();
  });

  test('a child’s account left out has none', async () => {
    serve();
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'NY 529 plan');
    expect(tab.shown()).not.toContain('Growth after inflation');
    await tab.unmount();
  });

  test('in a copy: Done hands it over, and the sheet’s Save keeps it in the copy, never your plan', async () => {
    const server = serve({ copies: true });
    const tab = await mount();
    await press(part(tab.container, 'plan-bar')!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Plans'))[0]);
    await press(rowIn(tab.dialog()!, 'Stop at 52'));
    await press(rowIn(tab.dialog()!, 'Open it'));
    await openAssets(tab);
    await setOwn(tab, 'Brokerage', '6', 'Done');
    expect(server.facts()).toEqual([]);
    expect(subOf(tab, 'Brokerage')).toContain('grows 6%');
    await press(buttonShown(tab.dialog()!, 'Save'));
    const puts = server.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url)).toEqual(['/api/plans']);
    expect(puts[0].body.saves.map((x: any) => [x.id, x.plan.accounts])).toEqual([['a', [{ account_id: 'brk', growth: 0.06, yield: null }]]]);
    await tab.unmount();
  });

  test('in a copy with your own figure nothing can change on the level: Save stays off', async () => {
    const server = serve({ copies: true, plan: { ...PLAN, assets: 200_000 } });
    const tab = await mount();
    await press(part(tab.container, 'plan-bar')!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Plans'))[0]);
    await press(rowIn(tab.dialog()!, 'Stop at 52'));
    await press(rowIn(tab.dialog()!, 'Open it'));
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('With your own figure for invested assets, every account grows at the plan’s 5% after inflation.');
    expect(tab.shown()).not.toContain('Its growth is this copy’s own.');
    expect(buttonShown(tab.dialog()!, 'Done')).toBeNull();
    expect(buttonShown(tab.dialog()!, 'Save')!.disabled).toBe(true);
    expect(server.facts()).toEqual([]);
    await tab.unmount();
  });

  test('Assumptions says the plan’s rate is every account’s but their own, and what they come to as it is typed', async () => {
    serve({ plan: { ...PLAN, accounts: [{ account_id: 'brk', growth: 0.07, yield: null }] } });
    const tab = await mount();
    await press(tab.row('Assumptions'));
    await settle(60);
    expect(tab.shown()).toContain('The plan’s rate: every account grows at it unless you give one its own in Invested assets. With 1 account at its own, yours grow 5.58% a year together.');
    await act(async () => type(field(tab.dialog()!, 'Growth after inflation')!, '6'));
    // 6% + 140,000 × 1% / 485,000.
    expect(tab.shown()).toContain('With 1 account at its own, yours grow 6.29% a year together.');
    await act(async () => type(field(tab.dialog()!, 'Growth after inflation')!, '99'));
    expect(tab.shown()).toContain('in Invested assets.Only for the years until FI');
    await tab.unmount();
  });

  test('hide amounts masks the amounts beside a rate, never the rate', async () => {
    serve({ plan: { ...PLAN, accounts: [{ account_id: 'brk', growth: 0.07, yield: null }] } });
    const { setAmountsHidden } = await import('@/lib/format');
    setAmountsHidden(true);
    try {
      const tab = await mount();
      await openAssets(tab);
      const sub = subOf(tab, 'Brokerage');
      expect(sub).not.toContain('105,000');
      expect(sub).toEndWith(' · grows 7%');
      expect(tab.shown()).toContain('With 1 account’s own rate, they grow 5.58% a year together.');
      await tab.unmount();
    } finally {
      setAmountsHidden(false);
    }
  });

  test('Assumptions with your own figure: it grows at the plan’s rate', async () => {
    serve({ plan: { ...PLAN, assets: 200_000, accounts: [{ account_id: 'brk', growth: 0.07, yield: null }] } });
    const tab = await mount();
    await press(tab.row('Assumptions'));
    await settle(60);
    expect(tab.shown()).toContain('The plan’s rate: your own figure for invested assets grows at it.');
    expect(tab.shown()).not.toContain('together');
    await tab.unmount();
  });
});

describe('Roth contributions', () => {
  test('one for each person, at the group’s foot, each saving its amount', async () => {
    const server = serve({ plan: { ...PLAN, partnerAge: 40 } });
    const tab = await mount();
    await openAssets(tab);
    expect(rowIn(tab.dialog()!, 'Your partner’s Roth contributions')).not.toBeNull();
    await openRow(tab, 'Your Roth contributions');
    await act(async () => type(field(tab.dialog()!, 'Put in so far')!, '45000'));
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts()[0].body).toEqual({ kind: 'roth', owner: 'you', amount: 45_000 });
    expect(part(rowIn(tab.dialog()!, 'Your Roth contributions')!, 'list-row-sub')!.textContent).toBe('Put in $45,000');
    await tab.unmount();
  });

  describe('held with no Roth account counted', () => {
    const NO_ROTH: AssetInstitution[] = [{ ...INSTITUTIONS[0], accounts: INSTITUTIONS[0].accounts.filter((a) => a.account_id !== 'r') }];
    const HELD = { ...DEFAULT_TAX_FACTS, rothContributions: [{ owner: 'you' as const, amount: 45_000 }] };
    const NOTE = 'Your plan only uses what’s here once a Roth account is counted.';

    test('its own section under the buckets says so, with no Roth bucket drawn', async () => {
      serve({ tax: HELD });
      const tab = await mount({ institutions: NO_ROTH });
      await openAssets(tab);
      const d = tab.dialog()!;
      expect(d.findAll((e) => has(e, 'bucket-head')).map((h) => h.textContent)).toEqual(['Taxable$140,000', 'Tax-deferred$260,000', 'HSA$25,000', 'Unclassified$10,000']);
      expect(tab.shown()).toContain(NOTE);
      expect(part(rowIn(d, 'Your Roth contributions')!, 'list-row-sub')!.textContent).toBe('Put in $45,000');
      await tab.unmount();
    });

    test('nothing held: no section and no row', async () => {
      serve();
      const tab = await mount({ institutions: NO_ROTH });
      await openAssets(tab);
      expect(tab.shown()).not.toContain(NOTE);
      expect(rowIn(tab.dialog()!, 'Your Roth contributions')).toBeNull();
      await tab.unmount();
    });

    test('the amount can be changed', async () => {
      const server = serve({ tax: HELD });
      const tab = await mount({ institutions: NO_ROTH });
      await openAssets(tab);
      await openRow(tab, 'Your Roth contributions');
      expect(tab.title()).toBe('Your Roth contributions');
      expect(field(tab.dialog()!, 'Put in so far')!.value).toBe('45000');
      await act(async () => type(field(tab.dialog()!, 'Put in so far')!, '50000'));
      await press(button(tab.dialog()!, 'Save'));
      expect(server.facts()[0].body).toEqual({ kind: 'roth', owner: 'you', amount: 50_000 });
      expect(part(rowIn(tab.dialog()!, 'Your Roth contributions')!, 'list-row-sub')!.textContent).toBe('Put in $50,000');
      await tab.unmount();
    });

    test('emptied and saved, it is cleared, and the section goes', async () => {
      const server = serve({ tax: HELD });
      const tab = await mount({ institutions: NO_ROTH });
      await openAssets(tab);
      await openRow(tab, 'Your Roth contributions');
      expect(tab.shown()).toContain('Empty it and save to clear it.');
      await act(async () => type(field(tab.dialog()!, 'Put in so far')!, ''));
      await press(button(tab.dialog()!, 'Save'));
      expect(server.facts()[0].body).toEqual({ kind: 'roth', owner: 'you', amount: null });
      expect(server.state.tax.rothContributions).toEqual([]);
      expect(tab.shown()).not.toContain(NOTE);
      expect(rowIn(tab.dialog()!, 'Your Roth contributions')).toBeNull();
      await tab.unmount();
    });

    test('a partner’s row only when theirs is held, a partner since removed included', async () => {
      serve({ tax: HELD, plan: { ...PLAN, partnerAge: 40 } });
      const partnerSet = await mount({ institutions: NO_ROTH });
      await openAssets(partnerSet);
      expect(rowIn(partnerSet.dialog()!, 'Your Roth contributions')).not.toBeNull();
      expect(rowIn(partnerSet.dialog()!, 'Your partner’s Roth contributions')).toBeNull();
      await partnerSet.unmount();

      serve({ tax: { ...DEFAULT_TAX_FACTS, rothContributions: [{ owner: 'partner', amount: 9_000 }] } });
      const noPartner = await mount({ institutions: NO_ROTH });
      await openAssets(noPartner);
      expect(rowIn(noPartner.dialog()!, 'Your Roth contributions')).toBeNull();
      expect(part(rowIn(noPartner.dialog()!, 'Your partner’s Roth contributions')!, 'list-row-sub')!.textContent).toBe('Put in $9,000');
      await noPartner.unmount();
    });

    test('with no account counted at all it can still be reached, and your own figure isn’t said to be shared out', async () => {
      const server = serve({ tax: HELD, plan: { ...PLAN, assets: 200_000 } });
      const tab = await mount({ institutions: [] });
      await openAssets(tab);
      expect(tab.shown()).toContain(NOTE);
      expect(tab.shown()).not.toContain('Your own figure is shared out as these accounts are.');
      await openRow(tab, 'Your Roth contributions');
      await act(async () => type(field(tab.dialog()!, 'Put in so far')!, ''));
      await press(button(tab.dialog()!, 'Save'));
      expect(server.state.tax.rothContributions).toEqual([]);
      expect(tab.shown()).not.toContain(NOTE);
      await tab.unmount();
    });

    test('hide amounts masks it', async () => {
      serve({ tax: HELD });
      const { setAmountsHidden } = await import('@/lib/format');
      setAmountsHidden(true);
      try {
        const tab = await mount({ institutions: NO_ROTH });
        await openAssets(tab);
        expect(tab.shown()).toContain(NOTE);
        expect(tab.shown()).not.toContain('45,000');
        await tab.unmount();
      } finally {
        setAmountsHidden(false);
      }
    });
  });
});

describe('before the facts are known', () => {
  const STORED = { ...DEFAULT_TAX_FACTS, basis: [{ account_id: 'brk', amount: 120_000 }], owners: [{ account_id: 'brk', owner: 'partner' as const }], countAnyway: ['c'] };

  test('the plan’s answer failed: nothing can be saved over what is stored, and once it comes the level starts from it', async () => {
    const server = serve({ tax: STORED, plan: { ...PLAN, partnerAge: 40 } });
    const gate = planCanFail(true);
    const store = createPlanInputsStore();
    const tab = await mount({ planInputs: store });
    await settle(60);
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('What’s saved about your accounts hasn’t loaded, so this can’t be changed yet.');
    expect(field(tab.dialog()!, 'Cost basis')!.disabled).toBe(true);
    expect(button(tab.dialog()!, 'Save')!.disabled).toBe(true);
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts()).toEqual([]);
    gate.down = false;
    await act(async () => store.invalidate());
    await settle(60);
    expect(tab.shown()).not.toContain('hasn’t loaded');
    expect(field(tab.dialog()!, 'Cost basis')!.value).toBe('120000');
    // A fact unchanged isn't sent; one changed goes with the others as stored.
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '125000'));
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(server.facts()[0].body).toEqual({ kind: 'account', account_id: 'brk', owner: 'partner', basis: 125_000, count: false });
    expect(server.state.tax.owners).toEqual(STORED.owners);
    await tab.unmount();
  });

  test('a growth typed while they come stays once they do, and the facts start from what came', async () => {
    const server = serve({ tax: { ...STORED, futureKey: 1 } as unknown as TaxFacts, plan: { ...PLAN, partnerAge: 40 } });
    const store = createPlanInputsStore();
    const tab = await mount({ planInputs: store });
    await settle(60);
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('What’s saved about your accounts hasn’t loaded, so this can’t be changed yet. Its growth in this plan can still be changed.');
    await press(buttonShown(tab.dialog()!, 'Its own'));
    await act(async () => type(field(tab.dialog()!, 'Its growth after inflation')!, '7'));
    server.state.tax = STORED;
    await act(async () => store.invalidate());
    await settle(60);
    expect(tab.shown()).not.toContain('hasn’t loaded');
    expect(field(tab.dialog()!, 'Cost basis')!.value).toBe('120000');
    expect(field(tab.dialog()!, 'Its growth after inflation')!.value).toBe('7');
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(server.facts()).toEqual([]);
    expect(tab.title()).toBe('Invested assets');
    expect(subOf(tab, 'Brokerage')).toBe('Your partner’s · Cost basis $120,000 · gain $20,000 · grows 7%');
    await tab.unmount();
  });

  test('a Roth amount waits too', async () => {
    const server = serve({ tax: { ...DEFAULT_TAX_FACTS, rothContributions: [{ owner: 'you', amount: 45_000 }] } });
    planCanFail(true);
    const tab = await mount();
    await settle(60);
    await openAssets(tab);
    await openRow(tab, 'Your Roth contributions');
    expect(button(tab.dialog()!, 'Save')!.disabled).toBe(true);
    expect(server.facts()).toEqual([]);
    await tab.unmount();
  });

  test('facts this page can’t read, a newer release’s, aren’t known either', async () => {
    const server = serve({ tax: { ...STORED, futureKey: 1 } as unknown as TaxFacts });
    const tab = await mount();
    await settle(60);
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('hasn’t loaded');
    // Its facts are off; its growth isn't, which the button hands to the sheet.
    expect(field(tab.dialog()!, 'Cost basis')!.disabled).toBe(true);
    expect(buttonShown(tab.dialog()!, 'Save')).toBeNull();
    expect(buttonShown(tab.dialog()!, 'Done')!.disabled).toBe(false);
    await press(buttonShown(tab.dialog()!, 'Done'));
    expect(server.facts()).toEqual([]);
    expect(tab.title()).toBe('Invested assets');
    await tab.unmount();
  });

  test('none written is known: Save is on', async () => {
    serve();
    const tab = await mount();
    await settle(60);
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).not.toContain('hasn’t loaded');
    expect(button(tab.dialog()!, 'Save')!.disabled).toBe(false);
    await tab.unmount();
  });

  test('a reload that fails moves nothing: the rows and what a save sends stay as they were', async () => {
    const server = serve({ tax: STORED, plan: { ...PLAN, partnerAge: 40 } });
    const gate = planCanFail(false);
    const store = createPlanInputsStore();
    const tab = await mount({ planInputs: store });
    await settle(60);
    await openAssets(tab);
    const head = () => tab.dialog()!.findAll((e) => has(e, 'bucket-head')).map((h) => h.textContent);
    const before = subOf(tab, 'Brokerage');
    expect(before).toContain('Cost basis $120,000');
    expect(head()).toContain('Education$48,000');
    gate.down = true;
    await act(async () => store.invalidate());
    await settle(60);
    expect(store.get().plan?.status).toBe(500);
    expect(subOf(tab, 'Brokerage')).toBe(before);
    expect(head()).toContain('Education$48,000');
    await openRow(tab, 'Brokerage');
    expect(field(tab.dialog()!, 'Cost basis')!.value).toBe('120000');
    await act(async () => type(field(tab.dialog()!, 'Cost basis')!, '125000'));
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(server.facts()[0].body).toEqual({ kind: 'account', account_id: 'brk', owner: 'partner', basis: 125_000, count: false });
    await tab.unmount();
  });
});

describe('with a copy open', () => {
  /** The Plan with a copy open from the bar's Plans sheet. */
  async function inCopy(server: ReturnType<typeof serve>) {
    const tab = await mount();
    await press(part(tab.container, 'plan-bar')!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Plans'))[0]);
    await press(rowIn(tab.dialog()!, 'Stop at 52'));
    await press(rowIn(tab.dialog()!, 'Open it'));
    expect(server.calls.some((c) => c.url === '/api/plans')).toBe(true);
    return tab;
  }

  test('the facts are shared by every plan: they show, and each is off with the reason', async () => {
    const server = serve({ copies: true });
    const tab = await inCopy(server);
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('What is said about an account is the same in every plan: change it on your plan. Its growth is this copy’s own.');
    expect(field(tab.dialog()!, 'Cost basis')!.disabled).toBe(true);
    expect(buttonShown(tab.dialog()!, 'Save')).toBeNull();
    expect(buttonShown(tab.dialog()!, 'Done')!.disabled).toBe(false);
    await press(buttonShown(tab.dialog()!, 'Cancel'));
    await openRow(tab, 'Your Roth contributions');
    expect(field(tab.dialog()!, 'Put in so far')!.disabled).toBe(true);
    expect(button(tab.dialog()!, 'Save')!.disabled).toBe(true);
    expect(server.facts()).toEqual([]);
    await tab.unmount();
  });

  test('an amount held with no Roth account is off too, with the reason', async () => {
    const server = serve({ copies: true, tax: { ...DEFAULT_TAX_FACTS, rothContributions: [{ owner: 'you', amount: 45_000 }] } });
    const tab = await mount({ institutions: [{ ...INSTITUTIONS[0], accounts: INSTITUTIONS[0].accounts.filter((a) => a.account_id !== 'r') }] });
    await press(part(tab.container, 'plan-bar')!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Plans'))[0]);
    await press(rowIn(tab.dialog()!, 'Stop at 52'));
    await press(rowIn(tab.dialog()!, 'Open it'));
    await openAssets(tab);
    await openRow(tab, 'Your Roth contributions');
    expect(tab.shown()).toContain('What is said about an account is the same in every plan: change it on your plan.');
    expect(tab.shown()).not.toContain('Empty it and save to clear it.');
    expect(field(tab.dialog()!, 'Put in so far')!.disabled).toBe(true);
    expect(button(tab.dialog()!, 'Save')!.disabled).toBe(true);
    expect(server.facts()).toEqual([]);
    await tab.unmount();
  });
});

describe('each account’s own rate of return', () => {
  const DETAILED = { ...DEFAULT_TAX_FACTS, model: 'detailed' as const };
  // With tax worked out each render works out the tax (see the dividends' SLOW).
  const SLOW = 30_000;
  /** Fidelity's accounts under an item of their own, so what one test loads
   *  isn't another's (components/InvestmentActivity.tsx keeps a payload a minute). */
  const under = (item: string) => [{ ...INSTITUTIONS[0], item_id: item }, INSTITUTIONS[1]];
  const growthField = (tab: Tab) => field(tab.dialog()!, 'Its growth after inflation (% a year)');
  const NONE = 'No yearly rate for it yet: that takes more than a year of its balances, and what went in and out.';

  test('since it starts, after 3% inflation on a flat plan; Use sets its own, which the sheet’s Save keeps', async () => {
    const server = serve({ histories: { 'r1:brk': grown('2020-06-01', '2026-10-01', 0.091) } });
    const tab = await mount({ institutions: under('r1') });
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('Its rate of return since Oct 2021: 9.1% a year, about 5.9% after 3% inflation. A guide, not a forecast: a few strong years rarely repeat on cue.');
    expect(tab.shown()).not.toContain('A plan’s rates are');
    // Never put in by itself.
    expect(growthField(tab)).toBeNull();
    await press(buttonShown(tab.dialog()!, 'Use 5.9%'));
    expect(growthField(tab)!.value).toBe('5.9');
    expect(buttonShown(tab.dialog()!, 'Use 5.9%')).toBeNull();
    expect(server.saved()).toEqual([]);
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $105,000 · gain $35,000 · grows 5.9%');
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(server.saved().map((p: any) => p.accounts)).toEqual([[{ account_id: 'brk', growth: 0.059, yield: null }]]);
    await tab.unmount();
  });

  test('with tax worked out, after the plan’s own inflation; Use only where it would change its own', async () => {
    serve({ tax: DETAILED, choices: { ...DEFAULT_TAX_CHOICES, inflation: 0.025 }, plan: { ...PLAN, accounts: [{ account_id: 'brk', growth: 0.064, yield: null }] }, histories: { 'r2:brk': grown('2020-06-01', '2026-10-01', 0.091) }, rows: { 'r2:brk': yearRow('r2:brk', 2_800, 6_000) } });
    const tab = await mount({ institutions: under('r2') });
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('Its rate of return since Oct 2021: 9.1% a year, about 6.4% after 2.5% inflation.');
    expect(growthField(tab)!.value).toBe('6.4');
    expect(buttonShown(tab.dialog()!, 'Use 6.4%')).toBeNull();
    await act(async () => type(growthField(tab)!, '6'));
    await settle();
    expect(buttonShown(tab.dialog()!, 'Use 6.4%')).not.toBeNull();
    await tab.unmount();
  }, SLOW);

  test('none for an account with under a year of it, or no activity; one that can’t be loaded says so', async () => {
    serve({ histories: { 'r3:brk': grown('2026-02-01', '2026-10-01', 0.091), 'r3:r': 'fails' } });
    const tab = await mount({ institutions: under('r3') });
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain(NONE);
    expect(tab.shown()).not.toContain('Its rate of return');
    expect(buttonShown(tab.dialog()!, 'Use 5.9%')).toBeNull();
    await arrow(tab);
    await openRow(tab, '401(k)');
    expect(tab.shown()).toContain(NONE);
    await arrow(tab);
    await openRow(tab, 'Roth IRA');
    expect(tab.shown()).toContain('Its rate of return couldn’t be loaded.');
    expect(tab.shown()).not.toContain(NONE);
    await tab.unmount();
  });

  test('a rate that ends long before the balances says when it ends; past what a plan takes, Use takes the most', async () => {
    serve({ histories: { 'r4:brk': grown('2018-06-01', '2024-03-01', 0.3) } });
    const tab = await mount({ institutions: under('r4') });
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('Its rate of return from Mar 2019 to Mar 2024: 30% a year, about 26.2% after 3% inflation. A guide, not a forecast: a few strong years rarely repeat on cue. A plan’s rates are from -5% to 15%.');
    await press(buttonShown(tab.dialog()!, 'Use 15%'));
    expect(growthField(tab)!.value).toBe('15');
    await tab.unmount();
  });

  test('checking and savings, counted, ask nothing: a bank has no investment activity to give', async () => {
    const cash = { ...INSTITUTIONS[0], item_id: 'r6', accounts: [...INSTITUTIONS[0].accounts, { account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 5_000, currency: 'USD' }] };
    const server = serve({ plan: { ...PLAN, includeCash: true } });
    const tab = await mount({ institutions: [cash, INSTITUTIONS[1]] });
    await openAssets(tab);
    await openRow(tab, 'Checking');
    expect(tab.title()).toBe('Checking');
    expect(tab.shown()).toContain('Growth after inflation');
    expect(tab.shown()).not.toContain('rate of return');
    expect(tab.shown()).not.toContain(NONE);
    expect(server.calls.filter((c) => c.url.includes('id=chk'))).toEqual([]);
    await tab.unmount();
  });

  test('nothing is asked where its growth can’t be set: with your own figure for invested assets', async () => {
    const server = serve({ plan: { ...PLAN, assets: 200_000 }, histories: { 'r5:brk': grown('2020-06-01', '2026-10-01', 0.091) } });
    const tab = await mount({ institutions: under('r5') });
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(tab.shown()).toContain('every account grows at the plan’s 5% after inflation');
    expect(tab.shown()).not.toContain('rate of return');
    expect(tab.shown()).not.toContain(NONE);
    expect(server.calls.filter((c) => c.url.startsWith('/api/account-history') || c.url.startsWith('/api/investment-activity'))).toEqual([]);
    await tab.unmount();
  });
});

describe('Annual savings', () => {
  test('the split by bucket, from the last year’s contributions, the rest counted as taxable', async () => {
    serve();
    const tab = await mount();
    await press(tab.row('Annual savings'));
    await settle(60);
    expect(tab.shown()).toContain('Where it goes');
    expect(tab.dialog()!.findAll((e) => has(e, 'txn-detail-row')).map((r) => r.textContent)).toEqual(['Tax-deferred67%', 'Taxable33%']);
    expect(tab.shown()).toContain('From the last year’s contributions to each account.');
    await tab.unmount();
  });

  test('while rows are coming it says so', async () => {
    let letGo = () => {};
    serve({ hold: new Promise<void>((r) => (letGo = r)) });
    const tab = await mount();
    await press(tab.row('Annual savings'));
    expect(tab.shown()).toContain('Still reading contributions.');
    letGo();
    await settle(60);
    expect(tab.shown()).not.toContain('Still reading contributions.');
    await tab.unmount();
  });
});

describe('the rows asked for', () => {
  test('nothing for them until a sheet opens, once then, and a later load keeps them', async () => {
    const server = serve();
    const tab = await mount();
    await settle(60);
    // Workplace plans and a child's account, whose rows move the savings, as Home asks.
    expect(server.asked()).toEqual(['/api/plan-inputs?plan=i1%3Ak&plan=i2%3Ac', '/api/plan-inputs?sync=1&plan=i1%3Ak&plan=i2%3Ac']);
    await openAssets(tab);
    await settle(60);
    expect(server.asked().slice(2)).toEqual(['/api/plan-inputs?sync=1&plan=i1%3Abrk&plan=i1%3Ar&plan=i1%3Ah&plan=i1%3Ao']);
    expect(tab.store.get().rows['i1:brk'].dividends_12m).toBe(2_800);
    await act(async () => tab.store.invalidate());
    await settle(60);
    expect(tab.store.get().rows['i1:brk'].dividends_12m).toBe(2_800);
    await tab.unmount();
  });

  test('Home asks for none but those', async () => {
    const server = serve();
    const container = dom.document.createElement('ul');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={INSTITUTIONS} currency="USD" onOpenPlan={() => {}} planInputs={createPlanInputsStore()} />));
    await settle(60);
    expect(server.asked()).toEqual(['/api/plan-inputs?plan=i1%3Ak&plan=i2%3Ac', '/api/plan-inputs?sync=1&plan=i1%3Ak&plan=i2%3Ac']);
    await act(async () => root.unmount());
  });

  test('Home and the Plan count the same accounts, and move together on Count it', async () => {
    serve();
    const store = createPlanInputsStore();
    const container = dom.document.createElement('ul');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const tab = await mount({ planInputs: store });
    await act(async () => root.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={INSTITUTIONS} currency="USD" onOpenPlan={() => {}} planInputs={store} />));
    await settle(60);
    expect(container.textContent).toContain('$485,000');
    await openAssets(tab);
    await openRow(tab, 'NY 529 plan');
    await tick(tab);
    await press(button(tab.dialog()!, 'Save'));
    expect(container.textContent).toContain('$533,000');
    await act(async () => root.unmount());
    await tab.unmount();
  });
});

describe('each taxable account’s dividends', () => {
  const DETAILED = { ...DEFAULT_TAX_FACTS, model: 'detailed' as const };
  // Each render works out the tax, year by year: well within 5s here, but CI's
  // runner has taken over 5s for one of these (test/plan-detail-forms-view.test.tsx
  // gives its tests the same room).
  const SLOW = 30_000;
  const yieldField = (tab: Tab) => field(tab.dialog()!, 'Dividends and interest (% a year)');
  const ABOUT = 'Part of its growth, not on top of it: after you stop, it’s paid out and taxed each year, and the rest grows. A dividend its institution reports only as reinvested isn’t counted.';
  /** Opens an account, types its dividends, and hands them to the sheet. */
  async function setYield(tab: Tab, title: string, rate: string) {
    await openRow(tab, title);
    await act(async () => type(yieldField(tab)!, rate));
    await press(buttonShown(tab.dialog()!, 'Save'));
  }

  test('with tax worked out: empty is what it paid; its own handed to the sheet, kept by the sheet’s Save, and cleared the same way', async () => {
    const server = serve({ tax: DETAILED });
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(yieldField(tab)!.value).toBe('');
    expect(yieldField(tab)!.getAttribute('placeholder')).toBe('2');
    expect(tab.shown()).toContain(`Empty is what it paid over the last year, $2,800. ${ABOUT}`);
    expect(tab.shown()).not.toContain('From the last year’s activity.');
    await act(async () => type(yieldField(tab)!, '3'));
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(server.facts()).toEqual([]);
    expect(server.saved()).toEqual([]);
    expect(tab.title()).toBe('Invested assets');
    // Dividends move no growth: no row or blend line says otherwise.
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $105,000 · gain $35,000');
    expect(tab.shown()).not.toContain('together');
    expect(tab.shown()).toContain('An account’s growth and dividends are kept when you save. Cancel or close this, and what you set is dropped.');
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(server.saved().map((p: any) => p.accounts)).toEqual([[{ account_id: 'brk', growth: null, yield: 0.03 }]]);
    expect(tab.dialog()).toBeNull();
    await openAssets(tab);
    await setYield(tab, 'Brokerage', '');
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(server.saved()[1].accounts).toBeUndefined();
    await tab.unmount();
  }, SLOW);

  test('its own beside its own growth; out of range is refused under the field; Cancel drops both', async () => {
    const server = serve({ tax: DETAILED, plan: { ...PLAN, accounts: [{ account_id: 'brk', growth: 0.07, yield: null }] } });
    const tab = await mount();
    await openAssets(tab);
    await setYield(tab, 'Brokerage', '25');
    expect(tab.title()).toBe('Brokerage');
    expect(tab.shown()).toContain('Its dividends and interest must be from 0% to 20%.');
    await act(async () => type(yieldField(tab)!, '1.5'));
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(subOf(tab, 'Brokerage')).toBe('Cost basis $105,000 · gain $35,000 · grows 7%');
    await press(buttonShown(tab.dialog()!, 'Save'));
    expect(server.saved().map((p: any) => p.accounts)).toEqual([[{ account_id: 'brk', growth: 0.07, yield: 0.015 }]]);
    await openAssets(tab);
    await setYield(tab, 'Brokerage', '4');
    await closeDrawer(tab);
    expect(server.saved()).toHaveLength(1);
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(yieldField(tab)!.value).toBe('1.5');
    await tab.unmount();
  }, SLOW);

  test('a yield typed in Assumptions is what empty is', async () => {
    serve({ tax: DETAILED, choices: { ...DEFAULT_TAX_CHOICES, taxableYield: 0.015 } });
    const tab = await mount();
    await openAssets(tab);
    await openRow(tab, 'Brokerage');
    expect(yieldField(tab)!.getAttribute('placeholder')).toBe('1.5');
    expect(tab.shown()).toContain(`Empty is the plan’s 1.5%, set in Assumptions. ${ABOUT}`);
    await tab.unmount();
  }, SLOW);

  test('without tax worked out, or with your own figure, what it paid is said and there is nothing to set', async () => {
    for (const plan of [PLAN, { ...PLAN, assets: 200_000 }]) {
      serve({ tax: plan === PLAN ? DEFAULT_TAX_FACTS : DETAILED, plan });
      const tab = await mount();
      await openAssets(tab);
      await openRow(tab, 'Brokerage');
      expect(yieldField(tab)).toBeNull();
      expect(tab.shown()).toContain('From the last year’s activity.');
      await tab.unmount();
    }
  }, SLOW);

  test('hide amounts masks what it paid, never a rate', async () => {
    serve({ tax: DETAILED });
    const { setAmountsHidden } = await import('@/lib/format');
    setAmountsHidden(true);
    try {
      const tab = await mount();
      await openAssets(tab);
      await openRow(tab, 'Brokerage');
      expect(tab.shown()).toContain('Empty is what it paid over the last year, ');
      expect(tab.shown()).not.toContain('2,800');
      expect(yieldField(tab)!.getAttribute('placeholder')).toBe('2');
      await tab.unmount();
    } finally {
      setAmountsHidden(false);
    }
  }, SLOW);

  test('Assumptions, with tax worked out: the buckets drift apart, and an account’s own dividends come first', async () => {
    serve({ tax: DETAILED, plan: { ...PLAN, accounts: [{ account_id: 'brk', growth: 0.07, yield: null }] } });
    const tab = await mount();
    await press(tab.row('Assumptions'));
    await settle(60);
    expect(tab.shown()).toContain(
      'With 1 account at its own, yours grow 5.58% a year together. On Drawdown, from the stop on, taxable, tax-deferred, Roth and HSA money each grow at their own accounts’ rates, so together they drift from 5.58%.'
    );
    expect(tab.shown()).toContain('Empty is what your accounts paid over the last year. An account’s own, set in Invested assets, comes first.');
    // A number under a label that already says %, as every percent field's.
    expect(field(tab.dialog()!, 'Dividends and interest on taxable accounts (% a year)')!.getAttribute('placeholder')).toBe('2');
    expect(tab.shown()).toContain(
      'For years to FI, Coast FI, the balance at your stop age and the steady years on Drawdown. Your FI number’s tax and health coverage come from the steady years. The stress test uses market history for its returns instead, and works out each year’s tax and health coverage on them.'
    );
    await tab.unmount();
  }, SLOW);

  test('dividends of its own count toward what a plan keeps: one more is refused under its field', async () => {
    const many = Array.from({ length: 50 }, (_, i) => acct(`a${String(i).padStart(2, '0')}`, `Fund ${i}`, '401k', 10_000));
    const held = many.map((a) => ({ account_id: a.account_id, growth: 0.06, yield: null }));
    serve({ tax: DETAILED, plan: { ...PLAN, accounts: held } });
    const tab = await mount({ institutions: [{ ...INSTITUTIONS[0], accounts: [...many, acct('brk', 'Brokerage', 'brokerage', 140_000)] }] });
    await openAssets(tab);
    await setYield(tab, 'Brokerage', '3');
    expect(tab.title()).toBe('Brokerage');
    expect(tab.shown()).toContain('A plan keeps its own growth or dividends for 50 accounts at most: set one of them back to the plan’s first.');
    expect(yieldField(tab)!.getAttribute('aria-invalid')).toBe('true');
    await tab.unmount();
  }, SLOW);
});

describe('detailed tax saved, in another currency', () => {
  const HELD = 'Worked-out tax needs US dollars; using a flat 15%.';
  const open = async (tab: Tab) => {
    await press(tab.row('Assumptions'));
    await settle(60);
  };

  test('a caution on Assumptions and a notice by the rate, never silently', async () => {
    serve({ tax: { ...DEFAULT_TAX_FACTS, model: 'detailed' }, plan: { ...PLAN, taxRate: 0.15 }, currency: 'EUR' });
    const tab = await mount({ currency: 'EUR' });
    await settle(60);
    expect(tab.container.textContent).toContain(HELD);
    await open(tab);
    const notices = tab.dialog()!.findAll((e) => has(e, 'notice') && e.textContent.includes(HELD));
    expect(notices).toHaveLength(1);
    expect(has(notices[0], 'caution')).toBe(true);
    await tab.unmount();
  });

  test('the flat model draws neither', async () => {
    serve({ plan: { ...PLAN, taxRate: 0.15 }, currency: 'EUR' });
    const tab = await mount({ currency: 'EUR' });
    await settle(60);
    expect(tab.container.textContent).not.toContain(HELD);
    await open(tab);
    expect(tab.shown()).not.toContain(HELD);
    await tab.unmount();
  });
});

describe('the start from what you’d have at your stop age', () => {
  const options = (tab: Tab) => tab.dialog()!.findAll((e) => e.tagName === 'OPTION').map((e) => e.textContent);
  const open = async (tab: Tab) => {
    await press(tab.row('Assumptions'));
    await settle(60);
  };

  test('is an option for a plan on it, and for any other', async () => {
    for (const plan of [{ ...PLAN, start: 'at-stop' as const }, PLAN]) {
      serve({ plan });
      const tab = await mount();
      await settle(60);
      await open(tab);
      expect(options(tab).filter((o) => o.includes('at my stop age'))).toHaveLength(1);
      await tab.unmount();
    }
  });
});
