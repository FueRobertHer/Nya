import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { compactMoney, formatMoney, hiddenFigure, hideAmountsIn, MASK, setAmountsHidden, signedMoney, spoken, amountsHidden } from '@/lib/format';
import {
  HIDE_AMOUNTS_KEY,
  amountsHiddenNow,
  loadHideAmountsForTests,
  readHideAmounts,
  setHideAmounts,
  showFigures,
  subscribeHideAmounts,
  writeHideAmounts,
} from '@/components/hide-amounts';
import { HideAmountsToggle, Masked } from '@/components/HideAmounts';
import NetWorthChart from '@/components/NetWorthChart';
import MonthBreakdown, { type Txn } from '@/components/MonthBreakdown';
import BudgetsCard from '@/components/BudgetsCard';
import GoalsCard from '@/components/GoalsCard';
import Insights from '@/components/Insights';
import ForecastCard from '@/components/ForecastCard';
import CalendarView from '@/components/CalendarView';
import RecurringCard from '@/components/RecurringCard';
import { IncomePoolHeader } from '@/components/IncomePool';
import DebtPayoff from '@/components/DebtPayoff';
import PlanFanChart from '@/components/PlanFanChart';
import { wholeMoney } from '@/components/plan-text';
import { PreviewView } from '@/components/Sharing';
import { ReportView } from '@/components/ReportView';
import { buildReport, type ReportInput, type SourceFacts } from '@/lib/report/build';
import { resolvePeriod } from '@/lib/report/period';
import type { Txn as StoredTxn } from '@/lib/transactions';
import { detectRecurring, scheduleDates, type RecurringRow } from '@/lib/recurring';
import { EMPTY_PLANNED } from '@/lib/planned';
import type { ForecastInstitution } from '@/lib/forecast';
import type { IncomePool } from '@/lib/rollover';
import type { Goal } from '@/lib/goal-model';
import type { GoalAccount } from '@/lib/goal-view';
import { localDate, localMonth } from '@/lib/local-date';
import { categoriesFor } from './category-fixture';

// Hide amounts (components/hide-amounts.ts): the switch that shows the app's
// structure while hiding its figures. Every money amount the main screens
// show is written as "•••" by the formatters (lib/format.ts), with its sign
// and currency kept; meters, bars and charts keep their shapes; a screen
// reader hears "hidden"; the choice is kept on the device and survives a
// storage that fails; and nothing the server makes (the API, the downloads,
// a route's answer) or a report being printed is ever hidden.

const ROOT = join(import.meta.dir, '..');

afterEach(() => {
  // The flag lives in lib/format.ts for the whole test run: never leave it on.
  setAmountsHidden(false);
  showFigures(false);
});

/** Renders with amounts hidden, and as shown, for comparing the two. */
function both(node: () => React.ReactElement): { hidden: string; shown: string } {
  setAmountsHidden(true);
  try {
    return { hidden: renderToStaticMarkup(node()), shown: (setAmountsHidden(false), renderToStaticMarkup(node())) };
  } finally {
    setAmountsHidden(false);
  }
}

const decode = (s: string) =>
  s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

/** Everything a person or a screen reader is given: the text between the
 *  tags, and the attributes said or shown (a label, a tooltip). An input's
 *  value is a figure the person typed, hidden by the CSS hook (below); a
 *  placeholder is an example ("e.g. 24.99"), nobody's figure. */
function exposed(html: string): string {
  const attrs = [...html.matchAll(/\s(?:aria-label|aria-valuetext|title|alt)="([^"]*)"/g)].map((m) => m[1]);
  return decode([html.replace(/<[^>]+>/g, ' '), ...attrs].join('\n'));
}

/** A figure as the formatters write one: a currency's symbol beside a digit
 *  ("$12", "-$12", "CA$5", "12 €"), a code after one ("12.50 DOGE"), or a
 *  figure with cents ("1,234.56"); never a percentage. */
