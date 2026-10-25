import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, FakeElement, FakeEvent } from './mini-dom';
import { categoriesFor } from './category-fixture';

// Spending's one period (rollout phase 5c,
// docs/design/information-architecture.md#activity), used as a person would
// (react-dom/client over test/mini-dom.ts): chips set its length, the bar's
// month (or a column of Net by month) its end, and every card sums it. A pick
// from the cash flow lists the period's rows on Transactions, which stays on
// the bar's month.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: MonthBreakdown } = await import('@/components/MonthBreakdown');
const { localDate, localMonth } = await import('@/lib/local-date');
const { addMonths } = await import('@/lib/rollover');
const { periodCaption, periodEnding } = await import('@/lib/cash-flow');
const { amountSamples, formatMoney } = await import('@/lib/format');
const { textWidth } = await import('@/lib/sankey');
type Txn = import('@/components/MonthBreakdown').Txn;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The pick's effect scrolls the list into view; the fake DOM has no layout.
(FakeElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const today = localDate();
const month = localMonth();
const back = (n: number) => addMonths(month, -n);
const { taxonomy } = categoriesFor({ groceries: 700 }, { words: ['groceries', 'income'], groups: { groceries: 'Food' } });

let n = 0;
const row = (date: string, name: string, amount: number, category: string | null): Txn =>
  ({
    transaction_id: `p${++n}`,
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
    payment_channel: 'in store',
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: 'Austin',
    region: 'TX',
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
  }) as Txn;

// Groceries in each of four months, so each length sums a different total.
const ROWS: Txn[] = [
  row(`${month}-01`, 'ACME CORP', -3100, 'income'),
  row(`${month}-01`, 'Whole Foods', 400, 'groceries'),
  row(`${back(1)}-10`, 'Trader Joes', 200, 'groceries'),
  { ...row(`${back(2)}-10`, 'Farmers market', 20, 'groceries'), tags: ['food'] },
  row(`${back(3)}-10`, 'Corner shop', 7, 'groceries'),
];

type Props = Partial<React.ComponentProps<typeof MonthBreakdown>>;
function mount(props: Props = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = (p: Props) =>
    act(() =>
      root.render(<MonthBreakdown txns={ROWS} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} segment="spending" {...p} />)
    );
  let shown: Props = props;
  render(shown);
  const all = (test: (e: FakeElement) => boolean) => host.findAll(test);
  const radios = () => all((e) => e.getAttribute('role') === 'radio');
  const chip = (label: string) => radios().find((e) => e.textContent === label)!;
  return {
    host,
    all,
    rerender: (p: Props) => render((shown = { ...shown, ...p })),
    group: () => all((e) => e.getAttribute('role') === 'radiogroup')[0] ?? null,
    radios,
    chip,
    checked: () => radios().filter((e) => e.getAttribute('aria-checked') === 'true').map((e) => e.textContent),
    // The In / Out / Net card's Out, as the totals sum it.
    out: () => all((e) => e.getAttribute('class') === 'summary-row')[0]?.findAll((e) => (e.getAttribute('class') ?? '').startsWith('summary-value'))[1]?.textContent ?? null,
    text: () => host.textContent,
    button: (label: string) => all((e) => e.getAttribute('aria-label') === label)[0],
    unmount: () => act(() => root.unmount()),
  };
}

const key = (el: FakeElement, k: string) => {
  const e = new FakeEvent('keydown');
  e.key = k;
  act(() => {
    el.dispatchEvent(e);
  });
};

const caption = (key: Parameters<typeof periodEnding>[0], end = month) => periodCaption(periodEnding(key, end), today);
const money = (v: number) => formatMoney(v, 'USD');

