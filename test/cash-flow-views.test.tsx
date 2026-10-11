import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import CashFlowSankey, { FlowShown } from '@/components/CashFlowSankey';
import MonthBreakdown, { type Txn } from '@/components/MonthBreakdown';
import BudgetsTab from '@/components/BudgetsTab';
import { cashFlow, inPeriod, periodCaption, periodOf, pickedRows, type FlowPick } from '@/lib/cash-flow';
import { summarize, spendingByCategory } from '@/lib/totals';
import { filedId, indexTaxonomy } from '@/lib/categories';
import { formatMoney } from '@/lib/format';
import { localDate, localMonth } from '@/lib/local-date';
import { addMonths } from '@/lib/rollover';
import { categoriesFor } from './category-fixture';

// The Activity tab's cash flow (components/CashFlowSankey.tsx, #41), rendered:
// the issue's acceptance (money in is the Activity tab's month's, spending by
// category the Budgets tab's, a month that spent more than came in drawn
// sensibly), its period selector, its text alternative, what it says beside
// it, and how a tap lists a node's transactions in the Activity list.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const today = localDate();
const month = localMonth();
const lastMonth = addMonths(month, -1);
const { taxonomy, budgets } = categoriesFor({ groceries: 700, restaurants: 100 }, { words: ['groceries', 'restaurants'], groups: { groceries: 'Food', restaurants: 'Food' } });
const ix = indexTaxonomy(taxonomy);

