import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MonthBreakdown from '@/components/MonthBreakdown';
import BudgetsTab from '@/components/BudgetsTab';
import Insights from '@/components/Insights';
import { FiCard } from '@/components/PlanTab';
import { RedirectChoices, madeTheOtherWay, type RedirectItem } from '@/components/ConnectRedirect';
import { wholeMoney } from '@/components/plan-text';
import { DEFAULT_PLAN, fiView, type Measured } from '@/lib/fire/plan';
import type { InvestedAssets, TrailingFlows, WorkplaceSavings } from '@/lib/fire/inputs';
import {
  missingEmptyNotes,
  missingFigureNotes,
  missingMonthNotes,
  missingWhat,
  noSpending,
  noTransactionsView,
  quietItemIds,
  withoutNote,
  type NoTransactionsView,
} from '@/lib/no-transactions';
import { stoppedConnections } from '@/lib/month-coverage';
import type { Txn } from '@/lib/transactions';

// Connections that bring in no transactions (lib/no-transactions.ts): what
// Activity, budgets, Home's insights and the Plan say for them instead of an
// empty year, a $0 budget or a figure waiting for transactions that won't
// come; that none of it is said when rows entered by hand bring spending in;
// that a lapsed one holding no bank account or card is never named as missing
// transactions; and the already-connected sheet
// (components/ConnectRedirect.tsx), which must not leave someone at a
// connection made the other way with no way on.

const noop = () => {};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

const investmentsOnly: NoTransactionsView = {
  without: [
    { institution_name: 'Empower', reason: 'investment_accounts' },
    { institution_name: 'Vanguard', reason: 'investment_accounts' },
  ],
  connections: 2,
};
const withALoan: NoTransactionsView = {
  without: [
    { institution_name: 'Empower', reason: 'investment_accounts' },
    { institution_name: 'Nelnet', reason: 'no_cash_accounts' },
  ],
  connections: 2,
};
const refusedOnly: NoTransactionsView = {
  without: [
    { institution_name: 'Empower', reason: 'investment_accounts' },
    { institution_name: 'Acme CU', reason: 'refused' },
  ],
  connections: 2,
};
/** A bank that brings transactions, beside one Plaid refused. */
const refusedBeside: NoTransactionsView = { without: [{ institution_name: 'Acme CU', reason: 'refused' }], connections: 2 };
/** A bank that brings transactions, beside one whose transactions weren't allowed. */
const unallowedBeside: NoTransactionsView = { without: [{ institution_name: 'Fidelity', reason: 'no_consent' }], connections: 2 };
const ALLOW = 'To bring them in, reconnect Fidelity and allow transactions.';

const INVESTMENTS_LEAD = 'Your connected accounts are investment accounts';

