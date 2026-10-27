import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, FakeElement } from './mini-dom';
import { categoriesFor } from './category-fixture';

// Activity and Budgets share the month (look and feel step 2b2,
// components/view-month-state.ts), used as a person would (react-dom/client
// over test/mini-dom.ts): a harness holds the month as the dashboard does and
// shows one tab at a time, unmounting the other, as the dashboard does.

const dom = installDom();
// A past month on Budgets is read from the server; here it never answers, so
// it shows as loading.
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string) => new Promise(() => void url)) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: MonthBreakdown } = await import('@/components/MonthBreakdown');
const { default: BudgetsTab } = await import('@/components/BudgetsTab');
const { useViewMonth } = await import('@/components/view-month-state');
const { localMonth } = await import('@/lib/local-date');
const { addMonths, monthName } = await import('@/lib/rollover');
type Txn = import('@/components/MonthBreakdown').Txn;
type BudgetMonthState = import('@/components/budget-month-state').BudgetMonthState;
type BudgetMonthView = import('@/components/budget-month-state').BudgetMonthView;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(FakeElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const NOW = localMonth();
const back = (n: number) => addMonths(NOW, -n);
const { taxonomy } = categoriesFor({ groceries: 700 }, { words: ['groceries', 'income'], groups: { groceries: 'Food' } });
const GROCERIES = taxonomy.categories.find((c) => c.name === 'groceries')!.id;
const budgets = { categories: { [GROCERIES]: { amount: 300 } }, groups: {} };

let n = 0;
const row = (month: string, name: string, amount: number): Txn =>
  ({
    transaction_id: `s${++n}`,
    date: `${month}-10`,
    name,
    amount,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Chase',
    category: 'groceries',
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
  }) as Txn;

// Transactions this month, last month and three months back: none two back.
const ROWS = [row(NOW, 'Whole Foods', 40), row(back(1), 'Trader Joes', 30), row(back(3), 'Safeway', 20)];

// This month as the server works it out, with history back four months.
const view = (over: Partial<BudgetMonthView> = {}): BudgetMonthView => ({
  history: true,
  month: NOW,
  today: NOW,
  currency: 'USD',
  budgets,
  assumed: { categories: [], groups: [] },
  recorded_since: back(4),
  carries: { categories: {}, groups: {} },
  rollover: { categories: {}, groups: {} },
  starts: { categories: {}, groups: {} },
  ended: { categories: {}, groups: {} },
  spent: {},
  income: null,
  pool: null,
  earliest: back(4),
  gaps: [],
  left_out_text: null,
  counted_left_out_text: null,
  notes: [],
  ...over,
});
const ready = (v: BudgetMonthView | null): BudgetMonthState => ({ status: 'ready', view: v, error: null, reload: () => {} });

const longName = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

type Opts = { txns?: Txn[]; budgetMonth?: BudgetMonthState; budgetsStatus?: 'loading' | 'ready' | 'error' };
let reset: () => void = () => {};
function Harness({ tab, txns = ROWS, budgetMonth = ready(view()), budgetsStatus = 'ready' }: Opts & { tab: 'activity' | 'budgets' }) {
  const month = useViewMonth();
  reset = month.reset;
  return tab === 'activity' ? (
    <MonthBreakdown txns={txns} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} viewMonth={month.month} onViewMonth={month.set} />
  ) : (
    <BudgetsTab
      txns={txns}
      budgets={budgets}
      taxonomy={taxonomy}
      onSave={async () => true}
      goals={[]}
      onSaveGoals={async () => true}
      accounts={[]}
      loading={false}
      series={[]}
      budgetMonth={budgetMonth}
      budgetsStatus={budgetsStatus}
      viewMonth={month.month}
      onViewMonth={month.set}
    />
  );
}

function mount(opts: Opts = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  // The tab shown, and anything that changes on the page meanwhile (a reload's rows).
  const show = (tab: 'activity' | 'budgets', more: Opts = {}) => act(() => root.render(<Harness tab={tab} {...opts} {...more} />));
  show('activity');
  const all = (t: (e: FakeElement) => boolean) => host.findAll(t);
  // The stepper's own (Budgets' calendar, in its hidden Upcoming panel, has arrows of the same names).
  const stepper = () => all((e) => e.getAttribute('class') === 'month-stepper')[0];
  return {
    show,
    all,
    month: () => all((e) => (e.getAttribute('class') ?? '').startsWith('month-stepper-title'))[0].textContent,
    arrow: (label: string) => stepper().findAll((e) => e.getAttribute('aria-label') === label)[0],
    list: () => stepper().findAll((e) => e.tagName === 'SELECT')[0],
    back: () => stepper().findAll((e) => e.tagName === 'BUTTON' && ['This month', 'Latest month'].includes(e.textContent.trim()))[0],
    pastLine: () => all((e) => e.getAttribute('class') === 'helper' && e.textContent.includes('is shown as it was'))[0],
    unmount: () => act(() => root.unmount()),
  };
}

