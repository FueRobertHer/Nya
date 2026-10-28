import { afterAll, describe, expect, test } from 'bun:test';
import { installDom } from './mini-dom';

// The screen review: React logged hundreds of duplicate-key errors on the
// demo, which has two sandbox banks linked to one account, with the same
// account names and masks, because sentences were used as React keys. Two
// sentences can read the same; a row's key is what it is about. Rendered with
// react-dom/client, since only a client render checks keys, and every
// console.error React writes is caught.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { AllocationNotes, HistoryBody } = await import('@/components/AllocationCard');
const { PayoffPanel, NO_INPUTS } = await import('@/components/DebtPayoff');
const { allocate } = await import('@/lib/allocation/allocation');
const { wholeMoney } = await import('@/components/plan-text');
type AllocAccount = import('@/lib/allocation/allocation').AllocAccount;
type AllocCaveat = import('@/lib/allocation/allocation').AllocCaveat;
type DebtInstitutionInput = import('@/lib/payoff').DebtInstitutionInput;

/** What React said while `node` was mounted, re-rendered and unmounted, and
 *  the text it drew. */
function render(node: React.ReactNode): { errors: string[]; text: string } {
  const errors: string[] = [];
  const was = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    act(() => root.render(node));
    act(() => root.render(node));
    return { errors, text: host.textContent ?? '' };
  } finally {
    act(() => root.unmount());
    console.error = was;
  }
}

const sameKey = (errors: string[]) => errors.filter((e) => e.includes('the same key'));

// Two banks, each with the same 401k (name and mask), each worth more in
// positions than its balance, and each unreachable once.
const k401 = (account_id: string): AllocAccount => ({ account_id, name: 'Plaid 401k', mask: '6666', type: 'investment', subtype: '401k', balance: 20_000, currency: 'USD' });
const twinAlloc = () => {
  const a = allocate({
    institutions: [
      { name: 'Tartan Bank', error: false, staleAsOf: null, missing: 0, accounts: [k401('t401')] },
      { name: 'Houndstooth Bank', error: false, staleAsOf: null, missing: 0, accounts: [k401('h401')] },
    ],
    holdings: [
      { account_id: 't401', ticker: 'VTI', name: 'VTI', security_type: 'etf', is_cash_equivalent: false, value: 21_494 },
      { account_id: 'h401', ticker: 'VTI', name: 'VTI', security_type: 'etf', is_cash_equivalent: false, value: 21_494 },
    ],
    settings: null,
    currency: 'USD',
  });
  const twice: AllocCaveat[] = [
    { kind: 'missing', institution: 'Plaid Bank', count: 1 },
    { kind: 'missing', institution: 'Plaid Bank', count: 1 },
  ];
  return { ...a, caveats: twice };
};

describe('no two rows share a key, even when they read the same', () => {
  test('the allocation’s notes: each account worth more than its balance named apart, and the same caveat twice', () => {
    const { errors, text } = render(<AllocationNotes alloc={twinAlloc()} money={(n) => wholeMoney(n, 'USD')} />);
    expect(sameKey(errors)).toEqual([]);
    expect(text).toContain("Tartan Bank Plaid 401k's positions are worth $1,494 more than its balance");
    expect(text).toContain("Houndstooth Bank Plaid 401k's positions are worth $1,494 more than its balance");
  });

  test('the mix over time, with today’s caveats repeated twice', () => {
    const day = { date: '2026-10-20', classes: { 'us-stocks': 100 }, total: 100, unlisted: 0, missing: [], otherCurrencies: {}, noCurrency: 0, unpriced: 0 };
    const state = {
      kind: 'ready' as const,
      answer: { currency: 'USD', first_recorded: '2026-10-19', first_recorded_at: null, last_recorded: '2026-10-20', days: [{ ...day, date: '2026-10-19' }, day], accounts: [], unreadable_days: [] },
    };
    const { errors } = render(<HistoryBody state={state} accountNames={new Map()} caveats={twinAlloc().caveats} onRetry={() => {}} />);
    expect(sameKey(errors)).toEqual([]);
  });

  test('the payoff plan, with the same mortgage at two banks: its escrow lines name each bank', () => {
    const mortgage = (account_id: string) => ({
      account_id,
      name: 'Plaid Mortgage',
      mask: '8888',
      type: 'loan',
      subtype: 'mortgage',
      balance: 56_302.06,
      currency: 'USD',
      liability: { kind: 'mortgage' as const, apr: 3.99, apr_label: 'Interest rate', minimum_payment: 3141.54, escrow_balance: 3141.54, origination_principal_amount: 425_000, loan_term: '30 year', interest_rate_type: 'fixed' },
    });
    const bank = (institution_name: string, id: string): DebtInstitutionInput => ({ institution_name, liabilities: 'on', accounts: [mortgage(id)] });
    const { errors, text } = render(<PayoffPanel institutions={[bank('Tartan Bank', 'tm'), bank('Houndstooth Bank', 'hm')]} inputs={NO_INPUTS} onChange={() => {}} startMonth="2026-10" />);
    expect(sameKey(errors)).toEqual([]);
    expect(text).toContain('Tartan Bank Plaid Mortgage ••8888: Plaid');
    expect(text).toContain('Houndstooth Bank Plaid Mortgage ••8888: Plaid');
    // The mask is written once, never twice.
    expect(text).not.toContain('••8888 ••8888');
  });
});
