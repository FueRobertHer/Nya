import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isExcluded, isMoneyMovement, isTransfer, countsInTotals, currencyOf, totalsCurrency, inCurrency, leftOutByCurrency, leftOutText } from '@/lib/spending';
import { detectRecurring } from '@/lib/recurring';
import { trailingFlows } from '@/lib/fire/inputs';
import { localDate } from '@/lib/local-date';
import MonthBreakdown, { type Txn } from '@/components/MonthBreakdown';
import MonthFlowChart from '@/components/MonthFlowChart';
import BudgetsTab from '@/components/BudgetsTab';
import Insights from '@/components/Insights';

// Which transactions count in budgets and reports (lib/spending.ts), and that
// every total leaving transfers out leaves an excluded transaction out too,
// and never adds up amounts in two currencies: the Activity tab's figures,
// chart, categories, trend and day headers, the budgets, the Home insights,
// recurring bills and the Plan's spending.

const today = localDate();
const month = today.slice(0, 7);

function txn(over: Partial<Txn>): Txn {
  return {
    transaction_id: 't',
    date: today,
    name: 'Shop',
    amount: 10,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Bank',
    category: 'food and drink',
    iso_currency_code: 'USD',
    vendor_key: 'nm:bank::shop',
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
  };
}

/** Markup as text, tags dropped and entities decoded, for reading sentences. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

// This month: a counted purchase, a one-off the person excluded, a paycheck,
// and a transfer (out of every total already).
const COUNTED = txn({ transaction_id: 'counted', name: 'Corner shop', amount: 30, city: 'Austin', payment_channel: 'in store' });
const EXCLUDED = txn({ transaction_id: 'excluded', name: 'New laptop', amount: 80, excluded: true, city: 'Austin', payment_channel: 'online', category: 'general merchandise' });
const PAY = txn({ transaction_id: 'pay', name: 'Payroll', amount: -100, category: 'income' });
const MOVED = txn({ transaction_id: 'moved', name: 'To savings', amount: 500, category: 'transfer out', transaction_code: 'transfer' });
const MONTH = [COUNTED, EXCLUDED, PAY, MOVED];

describe('the rule', () => {
  test('a transfer, cash or a loan payment is not spending; an excluded transaction counts in nothing', () => {
    expect(isTransfer(txn({ transaction_code: 'atm' }))).toBe(true);
    expect(isTransfer(txn({ category: 'transfer in' }))).toBe(true);
    expect(isTransfer(txn({ category: 'loan payments' }))).toBe(true);
    expect(isTransfer(txn({}))).toBe(false);
    // Recurring bills keep loan payments: only money moved is out.
    expect(isMoneyMovement(txn({ category: 'loan payments' }))).toBe(false);
    expect(isMoneyMovement(txn({ transaction_code: 'transfer' }))).toBe(true);

    expect(isExcluded(txn({ excluded: true }))).toBe(true);
    expect(isExcluded(txn({}))).toBe(false);
    expect(isExcluded(txn({ excluded: false }))).toBe(false);
    // Couldn't be read: counted, never silently left out.
    expect(isExcluded(txn({ excluded: null }))).toBe(false);

    expect(countsInTotals(COUNTED, 'USD')).toBe(true);
    expect(countsInTotals(PAY, 'USD')).toBe(true);
    expect(countsInTotals(EXCLUDED, 'USD')).toBe(false);
    expect(countsInTotals(MOVED, 'USD')).toBe(false);
    expect(countsInTotals(txn({ excluded: null }), 'USD')).toBe(true);
  });

  test('a bank’s fee is spending, wherever spending is counted', () => {
    const fee = txn({ transaction_id: 'fee', name: 'Monthly maintenance fee', amount: 12, category: 'bank fees', transaction_code: 'bank charge' });
    expect(isTransfer(fee)).toBe(false);
    expect(isMoneyMovement(fee)).toBe(false);
    expect(countsInTotals(fee, 'USD')).toBe(true);
    // The Activity tab's totals and the budgets count it.
    expect(text(activity([fee]))).toContain('Out $12.00');
    const budgets = text(renderToStaticMarkup(createElement(BudgetsTab, { ...BUDGET_PROPS, txns: [fee], budgets: { 'bank fees': 20 } })));
    expect(budgets).toContain('bank fees $12.00 of $20.00');
    // A fee charged every month is a bill worth seeing.
    const monthsAgo = (n: number) => localDate(new Date(new Date().getFullYear(), new Date().getMonth() - n, 3));
    expect(detectRecurring([0, 1, 2].map((n) => ({ ...fee, transaction_id: `fee-${n}`, date: monthsAgo(n) }))).map((b) => b.name)).toEqual(['Monthly maintenance fee']);
    // And the Plan, as before.
    const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    expect(trailingFlows([txn({ date: day(364), amount: 100 }), { ...fee, date: day(1) }], today)!.spending).toBe(112);
  });

  test('a row’s currency is its ISO code, or Plaid’s unofficial one; a row with neither is taken to be in the totals’', () => {
    expect(currencyOf(txn({ iso_currency_code: 'CAD' }))).toBe('CAD');
    expect(currencyOf(txn({ iso_currency_code: null, unofficial_currency_code: 'DOGE' }))).toBe('DOGE');
    expect(currencyOf(txn({ iso_currency_code: null }))).toBeNull();
    // The totals' currency is the one most rows are in.
    expect(totalsCurrency([txn({}), txn({}), txn({ iso_currency_code: 'JPY' }), txn({ iso_currency_code: null })])).toBe('USD');
    expect(totalsCurrency([txn({ iso_currency_code: null })])).toBeNull();
    expect(inCurrency(txn({ iso_currency_code: null }), 'EUR')).toBe(true);
    expect(inCurrency(txn({ iso_currency_code: 'JPY' }), 'USD')).toBe(false);
    expect(countsInTotals(txn({ iso_currency_code: 'JPY' }), 'USD')).toBe(false);
    expect(countsInTotals(txn({ iso_currency_code: 'JPY' }), 'JPY')).toBe(true);
  });

  test('what a total left out is named, by currency, most first', () => {
    const rows = [txn({ iso_currency_code: 'JPY' }), txn({ iso_currency_code: 'JPY' }), txn({ iso_currency_code: 'EUR' }), txn({ iso_currency_code: 'EUR', category: 'transfer out' }), txn({})];
    const left = leftOutByCurrency(rows, 'USD');
    // The transfer in EUR would count in nothing anyway: not named.
    expect(left).toEqual([
      { currency: 'JPY', count: 2 },
      { currency: 'EUR', count: 1 },
    ]);
    expect(leftOutText(left, 'USD')).toBe("2 transactions in JPY and 1 in EUR aren't in these totals, which are in USD.");
    expect(leftOutText([{ currency: 'JPY', count: 1 }], 'USD')).toBe("1 transaction in JPY isn't in these totals, which are in USD.");
    expect(leftOutText([{ currency: 'EUR', count: 1 }], 'USD', { noun: 'bill', where: 'this total', plural: false })).toBe("1 bill in EUR isn't in this total, which is in USD.");
    expect(leftOutText([], 'USD')).toBeNull();
  });
});

const activity = (txns: Txn[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(MonthBreakdown, { txns, notes: [], loading: false, onRecategorize: () => {}, onRename: () => {}, ...extra }));
const BUDGET_PROPS = { budgets: {}, onSave: async () => true, goals: [], onSaveGoals: async () => true, accounts: [], loading: false };

describe('every total leaves an excluded transaction out, and still lists it', () => {
  test('the Activity tab’s money in, out and net, top categories, places and channels', () => {
    const html = activity(MONTH);
    const t = text(html);
    expect(t).toContain('In $100.00 Out $30.00 Net $70.00');
    expect(t).toContain('Transfers and loan payments excluded, and 1 transaction you left out.');
    // Top spending, where you spent and online vs in store count the shop only.
    expect(t).toContain('Top spending food and drink $30.00');
    expect(t).not.toContain('general merchandise $80.00');
    expect(t).toContain('Where you spent Austin $30.00');
    expect(t).toContain('Online vs in-store Online $0.00 In store $30.00');
    // Still in the list, marked.
    expect(t).toContain('New laptop');
    expect(t).toContain('Excluded from budgets and reports');
    expect(html).toContain('num excluded');
  });

  test('the month’s chart', () => {
    const html = renderToStaticMarkup(createElement(MonthFlowChart, { txns: MONTH, month }));
    expect(html).toContain('Income $100.00, spending $30.00.');
  });

  test('the net-by-month trend', () => {
    const lastMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 15);
    const earlier = txn({ transaction_id: 'earlier', date: localDate(lastMonth), amount: 5 });
    const t = text(activity([...MONTH, earlier]));
    // This month's column: +$100 in, -$30 out; the laptop and the transfer left out.
    expect(t).toContain('+$70');
  });

  test('one whose exclusion couldn’t be read counts, and the screen says so', () => {
    const t = text(activity([COUNTED, { ...EXCLUDED, excluded: null }, PAY]));
    expect(t).toContain('Out $110.00');
    expect(t).toContain("Whether you excluded 1 transaction couldn't be read, so it counts here.");
    expect(t).toContain("Couldn't read whether you excluded this");
  });

  test('the budgets', () => {
    const t = text(
      renderToStaticMarkup(
        createElement(BudgetsTab, {
          txns: MONTH,
          budgets: { 'food and drink': 100, 'general merchandise': 50 },
          onSave: async () => true,
          goals: [],
          onSaveGoals: async () => true,
          accounts: [],
          loading: false,
        })
      )
    );
    expect(t).toContain('food and drink $30.00 of $100.00');
    expect(t).toContain('general merchandise $0.00 of $50.00');
    expect(t).not.toContain('over');
  });

  test('the Home insights: budget alerts and the biggest purchase', () => {
    const t = text(
      renderToStaticMarkup(createElement(Insights, { txns: [COUNTED, { ...EXCLUDED, category: 'food and drink' }], budgets: { 'food and drink': 100 }, accounts: [] }))
    );
    expect(t).not.toContain('food and drink budget');
    expect(t).toContain('Biggest purchase this month: Corner shop, $30.00');
    // Without the exclusion the same two would be over budget.
    const all = text(
      renderToStaticMarkup(
        createElement(Insights, { txns: [COUNTED, { ...EXCLUDED, category: 'food and drink', excluded: undefined }], budgets: { 'food and drink': 100 }, accounts: [] })
      )
    );
    expect(all).toContain('Over your food and drink budget');
  });

  test('recurring bills', () => {
    const monthsAgo = (n: number) => {
      const d = new Date();
      return localDate(new Date(d.getFullYear(), d.getMonth() - n, 3));
    };
    const bill = (n: number, over: Partial<Txn> = {}) => txn({ transaction_id: `bill-${n}`, name: 'Streaming', amount: 15, date: monthsAgo(n), ...over });
    expect(detectRecurring([bill(0), bill(1), bill(2)]).map((b) => b.name)).toEqual(['Streaming']);
    // One of the three left out: two months is not a bill yet.
    expect(detectRecurring([bill(0), bill(1, { excluded: true }), bill(2)])).toEqual([]);
    expect(detectRecurring([bill(0), bill(1, { excluded: null }), bill(2)]).map((b) => b.name)).toEqual(['Streaming']);
  });

  test('the Plan’s spending and income, with the history it still dates from', () => {
    const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    const rows = [
      txn({ transaction_id: 'car', date: day(300), amount: 25_000, name: 'Car dealer', category: 'transportation', excluded: true }),
      txn({ transaction_id: 'gift', date: day(200), amount: -10_000, name: 'Inheritance', category: 'income', excluded: true }),
      txn({ transaction_id: 'food', date: day(100), amount: 400 }),
      txn({ transaction_id: 'salary', date: day(50), amount: -3_000, category: 'income' }),
    ];
    const f = trailingFlows(rows, today)!;
    // Scaled from the 301 days the history covers, the car's day included.
    expect(f.from).toBe(day(300));
    expect(f.days).toBe(301);
    expect(f.spending).toBeCloseTo((400 * 365) / 301, 6);
    expect(f.income).toBeCloseTo((3_000 * 365) / 301, 6);
    expect(f.count).toBe(2);
    expect(f.excludedCount).toBe(2);
  });
});

describe('the Activity tab', () => {
  test('offers to add a transaction only when there is a manual account to add to, empty or not', () => {
    const render = (txns: Txn[], onAddTransaction?: () => void) =>
      text(renderToStaticMarkup(createElement(MonthBreakdown, { txns, notes: [], loading: false, onRecategorize: () => {}, onRename: () => {}, onAddTransaction })));
    expect(render(MONTH, () => {})).toContain('Add a transaction');
    expect(render([], () => {})).toContain('Add a transaction');
    expect(render([], () => {})).toContain('No transactions in the last 12 months.');
    expect(render(MONTH)).not.toContain('Add a transaction');
    expect(render(MONTH, () => {})).toContain("It doesn't change the account's balance unless you ask.");
  });

  test('a manual row says where it came from, beside its account and category', () => {
    const manual = txn({ transaction_id: 'manual-txn:1', name: 'Farmers market', institution_name: 'Cash', account_name: 'Wallet', source: 'manual', vendor_key: '', account_id: 'manual_w' });
    const t = text(renderToStaticMarkup(createElement(MonthBreakdown, { txns: [manual], notes: [], loading: false, onRecategorize: () => {}, onRename: () => {} })));
    expect(t).toContain('Cash · Wallet · food and drink · entered by hand');
  });
});

describe('no total adds up amounts in two currencies', () => {
  // A bowl of ramen entered on a trip, about $21: never $3,200.
  const RAMEN = txn({ transaction_id: 'ramen', name: 'Ramen Ichiran', amount: 3200, iso_currency_code: 'JPY', city: 'Tokyo', payment_channel: 'in store', source: 'manual', account_id: 'manual_w' });
  // And Plaid's rows in other currencies: a Canadian card, a crypto exchange.
  const MAPLE = txn({ transaction_id: 'maple', name: 'Maple Leaf Cafe', amount: 40, iso_currency_code: 'CAD', payment_channel: 'online' });
  const DOGE = txn({ transaction_id: 'doge', name: 'Coin shop', amount: 5, iso_currency_code: null, unofficial_currency_code: 'DOGE' });

  test('the Activity tab’s totals, categories, places and channels count the totals’ currency, and name the rest; the rows stay listed in their own', () => {
    const t = text(activity([...MONTH, RAMEN, MAPLE, DOGE]));
    expect(t).toContain('In $100.00 Out $30.00 Net $70.00');
    expect(t).toContain("1 transaction in CAD, 1 in DOGE and 1 in JPY aren't in these totals, which are in USD.");
    expect(t).toContain('Top spending food and drink $30.00');
    expect(t).toContain('Where you spent Austin $30.00');
    expect(t).not.toContain('Tokyo $');
    expect(t).toContain('Online vs in-store Online $0.00 In store $30.00');
    // Listed, each in its own currency; one Intl doesn't know, with its code.
    expect(t).toContain('-¥3,200');
    expect(t).toContain('-CA$40.00');
    expect(t).toContain('-5.00 DOGE');
  });

  test('the day’s header gives one figure per currency, never a sum across them, and leaves an excluded row out', () => {
    const t = text(activity([...MONTH, RAMEN]));
    // In: $100; out: $30 and the $500 transfer (the day's rows, as listed);
    // the excluded laptop isn't in it; the ramen is its own figure.
    expect(t).toContain('-$430.00 · -¥3,200');
    expect(t).not.toContain('-$3,');
  });

  test('the trend and the month’s chart count only the totals’ currency', () => {
    const lastMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 15);
    const earlier = txn({ transaction_id: 'earlier', date: localDate(lastMonth), amount: 5 });
    const trend = text(activity([...MONTH, RAMEN, earlier, { ...RAMEN, transaction_id: 'ramen-2', date: localDate(lastMonth) }]));
    expect(trend).toContain('+$70');
    expect(trend).toContain('-$5');
    expect(renderToStaticMarkup(createElement(MonthFlowChart, { txns: [...MONTH, RAMEN], month }))).toContain('Income $100.00, spending $30.00.');
    // Given the tab's currency, the chart uses it.
    expect(renderToStaticMarkup(createElement(MonthFlowChart, { txns: [...MONTH, RAMEN], month, currency: 'JPY' }))).toContain('spending ¥3,200');
  });

  test('a row with no currency code counts, in the totals’ currency, and is shown in it', () => {
    const t = text(activity([txn({ amount: 10 }), txn({ transaction_id: 'old', amount: 5, iso_currency_code: null }), txn({ transaction_id: 'e', amount: 1, iso_currency_code: 'EUR' })]));
    expect(t).toContain('Out $15.00');
    expect(t).toContain('-$5.00');
  });

  test('the budgets and the bills’ total', () => {
    const monthsAgo = (n: number) => localDate(new Date(new Date().getFullYear(), new Date().getMonth() - n, 3));
    const bill = (n: number, over: Partial<Txn>) => txn({ transaction_id: `${over.name}-${n}`, date: monthsAgo(n), ...over });
    // Last month and the two before: bills, not this month's spending.
    const bills = [1, 2, 3].flatMap((n) => [
      bill(n, { name: 'Streaming', amount: 15, category: 'entertainment' }),
      bill(n, { name: 'Gym', amount: 30, category: 'personal care', iso_currency_code: 'EUR' }),
    ]);
    // Detected once for the dashboard, and handed down (components/Dashboard.tsx).
    const txns = [COUNTED, RAMEN, ...bills];
    const t = text(
      renderToStaticMarkup(createElement(BudgetsTab, { ...BUDGET_PROPS, txns, series: detectRecurring(txns), budgets: { 'food and drink': 600 } }))
    );
    expect(t).toContain('food and drink $30.00 of $600.00');
    expect(t).toContain("1 transaction in JPY isn't in these budgets, which are in USD.");
    expect(t).toContain('~$15.00/mo');
    expect(t).toContain('€30.00');
    expect(t).toContain("1 bill in EUR isn't in this total, which is in USD.");
  });

  test('the Home insights: no budget alert, pace or biggest purchase from another currency, and a word on what was left out', () => {
    const t = text(renderToStaticMarkup(createElement(Insights, { txns: [COUNTED, RAMEN], budgets: { 'food and drink': 600 }, accounts: [] })));
    expect(t).not.toContain('food and drink budget');
    expect(t).toContain('Biggest purchase this month: Corner shop, $30.00');
    expect(t).not.toContain('Ramen');
    expect(t).toContain("1 transaction in JPY isn't in these figures, which are in USD.");
    // Said only beside a figure it is missing from.
    const lowOnly = text(
      renderToStaticMarkup(
        createElement(Insights, { txns: [{ ...RAMEN, amount: -3200, category: 'income' }], budgets: {}, accounts: [{ name: 'Checking', type: 'depository', balance: 50, currency: 'USD' }] })
      )
    );
    expect(lowOnly).toContain('Low balance');
    expect(lowOnly).not.toContain("isn't in these figures");
  });

  test('recurring bills: a merchant billing in two currencies is two bills, each in its own', () => {
    const monthsAgo = (n: number) => localDate(new Date(new Date().getFullYear(), new Date().getMonth() - n, 3));
    const rows = [0, 1, 2].flatMap((n) => [
      txn({ transaction_id: `u${n}`, name: 'Cloud', amount: 10, date: monthsAgo(n) }),
      txn({ transaction_id: `e${n}`, name: 'Cloud', amount: 9, date: monthsAgo(n), iso_currency_code: 'EUR' }),
    ]);
    expect(detectRecurring(rows).map((b) => [b.name, b.amount, b.currency])).toEqual([
      ['Cloud', 10, 'USD'],
      ['Cloud', 9, 'EUR'],
    ]);
  });

  test('the Plan’s spending', () => {
    const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    const f = trailingFlows([txn({ date: day(364), amount: 400 }), { ...RAMEN, date: day(3) }, { ...MAPLE, date: day(2) }], today)!;
    expect(f.spending).toBe(400);
    expect(f.leftOut).toEqual([
      { currency: 'CAD', count: 1 },
      { currency: 'JPY', count: 1 },
    ]);
  });
});

describe('the Activity tab opens on this month', () => {
  test('never on a later one: a row dated tomorrow, on a month’s last day, doesn’t take it over', () => {
    const next = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
    const ahead = txn({ transaction_id: 'ahead', name: 'Rent (entered ahead)', amount: 1800, date: localDate(next), category: 'rent and utilities' });
    const t = text(activity([COUNTED, PAY, ahead]));
    // This month's figures, not the next one's.
    expect(t).toContain('In $100.00 Out $30.00 Net $70.00');
    expect(t).not.toContain('Rent (entered ahead)');
  });
});

describe('beside the notes on incomplete months', () => {
  // A month a bank couldn't be read for (lib/month-coverage.ts) still counts
  // what it has by the shared rule, and says both what it left out and what
  // may be missing. A manual account is never incomplete: it has no connection.
  const RAMEN = txn({ transaction_id: 'ramen', name: 'Ramen', amount: 3200, iso_currency_code: 'JPY', source: 'manual', account_id: 'manual_w' });
  const CASH = txn({ transaction_id: 'cash', name: 'Market', amount: 20, source: 'manual', account_id: 'manual_w' });
  const incomplete = [{ institution_name: 'Chase', coverage: 'missing' as const }];

  test('the Activity tab', () => {
    const t = text(activity([...MONTH, RAMEN, CASH], { incomplete }));
    expect(t).toContain('Out $50.00');
    expect(t).toContain("1 transaction in JPY isn't in these totals, which are in USD.");
    expect(t).toContain("Doesn't include Chase: its transactions couldn't be loaded, so this month may be incomplete.");
  });

  test('the budgets', () => {
    const t = text(renderToStaticMarkup(createElement(BudgetsTab, { ...BUDGET_PROPS, txns: [COUNTED, RAMEN, CASH], budgets: { 'food and drink': 600 }, incomplete })));
    expect(t).toContain('food and drink $50.00 of $600.00');
    expect(t).toContain("1 transaction in JPY isn't in these budgets, which are in USD.");
    expect(t).toContain("Doesn't include Chase");
  });
});
