import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import Insights, { type InsightAccount } from '@/components/Insights';
import type { Txn } from '@/components/MonthBreakdown';
import { formatInstantDay } from '@/lib/format';
import { localMonth } from '@/lib/local-date';
import { detectRecurring } from '@/lib/recurring';
import { addMonths } from '@/lib/rollover';
import { monthGapNotes, type Incomplete, type Stopped } from '@/lib/month-coverage';

// Home's insights (components/Insights.tsx): the alerts are the ones worth
// acting on, so none may be raised where there is nothing to act on.

/** The text a person reads. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');
/** The Dashboard's <Insights ... /> element, as written. */
const mount = dashboard.slice(dashboard.indexOf('<Insights'), dashboard.indexOf('/>', dashboard.indexOf('<Insights')));
/** The accounts it is given, kept while the accounts are. */
const insightAccounts = dashboard.slice(dashboard.indexOf('const insightAccounts'), dashboard.indexOf('[institutions]', dashboard.indexOf('const insightAccounts')));

describe('the Low balance alert', () => {
  const alerts = (accounts: InsightAccount[]) => text(renderToStaticMarkup(<Insights txns={[]} accounts={accounts} />));
  const checking: InsightAccount = { name: 'Checking', type: 'depository', subtype: 'checking', balance: 40, currency: 'USD' };
  const wallet: InsightAccount = { name: 'Wallet', type: 'depository', subtype: 'cash', balance: 20, currency: 'USD' };

  test('is raised for a checking or savings account running low', () => {
    expect(alerts([checking])).toContain('Low balance: Checking at');
    // A manual one, or one from a payload from before subtypes were passed.
    expect(alerts([{ name: 'Credit union', type: 'depository', subtype: null, balance: 12, currency: 'USD' }])).toContain('Low balance: Credit union');
    expect(alerts([{ name: 'Savings', type: 'depository', balance: 5, currency: 'USD' }])).toContain('Low balance: Savings');
  });

  test('never for cash on hand: a wallet running low is no risk of an overdraft', () => {
    expect(alerts([wallet])).toBe('');
    // Beside a checking account that is low, only that one is raised.
    const both = alerts([wallet, checking]);
    expect(both).toContain('Low balance: Checking');
    expect(both).not.toContain('Wallet');
  });

  test('never for a health savings account a bank reports as a bank account: no bills are paid from it', () => {
    const hsa: InsightAccount = { name: 'Health savings', type: 'depository', subtype: 'hsa', balance: 30, currency: 'USD' };
    expect(alerts([hsa])).toBe('');
    const both = alerts([hsa, checking]);
    expect(both).toContain('Low balance: Checking');
    expect(both).not.toContain('Health savings');
  });

  test("the dashboard passes each account's subtype, so cash on hand can be told apart", () => {
    expect(mount).toContain('accounts={insightAccounts}');
    expect(insightAccounts).toContain('subtype: a.subtype,');
  });
});

describe("the spending figures in a month that may be missing a connection's transactions", () => {
  const now = new Date();
  const thisMonth = localMonth(now);
  const before = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = `${before.getFullYear()}-${String(before.getMonth() + 1).padStart(2, '0')}`;
  const row = (date: string, amount: number): Txn => ({
    transaction_id: `${date}:${amount}`,
    date,
    name: 'Grocer',
    amount,
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
  });
  // Spending this month and last, so the pace is said.
  const spent = [row(`${thisMonth}-01`, 40), row(`${lastMonth}-02`, 900)];
  const insights = (incomplete: Incomplete[], stopped: Stopped[], txns = spent, accounts: InsightAccount[] = []) =>
    text(renderToStaticMarkup(<Insights txns={txns} accounts={accounts} incomplete={incomplete} stopped={stopped} />));
  /** What Activity and Budgets say under this month. */
  const said = (incomplete: Incomplete[], stopped: Stopped[]) => monthGapNotes(thisMonth, incomplete, stopped, (at) => formatInstantDay(at, { sentence: true }) ?? at.slice(0, 10));

  test('the pace beside a connection that stopped syncing says what the month may be missing, in the words Activity uses', () => {
    const stopped = [{ institution_name: 'Chase', last_ok_at: `${lastMonth}-12T15:00:00.000Z` }];
    const t = insights([], stopped);
    expect(t).toContain('Spending is tracking');
    expect(said([], stopped)).toHaveLength(1);
    expect(t).toContain(said([], stopped)[0]);
    expect(t).toContain("Chase hasn't synced since");
  });

  test('so does the pace beside an institution whose transactions did not load, or are still importing', () => {
    const missing = insights([{ institution_name: 'Chase', coverage: 'missing' }], []);
    expect(missing).toContain('Spending is tracking');
    expect(missing).toContain("Doesn't include Chase: its transactions couldn't be loaded, so this month may be incomplete.");
    expect(insights([{ institution_name: 'Amex', coverage: 'importing' }], [])).toContain(
      'Amex is still importing older transactions, so this month may be incomplete.'
    );
    // With every connection in, nothing is said.
    expect(insights([], [])).not.toContain('may be');
  });

  test('and not beside alerts that are not about spending', () => {
    const lowOnly = insights([{ institution_name: 'Chase', coverage: 'missing' }], [{ institution_name: 'Amex', last_ok_at: null }], [], [
      { name: 'Checking', type: 'depository', subtype: 'checking', balance: 12, currency: 'USD' },
    ]);
    expect(lowOnly).toContain('Low balance');
    expect(lowOnly).not.toContain('may be');
  });

  test('the dashboard passes what Activity and Budgets get', () => {
    expect(mount).toContain('incomplete={txnIncomplete}');
    expect(mount).toContain('stopped={stoppedTxns}');
  });

  test('omits low-balance insight for an account that already has an open question, and renders clickable buttons when onGo is passed', () => {
    const html = renderToStaticMarkup(
      <Insights
        txns={spent}
        accounts={[
          { name: 'Old Savings', type: 'depository', subtype: 'savings', balance: 0, currency: 'USD', hasQuestion: true },
        ]}
        onGo={() => {}}
      />
    );
    expect(text(html)).not.toContain('Old Savings');
    expect(html).toContain('<button type="button" class="list-row">');
  });
});