describe('what /api/transactions says about them', () => {
  test('read from the payload, keeping only well-formed entries', () => {
    expect(
      noTransactionsView({
        without_transactions: [
          { institution_name: 'Empower', reason: 'investment_accounts' },
          { item_id: 'item_acme', institution_name: 'Acme CU', reason: 'refused' },
          { item_id: 7, institution_name: 'Fidelity', reason: 'no_consent' },
          { institution_name: 'Odd', reason: 'something new' },
          { reason: 'refused' },
          null,
          'Empower',
        ],
        connections: 3,
      })
    ).toEqual({
      without: [
        { institution_name: 'Empower', reason: 'investment_accounts' },
        { item_id: 'item_acme', institution_name: 'Acme CU', reason: 'refused' },
        { institution_name: 'Fidelity', reason: 'no_consent' },
      ],
      connections: 3,
    });
    // A payload cached before these fields existed, or a broken count.
    for (const payload of [{}, null, undefined, { transactions: [] }]) expect(noTransactionsView(payload)).toEqual({ without: [] });
    for (const connections of [-1, 1.5, '2', NaN, null]) {
      expect(noTransactionsView({ without_transactions: [], connections })).toEqual({ without: [] });
    }
  });

  test('no spending at all is said by what is true of the connections', () => {
    expect(noSpending(investmentsOnly, 0)).toEqual({ lead: INVESTMENTS_LEAD, remedy: 'connect a bank or card' });
    expect(noSpending(withALoan, 0)).toEqual({ lead: 'None of your connected accounts is a bank account or card', remedy: 'connect a bank or card' });
    expect(noSpending(refusedOnly, 0)).toEqual({
      lead: "Plaid doesn't provide transactions for the bank or card accounts at Acme CU",
      remedy: 'connect another bank or card',
    });
  });

  test('and not said while some connection brings transactions, nothing is connected, or the count is unknown', () => {
    expect(noSpending(refusedBeside, 0)).toBeNull();
    expect(noSpending({ without: [{ institution_name: 'Empower', reason: 'investment_accounts' }], connections: 2 }, 0)).toBeNull();
    expect(noSpending({ without: [], connections: 0 }, 0)).toBeNull();
    expect(noSpending({ without: investmentsOnly.without }, 0)).toBeNull();
  });

  test('rows entered by hand bring spending in: then the connections without any are named instead', () => {
    for (const view of [investmentsOnly, withALoan, refusedOnly]) expect(noSpending(view, 1)).toBeNull();
    expect(withoutNote(investmentsOnly, 3)).toBe('Empower and Vanguard hold no bank account or card, so no transactions come from them.');
    expect(withoutNote(withALoan, 1)).toBe('Empower and Nelnet hold no bank account or card, so no transactions come from them.');
    expect(withoutNote({ without: [{ institution_name: 'Empower', reason: 'investment_accounts' }], connections: 1 }, 1)).toBe(
      'Empower holds no bank account or card, so no transactions come from it.'
    );
    // A refused one is named by the refused notes; it does hold a bank account or card.
    expect(withoutNote(refusedOnly, 1)).toBe('Empower holds no bank account or card, so no transactions come from it.');
    expect(withoutNote({ without: [{ institution_name: 'Acme CU', reason: 'refused' }], connections: 1 }, 1)).toBeNull();
    // Not without rows (noSpending says it then), nor beside a connection that brings some.
    expect(withoutNote(investmentsOnly, 0)).toBeNull();
    expect(withoutNote(refusedBeside, 1)).toBeNull();
    expect(withoutNote({ without: investmentsOnly.without }, 1)).toBeNull();
  });

  test('a refused bank account is named, once, wherever spending is counted', () => {
    const twice: NoTransactionsView = { without: [...refusedBeside.without, ...refusedBeside.without], connections: 3 };
    expect(missingMonthNotes(twice)).toEqual([
      "Doesn't include the bank or card accounts at Acme CU: Plaid doesn't provide their transactions, so this month may be incomplete.",
    ]);
    expect(missingEmptyNotes(twice)).toEqual(["Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so they can't be shown."]);
    expect(missingFigureNotes(twice, 'low')).toEqual(["Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so this figure may be low."]);
    expect(missingFigureNotes(twice, 'off')).toEqual(["Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so this figure may be off."]);
    expect(missingFigureNotes(twice, 'uncounted')).toEqual(["Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so they aren't counted."]);
    expect(missingWhat(twice)).toBe("transactions Plaid doesn't provide");
    for (const view of [investmentsOnly, withALoan, { without: [] }]) {
      expect(missingMonthNotes(view)).toEqual([]);
      expect(missingEmptyNotes(view)).toEqual([]);
      expect(missingFigureNotes(view, 'low')).toEqual([]);
      expect(missingWhat(view)).toBeNull();
    }
  });

  test('transactions that were not allowed are said as that, with the way to allow them', () => {
    expect(missingMonthNotes(unallowedBeside)).toEqual([
      `Doesn't include the bank or card accounts at Fidelity: you didn't allow Nya to see their transactions, so this month may be incomplete. ${ALLOW}`,
    ]);
    expect(missingEmptyNotes(unallowedBeside)).toEqual([
      `You didn't allow Nya to see transactions from the bank or card accounts at Fidelity, so they can't be shown. ${ALLOW}`,
    ]);
    expect(missingFigureNotes(unallowedBeside, 'low')).toEqual([
      `You didn't allow Nya to see transactions from the bank or card accounts at Fidelity, so this figure may be low. ${ALLOW}`,
    ]);
    expect(missingWhat(unallowedBeside)).toBe("transactions you didn't allow");
    for (const note of [...missingMonthNotes(unallowedBeside), ...missingEmptyNotes(unallowedBeside)]) expect(note).not.toContain('Plaid');
    // Alone, it is why there is no spending, and reconnecting is the way on.
    const only: NoTransactionsView = { without: [{ institution_name: 'Fidelity', reason: 'no_consent' }], connections: 1 };
    expect(noSpending(only, 0)).toEqual({
      lead: "You didn't allow Nya to see transactions from the bank or card accounts at Fidelity",
      remedy: 'reconnect Fidelity and allow transactions',
    });
    // Both causes at once: each said, each with its way on.
    const both: NoTransactionsView = { without: [...unallowedBeside.without, ...refusedBeside.without], connections: 2 };
    expect(noSpending(both, 0)).toEqual({
      lead: "You didn't allow Nya to see transactions from the bank or card accounts at Fidelity, and Plaid doesn't provide transactions for the bank or card accounts at Acme CU",
      remedy: 'reconnect Fidelity and allow transactions, or connect another bank or card',
    });
    expect(missingWhat(both)).toBe("transactions Plaid doesn't provide or you didn't allow");
    expect(missingMonthNotes(both)).toHaveLength(2);
  });

  test('the connections that never bring transactions in, by id, for leaving them out of the stopped', () => {
    const view: NoTransactionsView = {
      without: [
        { item_id: 'item_emp', institution_name: 'Empower', reason: 'investment_accounts' },
        { item_id: 'item_loan', institution_name: 'Nelnet', reason: 'no_cash_accounts' },
        { item_id: 'item_acme', institution_name: 'Acme CU', reason: 'refused' },
        { item_id: 'item_fid', institution_name: 'Fidelity', reason: 'no_consent' },
        { institution_name: 'Old payload', reason: 'investment_accounts' },
      ],
      connections: 6,
    };
    expect([...quietItemIds(view)]).toEqual(['item_emp', 'item_loan']);
  });
});

