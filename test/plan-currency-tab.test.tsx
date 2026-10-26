import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { installDom, click, outline, pressThrough, type, FakeElement } from './mini-dom';

// The Plan tab and the currency its typed figures are in, rendered
// (react-dom/client over test/mini-dom.ts):
//   - a plan saved before the currency was recorded gets it recorded at once
//     when the accounts, truly loaded (never the dashboard's saved copy), show
//     it reliably, and is asked about otherwise (a tie, spending elsewhere,
//     nothing in sight, with any code offered), with nothing saved meanwhile;
//   - a record that no longer fits is asked about, its currency first, and
//     never replaced on the tab's own;
//   - the save that gives a plan its first amount records the currency in
//     its own write, and nothing about the currency starts while a save is
//     under way;
//   - a recorded currency stays whatever the accounts' count does, each save
//     sends it, and changing it is confirmed first and can be undone;
//   - the card announces what it records and its errors, and with amounts
//     hidden it names currencies, never an amount.
// Every request is answered here, by path; nothing reaches a network.
//
// A rendered element never goes into a matcher that diffs (see
// test/plan-tab-scenarios.test.tsx): elements are counted, or outlined first.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: PlanTab } = await import('@/components/PlanTab');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { typedAmounts } = await import('@/lib/fire/plan-currency');
const { MASK, setAmountsHidden } = await import('@/lib/format');
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type AssetInstitution = import('@/lib/fire/inputs').AssetInstitution;
type AssetAccount = import('@/lib/fire/inputs').AssetAccount;
type Txn = import('@/components/MonthBreakdown').Txn;

afterEach(() => setAmountsHidden(false));

// Spending typed, assets measured: what the accounts hold counts.
const PLAN = { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000 };
const UNTYPED = { ...DEFAULT_PLAN, age: 40 };
const AS_OF = '2026-10-23T12:00:00.000Z';
const USD = (over: Partial<AssetAccount> = {}): AssetAccount => ({ account_id: 'usd', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balance: 300_000, currency: 'USD', ...over });
const EUR = (over: Partial<AssetAccount> = {}): AssetAccount => ({ account_id: 'eur', name: 'Depot', type: 'investment', subtype: 'brokerage', balance: 250_000, currency: 'EUR', ...over });
const broker = (accounts: AssetAccount[]): AssetInstitution[] => [{ name: 'Broker', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts }];

type Call = { method: string; url: string; body: any };
type Answer = (call: Call) => [number, unknown] | Promise<[number, unknown]>;

function serve(answers: Record<string, Answer | [number, unknown]>) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const a = answers[`${call.method} ${url}`];
    const [status, body] = typeof a === 'function' ? await a(call) : (a ?? [404, { error: 'not here' }]);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

/** A plan route on a fake server that keeps the plan and its record as the
 *  real one does: a record holds while its amounts are the plan's, and only
 *  the person's answer replaces one. */
function planServer(start: { plan: any; record?: { currency: string; amounts: unknown } | null }) {
  const s = { plan: start.plan, record: start.record ?? null };
  const fits = () => !!s.record && JSON.stringify(s.record.amounts) === JSON.stringify(typedAmounts(s.plan));
  const typed = () => s.plan && JSON.stringify(typedAmounts(s.plan)) !== JSON.stringify(typedAmounts(DEFAULT_PLAN));
  const answer = () => {
    if (!s.plan || !typed()) return { plan: s.plan, currency: null };
    if (fits()) return { plan: s.plan, currency: s.record!.currency };
    return s.record ? { plan: s.plan, currency: null, currency_problem: 'stale', currency_was: s.record.currency } : { plan: s.plan, currency: null };
  };
  return {
    s,
    answers: {
      'GET /api/fire-plan': (): [number, unknown] => [200, answer()],
      'PUT /api/fire-plan': (c: Call): [number, unknown] => {
        if (c.body.currency) s.record = { currency: c.body.currency, amounts: typedAmounts(c.body.plan) };
        s.plan = c.body.plan;
        return [200, answer()];
      },
      'POST /api/fire-plan': (c: Call): [number, unknown] => {
        if (JSON.stringify(c.body.amounts) !== JSON.stringify(typedAmounts(s.plan))) return [409, { error: 'Your plan was changed since this page loaded it, so nothing was recorded: load it again.', stale: true }];
        if (s.record && !c.body.answered && !(fits() && s.record.currency === c.body.currency)) return [409, { error: 'A currency is recorded for your plan already.', stale: true }];
        s.record = { currency: c.body.currency, amounts: c.body.amounts };
        return [200, answer()];
      },
      'GET /api/plan-scenarios': [200, EMPTY] as [number, unknown],
      'GET /api/allocation-settings': [200, { settings: null }] as [number, unknown],
    },
  };
}

