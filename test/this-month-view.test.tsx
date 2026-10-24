import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import Insights from '@/components/Insights';
import type { Txn } from '@/components/MonthBreakdown';
import { localMonth } from '@/lib/local-date';

// Home's This month card (rollout phase 4c, components/Insights.tsx): plain
// rows that need nothing done, what the month may be missing after the
// figures read from it, and the FI line last.

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
const now = new Date();
const thisMonth = localMonth(now);
const before = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const lastMonth = `${before.getFullYear()}-${String(before.getMonth() + 1).padStart(2, '0')}`;
const row = (date: string, amount: number): Txn =>
  ({
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
  }) as Txn;
const spent = [row(`${thisMonth}-01`, 40), row(`${lastMonth}-02`, 900)];
const FI = <li className="fi">FI line</li>;

describe('the card', () => {
  test('a heading, then a plain row per insight: nothing to tap, no color of its own', () => {
    const html = renderToStaticMarkup(<Insights txns={spent} accounts={[{ name: 'Checking', type: 'depository', subtype: 'checking', balance: 40, currency: 'USD' }]} />);
    expect(html).toContain('<section class="card this-month" aria-labelledby="this-month-title"><div class="card-header"><h2 id="this-month-title">This month</h2></div>');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/insight-(up|down|neutral|warn)/);
    expect(html.match(/<div class="list-row"><span class="list-row-text">/g)!.length).toBeGreaterThanOrEqual(2);
    const t = text(html);
    expect(t).toContain('Low balance: Checking at');
    expect(t).toContain('Spending is tracking');
  });

  test('what the month may be missing follows the figures read from it, inside their row', () => {
    const html = renderToStaticMarkup(<Insights txns={spent} accounts={[]} stopped={[{ institution_name: 'Chase', last_ok_at: `${lastMonth}-12T15:00:00.000Z` }]} fi={FI} />);
    const notes = html.indexOf('<div class="stack tight row-notes">');
    expect(notes).toBeGreaterThan(html.indexOf('Spending is tracking'));
    expect(notes).toBeLessThan(html.indexOf('FI line'));
    expect(text(html)).toContain("Chase hasn't synced since");
  });

  test('the FI line is the last row, and the card is drawn for it alone; with neither, nothing', () => {
    const html = renderToStaticMarkup(<Insights txns={spent} accounts={[]} fi={FI} />);
    expect(html.indexOf('FI line')).toBeGreaterThan(html.indexOf('Spending is tracking'));
    expect(html).toMatch(/<li class="fi">FI line<\/li><\/ul><\/section>$/);
    expect(renderToStaticMarkup(<Insights txns={[]} accounts={[]} fi={FI} />)).toContain('<h2 id="this-month-title">This month</h2>');
    expect(renderToStaticMarkup(<Insights txns={[]} accounts={[]} />)).toBe('');
  });

  test('a card with no row yet (the FI line still loading) is hidden, not drawn empty', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8');
    expect(css).toContain('.this-month:not(:has(li)) {');
  });

  test('the dashboard hands it the FI line as its last prop', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const mount = dashboard.slice(dashboard.indexOf('<Insights'));
    expect(mount.indexOf('fi={')).toBeLessThan(mount.indexOf('<FiProgressLoader'));
    expect(mount.indexOf('<FiProgressLoader')).toBeLessThan(mount.indexOf('{error &&'));
  });
});