const AMOUNT = /\p{Sc}[\s ]?[-+]?\d|\d[\s ]?\p{Sc}|\d[\d,]*\.\d{2}(?![\d%])|\d[\s ](?:USD|EUR|GBP|JPY|DOGE)\b/u;

/** No figure anywhere a person or a screen reader is given one (each line
 *  that holds one is listed, to say where), and the mask is there instead. */
function expectNoAmounts(html: string) {
  const text = exposed(html);
  expect(text.split(/\n|(?<=>)|\s{2,}/).filter((l) => AMOUNT.test(l))).toEqual([]);
  expect(text).toContain(MASK);
}

/** What shows a proportion: each style (a meter's or a bar's width, a
 *  marker's place) and each drawn shape, in order. */
const shapes = (html: string) => [...html.matchAll(/\s(?:style|d|points|width|height|x|y|cx|cy|r)="([^"]*)"/g)].map((m) => m[1]);

describe('the formatters, with amounts hidden', () => {
  test('write the figures as one mask, whatever the size, with the sign and the currency where they go', () => {
    setAmountsHidden(true);
    expect(formatMoney(1234.5, 'USD')).toBe('$•••');
    expect(formatMoney(7, 'USD')).toBe('$•••');
    expect(formatMoney(-12, 'USD')).toBe('-$•••');
    expect(formatMoney(12, 'EUR')).toBe('€•••');
    expect(formatMoney(3200, 'JPY')).toBe('¥•••');
    expect(formatMoney(12, 'CAD')).toBe('CA$•••');
    expect(formatMoney(12)).toBe('$•••');
    expect(formatMoney(-12, null)).toBe('-$•••');
    // A code Intl refuses goes after the mask, as after the figures.
    expect(formatMoney(12.5, 'DOGE')).toBe('••• DOGE');
    expect(formatMoney(-12.5, 'DOGE')).toBe('-••• DOGE');
    // Signed, and compact: a "K" or an "M" says a size too.
    expect(signedMoney(12, 'USD', { always: true })).toBe('+$•••');
    expect(signedMoney(-5, 'USD')).toBe('-$•••');
    expect(signedMoney(0, 'USD')).toBe('$•••');
    expect(signedMoney(5, 'DOGE')).toBe('+••• DOGE');
    expect(compactMoney(1_200_000, 'USD')).toBe('$•••');
    expect(compactMoney(1_200_000)).toBe('$•••');
    expect(compactMoney(950, 'EUR')).toBe('€•••');
    expect(wholeMoney(1_500_000, 'USD')).toBe('$•••');
    expect(wholeMoney(-3, null)).toBe('-$•••');
  });

  test('and as before when amounts show', () => {
    expect(amountsHidden()).toBe(false);
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50');
    expect(signedMoney(12, 'USD', { always: true })).toBe('+$12.00');
    expect(compactMoney(1_200_000, 'USD')).toBe('$1.2M');
    expect(hiddenFigure('12.345')).toBe('12.345');
  });

  test('a figure written without them is hidden too (a holding’s quantity, a rule’s amount)', () => {
    setAmountsHidden(true);
    expect(hiddenFigure('12.345')).toBe(MASK);
  });

  test('text the server wrote, naming a balance, is hidden where it is shown, its other numbers kept', () => {
    const said = "Checking's balance changed to $1,234.56 since this form opened. Card (+$40.00) and Wallet (+12.50 DOGE), €3,40, 12,50 €, CA$12.00 and XAU 12.00 on Sep 12 at 3 pm, 2026.";
    expect(hideAmountsIn(said)).toBe(said);
    setAmountsHidden(true);
    expect(hideAmountsIn(said)).toBe(
      "Checking's balance changed to $••• since this form opened. Card (+$•••) and Wallet (+••• DOGE), €•••, ••• €, CA$••• and XAU ••• on Sep 12 at 3 pm, 2026."
    );
  });

  test('a screen reader hears "hidden" for each, never bullets, and an account’s last digits as they are', () => {
    expect(spoken('Groceries $••• of $••• · over')).toBe('Groceries hidden of hidden · over');
    expect(spoken('Spent •••, -€•••, +••• DOGE, ••• €, CA$•••, (¥•••)')).toBe('Spent hidden, hidden, hidden, hidden, hidden, (hidden)');
    expect(spoken('Checking ••1234')).toBe('Checking ••1234');
    expect(spoken('Nothing hidden here: $12.00')).toBe('Nothing hidden here: $12.00');
  });

  test('Masked draws the text as it is, and gives a screen reader the spoken words', () => {
    const html = renderToStaticMarkup(<Masked>{'$••• of $•••'}</Masked>);
    expect(html).toBe('<span aria-hidden="true">$••• of $•••</span><span class="visually-hidden">hidden of hidden</span>');
    expect(renderToStaticMarkup(<Masked>{'$12.00 of $40.00'}</Masked>)).toBe('$12.00 of $40.00');
    expect(renderToStaticMarkup(<Masked>{null}</Masked>)).toBe('');
  });
});