let n = 0;
const row = (date: string, name: string, amount: number, category: string | null, over: Partial<Txn> = {}): Txn => ({
  transaction_id: `v${++n}`,
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
const day = (d: number, m = month) => `${m}-${String(d).padStart(2, '0')}`;

/** This month: pay, a refund, spending in three groups, and what totals
 *  leave out; and last month, for the longer periods. */
const ROWS: Txn[] = [
  row(day(1), 'ACME CORP', -3100, 'income'),
  row(day(2), 'Amazon', -38.5, 'general merchandise'),
  row(day(2), 'Whole Foods', 412.3, 'groceries'),
  row(day(3), 'Trader Joes', 188, 'groceries'),
  row(day(3), 'Nopalito', 96, 'restaurants'),
  row(day(4), 'Landlord', 2100, 'rent and utilities'),
  row(day(5), 'Target', 85, 'general merchandise'),
  row(day(5), 'To savings', 500, 'transfer out', { transaction_code: 'transfer' }),
  row(day(6), 'Car', 9000, 'general merchandise', { excluded: true }),
  row(day(6), 'Paris', 40, 'travel', { iso_currency_code: 'EUR' }),
  row(day(10, lastMonth), 'ACME CORP', -3100, 'income'),
  row(day(11, lastMonth), 'Whole Foods', 300, 'groceries'),
];

const sankey = (props: Partial<Parameters<typeof CashFlowSankey>[0]> = {}) =>
  renderToStaticMarkup(<CashFlowSankey txns={ROWS} taxonomy={taxonomy} currency="USD" onPick={() => {}} {...props} />);

describe('the issue’s acceptance, through the views themselves', () => {
  test('money in on the chart is the Activity tab’s money in for the same month, to the cent', () => {
    const html = renderToStaticMarkup(<MonthBreakdown txns={ROWS} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} />);
    const moneyIn = summarize(ROWS, (d) => d.startsWith(month), 'USD').money_in;
    expect(moneyIn).toBe(3138.5);
    // Once in the chart's figures, once in the month's summary: the same figure.
    expect(html.split(`<div class="summary-value inflow">${formatMoney(moneyIn, 'USD')}</div>`).length - 1).toBe(2);
    const out = formatMoney(summarize(ROWS, (d) => d.startsWith(month), 'USD').money_out, 'USD');
    expect(html.split(`<div class="summary-value">${out}</div>`).length - 1).toBe(2);
    expect(text(html)).toContain('Cash flow');
  });

  test('spending by category on the chart is the Budgets tab’s for the same month, to the cent', () => {
    const budgetsText = text(
      renderToStaticMarkup(<BudgetsTab txns={ROWS} taxonomy={taxonomy} budgets={budgets} onSave={async () => true} goals={[]} onSaveGoals={async () => true} accounts={[]} loading={false} />)
    );
    const chart = text(sankey());
    const spent = spendingByCategory(ROWS, (d) => d.startsWith(month), 'USD', (t) => filedId(ix, t));
    const figure = (name: string) => formatMoney(spent[taxonomy.categories.find((c) => c.name === name)!.id], 'USD');
    const listed = (shown: string, amount: string) => new RegExp(`${shown} : list its transactions ${amount.replace(/[$.]/g, '\\$&')} \\d`);
    // A budgeted group's meter: what its categories spent, the chart's group.
    const food = formatMoney(spent[taxonomy.categories.find((c) => c.name === 'groceries')!.id] + spent[taxonomy.categories.find((c) => c.name === 'restaurants')!.id], 'USD');
    expect(budgetsText).toContain(`Food ${food} of ${formatMoney(800, 'USD')}`);
    expect(chart).toMatch(listed('Food', food));
    // Each category the Budgets tab offers to budget, with what it spent this month.
    for (const name of ['rent and utilities', 'general merchandise']) {
      const shown = name[0].toUpperCase() + name.slice(1);
      expect(budgetsText).toContain(`${shown} (${figure(name)} this month)`);
      expect(chart).toMatch(listed(shown, figure(name)));
    }
    // And the budgeted ones, by the same function the tab calls.
    expect(chart).toMatch(listed('Groceries', figure('groceries')));
    expect(chart).toMatch(listed('Restaurants', figure('restaurants')));
  });

  test('a month that spent more than came in: the difference from savings or debt, drawn and said, never a link back', () => {
    const html = sankey({ txns: [row(day(1), 'ACME CORP', -1000, 'income'), row(day(2), 'Landlord', 2100, 'rent and utilities')] });
    const t = text(html);
    expect(t).toContain('Savings or debt $1.1K');
    expect(t).toContain('From savings or debt');
    expect(t).toContain('From savings or debt, beyond what came in $1,100.00');
    expect(html).toContain('<div class="summary-value negative">-$1,100.00</div>');
    expect(html).toContain('class="sankey-node deficit"');
    expect(html).toContain('class="sankey-link deficit"');
    expect(t).not.toContain('Left over');
    // Every ribbon runs left to right: its path starts left of where it ends.
    for (const [, x0, x1] of html.matchAll(/<path class="sankey-link[^"]*" d="M([\d.]+),[\d.]+C[\d.]+,[\d.]+ [\d.]+,[\d.]+ ([\d.]+),/g)) expect(Number(x0)).toBeLessThan(Number(x1));
  });
});

