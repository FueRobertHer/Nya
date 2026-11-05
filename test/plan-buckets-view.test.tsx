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
// together on a fact. Every request is answered here.

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
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type TaxFacts = import('@/lib/fire/tax-facts').TaxFacts;
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
function serve(over: { tax?: TaxFacts; plan?: typeof PLAN; refuse?: string; rows?: Record<string, ReturnType<typeof yearRow>>; hold?: Promise<void>; copies?: boolean } = {}) {
  const calls: Call[] = [];
  const state = { tax: over.tax ?? DEFAULT_TAX_FACTS, plan: over.plan ?? PLAN, refuse: over.refuse ?? null, settings: { version: 1, target: null, buckets: [], funds: [], accounts: [] } as any };
  const rows = over.rows ?? { 'i1:brk': yearRow('i1:brk', 2_800, 6_000), 'i1:k': yearRow('i1:k', 0, 20_000) };
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = new URL(url, 'http://nya.test');
    const call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const plan = () => ({ plan: state.plan, currency: 'USD', tax_facts: state.tax });
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
    if (u.pathname === '/api/plans' && method === 'GET') {
      const [status, body] = plansListing(state.plan, over.copies ? [copyRow(state.plan, 'a', 'Stop at 52', { targetAge: 52 })] : []);
      return json(body, status as number);
    }
    if (u.pathname === '/api/allocation-settings') {
      if (method === 'PUT') state.settings = call.body.settings ?? call.body;
      return json({ settings: state.settings });
    }
    return json({ error: 'not here' }, 404);
  };
  return { calls, state, facts: () => calls.filter((c) => c.url === '/api/plan-facts'), asked: () => calls.filter((c) => c.url.startsWith('/api/plan-inputs')).map((c) => c.url) };
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
  const all = { txns: [], txnsLoading: false, txnNotes: [], institutions: INSTITUTIONS, balancesAsOf: '2026-10-31T13:41:00.000Z', currency: 'USD', holdings: HOLDINGS, planInputs: store, childOut: true, ...props } as PlanTabProps;
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
    expect(tab.shown()).toContain('Each account’s bucket comes from its type; change one that is in another.');
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

  test('with the switch off: no group left out, and the 529 counts under Education', async () => {
    serve();
    const tab = await mount({ childOut: false });
    await openAssets(tab);
    expect(tab.shown()).not.toContain('Left out');
    expect(tab.dialog()!.findAll((e) => has(e, 'bucket-head')).map((h) => h.textContent)).toContain('Education$48,000');
    await tab.unmount();
  });

  test('gaps are quiet in the flat model: a neutral badge, and no caution at all', async () => {
    serve();
    const tab = await mount();
    await openAssets(tab);
    const d = tab.dialog()!;
    const roth = rowIn(d, 'Your Roth contributions')!;
    const badge = part(roth, 'badge')!;
    expect(badge.textContent).toBe('Put in not set');
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
    const NOTE = 'No Roth account is counted, so your plan doesn’t use this for now. Open it to change or clear it.';

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
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts()[0].body).toEqual({ kind: 'account', account_id: 'brk', owner: 'partner', basis: 120_000, count: false });
    expect(server.state.tax.owners).toEqual(STORED.owners);
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
    expect(button(tab.dialog()!, 'Save')!.disabled).toBe(true);
    expect(server.facts()).toEqual([]);
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
    await press(button(tab.dialog()!, 'Save'));
    expect(server.facts()[0].body).toEqual({ kind: 'account', account_id: 'brk', owner: 'partner', basis: 120_000, count: false });
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
    expect(tab.shown()).toContain('What is said about an account is the same in every plan: change it on your plan.');
    expect(field(tab.dialog()!, 'Cost basis')!.disabled).toBe(true);
    expect(button(tab.dialog()!, 'Save')!.disabled).toBe(true);
    await press(button(tab.dialog()!, 'Cancel'));
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
    // Workplace plans alone, as Home asks.
    expect(server.asked()).toEqual(['/api/plan-inputs?plan=i1%3Ak', '/api/plan-inputs?sync=1&plan=i1%3Ak']);
    await openAssets(tab);
    await settle(60);
    expect(server.asked().slice(2)).toEqual(['/api/plan-inputs?sync=1&plan=i1%3Abrk&plan=i1%3Ar&plan=i1%3Ah&plan=i1%3Ao&plan=i2%3Ac']);
    expect(tab.store.get().rows['i1:brk'].dividends_12m).toBe(2_800);
    await act(async () => tab.store.invalidate());
    await settle(60);
    expect(tab.store.get().rows['i1:brk'].dividends_12m).toBe(2_800);
    await tab.unmount();
  });

  test('Home asks for none', async () => {
    const server = serve();
    const container = dom.document.createElement('ul');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={INSTITUTIONS} currency="USD" onOpenPlan={() => {}} planInputs={createPlanInputsStore()} childOut />));
    await settle(60);
    expect(server.asked()).toEqual(['/api/plan-inputs?plan=i1%3Ak', '/api/plan-inputs?sync=1&plan=i1%3Ak']);
    await act(async () => root.unmount());
  });

  test('Home and the Plan count the same accounts, and move together on Count it', async () => {
    serve();
    const store = createPlanInputsStore();
    const container = dom.document.createElement('ul');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const tab = await mount({ planInputs: store });
    await act(async () => root.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={INSTITUTIONS} currency="USD" onOpenPlan={() => {}} planInputs={store} childOut />));
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

describe('detailed tax saved, while it can’t be worked out', () => {
  const HELD = 'Worked-out tax is paused; using a flat 15%.';
  const open = async (tab: Tab) => {
    await press(tab.row('Assumptions'));
    await settle(60);
  };

  test('a caution on Assumptions and a notice by the rate, never silently', async () => {
    serve({ tax: { ...DEFAULT_TAX_FACTS, model: 'detailed' }, plan: { ...PLAN, taxRate: 0.15 } });
    const tab = await mount();
    await settle(60);
    expect(tab.container.textContent).toContain(HELD);
    await open(tab);
    const notices = tab.dialog()!.findAll((e) => has(e, 'notice') && e.textContent.includes(HELD));
    expect(notices).toHaveLength(1);
    expect(has(notices[0], 'caution')).toBe(true);
    await tab.unmount();
  });

  test('the flat model draws neither', async () => {
    serve({ plan: { ...PLAN, taxRate: 0.15 } });
    const tab = await mount();
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

  test('is an option only for a plan already on it', async () => {
    serve({ plan: { ...PLAN, start: 'at-stop' } });
    const tab = await mount();
    await settle(60);
    await open(tab);
    expect(options(tab).filter((o) => o.includes('at my stop age'))).toHaveLength(1);
    await tab.unmount();
  });

  test('and isn’t offered to any other', async () => {
    serve();
    const tab = await mount();
    await settle(60);
    await open(tab);
    expect(options(tab).filter((o) => o.includes('at my stop age'))).toHaveLength(0);
    await tab.unmount();
  });
});