describe('Spending’s period', () => {
  test('four lengths as a labelled radio group, Month first; the cash flow has no control of its own', () => {
    const v = mount();
    expect(v.radios().map((e) => e.textContent)).toEqual(['Month', '3 months', '12 months', 'Year to date']);
    expect(v.checked()).toEqual(['Month']);
    const longName = new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    expect(v.group()!.getAttribute('aria-label')).toBe(`Period ending ${longName}`);
    expect(v.radios().map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    expect(v.all((e) => e.tagName === 'SELECT')).toHaveLength(0);
    v.unmount();
  });

  test('every card sums the period: a longer one counts the months before', () => {
    const v = mount({ tags: [{ id: 'food', name: 'Food run', color: 'blue', created_at: '2026-01-01T00:00:00.000Z' }] });
    expect(v.out()).toBe(money(400));
    act(() => click(v.chip('3 months')));
    expect(v.checked()).toEqual(['3 months']);
    expect(v.out()).toBe(money(620));
    // Each card says the period it sums.
    const three = caption('last-3-months');
    for (const card of ['In and out', 'Income vs spend', 'Top spending', 'Online vs in-store', 'Where you spent', 'Spending by tag']) {
      const [header] = v.all((e) => e.getAttribute('class') === 'inst-header' && e.textContent.startsWith(card));
      expect([card, header?.textContent.includes(three)]).toEqual([card, true]);
    }
    expect(v.text()).toContain(`Austin, TX${money(620)}`);
    expect(v.text()).toContain(`In store${money(620)}`);
    // Income vs spend runs from the period's first day.
    const [chart] = v.all((e) => (e.getAttribute('class') ?? '').split(' ').includes('chart-svg'));
    const first = new Date(`${back(2)}-01T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC', ...(back(2).slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' as const } : {}) });
    expect(chart.getAttribute('aria-label')).toContain(`for ${first} to`);
    act(() => click(v.chip('12 months')));
    expect(v.out()).toBe(money(627));
    v.unmount();
  });

  test('the arrow keys move between the lengths and choose as they go', () => {
    const v = mount();
    key(v.chip('Month'), 'ArrowRight');
    expect(v.checked()).toEqual(['3 months']);
    expect(dom.document.activeElement).toBe(v.chip('3 months'));
    key(v.chip('3 months'), 'ArrowDown');
    expect(v.checked()).toEqual(['12 months']);
    key(v.chip('12 months'), 'End');
    expect(v.checked()).toEqual(['Year to date']);
    key(v.chip('Year to date'), 'ArrowUp');
    expect(v.checked()).toEqual(['12 months']);
    key(v.chip('12 months'), 'Home');
    expect(v.checked()).toEqual(['Month']);
    v.unmount();
  });

  test('the bar’s month ends the period and keeps its length; so does a column of Net by month', () => {
    const v = mount();
    act(() => click(v.chip('3 months')));
    act(() => click(v.button('Earlier month')));
    expect(v.checked()).toEqual(['3 months']);
    // Last month and the two before it: no Whole Foods.
    expect(v.out()).toBe(money(227));
    expect(v.text()).toContain(caption('last-3-months', back(1)));
    // Net by month: the end month pressed, the others in the period marked.
    const cols = () => v.all((e) => (e.getAttribute('class') ?? '').startsWith('trend-col'));
    const pressed = () => cols().filter((e) => e.getAttribute('aria-pressed') === 'true').length;
    expect(pressed()).toBe(1);
    expect(cols().filter((e) => e.getAttribute('class') === 'trend-col in-period')).toHaveLength(2);
    // A column moves the end, as the arrows do.
    act(() => click(cols()[cols().length - 1]));
    expect(v.checked()).toEqual(['3 months']);
    expect(v.out()).toBe(money(620));
    expect(pressed()).toBe(1);
    v.unmount();
  });

  test('Net by month’s columns are as wide as the widest month’s figure the currency writes at 12px, whatever the figures are', () => {
    const column = (rows: Txn[]) => {
      const v = mount({ txns: rows });
      const [trend] = v.all((e) => e.getAttribute('class') === 'trend-row');
      const px = (trend.style as unknown as { getPropertyValue: (k: string) => string }).getPropertyValue('--trend-col');
      v.unmount();
      return px;
    };
    const usd = column(ROWS);
    expect(usd).toMatch(/^\d+px$/);
    for (const s of amountSamples('USD')) expect(parseInt(usd, 10)).toBeGreaterThanOrEqual(textWidth(`+${s}`, 12));
    // From the currency alone: a hundred times the figures, the same columns.
    expect(column(ROWS.map((t) => ({ ...t, amount: t.amount * 100 })))).toBe(usd);
  });

  test('a pick lists the period’s rows on Transactions, which stays on the month; choosing a length ends it', () => {
    let segment = 'spending' as 'spending' | 'transactions';
    const v = mount({ onSegment: (s) => v.rerender({ segment: (segment = s as typeof segment) }) });
    act(() => click(v.chip('3 months')));
    const [groceries] = v.all((e) => e.getAttribute('class') === 'cash-flow-show' && e.textContent.startsWith('Groceries'));
    act(() => click(groceries));
    expect(segment).toBe('transactions');
    const [shown] = v.all((e) => e.getAttribute('class') === 'flow-shown');
    expect(shown.textContent).toContain(caption('last-3-months'));
    expect(v.text()).toContain('Farmers market');
    expect(v.text()).not.toContain('Corner shop');
    // Transactions' own figures are still the month's.
    expect(v.out()).toBe(money(400));
    // Back on Spending, the length is kept; choosing one ends the pick.
    v.rerender({ segment: 'spending' });
    expect(v.checked()).toEqual(['3 months']);
    act(() => click(v.chip('Month')));
    v.rerender({ segment: 'transactions' });
    expect(v.all((e) => e.getAttribute('class') === 'flow-shown')).toHaveLength(0);
    v.unmount();
  });

  test('without categories, the In / Out / Net card sums the period and says what may be missing from it', () => {
    const v = mount({ taxonomy: null, notes: ['Your rules couldn’t be read'] });
    act(() => click(v.chip('3 months')));
    expect(v.out()).toBe(money(620));
    expect(v.text()).toContain('Your rules couldn’t be read.');
    // With categories, the cash flow says it, and the card doesn't again.
    v.rerender({ taxonomy });
    expect(v.text().split('Your rules couldn’t be read').length - 1).toBe(1);
    v.unmount();
  });
});