describe('the chart', () => {
  test('an image to a screen reader, with its figures in a sentence; its text alternative a table of every flow', () => {
    const html = sankey();
    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-label="Cash flow for ' +
        periodCaption(periodOf('this-month', today), today) +
        ': $3,138.50 came in from 2 payers; $2,881.30 went out to 3 category groups, and $257.20 was left over. The table under the chart lists every flow."'
    );
    const t = text(html);
    expect(t).toContain('Show as a table');
    expect(t).toContain('Money in, by who paid it');
    expect(t).toContain('ACME CORP : list its transactions $3,100.00 1');
    // The refund is money in, marked.
    expect(t).toContain('Amazon : list its transactions refund $38.50 1');
    expect(t).toContain('Money in $3,138.50 2');
    expect(t).toContain('Left over, of what came in $257.20');
    expect(t).toContain('Housing : list its transactions $2,100.00 1');
    expect(t).toContain('Rent and utilities : list its transactions $2,100.00 1');
    // A button each, its purpose read out but not shown.
    expect(html).toContain('<button type="button" class="cash-flow-show">Housing<span class="visually-hidden">: list its transactions</span></button>');
  });

  test('says what it leaves out, as the totals do, and what is in another currency', () => {
    const t = text(sankey());
    expect(t).toContain('Transfers, cash withdrawals and loan payments are left out, as in every total (1 here). So is 1 transaction you excluded.');
    expect(t).toContain("1 transaction in EUR isn't in these totals, which are in USD.");
    expect(t).toContain('A refund counts as money in, as in every total, never as less spending in its category.');
  });

  test('colors are the app’s variables, never a color of its own, and labels sit outside their nodes', () => {
    const html = sankey();
    expect(html).not.toMatch(/(fill|stroke)="#[0-9a-f]{3,6}"/i);
    expect(html).toMatch(/class="sankey-node in tappable"/);
    expect(html).toMatch(/class="sankey-node out tappable"/);
    expect(html).toContain('viewBox="0 0 340 ');
    expect(html).toContain('<tspan class="sankey-amount">');
  });

  test('without onPick nothing can be tapped, and nothing says it can', () => {
    const html = renderToStaticMarkup(<CashFlowSankey txns={ROWS} taxonomy={taxonomy} currency="USD" />);
    expect(html).not.toContain('tappable');
    expect(html).not.toContain('sankey-hit');
    expect(text(html)).not.toContain('Tap a payer');
    expect(html).not.toContain('<button');
  });

  test('the node whose transactions are listed is marked, and its ribbons lit', () => {
    const food = taxonomy.groups.find((g) => g.name === 'Food')!.id;
    const html = sankey({ pick: { period: 'this-month', node: `group:${food}`, label: 'Food' } });
    expect(html).toContain('sankey-svg sankey-picking');
    expect(html).toContain('class="sankey-node out tappable picked"');
    expect((html.match(/sankey-link[^"]* lit"/g) ?? []).length).toBe(3);
    // A pick from another period marks nothing here.
    expect(sankey({ pick: { period: 'last-month', node: `group:${food}`, label: 'Food' } })).not.toContain('picked');
  });
});

describe('the period selector', () => {
  test('offers this month, last month, the last 3 months, the year to date and the last 12 months, and says the months', () => {
    const t = text(sankey());
    for (const label of ['This month', 'Last month', 'Last 3 months', 'Year to date', 'Last 12 months']) expect(t).toContain(label);
    for (const key of ['last-month', 'last-3-months', 'year-to-date', 'last-12-months'] as const) {
      const html = sankey({ initialPeriod: key });
      expect(html).toContain(`<option value="${key}" selected="">`);
      expect(text(html)).toContain(periodCaption(periodOf(key, today), today));
    }
  });

  test('a longer period adds its months up', () => {
    const html = sankey({ initialPeriod: 'last-3-months' });
    const s = summarize(ROWS, inPeriod(periodOf('last-3-months', today)), 'USD');
    expect(s.money_in).toBe(6238.5);
    expect(html).toContain(`<div class="summary-value inflow">${formatMoney(s.money_in, 'USD')}</div>`);
  });

  test('a period reaching before the earliest transaction says it may be missing what came before', () => {
    expect(text(sankey({ initialPeriod: 'last-12-months' }))).toContain(`The earliest transaction here is from`);
  });

  test('an empty period says so, with no chart and no table', () => {
    const html = sankey({ txns: [row(day(2), 'To savings', 500, 'transfer out', { transaction_code: 'transfer' })] });
    const t = text(html);
    expect(t).toContain(`Nothing came in or went out in ${periodCaption(periodOf('this-month', today), today)}, of what the totals count.`);
    expect(html).not.toContain('<svg');
    expect(t).not.toContain('Show as a table');
    // What was left out is still said.
    expect(t).toContain('(1 here)');
  });
});