const thisMonth = new Date().toISOString().slice(0, 7);
const row = (over: Partial<Txn> = {}): Txn => ({
  transaction_id: 't1',
  date: `${thisMonth}-01`,
  name: 'Grocer',
  amount: 25,
  pending: false,
  account_name: 'Checking',
  institution_name: 'Chase',
  category: 'groceries',
  iso_currency_code: 'USD',
  vendor_key: 'grocer',
  logo_url: null,
  category_icon_url: null,
  subcategory: null,
  category_confidence: null,
  transaction_code: null,
  payment_channel: null,
  datetime: null,
  website: null,
  check_number: null,
  account_owner: null,
  city: null,
  region: null,
  counterparty: null,
  payment_processor: null,
  payment_reference: null,
  ...over,
});

/** A transaction entered by hand on a manual account (lib/manual-txns.ts). */
const handRow = (over: Partial<Txn> = {}): Txn =>
  row({
    transaction_id: 'manual_t1',
    name: 'Farmers market',
    source: 'manual',
    account_id: 'manual_wallet-1',
    account_name: 'Wallet',
    institution_name: 'Cash',
    vendor_key: 'farmers market',
    ...over,
  });
const NAMED = 'Empower and Vanguard hold no bank account or card, so no transactions come from them.';

describe('Activity', () => {
  const activity = (txns: Txn[] | null, without?: NoTransactionsView, notes: string[] = [], onAddTransaction?: () => void) =>
    text(
      renderToStaticMarkup(
        <MonthBreakdown
          txns={txns}
          notes={notes}
          loading={false}
          onRecategorize={noop}
          onRename={noop}
          onAddTransaction={onAddTransaction}
          withoutTransactions={without}
        />
      )
    );

  test('investment connections only: why there is nothing to show, never "No transactions in the last 12 months"', () => {
    const t = activity([], investmentsOnly);
    expect(t).toContain(`${INVESTMENTS_LEAD}, so there are no bank or card transactions to show. To see spending, connect a bank or card.`);
    expect(t).not.toContain('No transactions in the last 12 months');
    expect(activity([], withALoan)).toContain('None of your connected accounts is a bank account or card, so there are no bank or card transactions to show.');
  });

  test('rows entered by hand beside investment connections only: shown, never "nothing to show", and the connections named', () => {
    const t = activity([handRow()], investmentsOnly);
    expect(t).toContain('Farmers market');
    expect(t).not.toContain(INVESTMENTS_LEAD);
    expect(t).not.toContain('no bank or card transactions to show');
    expect(t).not.toContain('No transactions in the last 12 months');
    expect(t).toContain(NAMED);
    // Where the rows come from, not a warning: nothing is missing.
    const html = renderToStaticMarkup(
      <MonthBreakdown txns={[handRow()]} notes={[]} loading={false} onRecategorize={noop} onRename={noop} withoutTransactions={investmentsOnly} />
    );
    expect(html).toMatch(new RegExp(`<div class="chart-note">[^<]*${NAMED.replace(/[.()]/g, '\\$&')}</div>`));
    expect(html).not.toMatch(/class="stale-note">[^<]*hold no bank account or card/);
    // Beside a connection that brings transactions, nothing about the others.
    expect(activity([handRow(), row()], { without: investmentsOnly.without, connections: 3 })).not.toContain('hold no bank account or card');
  });

  test('with a manual account to add to, the empty state offers that too', () => {
    expect(activity([], investmentsOnly, [], noop)).toContain(
      `${INVESTMENTS_LEAD}, so there are no bank or card transactions to show. To see spending, connect a bank or card, or add a transaction by hand.`
    );
  });

  test('a refused bank account and nothing else: that, and once', () => {
    const t = activity([], refusedOnly);
    expect(t).toContain(
      "Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so there are no bank or card transactions to show. To see spending, connect another bank or card."
    );
    expect(t.split('Acme CU')).toHaveLength(2);
  });

  test('an empty year beside a refused bank account says both', () => {
    const t = activity([], refusedBeside);
    expect(t).toContain('No transactions in the last 12 months.');
    expect(t).toContain("Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so they can't be shown.");
  });

  test('before the payload says, or when the load failed, as before', () => {
    expect(activity([])).toContain('No transactions in the last 12 months.');
    expect(activity(null, investmentsOnly)).not.toContain(INVESTMENTS_LEAD);
  });

  test("a month's totals beside a refused bank account say they may be short", () => {
    const t = activity([row()], refusedBeside);
    expect(t).toContain("Doesn't include the bank or card accounts at Acme CU: Plaid doesn't provide their transactions, so this month may be incomplete.");
    expect(activity([row()], { without: [{ institution_name: 'Empower', reason: 'investment_accounts' }], connections: 2 })).not.toContain(
      "Doesn't include"
    );
  });
});