const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const EMPTY = { scenarios: [], unreadable_ids: [], unrecognised_ids: [] };

async function render(props: Partial<PlanTabProps> = {}) {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const all: PlanTabProps = { txns: [], txnsLoading: false, txnNotes: [], institutions: broker([USD()]), balancesAsOf: AS_OF, currency: 'USD', holdings: [], ...props };
  await act(async () => root.render(<PlanTab {...all} />));
  await settle();
  const region = () => container.findAll((e) => e.getAttribute('aria-label') === 'Your plan’s currency')[0] ?? null;
  return {
    rerender: async (more: Partial<PlanTabProps>) => {
      await act(async () => root.render(<PlanTab {...all} {...more} />));
      await settle();
    },
    unmount: () => act(async () => root.unmount()),
    text: () => container.textContent,
    byLabel: (label: string) => container.findAll((e) => e.getAttribute('aria-label') === label)[0] ?? null,
    buttons: (text: string) => container.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === text),
    dialog: () => container.findAll((e) => e.getAttribute('role') === 'dialog')[0] ?? null,
    /** The drawer open now, not one sliding out (for a third of a second). */
    openDialog: () => container.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null,
    container,
    region,
    /** The card's words, without the list of every currency's name. */
    said: () => {
      const r = region();
      if (!r) return '';
      const options = r.findAll((e) => e.tagName === 'OPTION').map((o) => o.textContent);
      let t = r.textContent;
      for (const o of options) t = t.replace(o, '');
      return t;
    },
    status: () => container.findAll((e) => e.getAttribute('role') === 'status').map((e) => e.textContent).join(' '),
    alerts: () => container.findAll((e) => e.getAttribute('role') === 'alert').map((e) => e.textContent),
  };
}

const press = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => click(el));
  await settle();
};
const posts = (calls: Call[]) => calls.filter((c) => c.url === '/api/fire-plan' && c.method === 'POST');
const puts = (calls: Call[]) => calls.filter((c) => c.url === '/api/fire-plan' && c.method === 'PUT');
const gets = (calls: Call[]) => calls.filter((c) => c.url === '/api/fire-plan' && c.method === 'GET');

/** Types a spending figure into its form and saves it. */
async function saveSpending(tab: Awaited<ReturnType<typeof render>>, value: string, settleMs = 400) {
  await press(tab.byLabel('Edit annual spending'));
  const dialog = tab.dialog()!;
  const own = dialog.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'My own')[0];
  if (own && own.getAttribute('aria-pressed') !== 'true') await press(own);
  const field = dialog.findAll((e) => e.tagName === 'INPUT')[0];
  await act(async () => type(field, value));
  await press(dialog.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0]);
  await settle(settleMs);
  return dialog;
}

/** Picks a code from the card's list of every currency, and presses it. */
async function another(tab: Awaited<ReturnType<typeof render>>, code: string, verb = 'They’re in') {
  const select = tab.region()!.findAll((e) => e.tagName === 'SELECT')[0];
  await act(async () => type(select, code));
  await press(tab.buttons(`${verb} ${code}`)[0]);
}