describe('the switch', () => {
  test('has one clear name, and its state is whether it is pressed', () => {
    const html = renderToStaticMarkup(<HideAmountsToggle />);
    expect(html).toContain('aria-label="Hide amounts"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('type="button"');
    // The server, and the browser's first render over its page, say shown.
    loadHideAmountsForTests(memory({ [HIDE_AMOUNTS_KEY]: '1' }));
    expect(renderToStaticMarkup(<HideAmountsToggle />)).toContain('aria-pressed="false"');
    expect(amountsHiddenNow()).toBe(true);
    loadHideAmountsForTests(null);
  });

  test('sits in the header, beside Refresh, and on the report page', () => {
    const dashboard = readFileSync(join(ROOT, 'components', 'Dashboard.tsx'), 'utf8');
    const actions = dashboard.slice(dashboard.indexOf('<div className="top-actions">'));
    expect(actions.indexOf('<HideAmountsToggle />')).toBeGreaterThan(-1);
    expect(actions.indexOf('<HideAmountsToggle />')).toBeLessThan(actions.indexOf('aria-label="Refresh"'));
    // The dashboard draws again when it changes.
    expect(dashboard).toContain('useAmountsHidden();');
    const reports = readFileSync(join(ROOT, 'components', 'ReportsPage.tsx'), 'utf8');
    expect(reports).toContain('<HideAmountsToggle />');
    expect(reports).toContain('useAmountsHidden();');
  });
});

/** A device's storage, in memory, or one that fails as a private window's
 *  or a blocked site's can. */
function memory(initial: Record<string, string> = {}, fail: { read?: boolean; write?: boolean } = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (k: string) => {
      if (fail.read) throw new Error('SecurityError');
      return items.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (fail.write) throw new Error('QuotaExceededError');
      items.set(k, v);
    },
    removeItem: (k: string) => {
      if (fail.write) throw new Error('QuotaExceededError');
      items.delete(k);
    },
  };
}