describe('budgets', () => {
  const budgets = (txns: Txn[] | null, without?: NoTransactionsView) =>
    text(
      renderToStaticMarkup(
        <BudgetsTab
          txns={txns}
          budgets={{ groceries: 500, dining: 200 }}
          onSave={async () => true}
          goals={[]}
          onSaveGoals={async () => true}
          accounts={[]}
          loading={false}
          withoutTransactions={without}
        />
      )
    );

  test('with no connection that brings spending, each limit and why, never "$0 of" it', () => {
    const t = budgets([], investmentsOnly);
    expect(t).toContain(`${INVESTMENTS_LEAD}, so there's no spending to count against budgets. To track them, connect a bank or card.`);
    expect(t).toContain('$500.00 limit');
    expect(t).toContain('$200.00 limit');
    expect(t).not.toContain('$0.00 of');
    expect(t).toContain(`${INVESTMENTS_LEAD}, so there are no bills to detect.`);
    expect(t).not.toContain('No recurring charges detected yet');
  });

  test('spending entered by hand beside investment connections only counts against budgets, and the connections are named', () => {
    const t = budgets([handRow()], investmentsOnly);
    expect(t).toContain('$25.00 of $500.00');
    expect(t).not.toContain(INVESTMENTS_LEAD);
    expect(t).not.toContain('no spending to count against budgets');
    expect(t).not.toContain('$500.00 limit');
    expect(t).toContain(NAMED);
  });

  test('a refused bank account and nothing else is said once, with another bank as the remedy', () => {
    const t = budgets([], refusedOnly);
    expect(t).toContain("so there's no spending to count against budgets. To track them, connect another bank or card.");
    expect(t).not.toContain("Doesn't include");
    expect(t).not.toContain('$0.00 of');
  });

  test('spending counted beside a refused bank account says the month may be short', () => {
    const t = budgets([row()], refusedBeside);
    expect(t).toContain('$25.00 of $500.00');
    expect(t).toContain("Doesn't include the bank or card accounts at Acme CU: Plaid doesn't provide their transactions, so this month may be incomplete.");
  });

  test('ordinary budgets are unchanged, and rows from anywhere still count', () => {
    expect(budgets([])).toContain('$0.00 of $500.00');
    // Should rows ever come from elsewhere, they count, whatever the connections are.
    expect(budgets([row()], investmentsOnly)).toContain('$25.00 of $500.00');
  });
});