describe('a plan saved before its currency was recorded', () => {
  test('shown in a currency that can be told reliably: recorded at once, for the plan as stored, announced, and then editable', async () => {
    const server = planServer({ plan: PLAN });
    const calls = serve(server.answers);
    const tab = await render();
    expect(posts(calls).map((c) => c.body)).toEqual([{ currency: 'USD', amounts: typedAmounts(PLAN) }]);
    expect(tab.said()).toContain('Your plan’s figures are in USD, the currency they were typed in.');
    expect(tab.status()).toContain('Your plan’s figures are recorded as USD.');
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(false);
    expect(tab.text()).toContain('$1,000,000');
    await tab.unmount();
  });

  test('while the accounts load: nothing recorded, nothing asked yet, nothing saved, and it says it waits', async () => {
    const calls = serve(planServer({ plan: PLAN }).answers);
    const tab = await render({ balancesAsOf: null, txns: null, txnsLoading: true });
    expect(posts(calls).length).toBe(0);
    expect(tab.said()).toBe('Nya is waiting for your accounts to load to tell which currency your plan’s figures are in. Nothing on the Plan is saved until it can.');
    expect(tab.region()!.findAll((e) => e.tagName === 'BUTTON').length).toBe(0);
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(true);
    await tab.unmount();
  });

  test('the transactions in, the balances not: still loading, nothing recorded', async () => {
    const calls = serve(planServer({ plan: PLAN }).answers);
    const tab = await render({ balancesAsOf: null });
    expect(posts(calls).length).toBe(0);
    await tab.rerender({ balancesAsOf: AS_OF });
    expect(posts(calls).map((c) => c.body.currency)).toEqual(['USD']);
    await tab.unmount();
  });

  test('the dashboard’s saved copy of the balances, whatever its date: nothing recorded from it, until its own load answers', async () => {
    const calls = serve(planServer({ plan: PLAN }).answers);
    const tab = await render({ balancesSaved: true });
    expect(posts(calls).length).toBe(0);
    await tab.rerender({ balancesSaved: false });
    expect(posts(calls).map((c) => c.body.currency)).toEqual(['USD']);
    await tab.unmount();
  });

  test('a tie between two currencies: asked, never guessed; nothing on the Plan saves until the person says, and then it stays in what they said', async () => {
    const server = planServer({ plan: PLAN });
    const calls = serve(server.answers);
    // As many accounts in each: the order puts EUR first, so it is shown in EUR.
    const tab = await render({ institutions: broker([EUR(), USD()]) });
    expect(posts(calls).length).toBe(0);
    expect(tab.said()).toContain('They’re shown in EUR for now, the currency most of your invested accounts are in, but as many of your invested accounts are in another currency');
    expect(tab.text()).toContain('€1,000,000');
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(true);
    expect(tab.byLabel('Edit annual spending')?.disabled).toBe(true);
    expect(tab.buttons('They’re in EUR').length).toBe(1);
    await press(tab.buttons('They’re in USD')[0]);
    expect(posts(calls).map((c) => c.body)).toEqual([{ currency: 'USD', amounts: typedAmounts(PLAN), answered: true }]);
    // In USD now: the spending as typed, the euros not counted as dollars.
    expect(tab.text()).toContain('$1,000,000');
    expect(tab.text()).not.toContain('€1,000,000');
    expect(tab.said()).toContain('Your plan’s figures are in USD, the currency they were typed in, and stay in it. Some of your accounts are in EUR');
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(false);
    expect(puts(calls).length).toBe(0);
    await tab.unmount();
  });

  test('a USD brokerage with the spending in EUR: asked, rather than recorded in the currency that would leave most of the spending out', async () => {
    const calls = serve(planServer({ plan: PLAN }).answers);
    const rows = [
      { transaction_id: 'e1', date: '2025-11-01', name: 'Shop', amount: 100, pending: false, account_name: 'Konto', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'EUR' },
      { transaction_id: 'e2', date: '2026-09-01', name: 'Shop', amount: 100, pending: false, account_name: 'Konto', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'EUR' },
    ] as Txn[];
    const tab = await render({ txns: rows });
    expect(posts(calls).length).toBe(0);
    expect(tab.said()).toContain('but most of your spending is in another currency');
    expect(tab.buttons('They’re in USD').length).toBe(1);
    expect(tab.buttons('They’re in EUR').length).toBe(1);
    await tab.unmount();
  });

  test('a record that can’t be read: asked, and the answer replaces it, as only the person’s may', async () => {
    const calls = serve({
      ...planServer({ plan: PLAN }).answers,
      'GET /api/fire-plan': [200, { plan: PLAN, currency: null, currency_problem: 'unreadable' }],
      'POST /api/fire-plan': (c) => [200, { plan: PLAN, currency: c.body.currency }],
    });
    const tab = await render();
    // Not recorded on its own, even though USD can be told: the bytes there aren't the tab's to replace.
    expect(posts(calls).length).toBe(0);
    expect(tab.said()).toContain('The record of the currency your plan’s figures are in couldn’t be read.');
    await press(tab.buttons('They’re in USD')[0]);
    expect(posts(calls).map((c) => c.body)).toEqual([{ currency: 'USD', amounts: typedAmounts(PLAN), answered: true }]);
    expect(tab.said()).toContain('Your plan’s figures are in USD');
    await tab.unmount();
  });

  test('nothing in sight to offer: any code from the list, so the Plan is never locked', async () => {
    const calls = serve(planServer({ plan: PLAN }).answers);
    const tab = await render({ institutions: [], txns: [], currency: null });
    expect(posts(calls).length).toBe(0);
    expect(tab.said()).toContain('Which currency are they in?');
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(true);
    await another(tab, 'JPY');
    expect(posts(calls).map((c) => [c.body.currency, c.body.answered])).toEqual([['JPY', true]]);
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(false);
    await tab.unmount();
  });
});

