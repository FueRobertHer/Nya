import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { amountSamples, compactMoney, formatMoney, formatRate, hiddenFigure, hideAmountsIn, hideFiguresIn, MASK, setAmountsHidden, signedMoney, spoken, amountsHidden } from '@/lib/format';
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
import BudgetsTab from '@/components/BudgetsTab';
import GoalsCard from '@/components/GoalsCard';
import Insights from '@/components/Insights';
import { HomeAttention } from './home-attention';
import ForecastCard from '@/components/ForecastCard';
import CalendarView from '@/components/CalendarView';
import RecurringCard from '@/components/RecurringCard';
import PlannedCard from '@/components/PlannedCard';
import UpcomingPanel from '@/components/UpcomingPanel';
import { CAR as UPCOMING_CAR, REFUND as UPCOMING_REFUND, SCENES as UPCOMING_SCENES, TODAY as UPCOMING_TODAY, derived as upcomingDerived } from './upcoming-notes-fixture';
import { IncomePoolHeader } from '@/components/IncomePool';
import DebtPayoff from '@/components/DebtPayoff';
import PlanFanChart from '@/components/PlanFanChart';
import PlanPathChart from '@/components/PlanPathChart';
import { ScenariosSheet } from '@/components/PlanScenarios';
import { ProgressView, SheetBody as ProgressSheetBody } from '@/components/PlanProgress';
import { LifeEventsCard } from '@/components/PlanEvents';
import { createScenarioClient, INITIAL_SCENARIOS } from '@/components/plan-scenarios';
import { DEFAULT_PLAN } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { NO_CHANGES } from '@/lib/fire/scenarios';
import { wholeMoney } from '@/components/plan-text';
import { InputsCard } from '@/components/PlanTab';
import { FigureForm } from '@/components/PlanForms';
import { figureNotes, windowText, type FigureArgs } from '@/components/plan-figure-notes';
import { fiFigures } from '@/lib/fire/progress';
import { NO_CONNECTIONS_WITHOUT } from '@/lib/no-transactions';
import type { InvestedAssets, TrailingFlows, WorkplaceSavings } from '@/lib/fire/inputs';
import { PreviewView } from '@/components/Sharing';
import { ReportView } from '@/components/ReportView';
import { CsvMapping, PreviewView as ImportPreview, type Picked, type Preview } from '@/components/ImportSheet';
import { MappingStep, ReviewStep, type Question as MigrationQuestion, type Review as MigrationReview } from '@/components/MigrationSheet';
import CashFlowSankey from '@/components/CashFlowSankey';
import { DrawnWidth } from '@/components/drawn-width';
import SplitSheet from '@/components/SplitSheet';
import GroupSheet from '@/components/GroupSheet';
import CardMode from '@/components/CardMode';
import ReviewNote from '@/components/ReviewNote';
import type { ReviewControls } from '@/components/review-state';
import { bankRows, expandSplitsAndGroups } from '@/lib/split-rows';
import { indexTaxonomy } from '@/lib/categories';
import { readImport, type ImportOptions } from '@/lib/import/read';
import { bypasses, clientModules, FORMATTERS, staleMemos, unmaskedChildren, unspokenLabels } from './amount-sources';
import { heroCurrencyCaveats } from '@/components/CurrencyNotes';
import { balancesIn } from '@/lib/fx/net-worth';
import { ecbTable } from './fx-fixture';
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
import { CARD as MONTH_CARD, FOOD as MONTH_FOOD, GROCERIES as MONTH_GROCERIES, TAB as MONTH_TAB, TAB_SCENES as MONTH_SCENES } from './budget-notes-fixture';
import { RunwayView } from '@/components/RunwayReport';
import { YearOverYearView } from '@/components/YearOverYearReport';
import { cashPosition } from '@/lib/forecast';
import { buildRunwayInputs, projectRunway, DEFAULT_WHAT_IF } from '@/lib/report/runway';
import type { RunwayReport } from '@/lib/report/runway-read';
import { buildYearOverYear } from '@/lib/report/year-over-year';
import type { YearOverYearReport } from '@/lib/report/year-over-year-read';
import { PLANNED as RUNWAY_PLANNED, ROWS as RUNWAY_ROWS, TODAY as RUNWAY_TODAY } from './runway-fixture';
import SharedExpensesCard from '@/components/SharedExpensesCard';
import ShareCostSheet from '@/components/ShareCostSheet';
import { ConfirmPaymentSheet, SettleSheet } from '@/components/ConfirmPaymentSheet';
import PersonSheet from '@/components/PersonSheet';
import HandoffSheet from '@/components/HandoffSheet';
import IouSheet from '@/components/IouSheet';
import { cardOf as sharedCard, daysAgo as sharedDaysAgo, shared as sharedState, txn as sharedTxn } from './shared-expenses-fixture';

// Hide amounts (components/hide-amounts.ts): the switch that shows the app's
// structure while hiding its figures. Every money amount the main screens
// show is written as "•••" by the formatters (lib/format.ts), with its sign
// and currency kept; meters, bars and charts keep their shapes; a screen
// reader hears "hidden"; the choice is kept on the device and survives a
// storage that fails; and nothing the server makes (the API, the downloads,
// a route's answer) or a report being printed is ever hidden.

const ROOT = join(import.meta.dir, '..');

/** As in a browser's page: only there can amounts be hidden (lib/format.ts
 *  setAmountsHidden refuses where there is no window). */
function inBrowser<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const none = g.window === undefined;
  if (none) g.window = {};
  try {
    return fn();
  } finally {
    if (none) delete g.window;
  }
}
const hideNow = () => inBrowser(() => setAmountsHidden(true));

afterEach(() => {
  // The flag lives in lib/format.ts for the whole test run: never leave it on.
  setAmountsHidden(false);
  showFigures(false);
});

/** Renders with amounts hidden, and as shown, for comparing the two. */
function both(node: () => React.ReactElement): { hidden: string; shown: string } {
  hideNow();
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

/** A figure as the formatters write one, or as anything else could: a
 *  currency's symbol beside a digit ("$12", "-$12", "CA$5", "12 €"), a code
 *  before or after one ("CHF 12.00", "12.50 DOGE"), a figure with cents or
 *  finer ("1,234.56", a quantity's "12.345"), thousands ("1,234"), or a
 *  compact figure ("1.2K"); never a percentage. A code is any three capitals
 *  (en-US writes every currency without a symbol of its own with its code,
 *  "SEK 12,000"), which errs towards reporting, or a longer one Plaid gives a
 *  cryptocurrency. */
const CODES = '(?:[A-Z]{3}|DOGE)';
const AMOUNT = new RegExp(
  [
    String.raw`\p{Sc}[\s ]?[-+]?\d`,
    String.raw`\d[\s  ]?\p{Sc}`,
    String.raw`\d[\d,]*\.\d{2,}(?![\d%])`,
    String.raw`\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b(?!%)`,
    String.raw`\b\d+\.\d[KMBT]\b`,
    String.raw`\b\d+(?:\.\d+)?[KMBT]?[\s ]${CODES}\b`,
    String.raw`\b${CODES}[\s ][-+]?\d`,
  ].join('|'),
  'u'
);

/** Examples of how a file can write an amount, in the CSV mapping step's
 *  choices: nobody's figures, and meaningless masked. */
const EXAMPLES = ['Negative (-12.50)', 'Positive (12.50)', 'a point (1,234.56)', 'a comma (1.234,56)'];

/** No figure anywhere a person or a screen reader is given one (each line
 *  that holds one is listed, to say where), and the mask is there instead. */
function expectNoAmounts(html: string) {
  const text = EXAMPLES.reduce((t, e) => t.split(e).join(''), exposed(html));
  expect(text.split(/\n|(?<=>)|\s{2,}/).filter((l) => AMOUNT.test(l))).toEqual([]);
  expect(text).toContain(MASK);
}

/** What a screen reader is given: the text, but what is hidden from it
 *  (aria-hidden), and an image's or a labelled control's text, said by its
 *  label instead; and each label it reads. */
function spokenText(html: string): string {
  const said: string[] = [];
  const quiet: boolean[] = [];
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>\/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    if (m[1]) quiet.pop();
    else if (m[2]) {
      const attrs = m[3] ?? '';
      const label = attrs.match(/\saria-label="([^"]*)"/)?.[1];
      const hidden = /\saria-hidden="true"/.test(attrs);
      if (label !== undefined && !hidden && !quiet.some(Boolean)) said.push(label);
      if (VOID.has(m[2].toLowerCase()) || m[4] === '/') continue;
      quiet.push(hidden || /\srole="img"/.test(attrs) || (label !== undefined && /^(?:button|a|option)$/i.test(m[2])));
    } else if (m[5] && !quiet.some(Boolean)) said.push(m[5]);
  }
  return decode(said.join('\n'));
}

/** What shows a proportion: each style (a meter's or a bar's width, a
 *  marker's place) and each drawn shape, in order. */
const shapes = (html: string) => [...html.matchAll(/\s(?:style|d|points|width|height|x|y|cx|cy|r)="([^"]*)"/g)].map((m) => m[1]);

