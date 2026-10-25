import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import CashFlowSankey, { FlowShown } from '@/components/CashFlowSankey';
import { DrawnWidth } from '@/components/drawn-width';
import MonthBreakdown, { type Txn } from '@/components/MonthBreakdown';
import BudgetsTab from '@/components/BudgetsTab';
import BudgetsCard from '@/components/BudgetsCard';
import { cashFlow, inPeriod, periodCaption, periodEnding, periodOf, pickedRows, type FlowPick } from '@/lib/cash-flow';
import { addMonths } from '@/lib/rollover';
import { summarize, spendingByCategory } from '@/lib/totals';
import { filedId, indexTaxonomy } from '@/lib/categories';
import { formatMoney } from '@/lib/format';
import { localDate, localMonth } from '@/lib/local-date';
import { IMPORTED_TXN_PREFIX } from '@/lib/history-import/view';
import { countTransactions } from '@/lib/spending';
import { bankRows, expandSplitsAndGroups } from '@/lib/split-rows';
import { entryLabel, wholeSplits } from '@/components/SplitRows';
import type { Txn as StoredTxnRow } from '@/lib/transactions';
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

const sankey = (props: Partial<Parameters<typeof CashFlowSankey>[0]> = {}, width?: number) =>
  renderToStaticMarkup(
    width === undefined ? (
      <CashFlowSankey txns={ROWS} taxonomy={taxonomy} currency="USD" onPick={() => {}} {...props} />
    ) : (
      <DrawnWidth.Provider value={width}>
        <CashFlowSankey txns={ROWS} taxonomy={taxonomy} currency="USD" onPick={() => {}} {...props} />
      </DrawnWidth.Provider>
    )
  );
// Near the narrowest a chart in dollars draws its fourth column, of
// categories, at (components/CashFlowSankey.tsx fitsCategories): a label
// there has about 108px, so names are cut beside their amounts.
const FOUR = 380;

