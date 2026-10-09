import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import Insights, { type InsightAccount } from '@/components/Insights';

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