describe('remembered on this device', () => {
  afterEach(() => loadHideAmountsForTests(null));

  test('kept in its storage, and read back as the page loads', () => {
    const storage = memory();
    expect(readHideAmounts(storage)).toBe(false);
    expect(setHideAmounts(true, storage)).toBe(true);
    expect(storage.items.get(HIDE_AMOUNTS_KEY)).toBe('1');
    expect(amountsHidden()).toBe(true);
    expect(formatMoney(5, 'USD')).toBe('$•••');
    // A new page on the same device.
    loadHideAmountsForTests(null);
    expect(amountsHidden()).toBe(false);
    loadHideAmountsForTests(storage);
    expect(amountsHidden()).toBe(true);
    // Turned off, nothing is kept: shown is the default.
    expect(setHideAmounts(false, storage)).toBe(true);
    expect(storage.items.has(HIDE_AMOUNTS_KEY)).toBe(false);
    expect(amountsHidden()).toBe(false);
  });

  test('a storage that can’t be read reads as shown, and one that can’t be written still hides for the page', () => {
    expect(readHideAmounts(memory({ [HIDE_AMOUNTS_KEY]: '1' }, { read: true }))).toBe(false);
    expect(readHideAmounts(null)).toBe(false);
    const broken = memory({}, { write: true });
    expect(setHideAmounts(true, broken)).toBe(false);
    expect(amountsHidden()).toBe(true);
    expect(writeHideAmounts(false, broken)).toBe(false);
    expect(writeHideAmounts(true, null)).toBe(false);
  });

  test('anything but "1" reads as shown', () => {
    for (const v of ['true', '0', '', 'yes']) expect(readHideAmounts(memory({ [HIDE_AMOUNTS_KEY]: v }))).toBe(false);
  });

  test('marks the root for the CSS hook while amounts are hidden, and follows another tab', () => {
    const storage = memory();
    const listeners = new Map<string, (e: unknown) => void>();
    const was = { window: globalThis.window, document: globalThis.document };
    const root = { dataset: {} as Record<string, string> };
    Object.assign(globalThis, {
      window: { localStorage: storage, addEventListener: (t: string, f: (e: unknown) => void) => listeners.set(t, f), removeEventListener: (t: string) => listeners.delete(t) },
      document: { documentElement: root },
    });
    try {
      let told = 0;
      const stop = subscribeHideAmounts(() => told++);
      setHideAmounts(true);
      expect(root.dataset.amounts).toBe('hidden');
      expect(told).toBe(1);
      setHideAmounts(false);
      expect(root.dataset.amounts).toBeUndefined();
      // Turned on in another tab of Nya on this device.
      storage.items.set(HIDE_AMOUNTS_KEY, '1');
      listeners.get('storage')!({ key: HIDE_AMOUNTS_KEY });
      expect(amountsHiddenNow()).toBe(true);
      expect(root.dataset.amounts).toBe('hidden');
      // Another key changed: nothing to do.
      listeners.get('storage')!({ key: 'nya:dashboard' });
      expect(told).toBe(3);
      stop();
      expect(listeners.has('storage')).toBe(false);
    } finally {
      Object.assign(globalThis, was);
    }
  });

  test('printing shows the figures, whatever the switch says, and hides them again after', () => {
    loadHideAmountsForTests(memory({ [HIDE_AMOUNTS_KEY]: '1' }));
    expect(formatMoney(12, 'USD')).toBe('$•••');
    showFigures(true);
    expect(formatMoney(12, 'USD')).toBe('$12.00');
    expect(amountsHiddenNow()).toBe(false);
    showFigures(false);
    expect(formatMoney(12, 'USD')).toBe('$•••');
  });
});

// ---- The main screens, masked ----

const TODAY = localDate();
const MONTH = localMonth();
const day = (d: number) => `${MONTH}-${String(d).padStart(2, '0')}`;

function txn(over: Partial<Txn>): Txn {
  return {
    transaction_id: 't',
    date: day(1),
    name: 'Shop',
    amount: 10,
    pending: false,
    account_name: 'Checking',
    account_type: 'depository',
    institution_name: 'Chase',
    category: 'food and drink',
    iso_currency_code: 'USD',
    vendor_key: 'nm:chase::shop',
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
  } as Txn;
}

const ROWS: Txn[] = [
  txn({ transaction_id: 'a', date: day(1), name: 'Payroll', amount: -3200.55, category: 'income' }),
  txn({ transaction_id: 'b', date: day(1), name: 'Grocer', amount: 84.12, category: 'groceries' }),
  txn({ transaction_id: 'c', date: day(2), name: 'Bistro', amount: 312.4, category: 'restaurants' }),
  txn({ transaction_id: 'd', date: day(2), name: 'Paris hotel', amount: 120, category: 'travel', iso_currency_code: 'EUR' }),
];
const { taxonomy, budgets } = categoriesFor({ groceries: 300, restaurants: 200 }, { words: ['groceries', 'restaurants'], groups: { groceries: 'Food', restaurants: 'Food' } });