describe('a record that no longer fits', () => {
  test('never replaced on the tab’s own, even when the accounts tell another currency reliably: asked, its own currency first', async () => {
    // Recorded USD for other amounts (a save that didn't finish, say); every account in EUR now.
    const server = planServer({ plan: { ...PLAN, spending: 60_000 }, record: { currency: 'USD', amounts: typedAmounts(PLAN) } });
    const calls = serve(server.answers);
    const tab = await render({ institutions: broker([EUR()]), currency: 'EUR' });
    expect(posts(calls).length).toBe(0);
    expect(tab.said()).toContain('Nya recorded your plan’s figures as USD, but they were changed since in a way that didn’t record a currency');
    const offered = tab.region()!.findAll((e) => e.tagName === 'BUTTON').map((b) => b.textContent.trim());
    expect(offered.slice(0, 2)).toEqual(['They’re still in USD', 'They’re in EUR']);
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(true);
    await press(tab.buttons('They’re still in USD')[0]);
    expect(posts(calls).map((c) => c.body)).toEqual([{ currency: 'USD', amounts: typedAmounts({ ...PLAN, spending: 60_000 }), answered: true }]);
    expect(tab.text()).toContain('$1,500,000');
    await tab.unmount();
  });
});

describe('the first amount', () => {
  test('its save records the currency in its own write, and nothing else is sent', async () => {
    const server = planServer({ plan: UNTYPED });
    const calls = serve(server.answers);
    const tab = await render();
    await saveSpending(tab, '40000');
    expect(puts(calls).map((c) => [c.body.currency, c.body.plan.spending])).toEqual([['USD', 40_000]]);
    expect(posts(calls).length).toBe(0);
    expect(server.s.record).toEqual({ currency: 'USD', amounts: typedAmounts({ ...UNTYPED, spending: 40_000 }) });
    expect(tab.said()).toContain('Your plan’s figures are in USD');
    await tab.unmount();
  });

  test('while its save is under way, nothing about the currency starts, and no reload lands in between', async () => {
    const server = planServer({ plan: UNTYPED });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const calls = serve({
      ...server.answers,
      'PUT /api/fire-plan': async (c) => {
        await held;
        return server.answers['PUT /api/fire-plan'](c);
      },
    });
    const tab = await render();
    await saveSpending(tab, '40000', 200);
    // The save is out and held: the page shows the plan with the amount, and asks nothing.
    expect(puts(calls).length).toBe(1);
    expect(posts(calls).length).toBe(0);
    expect(gets(calls).length).toBe(1);
    expect(tab.region()?.textContent ?? '').not.toContain('Which currency');
    release();
    await settle(400);
    expect(posts(calls).length).toBe(0);
    expect(gets(calls).length).toBe(1);
    expect(server.s.plan.spending).toBe(40_000);
    expect(tab.text()).toContain('$1,000,000');
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(false);
    // The next save keeps the amount.
    await press(tab.byLabel('Edit your ages'));
    await press(tab.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0]);
    expect(puts(calls).map((c) => c.body.plan.spending)).toEqual([40_000, 40_000]);
    await tab.unmount();
  });

  test('a save under way holds back the tab’s own record, even once the accounts can tell it, until the save is answered', async () => {
    const server = planServer({ plan: PLAN });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const calls = serve({
      ...server.answers,
      'PUT /api/fire-plan': async (c) => {
        await held;
        return server.answers['PUT /api/fire-plan'](c);
      },
    });
    // Not known, and the balances not in yet: nothing recorded, nothing saved.
    const tab = await render({ balancesAsOf: null });
    expect(posts(calls).length).toBe(0);
    // A save got past the disabled controls (test/mini-dom.ts pressThrough): held open.
    await act(async () => void pressThrough(tab.byLabel('Edit your ages')!));
    await settle();
    await act(async () => void pressThrough(tab.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0]));
    await settle();
    expect(puts(calls).length).toBe(1);
    await tab.rerender({ balancesAsOf: AS_OF });
    expect(posts(calls).length).toBe(0);
    release();
    await settle(400);
    // Answered: now the tab records it, for the plan the server holds.
    expect(posts(calls).map((c) => c.body)).toEqual([{ currency: 'USD', amounts: typedAmounts(PLAN) }]);
    await tab.unmount();
  });

  test('with no currency in sight: asked first, from any code, and the save waits for it (a plan never saved, too)', async () => {
    const server = planServer({ plan: null });
    const calls = serve(server.answers);
    const tab = await render({ institutions: [], txns: [], currency: null });
    expect(tab.said()).toContain('Which currency will you type your plan’s figures in?');
    const dialog = await saveSpending(tab, '40000');
    expect(puts(calls).length).toBe(0);
    expect(dialog.textContent).toContain('Say which currency you type your plan’s figures in first');
    await press(dialog.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Cancel')[0]);
    await settle(400);
    await another(tab, 'JPY', 'In');
    expect(tab.said()).toContain('You’ll type your plan’s figures in JPY');
    await saveSpending(tab, '4000000');
    expect(puts(calls).map((c) => [c.body.currency, c.body.plan.spending])).toEqual([['JPY', 4_000_000]]);
    expect(tab.said()).toContain('Your plan’s figures are in JPY');
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(false);
    await tab.unmount();
  });
});

