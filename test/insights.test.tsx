import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import Insights, { type InsightAccount } from '@/components/Insights';
import type { Txn } from '@/components/MonthBreakdown';
import { instantDay, localMonth } from '@/lib/local-date';
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

describe('the Low balance alert', () => {
  const alerts = (accounts: InsightAccount[]) => text(renderToStaticMarkup(<Insights txns={[]} budgets={{}} accounts={accounts} />));
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

  test("the dashboard passes each account's subtype, so cash on hand can be told apart", () => {
    expect(mount).toContain('subtype: a.subtype,');
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
    text(renderToStaticMarkup(<Insights txns={txns} budgets={{}} accounts={accounts} incomplete={incomplete} stopped={stopped} />));
  /** What Activity and Budgets say under this month. */
  const said = (incomplete: Incomplete[], stopped: Stopped[]) => monthGapNotes(thisMonth, incomplete, stopped, (at) => instantDay(at) ?? at.slice(0, 10));

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
});
