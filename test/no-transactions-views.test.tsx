import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MonthBreakdown from '@/components/MonthBreakdown';
import BudgetsTab from '@/components/BudgetsTab';
import { FiCard } from '@/components/PlanTab';
import { RedirectChoices, madeTheOtherWay, type RedirectItem } from '@/components/ConnectRedirect';
import { wholeMoney } from '@/components/plan-text';
import { DEFAULT_PLAN, fiView, type Measured } from '@/lib/fire/plan';
import type { InvestedAssets, TrailingFlows, WorkplaceSavings } from '@/lib/fire/inputs';
import {
  noSpending,
  noTransactionsView,
  refusedEmptyNote,
  refusedFigureNote,
  refusedMonthNote,
  type NoTransactionsView,
} from '@/lib/no-transactions';
import type { Txn } from '@/lib/transactions';

// Connections that bring in no transactions (lib/no-transactions.ts): what
// Activity, budgets and the Plan say for them instead of an empty year, a $0
// budget or a figure waiting for transactions that won't come; and the
// already-connected sheet (components/ConnectRedirect.tsx), which must not
// leave someone at a connection made the other way with no way on.

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

const INVESTMENTS_LEAD = 'Your connected accounts are investment accounts';

describe('what /api/transactions says about them', () => {
  test('read from the payload, keeping only well-formed entries', () => {
    expect(
      noTransactionsView({
        without_transactions: [
          { institution_name: 'Empower', reason: 'investment_accounts' },
          { institution_name: 'Acme CU', reason: 'refused' },
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
        { institution_name: 'Acme CU', reason: 'refused' },
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
    expect(noSpending(investmentsOnly)).toEqual({ lead: INVESTMENTS_LEAD, remedy: 'connect a bank or card' });
    expect(noSpending(withALoan)).toEqual({ lead: 'None of your connected accounts is a bank account or card', remedy: 'connect a bank or card' });
    expect(noSpending(refusedOnly)).toEqual({
      lead: "Plaid doesn't provide transactions for the bank or card accounts at Acme CU",
      remedy: 'connect another bank or card',
    });
  });

  test('and not said while some connection brings transactions, nothing is connected, or the count is unknown', () => {
    expect(noSpending(refusedBeside)).toBeNull();
    expect(noSpending({ without: [{ institution_name: 'Empower', reason: 'investment_accounts' }], connections: 2 })).toBeNull();
    expect(noSpending({ without: [], connections: 0 })).toBeNull();
    expect(noSpending({ without: investmentsOnly.without })).toBeNull();
  });

  test('a refused bank account is named, once, wherever spending is counted', () => {
    const twice: NoTransactionsView = { without: [...refusedBeside.without, ...refusedBeside.without], connections: 3 };
    expect(refusedMonthNote(twice)).toBe(
      "Doesn't include the bank or card accounts at Acme CU: Plaid doesn't provide their transactions, so this month may be incomplete."
    );
    expect(refusedEmptyNote(twice)).toBe("Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so they can't be shown.");
    expect(refusedFigureNote(twice, 'low')).toBe("Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so this figure may be low.");
    expect(refusedFigureNote(twice, 'off')).toBe("Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so this figure may be off.");
    expect(refusedFigureNote(twice, 'uncounted')).toBe("Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so they aren't counted.");
    for (const view of [investmentsOnly, withALoan, { without: [] }]) {
      expect(refusedMonthNote(view)).toBeNull();
      expect(refusedEmptyNote(view)).toBeNull();
      expect(refusedFigureNote(view, 'low')).toBeNull();
    }
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

describe('Activity', () => {
  const activity = (txns: Txn[] | null, without?: NoTransactionsView, notes: string[] = []) =>
    text(
      renderToStaticMarkup(
        <MonthBreakdown txns={txns} notes={notes} loading={false} onRecategorize={noop} onRename={noop} withoutTransactions={without} />
      )
    );

  test('investment connections only: why there is nothing to show, never "No transactions in the last 12 months"', () => {
    const t = activity([], investmentsOnly);
    expect(t).toContain(`${INVESTMENTS_LEAD}, so there are no bank or card transactions to show. To see spending, connect a bank or card.`);
    expect(t).not.toContain('No transactions in the last 12 months');
    expect(activity([], withALoan)).toContain('None of your connected accounts is a bank account or card, so there are no bank or card transactions to show.');
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

describe('the Plan', () => {
  const money = (n: number) => wholeMoney(n, 'USD');
  const flows: TrailingFlows = {
    spending: 40_000,
    income: 70_000,
    savings: 30_000,
    loanPayments: 0,
    cash: 0,
    refunds: 0,
    unclearLoans: 0,
    largestRefund: null,
    from: '2025-10-07',
    to: '2026-10-06',
    days: 365,
    scaled: false,
    count: 400,
    currency: 'USD',
    mixedCurrency: false,
  };
  const assets: InvestedAssets = {
    total: 250_000,
    accounts: [{ account_id: 'a', name: '401(k)', type: 'investment', subtype: '401k', balance: 250_000, currency: 'USD', institution: 'Empower', item_id: 'i1' }],
    unknown: 0,
    caveats: [],
    currency: 'USD',
    mixedCurrency: false,
  };
  const noPlans: WorkplaceSavings = { total: 0, plans: [], fromBank: [], partial: [], shortHistory: [], problems: [], unmeasured: [] };
  const card = (f: TrailingFlows | null, without: NoTransactionsView) => {
    const m: Measured = f ? { spending: f.spending, savings: f.savings, assets: 250_000 } : { spending: null, savings: null, assets: 250_000 };
    return text(
      renderToStaticMarkup(
        <FiCard
          plan={DEFAULT_PLAN}
          view={fiView(DEFAULT_PLAN, m)}
          flows={f}
          unread={[]}
          withoutTransactions={without}
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

  test('too few transactions yet, beside a refused bank account, says that one is not counted', () => {
    const t = card(null, refusedBeside);
    expect(t).toContain('not enough transactions to measure from yet');
    expect(t).toContain("Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so they aren't counted.");
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