describe('a recorded currency', () => {
  const answers = (): Record<string, Answer | [number, unknown]> => ({
    'GET /api/fire-plan': [200, { plan: PLAN, currency: 'USD' }],
    'PUT /api/fire-plan': (c) => [200, { plan: c.body.plan, currency: c.body.currency }],
    'GET /api/plan-scenarios': [200, EMPTY],
    'GET /api/allocation-settings': [200, { settings: null }],
  });

  test('stays whatever the accounts’ count does: a tie, a hidden account, a balance that reads empty', async () => {
    serve(answers());
    const tab = await render({ institutions: broker([USD(), EUR()]) });
    expect(tab.text()).toContain('$1,000,000');
    for (const institutions of [broker([EUR(), USD()]), broker([USD({ hidden: true }), EUR()]), broker([USD({ balance: null }), EUR()]), broker([EUR()])]) {
      await tab.rerender({ institutions });
      expect(tab.text()).toContain('$1,000,000');
      // The FI number in dollars, as typed; the euros only named where they are left out.
      expect(tab.text()).not.toContain('€1,000,000');
      expect(tab.said()).not.toContain('Which currency');
    }
    expect(tab.said()).toContain('Your plan’s figures are in USD, the currency they were typed in, and stay in it. Your accounts are in EUR: without a home currency nothing is converted');
    expect(tab.buttons('They’re in EUR').length).toBe(1);
    await tab.unmount();
  });

  test('each save sends it with the plan', async () => {
    const calls = serve(answers());
    const tab = await render();
    await press(tab.byLabel('Edit your ages'));
    await press(tab.buttons('Save')[0]);
    expect(puts(calls).map((c) => [c.body.currency, c.body.plan.spending])).toEqual([['USD', 40_000]]);
    await tab.unmount();
  });

  test('changing it is confirmed first, with what it means, and the one before is offered back', async () => {
    const server = planServer({ plan: PLAN, record: { currency: 'USD', amounts: typedAmounts(PLAN) } });
    const calls = serve(server.answers);
    const tab = await render({ institutions: broker([EUR()]), currency: 'EUR' });
    await press(tab.buttons('They’re in EUR')[0]);
    // Nothing yet: the drawer says what it means.
    expect(posts(calls).length).toBe(0);
    const dialog = tab.dialog()!;
    expect(dialog.textContent).toContain('Read your plan’s figures as EUR, not USD?');
    expect(dialog.textContent).toContain('Every figure you typed in your plan is then read in EUR, exactly as typed: nothing is converted.');
    await press(dialog.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Read them as EUR')[0]);
    expect(posts(calls).map((c) => [c.body.currency, c.body.answered])).toEqual([['EUR', true]]);
    expect(tab.text()).toContain('€1,000,000');
    expect(tab.said()).toContain('Changed from USD.');
    await press(tab.buttons('They’re in USD')[0]);
    expect(posts(calls).map((c) => [c.body.currency, c.body.answered])).toEqual([
      ['EUR', true],
      ['USD', true],
    ]);
    expect(tab.text()).toContain('$1,000,000');
    // Change, always there: confirmed the same way.
    await press(tab.byLabel('Change the currency your plan’s figures are in'));
    expect(tab.dialog()!.textContent).toContain('They’re recorded as USD.');
    await tab.unmount();
  });

  test('an answer that isn’t recorded says why, as an alert', async () => {
    serve({ ...planServer({ plan: PLAN }).answers, 'POST /api/fire-plan': [500, { error: 'Failed to record the currency of plan assumptions' }] });
    const tab = await render({ institutions: broker([EUR(), USD()]) });
    await press(tab.buttons('They’re in USD')[0]);
    expect(tab.alerts()).toContain('Failed to record the currency of plan assumptions');
    await tab.unmount();
  });
});

describe('scenarios against the Plan’s currency', () => {
  const scenario = (id: string, name: string, currency: string) => ({
    id,
    version: 1,
    name,
    currency,
    createdAt: '2026-10-01T00:00:00.000Z',
    savedAt: '2026-10-01T00:00:00.000Z',
    rev: 'r1',
    set: { targetAge: 50, spending: 45_000 },
    income: { leaveOut: [], add: [] },
    expenses: { leaveOut: [], add: [] },
    events: [],
  });

  test('recorded in USD with the accounts all in EUR: one typed in USD is the Plan’s and is worked out; one typed in EUR is not, until the person says', async () => {
    serve({
      'GET /api/fire-plan': [200, { plan: PLAN, currency: 'USD' }],
      'GET /api/plan-scenarios': [200, { ...EMPTY, scenarios: [scenario('s1', 'In dollars', 'USD'), scenario('s2', 'In euros', 'EUR')] }],
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render({ institutions: broker([EUR()]) });
    // Opened from the Scenarios sheet: the bar's button, then the row's Open.
    await press(tab.buttons('Scenarios (2)')[0]);
    await press(tab.openDialog()?.findAll((e) => e.getAttribute('aria-label') === 'Open In dollars')[0]);
    expect(tab.text()).toContain('Scenario: In dollars');
    expect(tab.buttons('They’re in USD').length).toBe(0);
    expect(tab.text()).toContain('Will it last?');
    // The other is listed with why it isn't worked out, in the sheet's
    // Compare, opened from the open scenario's card.
    await press(tab.buttons('Scenarios (2)')[0]);
    const sheet = tab.openDialog()!;
    expect(sheet.textContent).toContain('Its amounts were typed in EUR, and your plan is now in USD.');
    await press(sheet.findAll((e) => e.getAttribute('aria-label') === 'Close')[0]);
    // Back to your plan by the bar's arrow, and the other opened.
    await press(tab.container.findAll((e) => e.getAttribute('class') === 'plan-bar')[0].findAll((e) => e.getAttribute('aria-label') === 'Back to your plan')[0]);
    await press(tab.buttons('Scenarios (2)')[0]);
    await press(tab.openDialog()?.findAll((e) => e.getAttribute('aria-label') === 'Open In euros')[0]);
    expect(tab.text()).toContain('Scenario: In euros');
    expect(tab.text()).not.toContain('Will it last?');
    // Offered at once: the Plan's currency is recorded, so it can't move.
    expect(tab.buttons('They’re in USD').length).toBe(1);
    await tab.unmount();
  });
});


describe('a figure not measured is never counted as zero (review round 2)', () => {
  let n = 0;
  const row = (over: Partial<Txn>): Txn => ({ transaction_id: `y${++n}`, date: '2026-09-01', name: 'Shop', amount: 100, pending: false, account_name: 'Konto', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'EUR', ...over }) as Txn;
  const months = Array.from({ length: 12 }, (_, m) => `${m < 3 ? 2025 : 2026}-${String(m < 3 ? m + 10 : m - 2).padStart(2, '0')}-05`);
  const euroYear = months.flatMap((d) => [row({ date: d, amount: 4_000 }), row({ date: d, amount: -6_000, category: 'income' })]);
  const euros = broker([EUR({ account_id: 'e1', balance: 600_000 }), EUR({ account_id: 'e2', balance: 300_000 }), USD({ balance: 5_000 })]);
  const AGED = { ...DEFAULT_PLAN, age: 40, targetAge: 55 };
  const ECB = { home: null, own: [], changes: [], problem: null, removable: false, ecb: { date: '2026-09-14', rates: { USD: '1.1551', CAD: '1.6012' }, stale: false, fetch_ok: true } };

  test('the Plan tab: assets not measured by count, so years to FI, Coast FI and the balance at the target age say why, never from zero', async () => {
    serve(planServer({ plan: AGED }).answers);
    const tab = await render({ institutions: euros, txns: euroYear, currency: 'EUR' });
    expect(tab.text()).toContain('Not measured: more than a tenth of what would count, by count, as Nya doesn’t have the ECB’s rates at hand, is in another currency than the Plan’s, EUR (1 account in USD).');
    expect(tab.text()).toContain('Years to FI--Not worked out: your invested assets aren’t measured (below), and a figure that isn’t measured is never counted as zero.');
    expect(tab.text()).toContain('Your invested assets aren’t measured (below), so whether you have that much isn’t said.');
    expect(tab.text()).toContain('At age 55--Not worked out: your invested assets aren’t measured (below)');
    expect(tab.text()).not.toMatch(/Years to FIabout/);
    await tab.unmount();
  });

  test('the Plan tab: weighed by amount at the ECB’s rates, the small dollar account leaves the euros measured, and the years are worked out', async () => {
    const calls = serve({ ...planServer({ plan: AGED }).answers, 'GET /api/currency': [200, ECB] });
    const tab = await render({ institutions: euros, txns: euroYear, currency: 'EUR' });
    expect(calls.some((c) => c.url === '/api/currency')).toBe(true);
    expect(tab.text()).toContain('€900,000');
    expect(tab.text()).not.toContain('Not measured');
    expect(tab.text()).toMatch(/Years to FIabout/);
    await tab.unmount();
  });

  test('the Plan tab: spending typed and the year not measured, savings say so in the year’s own words', async () => {
    const typed = { ...AGED, spending: 40_000 };
    serve(planServer({ plan: typed, record: { currency: 'USD', amounts: typedAmounts(typed) } }).answers);
    const year = months.flatMap((d) => [row({ date: d, amount: 3_000, iso_currency_code: 'USD' }), row({ date: d, amount: -5_000, category: 'income', iso_currency_code: 'USD' }), row({ date: d, amount: 20, iso_currency_code: 'CAD' })]);
    const tab = await render({ institutions: broker([USD({ balance: 400_000 })]), txns: year });
    expect(tab.text()).toContain('Annual spending$40,000typed by you');
    expect(tab.text()).toMatch(/Annual savings--not measuredThe year’s income and savings aren’t measured: more than a tenth of the year’s spending, by count, as Nya doesn’t have the ECB’s rates at hand, is in another currency than the Plan’s, USD \(\d+ transactions in CAD this year\)\./);
    expect(tab.text()).toContain('Not worked out: your savings aren’t measured (below)');
    await tab.unmount();
  });
});

describe('a failed load of the balances, and a refused save (review round 2)', () => {
  test('the saved copy showing and its load failed: asked, with an answer to give, never locked as still loading', async () => {
    const calls = serve(planServer({ plan: PLAN }).answers);
    const tab = await render({ balancesSaved: true, balancesFailed: true });
    expect(tab.said()).toContain('your accounts couldn’t be loaded just now, so what is shown may be out of date');
    await press(tab.buttons('They’re in USD')[0]);
    expect(posts(calls).map((c) => [c.body.currency, c.body.answered])).toEqual([['USD', true]]);
    await tab.unmount();
  });

  test('a plan with nothing typed: a first amount can be given a currency, rather than refused as still loading', async () => {
    const calls = serve(planServer({ plan: UNTYPED }).answers);
    const tab = await render({ balancesSaved: true, balancesFailed: true });
    expect(tab.said()).toContain('Which currency will you type your plan’s figures in?');
    await press(tab.buttons('In USD')[0]);
    await saveSpending(tab, '40000');
    expect(puts(calls).map((c) => [c.body.currency, c.body.plan.spending])).toEqual([['USD', 40_000]]);
    await tab.unmount();
  });

  test('a save refused for another currency says why, not that it couldn’t save', async () => {
    const reason = 'The currency your plan’s figures are in was changed since this page loaded it, so nothing was saved: load it again.';
    serve({ ...planServer({ plan: PLAN, record: { currency: 'USD', amounts: typedAmounts(PLAN) } }).answers, 'PUT /api/fire-plan': [409, { error: reason, stale: true }] });
    const tab = await render();
    await press(tab.byLabel('Edit your ages'));
    await press(tab.buttons('Save')[0]);
    await settle(400);
    expect(tab.text()).toContain(`Not saved: ${reason}`);
    expect(tab.text()).not.toContain('Could not save plan assumptions');
    await tab.unmount();
  });
});

describe('with amounts hidden', () => {
  test('what the tab says about the currency names currencies, never an amount', async () => {
    setAmountsHidden(true);
    serve(planServer({ plan: PLAN }).answers);
    const tab = await render({ institutions: broker([EUR(), USD()]) });
    expect(tab.said()).toContain('EUR');
    expect(tab.said()).not.toMatch(/\d/);
    expect(tab.text()).toContain(MASK);
    expect(tab.text()).not.toContain('1,000,000');
    expect(tab.buttons('They’re in USD').map(outline)).toEqual(['<button>They’re in USD</button>']);
    await tab.unmount();
  });
});

describe('each side of the year, the rates at hand, and the simulation card (review round 3)', () => {
  let n = 0;
  const row = (over: Partial<Txn>): Txn => ({ transaction_id: `r${++n}`, date: '2026-09-01', name: 'Shop', amount: 500, pending: false, account_name: 'Checking', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'USD', ...over }) as Txn;
  const months = Array.from({ length: 12 }, (_, m) => `${m < 3 ? 2025 : 2026}-${String(m < 3 ? m + 10 : m - 2).padStart(2, '0')}`);
  const day = (month: string, d: number) => `${month}-${String(d).padStart(2, '0')}`;
  const ECB = { home: null, own: [], changes: [], problem: null, removable: false, ecb: { date: '2026-09-14', rates: { USD: '1.1551', CAD: '1.6012' }, stale: false, fetch_ok: true } };
  const dollars = broker([USD({ balance: 400_000 })]);

  test('the high earner: $200k paid in dollars hides none of the €18k spent in euros, so the FI number waits, and the simulation card says why', async () => {
    const highEarner = months.flatMap((m) => [
      row({ date: day(m, 1), amount: -200_000 / 12, category: 'income', name: 'Pay' }),
      ...Array.from({ length: 7 }, (_, k) => row({ date: day(m, k + 2) })),
      ...Array.from({ length: 3 }, (_, k) => row({ date: day(m, k + 11), iso_currency_code: 'EUR' })),
    ]);
    serve({ ...planServer({ plan: DEFAULT_PLAN }).answers, 'GET /api/currency': [200, ECB] });
    const tab = await render({ institutions: dollars, txns: highEarner });
    expect(tab.text()).toMatch(/Not measured: more than a tenth of the year’s spending, by amount at the ECB’s newest rates \(used only to weigh it\), is in another currency than the Plan’s, USD \(\d+ transactions in EUR this year\)\./);
    expect(tab.text()).toContain('FI number--Needs your annual spending, which isn’t measured (below).Years to FI--Needs your annual spending, which isn’t measured (below).');
    expect(tab.text()).toContain('The simulation withdraws your annual spending, which isn’t measured (the FI card on Your path says why). Type it on Your path.');
    expect(tab.text()).not.toContain('connect accounts with transactions');
    expect(tab.text()).not.toContain('$1,097');
    await tab.unmount();
  });

  test('the mirror: income in euros and spending in dollars, so the FI number is shown and years to FI aren’t, with the income’s reason', async () => {
    const mirror = months.flatMap((m) => [
      row({ date: day(m, 1), amount: -5_000, category: 'income', name: 'Pay', iso_currency_code: 'EUR' }),
      ...Array.from({ length: 10 }, (_, k) => row({ date: day(m, k + 2), amount: 350 })),
    ]);
    serve({ ...planServer({ plan: DEFAULT_PLAN }).answers, 'GET /api/currency': [200, ECB] });
    const tab = await render({ institutions: dollars, txns: mirror });
    expect(tab.text()).toMatch(/FI number\$[\d,]+\$[\d,]+ a year ÷ 4% withdrawal rate/);
    expect(tab.text()).toMatch(/Annual spending\$[\d,]+from \d+ days of transactions/);
    expect(tab.text()).toContain('Years to FI--Not worked out: your savings aren’t measured (below), and a figure that isn’t measured is never counted as zero.');
    expect(tab.text()).toMatch(/Annual savings--not measuredThe year’s income and savings aren’t measured: more than a tenth of the year’s income, by amount at the ECB’s newest rates \(used only to weigh it\), is in another currency than the Plan’s, USD \(\d+ transactions in EUR this year\)\./);
    expect(tab.text()).not.toContain('Not measured: more than a tenth');
    await tab.unmount();
  });

  test('rates never fetched: weighed by count, and said as rates Nya doesn’t have at hand, never as ones the ECB doesn’t publish', async () => {
    const rows = months.flatMap((m) => [row({ date: day(m, 1), amount: 3_000 }), row({ date: day(m, 2), amount: 3_000, iso_currency_code: 'CAD' })]);
    const calls = serve({ ...planServer({ plan: DEFAULT_PLAN }).answers, 'GET /api/currency': [200, { ...ECB, ecb: { date: null, rates: {}, stale: true, fetch_ok: null } }] });
    const tab = await render({ institutions: dollars, txns: rows });
    expect(calls.some((c) => c.url === '/api/currency')).toBe(true);
    expect(tab.text()).toMatch(/Not measured: more than a tenth of the year’s spending, by count, as Nya doesn’t have the ECB’s rates at hand, is in another currency than the Plan’s, USD \(\d+ transactions in CAD this year\)\./);
    expect(tab.text()).not.toContain('publishes no rate');
    await tab.unmount();
  });

  test('a simulation starting from invested assets that aren’t measured says so, not that there are none to count', async () => {
    const euros = broker([EUR({ account_id: 'e1', balance: 600_000 }), EUR({ account_id: 'e2', balance: 300_000 }), USD({ balance: 5_000 })]);
    const year = months.flatMap((m) => [row({ date: day(m, 5), amount: 4_000, iso_currency_code: 'EUR' }), row({ date: day(m, 5), amount: -6_000, category: 'income', iso_currency_code: 'EUR' })]);
    serve(planServer({ plan: { ...DEFAULT_PLAN, age: 40, targetAge: 55, start: 'assets' } }).answers);
    const tab = await render({ institutions: euros, txns: year, currency: 'EUR' });
    expect(tab.text()).toContain('The simulation starts with your invested assets, which aren’t measured (the FI card on Your path says why). Type them on Your path, or start from your FI number (Change).');
    expect(tab.text()).not.toContain('none to count yet');
    await tab.unmount();
  });
});