describe('a connection whose sign-in lapsed', () => {
  // As the dashboard builds it: from each institution's health, leaving out
  // by id the connections that hold no bank account or card.
  const DAY = 86_400_000;
  const healthy = { state: 'healthy', last_ok_at: new Date().toISOString() };
  const lapsed = { state: 'needs_reauth', last_ok_at: new Date(Date.now() - 40 * DAY).toISOString() };
  const MISSING = /hasn't synced since/;
  const render = (institutions: { item_id: string; institution_name: string; health: { state: string; last_ok_at: string } }[], view: NoTransactionsView, txns: Txn[]) => {
    const stopped = stoppedConnections(institutions, quietItemIds(view));
    const activity = text(
      renderToStaticMarkup(
        <MonthBreakdown txns={txns} notes={[]} loading={false} onRecategorize={noop} onRename={noop} stopped={stopped} withoutTransactions={view} />
      )
    );
    const budgets = text(
      renderToStaticMarkup(
        <BudgetsTab
          txns={txns}
          budgets={{ groceries: 400 }}
          onSave={async () => true}
          goals={[]}
          onSaveGoals={async () => true}
          accounts={[]}
          loading={false}
          stopped={stopped}
          withoutTransactions={view}
        />
      )
    );
    return { stopped, activity, budgets };
  };

  test('a 401(k) beside a bank: never named as missing transactions it never brings in', () => {
    const view: NoTransactionsView = { without: [{ item_id: 'item_emp', institution_name: 'Empower', reason: 'investment_accounts' }], connections: 2 };
    const { stopped, activity, budgets } = render(
      [
        { item_id: 'item_chase', institution_name: 'Chase', health: healthy },
        { item_id: 'item_emp', institution_name: 'Empower', health: lapsed },
      ],
      view,
      [row({ institution_name: 'Chase' })]
    );
    expect(stopped).toEqual([]);
    for (const t of [activity, budgets]) {
      expect(t).not.toMatch(MISSING);
      expect(t).not.toContain('Empower');
    }
  });

  test('retirement connections only: no month said to be missing anything beside "no spending"', () => {
    const view: NoTransactionsView = {
      without: [
        { item_id: 'item_emp', institution_name: 'Empower', reason: 'investment_accounts' },
        { item_id: 'item_vg', institution_name: 'Vanguard', reason: 'investment_accounts' },
      ],
      connections: 2,
    };
    const { activity, budgets } = render(
      [
        { item_id: 'item_vg', institution_name: 'Vanguard', health: healthy },
        { item_id: 'item_emp', institution_name: 'Empower', health: lapsed },
      ],
      view,
      []
    );
    expect(budgets).toContain(`${INVESTMENTS_LEAD}, so there's no spending to count against budgets.`);
    expect(activity).toContain(`${INVESTMENTS_LEAD}, so there are no bank or card transactions to show.`);
    for (const t of [activity, budgets]) expect(t).not.toMatch(MISSING);
  });

  test('matched by id: a bank of the same name that lapsed is still named', () => {
    // "Connect it again as ..." can leave two connections with one name.
    const view: NoTransactionsView = { without: [{ item_id: 'item_fid_ret', institution_name: 'Fidelity', reason: 'investment_accounts' }], connections: 2 };
    const { stopped, activity } = render(
      [
        { item_id: 'item_fid_ret', institution_name: 'Fidelity', health: healthy },
        { item_id: 'item_fid_bank', institution_name: 'Fidelity', health: lapsed },
      ],
      view,
      [row({ institution_name: 'Fidelity' })]
    );
    expect(stopped.map((s) => s.institution_name)).toEqual(['Fidelity']);
    expect(activity).toMatch(/Fidelity hasn't synced since/);
  });

  test('one whose bank account or card Plaid refuses is still named: it holds one', () => {
    const view: NoTransactionsView = { without: [{ item_id: 'item_acme', institution_name: 'Acme CU', reason: 'refused' }], connections: 2 };
    const { stopped } = render(
      [
        { item_id: 'item_chase', institution_name: 'Chase', health: healthy },
        { item_id: 'item_acme', institution_name: 'Acme CU', health: lapsed },
      ],
      view,
      [row()]
    );
    expect(stopped.map((s) => s.institution_name)).toEqual(['Acme CU']);
  });

  test('the dashboard builds the list that way', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    expect(dashboard).toContain('stoppedConnections(institutions, quietItemIds(txnWithout))');
    expect(dashboard).toMatch(/<Insights[^>]*withoutTransactions=\{txnWithout\}/);
  });
});