describe('the formatters, with amounts hidden', () => {
  test('write the figures as one mask, whatever the size, with the sign and the currency where they go', () => {
    hideNow();
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
    hideNow();
    expect(hiddenFigure('12.345')).toBe(MASK);
  });

  test('text the server wrote, naming a balance, is hidden where it is shown, its other numbers kept', () => {
    const said = "Checking's balance changed to $1,234.56 since this form opened. Card (+$40.00) and Wallet (+12.50 DOGE), €3,40, 12,50 €, CA$12.00 and XAU 12.00 on Sep 12 at 3 pm, 2026.";
    expect(hideAmountsIn(said)).toBe(said);
    hideNow();
    expect(hideAmountsIn(said)).toBe(
      "Checking's balance changed to $••• since this form opened. Card (+$•••) and Wallet (+••• DOGE), €•••, ••• €, CA$••• and XAU ••• on Sep 12 at 3 pm, 2026."
    );
    // A code after a number that is no amount (a time, a year) is left alone.
    expect(hideAmountsIn('Synced at 12:00 UTC, for the 2026 IRS form, at 21.24% APR.')).toBe('Synced at 12:00 UTC, for the 2026 IRS form, at 21.24% APR.');
    expect(hideAmountsIn('1.234,56 DOGE and 1,234.56 DOGE')).toBe('••• DOGE and ••• DOGE');
  });

  test('a file’s figures, which carry no currency to tell an amount by, are hidden whole while it is imported, a date as one', () => {
    expect(hideFiguresIn('2026-09-01 | Rent | -2450.00')).toBe('2026-09-01 | Rent | -2450.00');
    hideNow();
    expect(hideFiguresIn('2026-09-01 | Rent | -2450.00')).toBe('••• | Rent | -•••');
    expect(hideFiguresIn("1'234.56, 1.234,56 and 1\u00a0234,56")).toBe('•••, ••• and •••');
    expect(spoken(hideFiguresIn('09/01/2026 | Payroll | 5120.33'))).toBe('hidden | Payroll | hidden');
  });

  test('a screen reader hears "hidden" for each, never bullets, and an account’s last digits as they are', () => {
    expect(spoken('Groceries $••• of $••• · over')).toBe('Groceries hidden of hidden · over');
    expect(spoken('Spent •••, -€•••, +••• DOGE, ••• €, CA$•••, (¥•••)')).toBe('Spent hidden, hidden, hidden, hidden, hidden, (hidden)');
    expect(spoken('Checking ••1234')).toBe('Checking ••1234');
    expect(spoken('Nothing hidden here: $12.00')).toBe('Nothing hidden here: $12.00');
    // A word after an amount with its symbol before is a word, said as one.
    expect(spoken('+$••• IRA contribution, $••• OK, CHF\u00a0••• due')).toBe('hidden IRA contribution, hidden OK, hidden due');
  });

  // A rate is no amount of the person's money: the ECB's are public, and a
  // rate of their own is a price (lib/format.ts formatRate).
  test('a rate shows while amounts are hidden, and the scan doesn’t take its formatter for one of theirs', () => {
    expect(FORMATTERS).not.toContain('formatRate');
    hideNow();
    expect(formatRate(0.865725911177, 'USD', 'EUR')).toBe('1 USD = 0.86573 EUR');
    expect(formatRate(61000, 'BTC', 'USD')).toBe('1 BTC = 61,000 USD');
    // Net worth's note under the hero: its amounts hidden, its rate kept.
    const fx = ecbTable({ home: 'EUR' });
    const b = balancesIn([{ amount: 1000, currency: 'USD' }, { amount: 2000, currency: 'EUR' }], fx, 'EUR', '2026-09-14', 'USD');
    const base = { currency: 'EUR', net_worth: b.total, parts: b.parts, left_out: b.left_out, unknown: 0, history: [], gaps: { unsplit: 0, main_unrated: [], left_out: [], unknown_currency: 0 }, delta: null, rates: { day: '2026-09-14', stale: false, own: [], unusable: [] }, fx: { home: 'EUR', latest: fx.latest, own: [] } };
    const html = renderToStaticMarkup(<>{heroCurrencyCaveats(base, 'USD', () => {}).map((c) => <div key={c.key}>{c.body}</div>)}</>);
    expect(exposed(html)).toContain('1 USD = 0.86573 EUR');
    expectNoAmounts(html.replace(/1 [A-Z]{3,10} = [\d.,]+ [A-Z]{3,10}/g, ''));
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
    expect(inBrowser(() => setHideAmounts(true, storage))).toBe(true);
    expect(storage.items.get(HIDE_AMOUNTS_KEY)).toBe('1');
    expect(amountsHidden()).toBe(true);
    expect(formatMoney(5, 'USD')).toBe('$•••');
    // A new page on the same device.
    loadHideAmountsForTests(null);
    expect(amountsHidden()).toBe(false);
    inBrowser(() => loadHideAmountsForTests(storage));
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
    expect(inBrowser(() => setHideAmounts(true, broken))).toBe(false);
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
      // Put back as it was: a window that wasn't there isn't left as undefined.
      for (const [k, v] of Object.entries(was)) {
        if (v === undefined) delete (globalThis as Record<string, unknown>)[k];
        else Object.assign(globalThis, { [k]: v });
      }
    }
  });

  test('printing shows the figures, whatever the switch says, and hides them again after', () => {
    inBrowser(() => loadHideAmountsForTests(memory({ [HIDE_AMOUNTS_KEY]: '1' })));
    expect(formatMoney(12, 'USD')).toBe('$•••');
    showFigures(true);
    expect(formatMoney(12, 'USD')).toBe('$12.00');
    expect(amountsHiddenNow()).toBe(false);
    inBrowser(() => showFigures(false));
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

const CSV = 'Date,Description,Amount\n2026-09-01,Rent,-2450.00\n2026-09-02,Payroll,5120.33\n2026-09-03,Grocer,-84.12\n';
const picked = (text: string): Picked => ({ name: 'checking.csv', blob: new Blob([text]), text, encoding: 'utf-8', format: 'csv' });
const IMPORT_PREVIEW: Preview = {
  format: 'csv',
  encoding: 'utf-8',
  statement: null,
  read: { date_order: null, dates_ordered: false, decimal: null },
  counts: { new: 2, present: 0, repeated: 0, replaced: 0, skipped: 0, conflicts: 0, unreadable: 1 },
  rows: [
    { line: 2, date: '2026-09-01', name: 'Rent', amount: 2450, currency: 'USD', category: null, note: null, outcome: 'new' },
    { line: 3, date: '2026-09-02', name: 'Payroll', amount: -5120.33, currency: 'USD', category: null, note: null, outcome: 'new' },
  ],
  // A file's amount, quoted where it couldn't be read: no currency to tell it by.
  problems: [{ line: 4, reason: 'Its amount (1.234,5x) can’t be read.' }],
  more_problems: 0,
  conflicts: [],
  more_conflicts: 0,
  shared_ids: [],
  more_shared_ids: 0,
  kinds: { transfers: 0, atm: 0, payments: 0, fees: 0 },
  first_date: '2026-09-01',
  last_date: '2026-09-02',
  currency: 'USD',
  currency_from: 'file',
  other_currencies: [],
  totals: { out: 2450, in: 5120.33 },
  shortened: 0,
  warnings: [],
  account_mismatch: null,
  balance: null,
};

/** Another app's export as the switching sheet reviews it
 *  (components/MigrationSheet.tsx): its Visa going into a new manual account
 *  (with what its rows come to, for its balance), its Checking into a linked
 *  account, with a row the bank has beside it, and a line whose amount
 *  can't be read. */
const MIGRATION_REVIEW: MigrationReview = {
  app: 'ynab',
  app_name: 'YNAB',
  detected: true,
  entry: null,
  read: { date_order: 'mdy', order_open: false, sign: null, sign_from: null, decimal: '.' },
  currency: { chosen: null, in_file: false },
  rows: 4,
  notes: [],
  accounts: [
    { key: 'Checking', name: 'Checking', rows: 2, first: '2026-09-01', last: '2026-09-05', currencies: [], net: 1850, transfers: 0, opening: 0, splits: 0, uncategorized: 0, choice: { to: 'linked', id: 'chk' } },
    { key: 'Visa', name: 'Visa', rows: 2, first: '2026-09-02', last: '2026-09-10', currencies: [], net: 1236.42, transfers: 0, opening: 0, splits: 0, uncategorized: 0, choice: null },
  ],
  offered: [{ kind: 'linked', id: 'chk', name: 'Checking', institution: 'Chase', type: 'depository', currency: 'USD', mask: '1111' }],
  categories: {
    mappings: [
      {
        key: 'monthly bills\u001frent',
        group: 'Monthly Bills',
        name: 'Rent',
        kind: null,
        from: null,
        rows: 1,
        target: { to: 'new', name: 'Rent', kind: 'expense', group: { new: 'Monthly Bills' } },
        by: 'new',
        differs: null,
      },
    ],
    added: 1,
    room: 400,
    problem: null,
  },
  counts: { uncategorized: 0, transfers: 0, opening: 0 },
  tags: { on: true, names: [], more: 0, added: 0 },
  splits: { rebuilt: 0, parts: 0, dropped: 0, kept: [], unmarked: null },
  problems: [{ line: 5, reason: 'Its amount (1.234,5x) can’t be read.' }],
  more_problems: 0,
  targets: [
    {
      key: 'linked:chk',
      kind: 'linked',
      name: 'Checking',
      new: false,
      sources: ['Checking'],
      currency: 'USD',
      counts: { new: 1, duplicates: 1 },
      first_date: '2026-09-01',
      last_date: '2026-09-05',
      totals: { out: 0, in: 2500.75 },
      currency_of_totals: 'USD',
      proposals: [
        {
          index: 1,
          line: 3,
          file: { date: '2026-09-05', name: 'Landlord', amount: 1850, currency: 'USD' },
          twin: { date: '2026-09-06', name: 'ZELLE PAYMENT TO LANDLORD', amount: 1850, currency: 'USD', kind: 'bank', descriptor: null },
          days: 1,
          confidence: 'high',
          similar: true,
          choice: 'same',
        },
      ],
      more_proposals: 0,
      problems: [],
      more_problems: 0,
      before_bank: 0,
      within_bank: 0,
      pending_alike: 0,
      history_pending: false,
      splits: 0,
      exploded: [],
      tags_cut: 0,
    },
    {
      key: 'new:Visa',
      kind: 'manual',
      name: 'Visa',
      new: true,
      sources: ['Visa'],
      currency: 'USD',
      counts: { new: 2 },
      first_date: '2026-09-02',
      last_date: '2026-09-10',
      totals: { out: 1271.42, in: 35 },
      currency_of_totals: 'USD',
      proposals: [],
      more_proposals: 0,
      problems: [],
      more_problems: 0,
      before_bank: null,
      within_bank: null,
      pending_alike: null,
      history_pending: false,
      splits: 0,
      exploded: [],
      tags_cut: 0,
    },
  ],
  blocks: [],
  waiting: { accounts: 1, proposals: 0 },
  review: 'a'.repeat(32),
};
/** A header the switching sheet doesn't know, with its first rows. */
const MIGRATION_MAPPING: Extract<MigrationQuestion, { needs: 'mapping' }> = {
  needs: 'mapping',
  app: null,
  columns: {},
  table: {
    header: ['When', 'Bank', 'Who', 'Out', 'In'],
    sample: [
      { line: 2, cells: ['2026-09-01', 'Checking', 'Rent', '2450.00', ''] },
      { line: 3, cells: ['2026-09-02', 'Checking', 'Payroll', '', '5,120.33'] },
    ],
    rows: 2,
  },
  problem: null,
};

/** A month the cash flow draws: pay and a refund in, spending in four
 *  groups, one with a long name, so labels are cut to fit. */
const FLOW: Txn[] = [
  txn({ transaction_id: 'f1', date: day(1), name: 'ACME CORP', amount: -3100.4, category: 'income' }),
  txn({ transaction_id: 'f2', date: day(2), name: 'Amazon', amount: -38.5, category: 'general merchandise' }),
  txn({ transaction_id: 'f3', date: day(2), name: 'Whole Foods', amount: 412.3, category: 'groceries' }),
  txn({ transaction_id: 'f4', date: day(3), name: 'Nopalito', amount: 96, category: 'restaurants' }),
  txn({ transaction_id: 'f5', date: day(4), name: 'Landlord', amount: 2100, category: 'rent and utilities' }),
  txn({ transaction_id: 'f6', date: day(5), name: 'Lisbon', amount: 1250.75, category: 'travel' }),
  txn({ transaction_id: 'f7', date: day(5), name: 'Target', amount: 85, category: 'general merchandise' }),
];

// A transaction split three ways, and a dinner grouped with its payback, as
// the server sends them (lib/split-rows.ts expandSplitsAndGroups).
const splitSet = categoriesFor({}, { words: ['groceries', 'household', 'auto', 'restaurants'] }).taxonomy;
const splitCat = (name: string) => splitSet.categories.find((c) => c.name === name)!.id;
const splitRows = (): Txn[] => {
  const of = (id: string, over: Partial<Txn>) => txn({ transaction_id: id, name: id, category_id: splitCat('general merchandise'), category_name: 'general merchandise', category_kind: 'expense', ...over } as Partial<Txn>);
  const rows = [
    of('Costco', { amount: 150 }),
    of('Bistro', { amount: 120 }),
    of('Venmo from Sam', { amount: -60, category: 'transfer in', category_id: splitCat('transfer in'), category_name: 'transfer in', category_kind: 'transfer' } as Partial<Txn>),
  ];
  return expandSplitsAndGroups(rows as never, {
    splits: new Map([
      [
        'Costco',
        {
          version: 1 as const,
          amount: 150,
          currency: 'USD',
          parts: [
            { id: 'p0', amount: 100.01, category_id: splitCat('groceries'), note: 'food' },
            { id: 'p1', amount: 30, category_id: splitCat('household') },
            { id: 'p2', amount: 19.99, category_id: splitCat('auto') },
          ],
          updated_at: '2026-10-01T00:00:00.000Z',
        },
      ],
    ]),
    splitsUnknown: new Set(),
    groups: new Map([
      [
        'g1',
        { version: 1, name: 'Dinner with Sam', category_id: splitCat('restaurants'), members: ['Bistro', 'Venmo from Sam'], date: day(1), currency: 'USD', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' },
      ],
    ]),
    groupsUnknown: 0,
    ix: indexTaxonomy(splitSet),
  } as never).rows as unknown as Txn[];
};

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

/** The review queue's controls as its views see them: on, doing nothing. */
const REVIEW = {
  view: { on: true, since: day(1), unread: false, unknown: 0 },
  accept: () => {},
  turn: async () => true,
  approve: async () => null,
  undo: async () => true,
  unapprove: async () => true,
  recategorizeAndApprove: async () => null,
  undoRecategorize: async () => true,
  error: null,
  setError: () => {},
  saving: false,
} as unknown as ReviewControls;

/** A bank row standing for one imported from the bank's file (#52), which
 *  was approved at the file's amount before the bank changed its own. */
const TWIN = txn({ transaction_id: 'b_costco', date: day(3), name: 'Costco', amount: 160.5, needs_review: true, review_changed: { amount: 150, currency: 'USD' }, imported_amount: 150 } as Partial<Txn>);
/** Transactions waiting for review, the twin among them. */
const TO_REVIEW: Txn[] = [...ROWS.map((t) => ({ ...t, needs_review: true as const })), TWIN];
/** The split Costco run, approved at another amount than the bank's now. */
const changedSplit = () => splitRows().map((t) => (t.split_of === 'Costco' ? { ...t, needs_review: true as const, review_changed: { amount: 140, currency: 'USD' } } : t));

/** The runway's hand-worked case (test/runway-fixture.ts), as the report
 *  page draws it, a month marked short and a card owed beside it. */
const RUNWAY: RunwayReport = (() => {
  const position = cashPosition([
    {
      institution_name: 'Chase',
      accounts: [
        { account_id: 'chk', name: 'Checking', type: 'depository', balance: 7000, currency: 'USD' },
        { account_id: 'sav', name: 'Savings', type: 'depository', balance: 5000, currency: 'USD' },
      ],
    },
  ]);
  const built = buildRunwayInputs({ today: RUNWAY_TODAY, position, rows: RUNWAY_ROWS, planned: RUNWAY_PLANNED, dismissed: [], short: [{ month: '2026-08', institutions: ['Citi'] }] });
  return {
    ...built,
    version: 1,
    time_zone: 'America/New_York',
    generated_at: '2026-10-22T15:00:00.000Z',
    cash_accounts: built.position.included.map((a) => ({ account_id: a.account_id, name: a.name, institution: a.institution, balance: a.balance, manual: a.manual, as_of: '2026-10-21' })),
    owed_on_cards: 600,
    stale_balances: [],
    gaps: [],
    data_as_of: null,
    notes: [],
  };
})();
/** Year over year over the same rows, and last year's. */
const YOY: YearOverYearReport = {
  ...buildYearOverYear({
    rows: [...RUNWAY_ROWS, ...RUNWAY_ROWS.map((t) => ({ ...t, transaction_id: `${t.transaction_id}-25`, date: `2025${t.date.slice(4)}`, amount: Math.round(t.amount * 0.9 * 100) / 100 }))],
    taxonomy: categoriesFor({}, { words: ['food and drink', 'rent and utilities', 'income', 'general merchandise'] }).taxonomy,
    currency: 'USD',
    today: RUNWAY_TODAY,
    short: new Map([['2026-08', { uncertain: true, institutions: ['Citi'] }]]),
  }),
  version: 1,
  today: RUNWAY_TODAY,
  time_zone: 'America/New_York',
  generated_at: '2026-10-22T15:00:00.000Z',
  gaps: [],
  data_as_of: null,
  caveats: { hidden: false, scope: { investment: false, loans: false }, names_unread: false, notes: [] },
};

/** What the Plan's figures are worked out from (components/plan-figure-notes.ts):
 *  a measured year with loan payments, a refund, IOUs from before it and
 *  loan payments not counted; a workplace plan's contributions added; two
 *  investment accounts, one more at Vanguard not shown; and part-time income
 *  among the assumptions. Made as it is drawn, so its amounts are written as
 *  the switch says. */
function planFigureArgs(): FigureArgs {
  const plan = { ...DEFAULT_PLAN, age: 40, targetAge: 55, partTimeIncome: 28_000 };
  const flows: TrailingFlows = {
    spending: 40_000,
    income: 70_000,
    savings: 30_000,
    loanPayments: 1_200,
    cash: 0,
    refunds: 200,
    cashWithdrawn: 0,
    cashEntered: 0,
    cashEnteredOn: [],
    cashIous: 0,
    unclearLoans: 150,
    largestRefund: { amount: 200, date: '2026-05-02', name: 'Shop' },
    from: '2025-10-07',
    to: '2026-10-06',
    days: 365,
    scaled: false,
    count: 400,
    excludedCount: 0,
    currency: 'USD',
    leftOut: [],
    iousBefore: { count: 2, amount: 300 },
  };
  const workplace: WorkplaceSavings = {
    total: 12_000,
    plans: [{ name: 'Fidelity 401(k)', paidFrom: 'payroll', added: 12_000, count: 24, largest: { amount: 900, date: '2026-03-15' }, matched: 0 }],
    fromBank: [],
    partial: [],
    shortHistory: [],
    problems: [],
    unmeasured: [],
  };
  const assets: InvestedAssets = {
    total: 250_000,
    accounts: [
      { account_id: 'a', name: 'Brokerage', type: 'investment', balance: 150_000, currency: 'USD', institution: 'Vanguard', item_id: 'i1' },
      { account_id: 'b', name: '401(k)', type: 'investment', subtype: '401k', balance: 100_000, currency: 'USD', institution: 'Fidelity', item_id: 'i2' },
    ],
    unknown: 0,
    caveats: [{ kind: 'missing', institution: 'Vanguard', count: 1 }],
    currency: 'USD',
    leftOut: [],
  };
  const figures = fiFigures(plan, { flows, workplace, assets }, 'USD');
  return {
    plan,
    view: figures.view,
    flows,
    unread: [],
    withoutTransactions: NO_CONNECTIONS_WITHOUT,
    transactionCount: flows.count,
    txnsLoading: false,
    txnsFailed: false,
    assets,
    balancesAsOf: '2026-10-06T15:12:00Z',
    workplace,
    workplaceCount: 1,
    cashOn: [],
    cashUnmarked: false,
    money: (n) => wholeMoney(n, 'USD'),
    savingsRate: figures.savingsRate,
    shareRates: null,
  };
}

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
  'Home: the insights': () => <Insights txns={ROWS} accounts={[{ name: 'Checking', type: 'depository', subtype: 'checking', balance: 40.5, currency: 'USD' }]} />,
  // The budget and payment rows: their sentences are built in a function the
  // source scans can't follow into the row.
  'Home: needs attention': () => (
    <HomeAttention
      txns={ROWS}
      budgets={{ categories: { ...budgets.categories }, groups: {} }}
      taxonomy={taxonomy}
      payments={[
        { item_id: 'i', account_id: 'a', name: 'Amex', type: 'credit', balance: 1820.4, currency: 'USD', liability: { minimum_payment: 35.12, next_due_date: null, is_overdue: true } },
      ]}
    />
  ),
  'Activity: the month, its totals and transactions': () => (
    <MonthBreakdown txns={ROWS} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} />
  ),
  'Activity: Spending, the cash flow, net by month, income vs spend, top spending, places and channels': () => (
    <MonthBreakdown txns={ROWS} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} segment="spending" />
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
  // Budgets > Month as rollout 6a2 draws it: the month's one notice, the
  // pool, the Spent card and its notes, the budgets' rows; and its sheets.
  'Budgets > Month: the notice, the pool, the Spent card and the budgets': () => <BudgetsTab {...MONTH_TAB} {...MONTH_SCENES['this month']} />,
  'Budgets > Month: a budget’s sheet, its figures, reconcile and suggestion': () => (
    <BudgetsCard {...MONTH_CARD} onRollover={async () => null} edit={{ kind: 'group', id: MONTH_FOOD }} />
  ),
  'Budgets > Month: a budget’s carryover reset': () => (
    <BudgetsCard {...MONTH_CARD} onRollover={async () => null} edit={{ kind: 'category', id: MONTH_GROCERIES }} editLevel="reset" />
  ),
  'Budgets > Month: Add budget, with what each choice spent': () => <BudgetsCard {...MONTH_CARD} budgets={{ categories: {}, groups: {} }} adding />,
  'Budgets > Month: a budget on a category since deleted': () => (
    <BudgetsCard {...MONTH_CARD} budgets={{ categories: { gone: { amount: 25 } }, groups: {} }} edit={{ kind: 'category', id: 'gone' }} />
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
  // Budgets > Upcoming as rollout 6a3 draws it: the segment's one notice (a
  // card's payment due there names its statement), the forecast, the list and
  // the calendar, Recurring and Planned; and the sheets they open.
  'Budgets > Upcoming: the notice, the forecast, the list, the calendar, recurring and planned': () => {
    const s = UPCOMING_SCENES['pay and bills it leaves out'];
    const d = upcomingDerived(s);
    return (
      <UpcomingPanel
        {...s}
        plannedDrawn
        dismissed={d.dismissed}
        onDismiss={async () => true}
        onSavePlanned={async () => true}
        currency={d.currency}
        plannedCurrency={d.plannedCurrency}
        noSpending={d.noSpending}
      />
    );
  },
  'Budgets > Upcoming: the low-balance warning’s sheet': () => (
    <ForecastCard
      institutions={[chase()]}
      series={SERIES}
      planned={{ ...EMPTY_PLANNED, threshold: { amount: 250, currency: 'USD' } }}
      onSavePlanned={async () => true}
      today={TODAY}
      open="warning"
    />
  ),
  'Budgets > Upcoming: what if I buy…': () => <ForecastCard institutions={[chase()]} series={SERIES} planned={EMPTY_PLANNED} today={TODAY} open="what-if" />,
  'Budgets > Upcoming: a bill’s sheet': () => <RecurringCard series={SERIES} today={TODAY} currency="USD" dismissed={new Set()} onDismiss={async () => true} edit={SERIES[0].id} />,
  'Budgets > Upcoming: planned items': () => (
    <PlannedCard planned={{ ...EMPTY_PLANNED, items: [UPCOMING_CAR, UPCOMING_REFUND] }} today={UPCOMING_TODAY} currency="USD" onSave={async () => true} />
  ),
  'Budgets > Upcoming: a planned item’s sheet': () => (
    <PlannedCard planned={{ ...EMPTY_PLANNED, items: [UPCOMING_CAR, UPCOMING_REFUND] }} today={UPCOMING_TODAY} currency="USD" onSave={async () => true} edit={UPCOMING_CAR.id} />
  ),
  'Budgets > Goals: the payoff plan': () => <DebtPayoff open onClose={() => {}} institutions={[{ institution_name: 'Chase', liabilities: 'on', accounts: [sapphire] }]} />,
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
  'Sharing: a net worth, spending, holdings, budgets and goals shared': () => (
    <PreviewView
      who="Pat"
      expiresAt={null}
      preview={{
        connection: 'c1',
        view: {
          accounts: [],
          expires_at: null,
          views: {
            net_worth: {
              detail: 'history',
              currency: 'USD',
              total: 321_480.25,
              as_of: '2026-09-27',
              from: '2026-09-26',
              other_currencies: [],
              without_balance: 0,
              history: [
                { date: '2026-09-13', value: 318_000 },
                { date: '2026-09-20', value: 320_400.5 },
                { date: '2026-09-27', value: 321_480.25 },
              ],
              accounts: [{ label: 'Joint ••1111', balance: 1250.5, currency: 'USD', debt: false, as_of: '2026-09-27' }],
            },
            spending: {
              detail: 'amounts',
              by: 'category',
              currency: 'USD',
              months: [{ month: '2026-09', so_far: true, total: 1357.5, groups: [{ name: 'Housing', pct: 88, label: '88%', amount: 1200, categories: [{ name: 'Rent', pct: 88, label: '88%', amount: 1200 }] }], left_out: null }],
            },
            holdings: {
              detail: 'amounts',
              currency: 'USD',
              as_of: '2026-09-27',
              from: '2026-09-27',
              total: 20_500,
              classes: [{ slot: 'us-stocks', name: 'US stocks', pct: 100, label: '100%', amount: 20_500 }],
              buckets: [{ slot: 'roth', name: 'Roth', pct: 100, label: '100%', amount: 20_500 }],
              positions: [{ ticker: 'VTI', name: null, class: 'US stocks', pct: 100, label: '100%', amount: 20_500 }],
              notes: [],
            },
            budgets: {
              detail: 'amounts',
              by: 'group',
              currency: 'USD',
              months: [
                {
                  month: '2026-09',
                  total: { name: 'All budgets', pct: 43, label: '43%', over: false, spent: 42.5, limit: 100 },
                  groups: [{ name: 'Food', pct: 43, label: '43%', over: false, spent: 42.5, limit: 100 }],
                  left_out: null,
                  may_be_incomplete: false,
                },
              ],
            },
            goals: {
              detail: 'amounts',
              goals: [
                {
                  name: 'Rainy day',
                  state: 'tracked',
                  pct: 33,
                  label: '33%',
                  currency: 'USD',
                  saved: 1000,
                  target: 3000,
                  target_date: null,
                  outlook: { status: 'on_track', completion: '2028-06', beyond: false, date_passed: false },
                  as_of: '2026-09-27',
                },
              ],
            },
          },
        },
      }}
      error=""
      unsaved={false}
    />
  ),
  'Plan: the simulation’s fan chart': () => (
    <PlanFanChart bands={{ p10: [100_000, 80_000, 0], p25: [100_000, 90_000, 50_000], p50: [100_000, 105_000, 110_000], p75: [100_000, 120_000, 150_000], p90: [100_000, 140_000, 200_000] }} startAge={60} currency="USD" />
  ),
  // Your path's chart (rollout phase 8b): its summary and its table.
  'Plan: Your path’s chart': () => (
    <PlanPathChart
      points={[
        { age: 40, balance: 250_000 },
        { age: 41, balance: 292_500 },
        { age: 42, balance: 1_100_000 },
      ]}
      today={40}
      stopAge={42}
      fiNumber={1_000_000}
      fiAge={41.8}
      realReturn={0.05}
      currency="USD"
    />
  ),
  // With what was recorded since a plan saved as your plan (rollout 8e): its words, summary and table.
  'Plan: Your path’s chart, with what was recorded since your plan': () => (
    <PlanPathChart
      points={[
        { age: 40, balance: 250_000 },
        { age: 41, balance: 292_500 },
        { age: 42, balance: 1_100_000 },
      ]}
      today={40}
      stopAge={42}
      fiNumber={1_000_000}
      fiAge={41.8}
      realReturn={0.05}
      currency="USD"
      recorded={{
        from: '2026-01-02',
        savedDay: '2026-01-02',
        recorded: [
          { age: 39.2, balance: 200_000 },
          { age: 40, balance: 250_000 },
        ],
        planned: [
          { age: 39.2, balance: 200_000 },
          { age: 40, balance: 236_000 },
        ],
        days: ['2026-01-02', '2026-10-01'],
      }}
    />
  ),
  // Since rollout phase 6b the scenarios are listed and compared in a sheet
  // (the Plan's bar, which opens it, has no amounts, and is left to the
  // source scans): a scenario's change, and Compare's figures beside your
  // plan's.
  'Plan: the Scenarios sheet, a scenario’s change and Compare': () => {
    const plan = { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, savings: 30_000, assets: 300_000 };
    const measured = { spending: 40_000, savings: 30_000, assets: 300_000 };
    const scenario = {
      id: 's1',
      version: 1 as const,
      name: 'Spend more',
      currency: 'USD',
      createdAt: '2026-10-01T00:00:00.000Z',
      savedAt: '2026-10-01T00:00:00.000Z',
      rev: 'r1',
      ...NO_CHANGES,
      set: { spending: 52_000 },
    };
    return (
      <ScenariosSheet
        open
        onClose={() => {}}
        onLeave={() => {}}
        state={{ ...INITIAL_SCENARIOS, status: 'ready', list: [scenario] }}
        client={createScenarioClient(() => {})}
        base={plan}
        baseFigures={planFigures(plan, measured) as PlanFigures}
        measured={measured}
        planCurrency="USD"
        canOpen
        planState="ready"
        whyNot={null}
        openId={null}
        onOpen={() => {}}
        run={() => new Promise(() => {})}
        cache={new Map()}
        method="historical"
        money={(n) => wholeMoney(n, 'USD')}
        today="2026-10-23"
      />
    );
  },
  // An open scenario's life events, a row each with its figures in words:
  // every kind, rollout 8d's car (once and every few years), raise, windfall
  // and loan paid off among them.
  'Plan > Your path: a scenario’s life events, of every kind': () => (
    <LifeEventsCard
      scenarioName="Retire at 50"
      version="s1@r1"
      events={[
        { id: 'h', kind: 'house', label: 'Home', atAge: 44, cost: 100_000, yearly: 6_000, years: null },
        { id: 'c', kind: 'child', label: 'Child', fromAge: 42, yearly: 15_000, years: 18 },
        { id: 's', kind: 'sabbatical', label: 'Off', fromAge: 45, years: 1, savingsLost: 80_000 },
        { id: 'p', kind: 'part-time', label: 'Part time', fromAge: 50, toAge: 60, yearly: 20_000 },
        { id: 'x', kind: 'spending', label: 'Less', fromAge: 65, yearly: -8_000, years: 10 },
        { id: 'v', kind: 'car', label: 'Car', atAge: 46, cost: 30_000, every: null, times: 1 },
        { id: 'w', kind: 'car', label: 'Cars', atAge: 50, cost: 35_000, every: 8, times: 4 },
        { id: 'r', kind: 'raise', label: 'Raise', fromAge: 42, yearly: 10_000 },
        { id: 'g', kind: 'windfall', label: 'Gift', atAge: 60, amount: 200_000 },
        { id: 'l', kind: 'loan-end', label: 'Loan', atAge: 48, yearly: 18_000 },
      ]}
      notes={[]}
      money={(n) => wholeMoney(n, 'USD')}
      editable
      onSave={async () => true}
    />
  ),
  // Your figures as rollout 6c draws them: each figure's row, its notes under
  // it (two gathered into a line, one in full), measured savings' rate as its
  // second line, and the assumptions, part-time income among them, as a sub.
  'Plan > Your path: Your figures, their notes, the savings rate and the assumptions': () => {
    const args = planFigureArgs();
    return <InputsCard figures={figureNotes(args)} view={args.view} money={args.money} onOpen={() => {}} />;
  },
  // A figure's sheet, drawn by itself (the tab opens it only once its row is
  // pressed): Nya's figure, measured and not typed, and Why?.
  'Plan > Your path: a figure’s sheet, its measured figure and Why?': () => {
    const args = planFigureArgs();
    return (
      <FigureForm
        plan={args.plan}
        onSave={async () => true}
        onDone={() => {}}
        editable
        kind="spending"
        measured={args.flows!.spending}
        measuredText={`from ${windowText(args.flows!)}`}
        why={figureNotes(args).spending.why}
        currency="USD"
      />
    );
  },
  'Reports: the report on screen': () => <ReportView report={report()} />,
  'Reports: the runway, its chart, inputs and what it can’t see': () => <RunwayView runway={RUNWAY} projection={projectRunway(RUNWAY, { ...DEFAULT_WHAT_IF, months: 3 })} />,
  'Reports: year over year, by month and by group': () => <YearOverYearView report={YOY} />,
  'Activity: the cash flow, where money came from and went': () => <CashFlowSankey txns={FLOW} taxonomy={taxonomy} currency="USD" onPick={() => {}} />,
  'Activity: a split transaction and a group, with their parts and transactions': () => (
    <MonthBreakdown txns={splitRows()} notes={[]} loading={false} taxonomy={splitSet} onRecategorize={() => {}} onRename={() => {}} onSplitsChanged={() => {}} />
  ),
  'Activity: splitting a transaction, and what is left to split': () => (
    <SplitSheet t={(bankRows(splitRows()) as Txn[]).find((t) => t.transaction_id === 'Costco')!} taxonomy={splitSet} onClose={() => {}} onSaved={() => {}} />
  ),
  'Activity: grouping transactions, and what the group comes to': () => (
    <GroupSheet start={null} group={splitRows().find((t) => t.group_members)!} txns={splitRows()} taxonomy={splitSet} onClose={() => {}} onSaved={() => {}} />
  ),
  'Import: a CSV file’s columns, and the lines its column names may be on': () => {
    const options: ImportOptions = { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out', delimiter: ',' } };
    const read = readImport(CSV, { format: 'csv', options, thisYear: 2026 });
    return <CsvMapping file={picked(CSV)} read={read} options={options} setOptions={() => {}} account="Checking" busy={false} error="" onNext={() => {}} />;
  },
  'Switching from another app: where each account goes, its categories, a row the bank has, and each account’s import': () => (
    <ReviewStep
      r={MIGRATION_REVIEW}
      taxonomy={null}
      options={{}}
      accounts={{ Checking: { to: 'linked', id: 'chk' }, Visa: { to: 'new', name: 'Visa', institution: 'YNAB', type: 'credit', balance: '' } }}
      categories={{}}
      tags={true}
      choices={{}}
      busy={false}
      error=""
      onAnswer={() => {}}
      onImport={() => {}}
    />
  ),
  'Switching from another app: a file’s columns, and its first rows': () => (
    <MappingStep q={MIGRATION_MAPPING} options={{ app: 'zerosum' }} busy={false} error="" onAnswer={() => {}} />
  ),
  'Import: what a file brings in, and a line that can’t be read': () => (
    <ImportPreview
      preview={IMPORT_PREVIEW}
      file={picked(CSV)}
      options={{}}
      account={{ account_id: 'manual_checking-1', name: 'Checking', type: 'depository', balance: 1000, currency: 'USD', institution_name: 'Cascade CU' }}
      busy={false}
      error=""
      setBalance={false}
      onSetBalance={() => {}}
      acknowledged={false}
      onAcknowledge={() => {}}
      onFlip={() => {}}
      onImport={() => {}}
      onBack={() => {}}
    />
  ),
  'Activity: the review queue’s bar, and transactions to review, one standing for an imported one the bank changed since': () => (
    <MonthBreakdown txns={TO_REVIEW} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} review={REVIEW} />
  ),
  'Activity: a transaction’s review, the bank having changed its amount since it was approved': () => (
    <ReviewNote t={txn({ needs_review: true, review_changed: { amount: 84.12, currency: 'USD' } } as Partial<Txn>)} taxonomy={taxonomy} review={REVIEW} onChanged={() => {}} />
  ),
  'Card Mode: a split transaction to review, its parts, and the amount it was approved at': () => (
    <CardMode open txns={changedSplit()} taxonomy={splitSet} tags={[]} currency="USD" review={REVIEW} onClose={() => {}} onSplit={() => {}} onGroup={() => {}} />
  ),
  'Card Mode: a transaction standing for one imported from the bank’s file, approved at the file’s amount': () => (
    <CardMode open txns={[TWIN]} taxonomy={taxonomy} tags={[]} currency="USD" review={REVIEW} onClose={() => {}} onSplit={() => {}} onGroup={() => {}} />
  ),
  // Progress against your plan (rollout 8e): where you are and where the plan has you, and the save sheet's savings.
  'Plan: progress against the plan saved as your plan, a newer day short, and an account added since': () => <ProgressView {...PROGRESS} />,
  'Plan: saying this is my plan, with the savings it keeps': () => (
    <ProgressSheetBody sheet="save" saved={null} savings={18_000} money={(n) => wholeMoney(n, 'USD')} inflation="3" onInflation={() => {}} error={null} />
  ),
  // Shared expenses (#49): the card and every sheet with a figure to hide.
  'Shared expenses: who owes what, a payment that may be one, and one gone with where it could move': () => (
    <SharedExpensesCard
      shared={sharedState(sharedCard())}
      txns={[
        sharedTxn({ transaction_id: 't-venmo', name: 'VENMO CASHOUT ALEX SMITH', amount: -35, date: sharedDaysAgo(3), category: 'transfer in', category_kind: 'transfer', transaction_code: 'transfer' }),
        sharedTxn({ transaction_id: 't-dinner-2', name: 'Bistro', amount: 120, date: sharedDaysAgo(9) }),
      ]}
      facts={{ gone: { shares: ['t-dinner'], payments: [] }, twice: [], moves: { shares: { 't-dinner': [{ transaction_id: 't-dinner-2', account_id: 'chk' }] }, payments: {} } }}
      tags={[]}
      taxonomy={null}
      currency="USD"
    />
  ),
  'Shared expenses: sharing a cost, and your part': () => (
    <ShareCostSheet t={sharedTxn({ transaction_id: 't-dinner', name: 'Bistro', amount: 120 })} shared={sharedState(sharedCard())} onClose={() => {}} />
  ),
  'Shared expenses: what a payment paid back, chosen item by item': () => (
    <ConfirmPaymentSheet
      t={sharedTxn({ transaction_id: 't-venmo', name: 'VENMO CASHOUT', amount: -35, date: sharedDaysAgo(3) })}
      person="alex"
      preset={[
        { item: 'e-dinner', amount: 60 },
        { item: 'i-groceries', amount: 25 },
      ]}
      shared={sharedState(sharedCard())}
      onClose={() => {}}
    />
  ),
  'Shared expenses: settled outside your accounts, or let go': () => <SettleSheet person="alex" currency="USD" shared={sharedState(sharedCard())} onClose={() => {}} />,
  'Shared expenses: someone you split costs with, and what is between you': () => <PersonSheet id="alex" open tags={[]} shared={sharedState(sharedCard())} onClose={() => {}} />,
  'Shared expenses: asking for it, and the message to send': () => <HandoffSheet person="alex" currency="USD" shared={sharedState(sharedCard())} onClose={() => {}} />,
};

/** A plan saved on Jan 2, 2026, set against Oct 1's balances. */
const PROGRESS_DAY = (date: string, total: number, over: Record<string, unknown> = {}) => ({ date, total, counted: 2, missing: [] as string[], otherCurrencies: {}, unrated: [], ...over });
const PROGRESS = {
  savedState: {
    kind: 'ready' as const,
    problem: null,
    saved: { version: 1 as const, plan: { ...DEFAULT_PLAN, age: 35, targetAge: 55 }, savings: 18_000, currency: 'USD', inflation: 0.03, day: '2026-01-02', savedAt: '2026-01-02T12:00:00.000Z', rev: 'r1' },
  },
  series: {
    kind: 'ready' as const,
    answer: {
      currency: 'USD',
      saved_day: '2026-01-02',
      anchor: PROGRESS_DAY('2026-01-02', 150_000),
      latest: PROGRESS_DAY('2026-10-02', 171_000, { missing: ['ira'] }),
      months: [{ date: '2026-01-31', total: 152_000 }, { date: '2026-10-01', total: 181_000 }],
      accounts: [{ account_id: 'newira', first: '2026-05-01', last: '2026-10-02', ended: null, label: 'New IRA at Broker' }],
      unreadable_days: [],
    },
  },
  plan: { ...DEFAULT_PLAN, age: 35, targetAge: 55, realReturn: 0.04 },
  blocked: null,
  scenarioOpen: false,
  savings: { value: 18_000, source: 'measured' as const },
  money: (n: number) => wholeMoney(n, 'USD'),
  nameOf: (id: string) => (id === 'ira' ? 'IRA at Broker' : 'New IRA at Broker'),
  busy: false,
  error: null,
  onSheet: () => {},
  onRetry: () => {},
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
      // Nor in any text it is given: each hidden amount is said as "hidden".
      expect(spokenText(hidden).split('\n').filter((l) => l.includes(MASK))).toEqual([]);
      expect(spokenText(hidden)).toContain('hidden');
    });
  }

  test('the cash flow is drawn from the amounts’ proportions alone: its labels, their lines and where they are tapped never move with a figure’s size, and a hidden one’s names never say it', () => {
    const names = (html: string) => [...html.matchAll(/<tspan class="sankey-name"[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]);
    const flow = (scale: number, width: number) => () => (
      <DrawnWidth.Provider value={width}>
        <CashFlowSankey txns={FLOW.map((t) => ({ ...t, amount: t.amount * scale }))} taxonomy={taxonomy} currency="USD" onPick={() => {}} />
      </DrawnWidth.Provider>
    );
    // At a phone's width (three columns), the narrowest four are drawn at,
    // where names are cut, and a wide card's.
    for (const width of [248, 380, 560]) {
      const small = both(flow(1, width));
      const large = both(flow(100, width));
      // The same proportions, a hundred times the figures: the same drawing,
      // tap areas and all, shown or hidden (to a millionth of a unit, past
      // which floating point is all that differs).
      const near = (html: string) => shapes(html).map((s) => s.replace(/-?\d+\.\d+/g, (n) => Number(n).toFixed(6)));
      expect(near(large.shown)).toEqual(near(small.shown));
      expect(near(large.hidden)).toEqual(near(small.shown));
      // Hidden, every name is cut beside the mask, whatever the figure.
      if (width === 380) expect(names(small.hidden).some((n) => n.endsWith('…'))).toBe(true);
      expect(names(large.hidden)).toEqual(names(small.hidden));
    }
    // The room kept is the widest any label writes in the currency here.
    for (const s of amountSamples('USD')) expect(s).toMatch(/^\$[\d.,]+[KMBT]?$/);
  });

  test('the forecast and the payoff plan, drawn at a phone’s width and a wide card’s, are drawn the same hidden as shown', () => {
    // Each screen with its chart's shape: its height to 340 wide.
    const charts: [string, number][] = [
      ['Budgets: the cash forecast', 150],
      ['Budgets > Goals: the payoff plan', 140],
    ];
    const boxes = (html: string) => [...html.matchAll(/<svg[^>]*\srole="img"[^>]*>/g)].map((m) => m[0].match(/\sviewBox="([^"]*)"/)?.[1]);
    for (const width of [248, 600]) {
      for (const [name, shape] of charts) {
        const screen = SCREENS[name];
        const { hidden, shown } = both(() => <DrawnWidth.Provider value={width}>{screen()}</DrawnWidth.Provider>);
        // Drawn at that width, in its shape, either way.
        expect([name, width, boxes(hidden)]).toEqual([name, width, [`0 0 ${width} ${Math.round((width * shape) / 340)}`]]);
        expect(boxes(shown)).toEqual(boxes(hidden));
        expectNoAmounts(hidden);
        expect(shapes(hidden)).toEqual(shapes(shown));
      }
    }
  });

  test('percentages stay: they say no amount', () => {
    const groceries = taxonomy.categories.find((c) => c.name === 'groceries')!.id;
    const { hidden } = both(() => (
      <HomeAttention txns={[txn({ transaction_id: 'g', amount: 285, category: 'groceries' })]} budgets={{ categories: { [groceries]: { amount: 300 } }, groups: {} }} taxonomy={taxonomy} />
    ));
    expect(exposed(hidden)).toContain('Approaching your groceries budget (95%)');
    const chart = both(SCREENS['Home: the net worth chart']).hidden;
    expect(exposed(chart)).toMatch(/[+-]\d+\.\d%/);
  });

  test('the hidden figures are said as "hidden" where they stand alone', () => {
    for (const screen of ['Activity: the month, its totals and transactions', 'Activity: Spending, the cash flow, net by month, income vs spend, top spending, places and channels']) {
      expect([screen, both(SCREENS[screen]).hidden.includes('<span class="visually-hidden">hidden</span>')]).toEqual([screen, true]);
    }
    const meters = both(SCREENS['Budgets: the meters, opened to a group']).hidden;
    expect(meters).toContain('<span class="visually-hidden">hidden of hidden</span>');
  });

  test('the IOU sheet’s one figure is its amount, in a field the CSS hook covers', () => {
    const { hidden, shown } = both(() => <IouSheet id="i-groceries" open currency="USD" taxonomy={null} shared={sharedState(sharedCard())} onClose={() => {}} />);
    for (const html of [hidden, shown]) expect(AMOUNT.test(exposed(html))).toBe(false);
    const amount = [...hidden.matchAll(/<input[^>]*>/g)].map((m) => m[0]).filter((f) => /inputmode="decimal"/i.test(f));
    expect(amount).toHaveLength(1);
  });

  test('a field holding an amount is one the CSS hook covers, a percentage’s is marked to stay, and the hook is there', () => {
    const { hidden } = both(SCREENS['Budgets > Goals: the payoff plan']);
    const fields = [...hidden.matchAll(/<input[^>]*>/g)].map((m) => m[0]).filter((f) => /value="[^"]*\d/.test(f));
    const value = (f: string) => f.match(/value="([^"]*)"/)![1];
    // The card's APR, a percentage, stays; its minimum payment, an amount, is covered.
    expect(fields.filter((f) => /data-percent/.test(f)).map(value)).toEqual(['21.24']);
    const amounts = fields.filter((f) => !/data-percent/.test(f));
    expect(amounts.map(value)).toEqual(['120.00']);
    // React writes inputMode as it is spelled; the browser reads attribute
    // names in any case, as the CSS hook does.
    for (const f of amounts) expect(/inputmode="decimal"|class="[^"]*budget-input/i.test(f)).toBe(true);
    const css = readFileSync(join(ROOT, 'app', 'globals.css'), 'utf8').replace(/\r/g, '');
    const hook = ':root[data-amounts="hidden"] :is(input[inputmode="decimal"], input.budget-input):not([data-percent]):not(:focus):not(:placeholder-shown) {';
    expect(css).toContain(hook);
    // The field's own text isn't drawn at all, and one mask is, the same
    // whatever the amount: never a dot per figure, which says its size.
    const rule = css.slice(css.indexOf(hook), css.indexOf('}', css.indexOf(hook)));
    expect(rule).toContain('color: transparent;');
    expect(rule).toContain('-webkit-text-fill-color: transparent;');
    // Three dots, drawn in the text's color so they read in either theme.
    expect(rule.match(/radial-gradient\(circle, var\(--text-1\) /g)).toHaveLength(3);
    expect(css).not.toContain('-webkit-text-security');
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
    const callers = all.filter((f) => /\bsetAmountsHidden\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f).replaceAll('\\', '/'));
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

  test('where there is no browser nothing can turn it on, whatever calls it: there the flag would be the whole server’s', () => {
    expect(typeof window).toBe('undefined');
    setAmountsHidden(true);
    expect(amountsHidden()).toBe(false);
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50');
    // Even the page's switch, set as if a device said hide: nothing hides.
    loadHideAmountsForTests(memory({ [HIDE_AMOUNTS_KEY]: '1' }));
    expect(amountsHidden()).toBe(false);
    expect(renderToStaticMarkup(<ReportView report={report()} />)).toContain('$4,000.00');
    loadHideAmountsForTests(null);
  });

  test('the report, shown again for printing, has its figures', () => {
    inBrowser(() => loadHideAmountsForTests(memory({ [HIDE_AMOUNTS_KEY]: '1' })));
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

// ---- Nothing writes an amount past the switch ----

describe('every module a page can load writes its amounts through the switch (a scan of the source)', () => {
  // The scans that read the whole model of the source (modelOf) take about
  // two seconds for the first of them on an idle four-core machine, which
  // builds it, and several times that on a loaded one; which goes first
  // changes with --randomize. So each has its own time, past bun's 5 s.
  const SCAN_MS = 30_000;
  const modules = clientModules(ROOT);
  // Past the formatters by design, each named with why: lib/format.ts is
  // them; lib/shared-expenses/links.ts writes the amounts a payment app's
  // link and the message to copy carry to the other person, whatever this
  // screen hides (the sheet draws the message through hideAmountsIn).
  const PAST_THE_SWITCH = new Set(['lib/format.ts', 'lib/shared-expenses/links.ts']);
  const sources = modules.filter((m) => !PAST_THE_SWITCH.has(m)).map((m) => ({ path: m, text: readFileSync(join(ROOT, m), 'utf8') }));

  test('it reaches every component and what they import', () => {
    expect(modules).toContain('components/Dashboard.tsx');
    expect(modules).toContain('components/plan-text.ts');
    // Library code a component imports, at any depth.
    expect(modules).toContain('lib/budget-suggestions.ts');
    expect(modules).toContain('lib/format.ts');
    // A route is the server's, never a page's.
    expect(modules.some((m) => m.startsWith('app/api/'))).toBe(false);
  });

  test('no amount is formatted past lib/format.ts: Intl, toLocaleString with a currency or fraction digits, or a "$" by hand, unless the function checks the switch', () => {
    // Each that does is said, with where: write it with formatMoney,
    // signedMoney or compactMoney, or check amountsHidden() first.
    expect(bypasses(sources)).toEqual([]);
  });

  test('no memo keeps an amount the switch can’t change', () => {
    // A useMemo whose callback writes an amount lists the switch
    // (useAmountsHidden()) among its dependencies; a component in memo()
    // that writes one reads it; no useState starts from one.
    expect(staleMemos(ROOT, modules)).toEqual([]);
  }, SCAN_MS);

  test('a label a screen reader reads alone is said through spoken(), and an amount drawn as text through <Masked>', () => {
    expect(unspokenLabels(ROOT, modules)).toEqual([]);
    expect(unmaskedChildren(ROOT, modules)).toEqual([]);
  }, SCAN_MS);

  test('the scan finds what it is for: a formatter of its own, a memo, a label and a figure past the switch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nya-amounts-'));
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    try {
      mkdirSync(join(dir, 'app'));
      write('lib/format.ts', 'export function formatMoney(n: number, c: string | null): string { return String(n) + (c ?? ""); }\n');
      // An imported helper that writes an amount, as a chart's module might.
      write('lib/flow.ts', "import { formatMoney } from './format';\nexport function flowLabel(n: number): string {\n  return `Flow ${formatMoney(n, null)}`;\n}\n");
      write(
        'components/Flow.tsx',
        [
          "'use client';",
          "import { useMemo } from 'react';",
          "import { formatMoney } from '@/lib/format';",
          "import { flowLabel } from '@/lib/flow';",
          "import { Masked } from './HideAmounts';",
          "import { useAmountsHidden } from './hide-amounts';",
          "const local = (n: number) => formatMoney(n, 'USD');",
          'export function Flow({ n }: { n: number }) {',
          '  const hidden = useAmountsHidden();',
          '  const title = useMemo(() => flowLabel(n), [n]);',
          '  const kept = useMemo(() => local(n), [n, hidden]);',
          "  const own = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);",
          '  const dollars = `$${n.toFixed(2)}`;',
          '  return (',
          '    <div aria-label={flowLabel(n)}>',
          "      <span>{formatMoney(n, 'USD')}</span>",
          '      <Masked>{local(n)}</Masked>',
          '      <svg role="img"><text>{local(n)}</text></svg>',
          '      {title}{kept}{own}{dollars}',
          '    </div>',
          '  );',
          '}',
          '',
        ].join('\n')
      );
      write('components/HideAmounts.tsx', 'export function Masked({ children }: { children: string }) { return children; }\n');
      write('components/hide-amounts.ts', 'export function useAmountsHidden(): boolean { return false; }\n');
      const mods = clientModules(dir);
      expect(mods).toEqual(['components/Flow.tsx', 'components/HideAmounts.tsx', 'components/hide-amounts.ts', 'lib/flow.ts', 'lib/format.ts']);
      const own = mods.filter((m) => m !== 'lib/format.ts').map((m) => ({ path: m, text: readFileSync(join(dir, m), 'utf8') }));
      expect(bypasses(own).map((b) => [b.file, b.line])).toEqual([
        ['components/Flow.tsx', 12],
        ['components/Flow.tsx', 13],
      ]);
      // The memo of the imported helper's label, not the one that lists the switch.
      expect(staleMemos(dir, mods).map((s) => [s.file, s.line])).toEqual([['components/Flow.tsx', 10]]);
      expect(unspokenLabels(dir, mods).map((s) => [s.file, s.line])).toEqual([['components/Flow.tsx', 15]]);
      // The figure drawn bare, and each variable holding one drawn bare, not
      // the one in <Masked> nor the chart's own text. Every other shape is
      // test/amount-sources.test.ts's.
      expect(unmaskedChildren(dir, mods).map((s) => [s.file, s.line])).toEqual([16, 19, 19, 19, 19].map((line) => ['components/Flow.tsx', line]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** View suites the backstop leaves out: this one (it would run itself), and
 *  the developers page's, whose API samples are figures by design. */
const NOT_VIEWS = new Set(['hide-amounts.test.tsx', 'developers.test.tsx']);

/** What a view draws that only looks like an amount: a file's example
 *  figures (EXAMPLES), a sync service's own price (SimpleFIN's, Lunch
 *  Flow's), an exchange rate (RATE), a count written with thousands,
 *  followed by what it counts or after its name, and a number beside three
 *  capitals that are no currency's code (NOT_CODES); but never a number with a
 *  currency's symbol or code beside it, which is an amount whatever follows. */
const PRICES = ['($15 a year', '(about $35 a year for two bank connections'];
/** An exchange rate as lib/format.ts formatRate writes one, "1 USD = 0.86573
 *  EUR": public data and never the person's money, so it shows while amounts
 *  are hidden. Only one whole, and never one with a currency's symbol or
 *  code, or a figure, right before or after it, so an amount beside it is
 *  still read as one. */
const RATE = new RegExp(
  String.raw`(?<!(?:\p{Sc}|\b[A-Z]{3}|[\d.,])[\s\u00a0]?[-+]?)\b1[\s\u00a0][A-Z]{3}[\s\u00a0]=[\s\u00a0]\d[\d,]*(?:\.\d+)?[\s\u00a0][A-Z]{3}\b(?![\s\u00a0]?[-+]?[\d\p{Sc}])`,
  'gu'
);
const COUNT = new RegExp(
  String.raw`(?<!(?:\p{Sc}|\b${CODES})[\s\u00a0]?[-+]?)\b\d{1,3}(?:,\d{3})+(?![\s\u00a0]?(?:\p{Sc}|${CODES}\b))(?=(?:\s+[A-Z][\w-]*)*\s+[a-z])|(?<=^Transactions: )[\d,]+$`,
  'gu'
);
/** Three capitals beside a number that are no currency's code, in the two
 *  shapes the views draw: a time's zone ("around 16:00 CET"), and a word of
 *  a bank's description written in capitals ("SHELL OIL 5544", "LANDLORD
 *  REF 99812", a store's or a payment's number), told by the capitals word
 *  before it, and never a real currency's code (ISO 4217, as Intl knows
 *  them): "CARD PAYMENT SEK 950" is an amount, as is a whole figure en-US
 *  writes after ISK or that the Plan writes in any currency. Only a whole
 *  number, so a figure with cents or thousands there is still an amount. */
const ISO_CODES = Intl.supportedValuesOf('currency').join('|');
const NOT_CODES = new RegExp(
  [String.raw`\b\d{1,2}:\d{2}(?=[\s\u00a0][A-Z]{3}\b)`, String.raw`(?<=\b[A-Z]{2,}[\s\u00a0](?!(?:${ISO_CODES})\b)[A-Z]{3}[\s\u00a0])\d+(?![\d.,])`].join('|'),
  'gu'
);
function withoutLookalikes(line: string): string {
  return [...EXAMPLES, ...PRICES]
    .reduce((t, e) => t.split(e).join(''), line)
    .replace(RATE, '#')
    .replace(COUNT, '#')
    .replace(NOT_CODES, '#');
}

describe('a backstop over every view the suites draw, amounts hidden', () => {
  test('lets a count, a file’s example, a service’s price and an exchange rate through, never an amount beside its currency', () => {
    const lookalikes = [
      'of 1,470 historical starts (Jan 1871 to Jun 1993) lasted 30 years',
      'Monte Carlo: 5,000 runs, each built from 5-year blocks',
      'Transactions: 1,234',
      'a point (1,234.56)',
      'You pay SimpleFIN for it ($15 a year), not Nya',
      'your own Lunch Flow account (about $35 a year for two bank connections, paid to Lunch Flow)',
      'USD $••• is €••• (1 USD = 0.86573 EUR)',
      'USD hidden is hidden (1 USD = 0.86573 EUR)',
      '1 BTC = 61,000 USD, every day, past ones included',
      'The ECB’s of Sep 14, 2026: 1 USD = 0.86573 EUR',
      '1 ARS = 0.00071 USD, from Sep 1, 2026',
      'published for information each working day around 16:00 CET; a weekend',
      'Aug 6, 2026 · SHELL OIL 5544',
      'ONLINE TRANSFER TO LANDLORD REF 99812',
    ];
    for (const line of lookalikes) expect([line, AMOUNT.test(withoutLookalikes(line))]).toEqual([line, false]);
    const amounts = [
      'Retire in 2040 with $45,000 a year after tax',
      '$1,234 more than last month',
      'Groceries $2,500 left',
      '€12,000 a year',
      '-$1,234 in fees',
      '1,234 USD in fees',
      'USD 1,234 in fees',
      '12,000 € a year',
      '$1,234.56 spent',
      '$450 a month',
      // A currency with no symbol of its own is written with its code, any
      // three capitals, before the figures or after them.
      'SEK 12,000 a year',
      'PLN 45,000 a year after tax',
      'ZAR 1,234 more than last month',
      '12,000 NOK a year',
      'SEK 950',
      '950 SEK',
      'KRW 1,234,567 in all',
      'Groceries SEK 950 this month',
      'CARD PAYMENT SEK 1,250',
      'CARD PAYMENT SEK 950.00',
      // A whole figure after a real code, behind a word in capitals: still one.
      'CARD PAYMENT SEK 950',
      'Roth IRA CHF 950',
      'ATM ISK 12500',
      'HSA NOK 400 this month',
      'opens at 16:00 CET with SEK 950',
      // Beside a rate, an amount is still one, before it or after it, and a
      // rate's shape around one never makes it pass.
      'USD $1,234 is €1,068.30 (1 USD = 0.86573 EUR)',
      'USD 1,234 is 1,068.30 EUR (1 USD = 0.86573 EUR)',
      '1 USD = 0.86573 EUR, €1,068.30 in all',
      '1 USD = 0.86573 EUR 12',
      '1 USD = 0.86573 EUR €12',
      'CHF 1 USD = 0.86573 EUR',
      '$1 USD = 0.92 EUR',
      '2 USD = 1.73 EUR',
      '1,000 USD = 865.73 EUR',
      '1 USD is',
    ];
    for (const line of amounts) expect([line, AMOUNT.test(withoutLookalikes(line))]).toEqual([line, true]);
  });

  test('each render the view suites make, made again with amounts hidden, shows no figure: in its text, a label read alone or an option', () => {
    // test/hidden-renders.ts makes each render twice in a run of the view
    // suites, and writes down what the hidden one shows: a figure the scan of
    // the source can't tell from text (a number drawn as it is) shows there.
    const dir = mkdtempSync(join(tmpdir(), 'nya-hidden-renders-'));
    try {
      const out = join(dir, 'shown.txt');
      const suites = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.tsx') && !NOT_VIEWS.has(f));
      // A fresh environment: the suites read what they set themselves, or
      // what the .env files say, never what an earlier file of this run set.
      // The run reads bunfig.toml as any does: test/preload.ts loads first.
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(?:PATH|HOME|TMPDIR|TZ|LANG|LC_\w+|BUN_\w+|CI|SYSTEMROOT|TEMP|TMP|USERPROFILE)$/i.test(k)));
      const run = Bun.spawnSync([process.execPath, 'test', '--preload', './test/hidden-renders.ts', ...suites.map((f) => `./test/${f}`)], {
        cwd: ROOT,
        env: { ...env, NYA_HIDDEN_RENDERS: out },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const said = `${run.stdout.toString()}${run.stderr.toString()}`;
      expect(said).toContain(`across ${suites.length} files`);
      // The one test the second render fails counts the renders it is drawn in.
      expect([...new Set([...said.matchAll(/^\(fail\) (.+?) \[[\d.]+m?s\]$/gm)].map((m) => m[1]))]).toEqual(['NetWorthChart time ranges > the baseline is computed from the range shown']);
      const shown = readFileSync(out, 'utf8').split('\n').filter(Boolean);
      expect(shown.length).toBeGreaterThan(1000);
      expect(shown.filter((l) => AMOUNT.test(withoutLookalikes(l.slice(l.indexOf('\t') + 1))))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