describe('the issue’s acceptance, through the views themselves', () => {
  test('money in on the chart is the Activity tab’s money in for the same month, to the cent', () => {
    const html = renderToStaticMarkup(<MonthBreakdown txns={ROWS} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} segment="spending" />);
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
    // Each category the Budgets tab offers to budget, with what it spent
    // this month: in Add budget's sheet, opened on the budgets the tab draws,
    // with its spending by the same function.
    const addText = text(renderToStaticMarkup(<BudgetsCard taxonomy={taxonomy} budgets={budgets} spent={spent} currency="USD" editable noSpending={false} onSave={async () => true} adding />));
    for (const name of ['rent and utilities', 'general merchandise']) {
      const shown = name[0].toUpperCase() + name.slice(1);
      expect(addText).toContain(`${shown} (${figure(name)} this month)`);
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
    expect(t).toContain("Transfers, cash withdrawals and loan payments are left out, as in the month's totals (1 here). So is 1 transaction you excluded.");
    expect(t).toContain("1 transaction in EUR isn't in these totals, which are in USD.");
    expect(t).toContain("A refund counts as money in, as in the month's totals, never as less spending in its category.");
  });

  test('colors are the app’s variables, never a color of its own, and labels sit outside their nodes', () => {
    const html = sankey();
    expect(html).not.toMatch(/(fill|stroke)="#[0-9a-f]{3,6}"/i);
    expect(html).toMatch(/class="sankey-node in tappable"/);
    expect(html).toMatch(/class="sankey-node out tappable"/);
    expect(html).toContain('viewBox="0 0 340 ');
    expect(html).toContain('<tspan class="sankey-amount">');
  });

  test('a tall node whose name one line would cut puts it on a line of its own, above its amount; a thin one keeps one line', () => {
    const html = sankey({}, FOUR);
    expect(html).toMatch(/<tspan class="sankey-name" x="[\d.]+" dy="-0.25em">Rent and utilities<\/tspan><tspan class="sankey-amount" x="[\d.]+" dy="1.2em">\$2\.1K<\/tspan>/);
    expect(html).toContain('<tspan class="sankey-name">Restaurants </tspan><tspan class="sankey-amount">$96</tspan>');
  });

  test('Other income says so whole where it fits, else as Other, and its tooltip names whom it holds', () => {
    const payers = [row(day(1), 'Big Employer', -100_000, 'income'), ...['Ann', 'Bo', 'Cy'].map((name) => row(day(2), name, -500, 'income'))];
    // Four columns, so the payers' labels have a third of the width.
    const html = sankey({ txns: [...payers, row(day(3), 'Landlord', 30_000, 'rent and utilities')] }, FOUR);
    expect(html).toContain('<tspan class="sankey-name">Other </tspan><tspan class="sankey-amount">$1.5K</tspan>');
    expect(html).toContain('<title>Other income: $1,500.00, 3 transactions (Ann, Bo, Cy)</title>');
    const small = sankey({ txns: [row(day(1), 'Big Employer', -3000, 'income'), ...['Ann', 'Bo'].map((name) => row(day(2), name, -20, 'income'))] });
    expect(small).toContain('<tspan class="sankey-name">Other income </tspan><tspan class="sankey-amount">$40</tspan>');
  });

  test('without onPick nothing can be tapped, and nothing says it can', () => {
    const html = renderToStaticMarkup(<CashFlowSankey txns={ROWS} taxonomy={taxonomy} currency="USD" />);
    expect(html).not.toContain('tappable');
    expect(html).not.toContain('sankey-hit');
    expect(text(html)).not.toContain('Tap a payer');
    expect(html).not.toContain('<button');
  });

  test('the middle node’s tooltip says both sides, since its transactions are money in and out alike', () => {
    expect(sankey()).toContain('<title>Everything counted: $3,138.50 in and $2,881.30 out, 7 transactions</title>');
  });

  test('a pick from the table the chart folds marks the node that holds it, and lights its ribbon rather than dimming them all', () => {
    const payers = [row(day(1), 'Big Employer', -100_000, 'income'), ...['Ann', 'Bo', 'Cy'].map((name) => row(day(2), name, -500, 'income'))];
    const html = sankey({ txns: [...payers, row(day(3), 'Landlord', 30_000, 'rent and utilities')], pick: { period: 'this-month', node: 'payer:bo', label: 'Bo' } });
    expect(html).toContain('sankey-svg sankey-picking');
    expect(html).toMatch(/<g class="sankey-node in tappable picked"><title>Other income:/);
    expect((html.match(/sankey-link[^"]* lit"/g) ?? []).length).toBe(1);
    // A pick of something no longer there dims nothing.
    expect(sankey({ pick: { period: 'this-month', node: 'payer:nobody', label: 'Nobody' } })).not.toContain('sankey-picking');
  });

  test('the node whose transactions are listed is marked, and its ribbons lit', () => {
    const food = taxonomy.groups.find((g) => g.name === 'Food')!.id;
    const html = sankey({ pick: { period: 'this-month', node: `group:${food}`, label: 'Food' } }, FOUR);
    expect(html).toContain('sankey-svg sankey-picking');
    expect(html).toContain('class="sankey-node out tappable picked"');
    // Its ribbon in, and one to each of its two categories.
    expect((html.match(/sankey-link[^"]* lit"/g) ?? []).length).toBe(3);
    // A pick from another period marks nothing here.
    expect(sankey({ pick: { period: 'last-month', node: `group:${food}`, label: 'Food' } })).not.toContain('picked');
  });
});

describe('the period, kept beside the pick', () => {
  test('the period given is the one shown, with the pick it belongs to marked, and only in the month it ended with', () => {
    const food = taxonomy.groups.find((g) => g.name === 'Food')!.id;
    const thisMonth = today.slice(0, 7);
    const html = sankey({ period: 'last-3-months', pick: { period: 'last-3-months', month: thisMonth, node: `group:${food}`, label: 'Food' } });
    expect(text(html)).toContain(periodCaption(periodOf('last-3-months', today), today));
    expect(html).toContain('class="sankey-node out tappable picked"');
    // A pick without its month is today's month's, as before months were kept.
    expect(sankey({ period: 'last-3-months', pick: { period: 'last-3-months', node: `group:${food}`, label: 'Food' } })).toContain('tappable picked');
    // The same length ending with another month isn't the pick's period.
    const earlier = addMonths(thisMonth, -1);
    expect(sankey({ period: 'last-3-months', month: earlier, pick: { period: 'last-3-months', month: thisMonth, node: `group:${food}`, label: 'Food' } })).not.toContain('tappable picked');
    // No control of its own: Spending's period chips choose it.
    expect(html).not.toContain('<select');
  });

  test('the Activity tab keeps it beside the pick, so a reload, which shows a spinner in the card’s place, brings both back', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'components', 'MonthBreakdown.tsx'), 'utf8');
    const mount = source.slice(source.indexOf('<CashFlowSankey'), source.indexOf('/>', source.indexOf('<CashFlowSankey')));
    expect(mount).toContain('period={span}');
    expect(mount).toContain('month={selected ?? undefined}');
    expect(source).toContain('const [span, setSpan] = useState<PeriodKey>("this-month");');
  });
});