describe("Home's insights", () => {
  const insights = (without: NoTransactionsView, txns: Txn[]) =>
    text(renderToStaticMarkup(<Insights txns={txns} budgets={{ groceries: 26 }} accounts={[]} withoutTransactions={without} />));

  test('a budget alert or the pace beside a bank account or card whose transactions are missing says so', () => {
    const t = insights(refusedBeside, [row()]);
    expect(t).toContain('Approaching your groceries budget');
    expect(t).toContain("Doesn't include the bank or card accounts at Acme CU: Plaid doesn't provide their transactions, so this month may be incomplete.");
    expect(insights(unallowedBeside, [row()])).toContain(`you didn't allow Nya to see their transactions, so this month may be incomplete. ${ALLOW}`);
  });

  test('and not beside alerts that are not about spending, nor without such an account', () => {
    expect(insights(investmentsOnly, [row()])).not.toContain("Doesn't include");
    // No budget near its limit and no other spending figure: nothing it would qualify.
    const lowBalanceOnly = text(
      renderToStaticMarkup(
        <Insights
          txns={[]}
          budgets={{}}
          accounts={[{ name: 'Checking', type: 'depository', balance: 12, currency: 'USD' }]}
          withoutTransactions={refusedBeside}
        />
      )
    );
    expect(lowBalanceOnly).toContain('Low balance');
    expect(lowBalanceOnly).not.toContain("Doesn't include");
  });
});