describe('Activity and Budgets share the month', () => {
  test('a month stepped to on Activity is the month Budgets opens on, read only and saying so', () => {
    const v = mount();
    act(() => click(v.arrow('Earlier month')));
    expect(v.month()).toBe(longName(back(1)));
    v.show('budgets');
    expect(v.month()).toBe(monthName(back(1)));
    expect(v.pastLine().textContent).toBe(`${monthName(back(1), NOW)} is shown as it was. To change a budget, go to this month.`);
    expect(v.back().textContent.trim()).toBe('This month');
    v.unmount();
  });

  test('a month picked on Budgets is the month Activity opens on, or the latest with transactions before it', () => {
    const v = mount();
    v.show('budgets');
    expect(v.pastLine()).toBeUndefined();
    act(() => type(v.list(), back(2)));
    v.show('activity');
    // None two months back: the month before it, never the later one.
    expect(v.month()).toBe(longName(back(3)));
    expect(v.back().textContent.trim()).toBe('This month');
    v.show('budgets');
    // Budgets kept the month asked for.
    expect(v.month()).toBe(monthName(back(2)));
    act(() => type(v.list(), back(1)));
    v.show('activity');
    expect(v.month()).toBe(longName(back(1)));
    v.unmount();
  });

  test('This month on either tab sends the other back to its own month', () => {
    const v = mount();
    v.show('budgets');
    act(() => type(v.list(), back(1)));
    act(() => click(v.back()));
    expect(v.month()).toBe(monthName(NOW));
    v.show('activity');
    expect(v.month()).toBe(longName(NOW));
    expect(v.back()).toBeUndefined();
    act(() => click(v.arrow('Earlier month')));
    act(() => click(v.back()));
    v.show('budgets');
    expect(v.month()).toBe(monthName(NOW));
    v.unmount();
  });

  test('landing on Activity’s own month by the arrows is its default too, while this month has no transactions', () => {
    const v = mount({ txns: [row(back(1), 'Trader Joes', 30), row(back(2), 'Safeway', 20)] });
    expect(v.month()).toBe(longName(back(1)));
    act(() => click(v.arrow('Earlier month')));
    act(() => click(v.arrow('Later month')));
    expect(v.month()).toBe(longName(back(1)));
    expect(v.back()).toBeUndefined();
    // Not a past month chosen: Budgets opens on this month.
    v.show('budgets');
    expect(v.month()).toBe(monthName(NOW));
    v.unmount();
  });

  const pick = (v: ReturnType<typeof mount>) => {
    act(() => click(v.all((e) => e.getAttribute('role') === 'tab' && e.textContent === 'Spending')[0]));
    const [groceries] = v.all((e) => e.getAttribute('class') === 'cash-flow-show' && e.textContent.startsWith('Groceries'));
    act(() => click(groceries));
    expect(v.all((e) => e.getAttribute('class') === 'flow-shown')).toHaveLength(1);
  };

  test('a pick on the cash flow holds Activity’s month alone: Budgets doesn’t follow it', () => {
    const v = mount();
    v.show('budgets');
    act(() => type(v.list(), back(2)));
    v.show('activity');
    // None two months back: Activity shows three back, and a pick holds it.
    expect(v.month()).toBe(longName(back(3)));
    pick(v);
    expect(v.month()).toBe(longName(back(3)));
    v.show('budgets');
    expect(v.month()).toBe(monthName(back(2)));
    v.unmount();
  });

  test('the month a pick holds stays when a reload brings a newer month', () => {
    // This month has no transactions yet: the tab opens on last month.
    const v = mount({ txns: [row(back(1), 'Trader Joes', 30)] });
    pick(v);
    expect(v.month()).toBe(longName(back(1)));
    // This month's first transaction arrives: the pick's month holds.
    v.show('activity', { txns: [row(NOW, 'Whole Foods', 40), row(back(1), 'Trader Joes', 30)] });
    expect(v.month()).toBe(longName(back(1)));
    v.unmount();
  });

  test('a past month says it is shown as it was only once its budgets are there', () => {
    const v = mount();
    act(() => click(v.arrow('Earlier month')));
    v.show('budgets', { budgetsStatus: 'loading' });
    expect(v.month()).toBe(monthName(back(1)));
    expect(v.pastLine()).toBeUndefined();
    v.show('budgets', { budgetsStatus: 'error' });
    expect(v.pastLine()).toBeUndefined();
    v.show('budgets');
    expect(v.pastLine()).toBeDefined();
    v.unmount();
  });

  test('Budgets keeps a past month while the first month with transactions isn’t known, can’t be read, or is later', () => {
    const states: [string, BudgetMonthState][] = [
      ['without history', ready(view({ history: false, earliest: null }))],
      ['failed', { status: 'error', view: null, error: 'Couldn’t load the month.', reload: () => {} }],
      ['later', ready(view({ earliest: NOW }))],
    ];
    for (const [why, budgetMonth] of states) {
      const v = mount({ budgetMonth });
      act(() => click(v.arrow('Earlier month')));
      v.show('budgets');
      expect([why, v.month()]).toEqual([why, monthName(back(1))]);
      expect([why, v.list().options.map((o) => o.value)]).toEqual([why, [NOW, back(1)]]);
      v.unmount();
    }
  });

  test('a reset, as Home’s links make, sends both back to their own month', () => {
    const v = mount();
    act(() => click(v.arrow('Earlier month')));
    act(() => reset());
    expect(v.month()).toBe(longName(NOW));
    v.show('budgets');
    expect(v.month()).toBe(monthName(NOW));
    v.unmount();
  });
});