describe('what the load couldn’t read, beside the chart', () => {
  const manual = "Manual accounts: couldn't be read, so transactions entered for them aren't shown";

  test('said first among what may be missing, as a sentence', () => {
    const html = sankey({ notes: [manual, 'Your rules couldn’t be read, so none are applied until they can be: transactions show as the bank and you have them.'] });
    expect(html).toContain('<div class="stale-note">Manual accounts: couldn&#x27;t be read, so transactions entered for them aren&#x27;t shown.</div>');
    expect(text(html)).toContain('Your rules couldn’t be read, so none are applied until they can be');
    // Even with nothing to draw: the period may only look empty.
    expect(text(sankey({ txns: [], notes: ['Could not load transactions.'] }))).toContain('Could not load transactions.');
  });

  test('the Activity tab passes its notes: the chart says them on Spending, as the list does on Transactions', () => {
    const render = (segment: 'spending' | 'transactions') =>
      renderToStaticMarkup(<MonthBreakdown txns={ROWS} notes={[manual]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} segment={segment} />);
    expect(render('spending')).toContain(`<div class="stale-note">${manual.replace(/'/g, '&#x27;')}.</div>`);
    expect(render('transactions')).toContain(`<div class="error">${manual.replace(/'/g, '&#x27;')}</div>`);
  });

  test('where the cash flow isn’t on the screen, the notes go with the figures', () => {
    const render = (segment: 'spending' | 'transactions', withCategories: boolean) =>
      renderToStaticMarkup(
        <MonthBreakdown txns={ROWS} notes={[manual]} loading={false} taxonomy={withCategories ? taxonomy : null} onRecategorize={() => {}} onRename={() => {}} segment={segment} />
      );
    const esc = manual.replace(/'/g, '&#x27;');
    // Spending before the categories load: no chart to say them, so the In /
    // Out / Net card says them as the chart would (a sentence each), once.
    const bare = render('spending', false);
    expect(bare).toContain(`<div class="stale-note">${esc}.</div>`);
    expect(bare.split(esc).length - 1).toBe(1);
    // Transactions: beside the month's figures as a stale-note without the
    // chart's full stop, and still under the list.
    for (const cats of [true, false]) {
      expect(render('transactions', cats)).toContain(`<div class="stale-note">${esc}</div>`);
      expect(render('transactions', cats)).toContain(`<div class="error">${esc}</div>`);
    }
    // Spending with the chart: the chart says them, once.
    const chart = render('spending', true);
    expect(chart.split(esc).length - 1).toBe(1);
  });

  test('what no figure reads (tags, the review queue’s settings) the list says, never the chart', () => {
    const tags = "Your tags couldn't be read, so transactions show without them until they can be.";
    const queue = 'Your review queue’s settings couldn’t be read, so nothing is marked to review until they can be.';
    const render = (segment: 'spending' | 'transactions') =>
      renderToStaticMarkup(
        <MonthBreakdown txns={ROWS} notes={[manual]} asideNotes={[tags, queue]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} segment={segment} />
      );
    const esc = (n: string) => n.replace(/'/g, '&#x27;');
    expect(render('transactions')).toContain(`<div class="error">${esc(manual)}</div><div class="error">${esc(tags)}</div><div class="error">${esc(queue)}</div>`);
    const chart = render('spending');
    expect(chart).toContain(`<div class="stale-note">${esc(manual)}.</div>`);
    expect(chart).not.toContain(esc(tags));
    expect(chart).not.toContain(esc(queue));
    // With nothing listed, they still say why rather than the year looking empty.
    const none = renderToStaticMarkup(<MonthBreakdown txns={[]} notes={[]} asideNotes={[tags]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} />);
    expect(none).not.toContain('No transactions in the last 12 months.');
  });
});

describe('the period it is given', () => {
  test('says the months of each length, ending with this month or the month given', () => {
    for (const key of ['this-month', 'last-3-months', 'year-to-date', 'last-12-months'] as const) {
      expect(text(sankey({ period: key }))).toContain(periodCaption(periodOf(key, today), today));
      const earlier = addMonths(today.slice(0, 7), -2);
      expect(text(sankey({ period: key, month: earlier }))).toContain(periodCaption(periodEnding(key, earlier), today));
    }
  });

  test('a longer period adds its months up', () => {
    const html = sankey({ period: 'last-3-months' });
    const s = summarize(ROWS, inPeriod(periodOf('last-3-months', today)), 'USD');
    expect(s.money_in).toBe(6238.5);
    expect(html).toContain(`<div class="summary-value inflow">${formatMoney(s.money_in, 'USD')}</div>`);
  });

  test('a period reaching before the earliest transaction says it may be missing what came before', () => {
    expect(text(sankey({ period: 'last-12-months' }))).toContain(`The earliest transaction here is from`);
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
    // A node no longer there (a fold that changed shape, say) is said to be gone, never its transactions.
    expect(text(renderToStaticMarkup(<FlowShown pick={{ ...pick, node: 'other-income', label: 'Other income' }} count={0} onClear={() => {}} />))).toBe(
      `Other income, ${periodCaption(periodOf('last-3-months', today), today)}, is no longer in the cash flow, so nothing is listed. Back to the month`
    );
    // Focus can be moved to it, where the list is, after a pick.
    expect(renderToStaticMarkup(<FlowShown pick={pick} count={4} onClear={() => {}} />)).toContain('<div class="flow-shown" role="status" tabindex="-1">');
  });

  test('the Activity tab mounts the chart with what its months say, and lists a tapped node’s rows through its own search', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'components', 'MonthBreakdown.tsx'), 'utf8');
    const mount = source.slice(source.indexOf('<CashFlowSankey'), source.indexOf('/>', source.indexOf('<CashFlowSankey')));
    // The rows as the totals count them: converted, with a home currency (lib/fx/totals.ts).
    for (const prop of ['txns={counted.rows}', 'taxonomy={taxonomy}', 'currency={currency}', 'incomplete={incomplete}', 'stopped={stopped}', 'withoutTransactions={withoutTransactions}', 'pick={flowPick}']) expect(mount).toContain(prop);
    expect(source).toContain('searchEntries(listed, { query, tag: filterTag, review: reviewing }, tags)');
    expect(source).toContain('<FlowShown pick={flowPick}');
  });

  test('the chart waits for the categories it draws by: none without them', () => {
    const html = renderToStaticMarkup(<MonthBreakdown txns={ROWS} notes={[]} loading={false} onRecategorize={() => {}} onRename={() => {}} segment="spending" />);
    expect(text(html)).not.toContain('Cash flow');
    // Where it would be, with them.
    expect(text(renderToStaticMarkup(<MonthBreakdown txns={ROWS} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} segment="spending" />))).toContain('Cash flow');
  });

  test('the flows the views draw are the module’s own', () => {
    const flow = cashFlow(ROWS, inPeriod(periodOf('this-month', today)), 'USD', ix);
    expect(text(sankey())).toContain(`${formatMoney(flow.net, 'USD')}`);
  });
});