const chase = (over: Partial<ForecastInstitution> = {}): ForecastInstitution => ({
  institution_name: 'Chase',
  item_id: 'item_1',
  accounts: [{ account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 1900.25, currency: 'USD' }],
  ...over,
});
const recurring = (date: string, amount: number, over: Partial<RecurringRow> = {}): RecurringRow => ({
  date,
  name: 'Rent',
  amount,
  institution_name: 'Chase',
  account_name: 'Checking',
  account_type: 'depository',
  category: 'rent and utilities',
  transaction_code: null,
  iso_currency_code: 'USD',
  ...over,
});
const monthly = (from: string, count: number, d: number) => scheduleDates({ unit: 'month', every: 1, days: [d], month: from, slot: 0 }, '2100-01-01', count);
const SERIES = detectRecurring([
  ...monthly('2026-04', 6, 15).map((d) => recurring(d, 1500.5)),
  ...monthly('2026-04', 6, 25).map((d) => recurring(d, -2000, { name: 'Payroll', category: 'income' })),
]);

const GOAL_ACCOUNTS: GoalAccount[] = [{ account_id: 'sav', name: 'Savings', institution: 'Chase', balance: 10_000, currency: 'USD', type: 'depository' }];
const GOALS: Goal[] = [
  { id: 'trip', name: 'Trip', target: 3000, account_id: 'sav', plan: { allocation: 1200, monthly_target: 250 } },
  { id: 'fund', name: 'Fund', target: 20_000, account_id: 'sav' },
];

const POOL: IncomePool = {
  start: MONTH,
  from: MONTH,
  clamped: false,
  carried_in: 0,
  income: 500,
  spending: 80,
  available: 420,
  uncertain: [],
  months: [{ month: MONTH, carried_in: 0, income: 500, spending: 80, carried_out: 420, uncertain: false }],
};

const NY = 'America/New_York';
const NOW = Date.parse('2026-10-10T14:00:00.000Z');
const storedRow = (id: string, date: string, amount: number, category: string): StoredTxn =>
  ({ ...txn({ transaction_id: id, date, name: id, amount, category }), vendor_key: id }) as unknown as StoredTxn;
const source: SourceFacts = {
  item_id: 'item_chase',
  institution_name: 'Chase',
  institution_id: null,
  coverage: 'complete',
  synced_at: '2026-10-10T13:00:00.000Z',
  first_date: '2023-01-01',
  first_seen: null,
  never_synced: false,
  no_transactions: null,
  last_ok_at: '2026-10-10T13:00:00.000Z',
  problem: null,
  records_unreadable: false,
  holds: { investment: false, loans: false },
};
function report() {
  const period = resolvePeriod({ kind: 'year', year: 2025 }, NY, NOW);
  if ('error' in period) throw new Error(period.error);
  const input: ReportInput = {
    period,
    generatedAt: new Date(NOW).toISOString(),
    rows: [storedRow('Payroll', '2025-01-15', -4000, 'income'), storedRow('Pharmacy', '2025-02-03', 42.5, 'medical'), storedRow('Rent', '2025-02-01', 1500, 'rent and utilities')],
    currency: null,
    sources: [source],
    notes: [],
    manual: [],
    removed: [],
    removedUnreadable: 0,
    manualUnread: [],
    liveAccounts: [],
    links: new Map(),
    ownRead: { categories: true, names: true, exclusions: true },
    marked: ['medical'],
    markedUnreadable: false,
    hidden: false,
    healthUnread: false,
  };
  return buildReport(input);
}

const sapphire = {
  account_id: 'sapphire',
  name: 'Sapphire',
  mask: '4321',
  type: 'credit',
  subtype: 'credit card',
  balance: 4210.55,
  currency: 'USD',
  liability: { kind: 'credit' as const, apr: 21.24, apr_label: 'Purchase APR', minimum_payment: 120 },
};

