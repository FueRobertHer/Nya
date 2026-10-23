import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { installDom, click, outline, FakeElement } from './mini-dom';

// The Plan tab and the currency its typed figures are in, rendered
// (react-dom/client over test/mini-dom.ts): a plan saved before the currency
// was recorded gets it recorded at once when the accounts show it reliably,
// and is asked about otherwise, with nothing saved until the person says; a
// recorded currency stays whatever the accounts' count does (a tie, a hidden
// account, a balance that reads empty); each save sends it; and with amounts
// hidden, what the tab says about it names currencies, never an amount. Every
// request is answered here, by path; nothing reaches a network.
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

afterEach(() => setAmountsHidden(false));

// Spending typed, assets measured: what the accounts hold counts.
const PLAN = { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000 };
const AS_OF = '2026-10-23T12:00:00.000Z';
const USD = (over: Partial<AssetAccount> = {}): AssetAccount => ({ account_id: 'usd', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balance: 300_000, currency: 'USD', ...over });
const EUR = (over: Partial<AssetAccount> = {}): AssetAccount => ({ account_id: 'eur', name: 'Depot', type: 'investment', subtype: 'brokerage', balance: 250_000, currency: 'EUR', ...over });
const broker = (accounts: AssetAccount[]): AssetInstitution[] => [{ name: 'Broker', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts }];

type Call = { method: string; url: string; body: any };
type Answer = (call: Call) => [number, unknown];

function serve(answers: Record<string, Answer | [number, unknown]>) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const a = answers[`${call.method} ${url}`];
    const [status, body] = typeof a === 'function' ? a(call) : (a ?? [404, { error: 'not here' }]);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return calls;
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
  return {
    rerender: async (more: Partial<PlanTabProps>) => {
      await act(async () => root.render(<PlanTab {...all} {...more} />));
      await settle();
    },
    unmount: () => act(async () => root.unmount()),
    text: () => container.textContent,
    byLabel: (label: string) => container.findAll((e) => e.getAttribute('aria-label') === label)[0] ?? null,
    buttons: (text: string) => container.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === text),
    region: () => container.findAll((e) => e.getAttribute('aria-label') === 'Your plan’s currency')[0] ?? null,
  };
}

const press = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => click(el));
  await settle();
};
const posts = (calls: Call[]) => calls.filter((c) => c.url === '/api/fire-plan' && c.method === 'POST');
const puts = (calls: Call[]) => calls.filter((c) => c.url === '/api/fire-plan' && c.method === 'PUT');

describe('a plan saved before its currency was recorded', () => {
  test('shown in a currency that can be told reliably: recorded at once, for the plan as stored, and then editable', async () => {
    const calls = serve({
      'GET /api/fire-plan': [200, { plan: PLAN, currency: null }],
      'POST /api/fire-plan': (c) => [200, { plan: PLAN, currency: c.body.currency }],
      'GET /api/plan-scenarios': [200, EMPTY],
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    expect(posts(calls).map((c) => c.body)).toEqual([{ currency: 'USD', amounts: typedAmounts(PLAN) }]);
    expect(tab.region()).toBeNull();
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(false);
    expect(tab.text()).toContain('$1,000,000');
    await tab.unmount();
  });

  test('while the accounts load: nothing recorded, nothing asked yet, nothing saved', async () => {
    const calls = serve({
      'GET /api/fire-plan': [200, { plan: PLAN, currency: null }],
      'GET /api/plan-scenarios': [200, EMPTY],
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render({ balancesAsOf: null, txns: null, txnsLoading: true });
    expect(posts(calls).length).toBe(0);
    expect(tab.region()).toBeNull();
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(true);
    await tab.unmount();
  });

  test('a tie between two currencies: asked, never guessed; nothing on the Plan saves until the person says, and then it stays in what they said', async () => {
    let recorded: string | null = null;
    const calls = serve({
      'GET /api/fire-plan': () => [200, { plan: PLAN, currency: recorded }],
      'POST /api/fire-plan': (c) => {
        recorded = c.body.currency;
        return [200, { plan: PLAN, currency: recorded }];
      },
      'PUT /api/fire-plan': (c) => [200, { plan: c.body.plan, currency: c.body.currency }],
      'GET /api/plan-scenarios': [200, EMPTY],
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    // As many accounts in each: the order puts EUR first, so it is shown in EUR.
    const tab = await render({ institutions: broker([EUR(), USD()]) });
    expect(posts(calls).length).toBe(0);
    const region = tab.region()!;
    expect(region.textContent).toContain('They’re shown in EUR for now');
    expect(region.textContent).toContain('as many of your invested accounts are in another currency');
    expect(tab.text()).toContain('€1,000,000');
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(true);
    expect(tab.byLabel('Edit annual spending')?.disabled).toBe(true);
    expect(tab.buttons('They’re in EUR').length).toBe(1);
    await press(tab.buttons('They’re in USD')[0]);
    expect(posts(calls).map((c) => c.body)).toEqual([{ currency: 'USD', amounts: typedAmounts(PLAN) }]);
    // In USD now: the spending as typed, the euros not counted as dollars.
    expect(tab.text()).toContain('$1,000,000');
    expect(tab.text()).not.toContain('€1,000,000');
    expect(tab.text()).toContain('Your plan’s figures are in USD, the currency they were typed in, and stay in it. Some of your accounts are in EUR');
    expect(tab.byLabel('Edit your ages')?.disabled).toBe(false);
    expect(puts(calls).length).toBe(0);
    await tab.unmount();
  });

  test('a record that can’t be read: asked, and the answer replaces it, as only the person’s may', async () => {
    const calls = serve({
      'GET /api/fire-plan': [200, { plan: PLAN, currency: null, currency_problem: 'unreadable' }],
      'POST /api/fire-plan': (c) => [200, { plan: PLAN, currency: c.body.currency }],
      'GET /api/plan-scenarios': [200, EMPTY],
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    // Not recorded on its own, even though USD can be told: the bytes there aren't the tab's to replace.
    expect(posts(calls).length).toBe(0);
    expect(tab.region()!.textContent).toContain('The record of the currency your plan’s figures are in couldn’t be read.');
    await press(tab.buttons('They’re in USD')[0]);
    expect(posts(calls).map((c) => c.body)).toEqual([{ currency: 'USD', amounts: typedAmounts(PLAN), replace_unreadable: true }]);
    expect(tab.region()).toBeNull();
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
      expect(tab.region()?.textContent ?? '').not.toContain('Which currency');
    }
    // All in EUR now, without a home currency: said, with a way to say the figures are in EUR after all.
    expect(tab.region()!.textContent).toContain('Your plan’s figures are in USD, the currency they were typed in, and stay in it. Your accounts are in EUR: without a home currency nothing is converted');
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
});

describe('with amounts hidden', () => {
  test('what the tab says about the currency names currencies, never an amount', async () => {
    setAmountsHidden(true);
    serve({
      'GET /api/fire-plan': [200, { plan: PLAN, currency: null }],
      'GET /api/plan-scenarios': [200, EMPTY],
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render({ institutions: broker([EUR(), USD()]) });
    const region = tab.region()!;
    expect(region.textContent).toContain('EUR');
    expect(region.textContent).not.toMatch(/\d/);
    expect(tab.text()).toContain(MASK);
    expect(tab.text()).not.toContain('1,000,000');
    expect(tab.buttons('They’re in USD').map(outline)).toEqual(['<button>They’re in USD</button>']);
    await tab.unmount();
  });
});