describe('rows imported into a linked account from its bank’s files (#52)', () => {
  // As the Activity tab gets them: beside the bank's, ids of their own.
  const FILES: Txn[] = [
    row(day(7), 'CORNER SHOP', 60, 'groceries', { transaction_id: `${IMPORTED_TXN_PREFIX}acc_chk:1`, source: 'import:ofx' }),
    row(day(8), 'OLD DEPOSIT', -500, null, { transaction_id: `${IMPORTED_TXN_PREFIX}acc_chk:2`, source: 'import:ofx' }),
  ];
  const rows = [...ROWS, ...FILES];

  test('counted as the month counts them, and said as the month’s summary says them, of the chart’s period', () => {
    const html = renderToStaticMarkup(<MonthBreakdown txns={rows} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} segment="spending" />);
    const s = summarize(rows, (d) => d.startsWith(month), 'USD');
    expect(s.money_in).toBe(3638.5);
    expect(html.split(`<div class="summary-value inflow">${formatMoney(s.money_in, 'USD')}</div>`).length - 1).toBe(2);
    expect(html.split(`<div class="summary-value">${formatMoney(s.money_out, 'USD')}</div>`).length - 1).toBe(2);
    const t = text(html);
    expect(t).toContain('2 of this month’s transactions were imported from files, not sent by the bank.');
    expect(t).toContain(`2 of ${periodCaption(periodOf('this-month', today), today)}’s transactions were imported from files, not sent by the bank.`);
    // Over a longer period, of the period.
    expect(text(sankey({ txns: rows, period: 'last-3-months' }))).toContain('2 of this period’s transactions were imported from files, not sent by the bank.');
    // Without them, nothing.
    expect(text(sankey())).not.toContain('imported from your bank');
  });

  test('a tap on their payer or their category lists them in the Activity list, beside the bank’s', () => {
    const groceries = taxonomy.categories.find((c) => c.name === 'groceries')!.id;
    const listed = (node: string) => pickedRows(rows, { period: 'this-month', node, label: '' }, { ix, currency: 'USD', today }).map((t) => t.name);
    expect(listed(`category:${groceries}`)).toEqual(['Whole Foods', 'Trader Joes', 'CORNER SHOP']);
    expect(listed('payer:old deposit')).toEqual(['OLD DEPOSIT']);
    // The table lists the deposit under the name the list shows, never a refund.
    expect(text(sankey({ txns: rows }))).toContain('OLD DEPOSIT : list its transactions $500.00 1');
  });
});