const SCREENS: Record<string, () => React.ReactElement> = {
  'Home: the net worth chart': () => (
    <NetWorthChart
      points={[
        { date: '2026-09-01', value: 152_000.12 },
        { date: '2026-09-02', value: 154_500.5 },
        { date: '2026-09-03', value: 151_800 },
      ]}
    />
  ),
  'Home: the insights': () => (
    <Insights
      txns={ROWS}
      budgets={{ categories: { ...budgets.categories }, groups: {} }}
      taxonomy={taxonomy}
      accounts={[{ name: 'Checking', type: 'depository', subtype: 'checking', balance: 40.5, currency: 'USD' }]}
    />
  ),
  'Activity: the month, its totals, top spending and transactions': () => (
    <MonthBreakdown txns={ROWS} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} />
  ),
  'Budgets: the meters, opened to a group': () => (
    <BudgetsCard
      taxonomy={taxonomy}
      budgets={budgets}
      spent={{ [taxonomy.categories.find((c) => c.name === 'groceries')!.id]: 84.12, [taxonomy.categories.find((c) => c.name === 'restaurants')!.id]: 312.4 }}
      currency="USD"
      editable
      noSpending={false}
      onSave={async () => true}
      open={[taxonomy.groups.find((g) => g.name === 'Food')!.id]}
    />
  ),
  'Budgets: goals': () => <GoalsCard goals={GOALS} accounts={GOAL_ACCOUNTS} onSave={async () => true} />,
  'Budgets: the income pool': () => <IncomePoolHeader pool={POOL} currency="USD" month={MONTH} today={MONTH} />,
  'Budgets: the cash forecast': () => <ForecastCard institutions={[chase()]} series={SERIES} planned={EMPTY_PLANNED} today={TODAY} />,
  'Budgets: the calendar': () => (
    <CalendarView
      txns={[txn({ transaction_id: 'x', date: TODAY, name: 'Corner shop', amount: 30.25 })]}
      series={SERIES}
      planned={[]}
      dismissed={new Set()}
      institutions={[chase()]}
      today={TODAY}
      currency="USD"
    />
  ),
  'Budgets: recurring bills and income': () => <RecurringCard series={SERIES} today={TODAY} currency="USD" dismissed={new Set()} onDismiss={async () => true} />,
  'Accounts: the payoff plan': () => <DebtPayoff open onClose={() => {}} institutions={[{ institution_name: 'Chase', liabilities: 'on', accounts: [sapphire] }]} />,
  'Sharing: the preview of what they see': () => (
    <PreviewView
      who="Pat"
      expiresAt={null}
      preview={{
        connection: 'c1',
        view: {
          accounts: [
            { id: 'a', label: 'Joint ••1111', level: 'transactions', balance: 500.75, currency: 'USD', as_of: '2026-09-27', debt: false, transactions: [{ date: '2026-09-25', name: 'Blue Bottle', amount: 12, pending: false, currency: 'USD' }] },
          ],
          expires_at: null,
        },
      }}
      error=""
      unsaved={false}
    />
  ),
  'Plan: the simulation’s fan chart': () => (
    <PlanFanChart bands={{ p10: [100_000, 80_000, 0], p25: [100_000, 90_000, 50_000], p50: [100_000, 105_000, 110_000], p75: [100_000, 120_000, 150_000], p90: [100_000, 140_000, 200_000] }} startAge={60} currency="USD" />
  ),
  'Reports: the report on screen': () => <ReportView report={report()} />,
};