describe('the Plan', () => {
  const money = (n: number) => wholeMoney(n, 'USD');
  const flows: TrailingFlows = {
    spending: 40_000,
    income: 70_000,
    savings: 30_000,
    loanPayments: 0,
    cash: 0,
    refunds: 0,
    cashWithdrawn: 0,
    cashEntered: 0,
    cashEnteredOn: [],
    unclearLoans: 0,
    largestRefund: null,
    from: '2025-10-07',
    to: '2026-10-06',
    days: 365,
    scaled: false,
    count: 400,
    excludedCount: 0,
    currency: 'USD',
    leftOut: [],
  };
  const assets: InvestedAssets = {
    total: 250_000,
    accounts: [{ account_id: 'a', name: '401(k)', type: 'investment', subtype: '401k', balance: 250_000, currency: 'USD', institution: 'Empower', item_id: 'i1' }],
    unknown: 0,
    caveats: [],
    currency: 'USD',
    leftOut: [],
  };
  const noPlans: WorkplaceSavings = { total: 0, plans: [], fromBank: [], partial: [], shortHistory: [], problems: [], unmeasured: [] };
  const card = (f: TrailingFlows | null, without: NoTransactionsView, transactionCount = f ? f.count : 0) => text(cardHtml(f, without, transactionCount));
  const cardHtml = (f: TrailingFlows | null, without: NoTransactionsView, transactionCount: number) => {
    const m: Measured = f ? { spending: f.spending, savings: f.savings, assets: 250_000 } : { spending: null, savings: null, assets: 250_000 };
    return (
      renderToStaticMarkup(
        <FiCard
          plan={DEFAULT_PLAN}
          view={fiView(DEFAULT_PLAN, m)}
          flows={f}
          unread={[]}
          withoutTransactions={without}
          transactionCount={transactionCount}
          txnsLoading={false}
          txnsFailed={false}
          assets={assets}
          balancesAsOf="2026-10-06T15:12:00Z"
          workplace={noPlans}
          workplaceCount={0}
          currencyNote={null}
          money={money}
          editable
          open={noop}
        />
      )
    );
  };

  test('investment connections only: spending and savings say why, not "yet"', () => {
    const t = card(null, investmentsOnly);
    expect(t).toContain(`${INVESTMENTS_LEAD}, so there are no bank or card transactions to measure spending from. Type it under Edit.`);
    expect(t).toContain(`${INVESTMENTS_LEAD}, so there are no bank or card transactions to measure income and spending from. Type it under Edit.`);
    expect(t).not.toContain('not enough transactions to measure from yet');
    expect(t).not.toContain('needs a year of transactions');
  });

  test('a refused bank account beside others keeps "may be low" on spending and the FI number, and "may be off" on savings', () => {
    const t = card(flows, refusedBeside);
    expect(t).toContain("Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so this figure may be low.");
    expect(t).toContain("May be low: spending is missing transactions Plaid doesn't provide (below).");
    expect(t).toContain("Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so this figure may be off.");
    expect(card(flows, investmentsOnly)).not.toContain('May be low');
  });

  test("transactions that weren't allowed keep the caveats, said as what they are", () => {
    const t = card(flows, unallowedBeside);
    expect(t).toContain(`You didn't allow Nya to see transactions from the bank or card accounts at Fidelity, so this figure may be low. ${ALLOW}`);
    expect(t).toContain("May be low: spending is missing transactions you didn't allow (below).");
    expect(t).toContain(`You didn't allow Nya to see transactions from the bank or card accounts at Fidelity, so this figure may be off. ${ALLOW}`);
    expect(t).not.toContain("Plaid doesn't provide");
  });

  test('too few transactions yet, beside a refused bank account, says that one is not counted', () => {
    const t = card(null, refusedBeside);
    expect(t).toContain('not enough transactions to measure from yet');
    expect(t).toContain("Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so they aren't counted.");
  });

  test('spending entered by hand beside investment connections only: measured, or waited for, never "type it in"', () => {
    // A few rows, not yet enough to measure from.
    const few = card(null, investmentsOnly, 3);
    expect(few).toContain('not enough transactions to measure from yet');
    expect(few).toContain('needs a year of transactions');
    expect(few).not.toContain('Type it under Edit');
    expect(few).not.toContain(INVESTMENTS_LEAD);
    expect(few).toContain(NAMED);
    // A year of them: measured from them, with the connections named.
    const year = card(flows, investmentsOnly);
    expect(year).toContain('from your last 12 months of transactions');
    expect(year).not.toContain('Type it under Edit');
    expect(year).toContain(NAMED);
    expect(year).not.toContain('May be low');
    // Said with where the figure comes from, never as a warning.
    for (const html of [cardHtml(null, investmentsOnly, 3), cardHtml(flows, investmentsOnly, flows.count)]) {
      expect(html).not.toMatch(/plan-warning">[^<]*hold no bank account or card/);
    }
    // The tab tells the card how many transactions there are.
    const source = readFileSync(join(import.meta.dir, '..', 'components', 'PlanTab.tsx'), 'utf8');
    expect(source).toContain('transactionCount={txns?.length ?? 0}');
  });

  test('a refused bank account and nothing else: no "yet" either', () => {
    const t = card(null, refusedOnly);
    expect(t).toContain(
      "Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so there are no bank or card transactions to measure spending from. Type it under Edit."
    );
    expect(t).not.toContain('measure from yet');
  });
});

/** Every <button> element in a rendered tree, without a DOM. */
function buttonElements(node: ReactNode): ReactElement<{ onClick: () => void; children?: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(buttonElements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<{ children?: ReactNode; onClick: () => void }>;
  return [...(el.type === 'button' ? [el] : []), ...buttonElements(el.props.children)];
}

describe('the already-connected sheet', () => {
  const asBank: RedirectItem = { item_id: 'item_a', institution_name: 'Fidelity', accounts: [{}, {}], linked_as: 'bank' };
  const asBrokerage: RedirectItem = { ...asBank, linked_as: 'investments' };
  const unknownWay: RedirectItem = { item_id: 'item_a', institution_name: 'Fidelity', accounts: [{}] };
  const sheet = (items: RedirectItem[], kind: 'bank' | 'investments') =>
    text(
      renderToStaticMarkup(
        <RedirectChoices name="Fidelity" items={items} kind={kind} connecting={false} onAdd={noop} onConnectAgain={noop} />
      )
    );

  test('made the same way: add to it, or connect a different login', () => {
    const t = sheet([asBank], 'bank');
    expect(t).toContain('To add more Fidelity accounts, add them to the connection you already have.');
    expect(t).toContain('Add accounts to existing connection');
    expect(t).toContain("It's a different login");
    // A connection whose way isn't known (its lookup at link failed) counts as the same.
    expect(madeTheOtherWay([unknownWay], 'investments')).toBe(false);
    expect(sheet([unknownWay], 'investments')).toContain("It's a different login");
  });

  test('made the other way: try adding first, and a way on if the accounts are not offered', () => {
    const t = sheet([asBank], 'investments');
    expect(t).toContain(
      "Fidelity is already connected as a bank or card, and Plaid may not offer its retirement and brokerage accounts on that connection. Try adding them to it first. If they aren't offered, connect Fidelity again as a brokerage or retirement account and choose only the accounts that aren't connected yet, so none is counted twice."
    );
    expect(t).toContain('Connect it again as a brokerage or retirement account');
    expect(t).not.toContain('different login');
    expect(sheet([asBrokerage], 'bank')).toContain('Connect it again as a bank or card');
    // Only when every connection there was made the other way.
    expect(madeTheOtherWay([asBank, asBrokerage], 'investments')).toBe(false);
    expect(madeTheOtherWay([], 'bank')).toBe(false);
  });

  test('each connection is offered by name when there are several, and the last button connects again', () => {
    const added: string[] = [];
    let again = 0;
    const tree = RedirectChoices({
      name: 'Fidelity',
      items: [asBank, { ...asBank, item_id: 'item_b', accounts: [{}] }],
      kind: 'investments',
      connecting: false,
      onAdd: (id) => added.push(id),
      onConnectAgain: () => again++,
    });
    const buttons = buttonElements(tree);
    expect(buttons.map((b) => text(renderToStaticMarkup(<>{b.props.children}</>)).trim())).toEqual([
      'Add to Fidelity (2 accounts)',
      'Add to Fidelity (1 account)',
      'Connect it again as a brokerage or retirement account',
    ]);
    for (const b of buttons) b.props.onClick();
    expect(added).toEqual(['item_a', 'item_b']);
    expect(again).toBe(1);
  });
});