describe('split and grouped transactions (#39)', () => {
  const at = new Date().toISOString();
  const cat = (name: string) => taxonomy.categories.find((c) => c.name === name)!.id;
  const by = (id: string, d: number, name: string, amount: number, category: string | null) => row(day(d), name, amount, category, { transaction_id: id });
  // The month as the read layer answers it (lib/split-rows.ts): a charge
  // split across two groups, a small one split across two small categories
  // of one, and tickets paid back with more than they cost, grouped.
  const rows = expandSplitsAndGroups(
    [
      by('pay', 1, 'ACME CORP', -3100, 'income'),
      by('costco', 2, 'COSTCO', 300, 'general merchandise'),
      by('diner', 3, 'DINER', 500, 'food and drink'),
      by('mart', 3, 'MART', 20, 'general merchandise'),
      by('tickets', 4, 'TICKETS', 90, 'entertainment'),
      by('ann', 5, 'ANN', -50, null),
      by('bo', 5, 'BO', -50, null),
      by('rent', 6, 'Landlord', 2100, 'rent and utilities'),
    ] as unknown as StoredTxnRow[],
    {
      splits: new Map([
        ['costco', { version: 1, amount: 300, currency: 'USD', parts: [{ id: 'c1', amount: 200, category_id: cat('home improvement') }, { id: 'c2', amount: 100, category_id: cat('general merchandise') }], updated_at: at }],
        ['mart', { version: 1, amount: 20, currency: 'USD', parts: [{ id: 'm1', amount: 12, category_id: cat('groceries') }, { id: 'm2', amount: 8, category_id: cat('restaurants') }], updated_at: at }],
      ]),
      splitsUnknown: new Set(),
      groups: new Map([['g-concert', { version: 1, name: 'Concert', category_id: cat('entertainment'), members: ['tickets', 'ann', 'bo'], date: day(4), currency: 'USD', created_at: at, updated_at: at }]]),
      groupsUnknown: 0,
      ix,
    }
  ).rows as unknown as Txn[];

  test('the table counts transactions, as the totals do: a split one once on each side, a group as many as it holds', () => {
    const t = text(sankey({ txns: rows }));
    const s = summarize(rows, (d) => d.startsWith(month), 'USD');
    expect([s.money_in, s.money_out]).toEqual([3110, 2920]);
    expect(t).toContain(`Money in ${formatMoney(3110, 'USD')} 4`);
    expect(t).toContain(`Money out ${formatMoney(2920, 'USD')} 4`);
    expect(t).toContain('Concert : list its transactions refund $10.00 3');
    expect(t).toContain('Home improvement : list its transactions $200.00 1');
    expect(t).toContain('Shopping : list its transactions $100.00 1');
    // The month's own count beside it is of the same transactions.
    expect(s.counted).toBe(1 + 1 + 1 + 1 + 3 + 1);
  });

  test('a fold’s tooltip counts the transaction once, though two of its parts are in it', () => {
    expect(sankey({ txns: rows }, FOUR)).toContain('<title>Other: $20.00, 1 transaction (Groceries, Restaurants)</title>');
  });

  test('a tap on a category lists the split transaction whole with the part in it under it, still said to be split in two; on a group’s payer, the group’s row with its transactions', () => {
    const pick = (node: string) => pickedRows(rows, { period: 'this-month', node, label: '' }, { ix, currency: 'USD', today });
    const groceries = pick(`category:${cat('groceries')}`);
    const listed = bankRows(groceries);
    expect(listed.map((t) => [t.name, t.amount, t.split_parts?.map((p) => p.amount)])).toEqual([['MART', 20, [12]]]);
    // Labelled, and its split edited, by the whole transaction, every part of it.
    expect(entryLabel(listed[0])).toBe('Split into 1');
    expect(entryLabel(wholeSplits(rows).get('mart')!)).toBe('Split into 2');
    expect(wholeSplits(rows).get('mart')!.split_parts!.map((p) => p.amount)).toEqual([12, 8]);
    const concert = pick('payer:concert');
    expect(bankRows(concert, { groups: 'keep' }).map((t) => [t.name, t.amount, t.group_members?.map((m) => m.name)])).toEqual([['Concert', -10, ['TICKETS', 'ANN', 'BO']]]);
    // The line above the list counts its transactions.
    expect(text(renderToStaticMarkup(<FlowShown pick={{ period: 'this-month', node: 'payer:concert', label: 'Concert' }} count={countTransactions(concert)} onClear={() => {}} />))).toBe(
      `Concert, ${periodCaption(periodOf('this-month', today), today)}, from the cash flow: 3 transactions. Back to the month`
    );
  });

  test('the Activity tab counts a pick’s transactions, and labels and edits a split one listed in part by the whole of it', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'components', 'MonthBreakdown.tsx'), 'utf8');
    expect(source).toContain('<FlowShown pick={flowPick} count={countTransactions(picked ?? [])}');
    expect(source).toContain('const splitsWhole = useMemo(() => wholeSplits(txns ?? []), [txns]);');
    expect(source).toContain('const sub = [entryLabel(whole(t)), ');
    expect(source).toContain('<TxnNotes t={t} whole={whole(t)} ');
    // Its sheet, and the split it edits, are the transaction's from every row
    // loaded, put back whole: never from the parts the list happens to show.
    expect(source).toContain('const byId = useMemo(() => new Map(bankRows(txns ?? [], { groups: "keep", ious: "keep" })');
    expect(source).toContain('const sheetRows = useMemo(() => findTarget(sheet?.target ?? null, byId), [sheet, byId]);');
  });
});