describe('the main screens with amounts hidden', () => {
  for (const [name, screen] of Object.entries(SCREENS)) {
    test(`${name}: no figure shows, and every proportion stays`, () => {
      const { hidden, shown } = both(screen);
      // The fixture shows figures when amounts aren't hidden.
      expect(AMOUNT.test(exposed(shown))).toBe(true);
      expectNoAmounts(hidden);
      // Meters, bars, chart shapes and markers are drawn exactly as shown.
      expect(shapes(hidden)).toEqual(shapes(shown));
      // A screen reader is never left with bullets in a label it reads alone.
      for (const m of hidden.matchAll(/aria-label="([^"]*)"/g)) expect(m[1]).not.toContain(MASK);
    });
  }

  test('percentages stay: they say no amount', () => {
    const groceries = taxonomy.categories.find((c) => c.name === 'groceries')!.id;
    const { hidden } = both(() => (
      <Insights txns={[txn({ transaction_id: 'g', amount: 285, category: 'groceries' })]} budgets={{ categories: { [groceries]: { amount: 300 } }, groups: {} }} taxonomy={taxonomy} accounts={[]} />
    ));
    expect(exposed(hidden)).toContain('Approaching your groceries budget (95%)');
    const chart = both(SCREENS['Home: the net worth chart']).hidden;
    expect(exposed(chart)).toMatch(/[+-]\d+\.\d%/);
  });

  test('the hidden figures are said as "hidden" where they stand alone', () => {
    const { hidden } = both(SCREENS['Activity: the month, its totals, top spending and transactions']);
    expect(hidden).toContain('<span class="visually-hidden">hidden</span>');
    const meters = both(SCREENS['Budgets: the meters, opened to a group']).hidden;
    expect(meters).toContain('<span class="visually-hidden">hidden of hidden</span>');
  });

  test('a field holding a figure is one the CSS hook covers, and the hook is there', () => {
    const { hidden } = both(SCREENS['Accounts: the payoff plan']);
    const fields = [...hidden.matchAll(/<input[^>]*>/g)].map((m) => m[0]).filter((f) => /value="[^"]*\d/.test(f));
    expect(fields.length).toBeGreaterThan(0);
    // React writes inputMode as it is spelled; the browser reads attribute
    // names in any case, as the CSS hook does.
    for (const f of fields) expect(/inputmode="decimal"|class="[^"]*budget-input/i.test(f)).toBe(true);
    const css = readFileSync(join(ROOT, 'app', 'globals.css'), 'utf8');
    expect(css).toContain(':root[data-amounts="hidden"] :is(input[inputmode="decimal"], input.budget-input):not(:focus)');
  });
});

describe('never the server, the API or a download', () => {
  /** Every source file under a directory, but tests and components. */
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...sources(path));
      else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
    return out;
  }

  test('only the browser’s switch turns it on, and nothing the server runs reaches the switch', () => {
    const all = [...sources(join(ROOT, 'lib')), ...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'components'))];
    const callers = all.filter((f) => /\bsetAmountsHidden\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    expect(callers.sort()).toEqual(['components/hide-amounts.ts', 'lib/format.ts']);
    // No route, page or library module imports it: only components drawn in
    // the browser do.
    const servers = [...sources(join(ROOT, 'lib')), ...sources(join(ROOT, 'app'))].filter((f) => /from ['"][^'"]*(?:hide-amounts|HideAmounts)['"]/.test(readFileSync(f, 'utf8')));
    expect(servers.map((f) => relative(ROOT, f))).toEqual([]);
  });

  test('loaded where there is no browser, the switch reads nothing and hides nothing', () => {
    // This test file imported it with no window: as the server would.
    expect(amountsHiddenNow()).toBe(false);
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50');
  });

  test('the report, shown again for printing, has its figures', () => {
    loadHideAmountsForTests(memory({ [HIDE_AMOUNTS_KEY]: '1' }));
    try {
      expect(exposed(renderToStaticMarkup(<ReportView report={report()} />))).not.toMatch(AMOUNT);
      showFigures(true);
      expect(exposed(renderToStaticMarkup(<ReportView report={report()} />))).toMatch(/\$4,000\.00/);
    } finally {
      showFigures(false);
      loadHideAmountsForTests(null);
    }
    const page = readFileSync(join(ROOT, 'components', 'ReportsPage.tsx'), 'utf8');
    expect(page).toContain('useFiguresWhenPrinted();');
  });
});