describe('the biggest purchase this month', () => {
  const thisMonth = localMonth();
  let id = 0;
  const txn = (date: string, name: string, amount: number, category: string, over: Partial<Txn> = {}): Txn => ({
    transaction_id: `b${++id}`,
    date,
    name,
    amount,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Chase',
    category,
    iso_currency_code: 'USD',
    vendor_key: name.toLowerCase(),
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
  /** A charge on the 1st of this month and of the five before it. */
  const monthly = (name: string, amount: number, category: string) =>
    Array.from({ length: 6 }, (_, i) => txn(`${addMonths(thisMonth, i - 5)}-01`, name, amount, category));
  const rent = monthly('Landlord', 2100, 'rent and utilities');
  const icloud = monthly('Apple', 2.99, 'general merchandise');
  const biggest = (txns: Txn[], dismissed: string[] = [], series = detectRecurring(txns)) =>
    /Biggest purchase this month: [^]*?\$[\d,.]+/.exec(text(renderToStaticMarkup(<Insights txns={txns} accounts={[]} series={series} dismissed={dismissed} />)))?.[0] ?? null;

  test('leaves out a detected bill: rent larger than a one-off purchase, the one-off wins', () => {
    const txns = [...rent, txn(`${thisMonth}-01`, 'Furniture store', 640, 'home improvement')];
    expect(detectRecurring(txns).map((s) => [s.name, s.kind, s.amount])).toEqual([['Landlord', 'bill', 2100]]);
    expect(biggest(txns)).toBe('Biggest purchase this month: Furniture store, $640.00');
    // Without the bills detected, rent is a purchase like any other.
    expect(biggest(txns, [], [])).toBe('Biggest purchase this month: Landlord, $2,100.00');
  });

  test('a one-off at a merchant that also bills a subscription still counts: the series is matched by its amount', () => {
    const txns = [...icloud, txn(`${thisMonth}-01`, 'Apple', 1299, 'general merchandise'), txn(`${thisMonth}-01`, 'Cafe', 6.5, 'coffee')];
    expect(detectRecurring(txns).map((s) => [s.name, s.amount])).toEqual([['Apple', 2.99]]);
    expect(biggest(txns)).toBe('Biggest purchase this month: Apple, $1,299.00');
    // With rent beside it, larger but a bill, the one-off still wins.
    expect(biggest([...txns, ...rent])).toBe('Biggest purchase this month: Apple, $1,299.00');
  });

  test('a series the person said isn’t recurring is no bill: its charge counts', () => {
    const txns = [...rent, txn(`${thisMonth}-01`, 'Furniture store', 640, 'home improvement')];
    const [landlord] = detectRecurring(txns);
    expect(biggest(txns, [landlord.id])).toBe('Biggest purchase this month: Landlord, $2,100.00');
  });

  test('a bill’s charge still pending this month is left out too, as detection takes it for its date', () => {
    const posted = rent.slice(0, 5);
    const txns = [...posted, txn(`${thisMonth}-01`, 'Landlord', 2100, 'rent and utilities', { pending: true }), txn(`${thisMonth}-01`, 'Furniture store', 640, 'home improvement')];
    expect(biggest(txns, [], detectRecurring(posted))).toBe('Biggest purchase this month: Furniture store, $640.00');
  });

  test('when every purchase this month is a bill, there is no biggest purchase', () => {
    expect(biggest([...rent, ...icloud])).toBeNull();
    expect(biggest([...rent, ...icloud], [], [])).toBe('Biggest purchase this month: Landlord, $2,100.00');
  });
});