describe('what may be missing, beside the chart', () => {
  test('a connection that stopped syncing, or whose transactions couldn’t be loaded, in the words of the stale notes', () => {
    const lapsed = sankey({ stopped: [{ institution_name: 'Chase', last_ok_at: new Date(Date.now() - 40 * 86_400_000).toISOString() }] });
    expect(lapsed).toMatch(/<div class="stale-note">Chase hasn&#x27;t synced since [^<]+, so [^<]+ may be missing some of its transactions\.<\/div>/);
    expect(text(sankey({ incomplete: [{ institution_name: 'Amex', coverage: 'missing' }] }))).toContain("Doesn't include Amex: its transactions couldn't be loaded");
  });

  test('a 401(k) that brings in no transactions is never named as missing any', () => {
    const view = { without: [{ item_id: 'e', institution_name: 'Empower', reason: 'investment_accounts' as const }], connections: 2 };
    expect(text(sankey({ withoutTransactions: view }))).not.toContain('Empower');
  });
});

describe('a tap lists the node’s transactions in the Activity list', () => {
  const food = taxonomy.groups.find((g) => g.name === 'Food')!.id;
  const pick: FlowPick = { period: 'last-3-months', node: `group:${food}`, label: 'Food' };

  test('its rows, from every month of its period, worked out from the rows as they are now', () => {
    const rows = pickedRows(ROWS, pick, { ix, currency: 'USD', today });
    expect(rows.map((t) => t.name)).toEqual(['Whole Foods', 'Trader Joes', 'Nopalito', 'Whole Foods']);
    // Recategorized since: it leaves the node.
    const moved = ROWS.map((t) => (t.name === 'Nopalito' ? { ...t, category: 'travel' } : t));
    expect(pickedRows(moved, pick, { ix, currency: 'USD', today }).map((t) => t.name)).toEqual(['Whole Foods', 'Trader Joes', 'Whole Foods']);
    // A node that isn't there now shows none.
    expect(pickedRows(ROWS, { ...pick, node: 'group:gone' }, { ix, currency: 'USD', today })).toEqual([]);
  });

  test('the list says which node it shows, from which months, and puts the month back', () => {
    const t = text(renderToStaticMarkup(<FlowShown pick={pick} count={4} onClear={() => {}} />));
    expect(t).toBe(`Food, ${periodCaption(periodOf('last-3-months', today), today)}, from the cash flow: 4 transactions. Back to the month`);
    expect(text(renderToStaticMarkup(<FlowShown pick={pick} count={0} onClear={() => {}} />))).toContain('none of its transactions are here now');
  });

  test('the Activity tab mounts the chart with what its months say, and lists a tapped node’s rows through its own search', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'components', 'MonthBreakdown.tsx'), 'utf8');
    const mount = source.slice(source.indexOf('<CashFlowSankey'), source.indexOf('/>', source.indexOf('<CashFlowSankey')));
    for (const prop of ['txns={txns}', 'taxonomy={taxonomy}', 'currency={currency}', 'incomplete={incomplete}', 'stopped={stopped}', 'withoutTransactions={withoutTransactions}', 'pick={flowPick}']) expect(mount).toContain(prop);
    expect(source).toContain('searchRows(listed, { query, tag: filterTag }, tags)');
    expect(source).toContain('<FlowShown pick={flowPick}');
  });

  test('the chart waits for the categories it draws by: none without them', () => {
    const html = renderToStaticMarkup(<MonthBreakdown txns={ROWS} notes={[]} loading={false} onRecategorize={() => {}} onRename={() => {}} />);
    expect(text(html)).not.toContain('Cash flow');
  });

  test('the flows the views draw are the module’s own', () => {
    const flow = cashFlow(ROWS, inPeriod(periodOf('this-month', today)), 'USD', ix);
    expect(text(sankey())).toContain(`${formatMoney(flow.net, 'USD')}`);
  });
});
