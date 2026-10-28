import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installDom, click, type, FakeElement, FakeEvent } from './mini-dom';
import { categoriesFor } from './category-fixture';

// Activity's pinned bar and segments (rollout phase 5a,
// docs/design/information-architecture.md#activity), used as a person would
// (react-dom/client over test/mini-dom.ts): the tab opens on Transactions
// with the month's In / Out / Net over the list; Spending holds the analysis
// and Reports; Shared the Shared expenses card. The month steps with the
// bar's arrows, the ⋯ adds or imports, and a pick on the cash flow lists its
// transactions on Transactions.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: MonthBreakdown } = await import('@/components/MonthBreakdown');
const { segmentKey } = await import('@/components/ActivityBar');
const { localMonth } = await import('@/lib/local-date');
const { addMonths } = await import('@/lib/rollover');
type Txn = import('@/components/MonthBreakdown').Txn;
type Segment = import('@/components/ActivityBar').ActivitySegment;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The pick's effect scrolls the list into view; the fake DOM has no layout.
const scrolled: FakeElement[] = [];
(FakeElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: FakeElement) {
  scrolled.push(this);
};

const month = localMonth();
const lastMonth = addMonths(month, -1);
const { taxonomy } = categoriesFor({ groceries: 700 }, { words: ['groceries', 'income'], groups: { groceries: 'Food' } });

let n = 0;
const row = (date: string, name: string, amount: number, category: string | null): Txn =>
  ({
    transaction_id: `a${++n}`,
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
  }) as Txn;

const ROWS: Txn[] = [
  row(`${month}-01`, 'ACME CORP', -3100, 'income'),
  row(`${month}-02`, 'Whole Foods', 412.3, 'groceries'),
  row(`${lastMonth}-10`, 'Trader Joes', 188, 'groceries'),
];

const longName = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

type Props = Partial<React.ComponentProps<typeof MonthBreakdown>>;
function mount(props: Props = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = (p: Props) =>
    act(() =>
      root.render(
        <MonthBreakdown
          txns={ROWS}
          notes={[]}
          loading={false}
          taxonomy={taxonomy}
          onRecategorize={() => {}}
          onRename={() => {}}
          sharedSegment={<p className="shared-here">Shared expenses</p>}
          {...p}
        />
      )
    );
  render(props);
  const all = (test: (e: FakeElement) => boolean) => host.findAll(test);
  const tab = (label: string) => all((e) => e.getAttribute('role') === 'tab' && e.textContent === label)[0];
  const button = (label: string) => all((e) => e.getAttribute('aria-label') === label)[0];
  return {
    host,
    render,
    all,
    tab,
    button,
    text: () => host.textContent,
    selected: () => all((e) => e.getAttribute('role') === 'tab' && e.getAttribute('aria-selected') === 'true').map((e) => e.textContent),
    month: () => all((e) => e.getAttribute('class') === 'month-stepper-title')[0]?.textContent ?? null,
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

describe('Activity: the bar and its segments', () => {
  test('opens on Transactions: the month, its In / Out / Net and the list, and no analysis', () => {
    const v = mount();
    expect(v.selected()).toEqual(['Transactions']);
    expect(v.month()).toBe(longName(month));
    expect(v.text()).toContain('In');
    expect(v.text()).toContain('Whole Foods');
    expect(v.text()).not.toContain('Cash flow');
    expect(v.text()).not.toContain('Net by month');
    expect(v.text()).not.toContain('Open reports');
    // The panel is labelled by the tab shown.
    const [panel] = v.all((e) => e.getAttribute('role') === 'tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(v.tab('Transactions').getAttribute('id'));
    v.unmount();
  });

  test('Spending holds the analysis and Reports; Shared the card, with no month', () => {
    const v = mount();
    act(() => click(v.tab('Spending')));
    expect(v.selected()).toEqual(['Spending']);
    expect(v.text()).toContain('Cash flow');
    expect(v.text()).toContain('Net by month');
    expect(v.text()).toContain('Open reports');
    expect(v.all((e) => e.getAttribute('class') === 'list-rows txn-list')).toHaveLength(0);
    act(() => click(v.tab('Shared')));
    expect(v.text()).toContain('Shared expenses');
    expect(v.all((e) => e.getAttribute('class') === 'shared-here')).toHaveLength(1);
    expect(v.month()).toBeNull();
    // Back on Transactions, the list is where it was.
    act(() => click(v.tab('Transactions')));
    expect(v.all((e) => e.getAttribute('class') === 'list-rows txn-list')).toHaveLength(1);
    v.unmount();
  });

  test('the month’s In / Out / Net, with what it leaves out, is on Transactions and on Spending, and not on Shared', () => {
    const v = mount();
    const strip = () => v.all((e) => e.getAttribute('class') === 'summary-row').length;
    const leftOut = () => v.text().includes('Transfers and loan payments excluded');
    expect([strip(), leftOut()]).toEqual([1, true]);
    act(() => click(v.tab('Spending')));
    expect([strip(), leftOut()]).toEqual([1, true]);
    act(() => click(v.tab('Shared')));
    expect([strip(), leftOut()]).toEqual([0, false]);
    v.unmount();
  });

  test('the strip is said once, first in the panel (after Spending’s period), on the page, signed', () => {
    const v = mount();
    const [panel] = v.all((e) => e.getAttribute('id') === 'activity-panel');
    const strip = () => v.all((e) => e.getAttribute('class') === 'month-figures');
    const kids = () => panel.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
    const figures = () => strip()[0].findAll((e) => (e.getAttribute('class') ?? '').startsWith('summary-value')).map((e) => e.textContent);
    // Transactions: the first thing under the bar, never in a card.
    expect(strip()).toHaveLength(1);
    expect(kids()[0]).toBe(strip()[0]);
    expect(figures()).toEqual(['+$3,100.00', '-$412.30', '+$2,687.70']);
    for (let p = strip()[0].parentNode as FakeElement | null; p; p = p.parentNode as FakeElement | null) expect((p.getAttribute?.('class') ?? '').split(' ')).not.toContain('card');
    // Its heading, for a screen reader alone: the bar names the month.
    expect(strip()[0].findAll((e) => e.tagName === 'H2')[0].textContent).toBe(`In and out, ${longName(month)}`);
    // Spending: after the period's switch, before the cash flow, which has none of its own.
    act(() => click(v.tab('Spending')));
    expect(strip()).toHaveLength(1);
    expect(kids()[0].getAttribute('class')).toBe('segmented spending-period');
    expect(kids()[1]).toBe(strip()[0]);
    expect(v.all((e) => (e.getAttribute('class') ?? '').split(' ').includes('summary-row'))).toHaveLength(1);
    expect(v.all((e) => e.getAttribute('class') === 'inst-name' && e.textContent === 'In and out')).toHaveLength(0);
    // At 1M the period is the bar's month: no caption shown, only the heading.
    expect(v.all((e) => e.getAttribute('class') === 'month-figures-caption')).toHaveLength(0);
    v.unmount();
  });

  test('with no transactions, the month’s row is still there, empty, so the segments sit where they will', () => {
    const v = mount({ txns: [] });
    expect(v.text()).toContain('No transactions in the last 12 months.');
    const rows = v.all((e) => e.getAttribute('class') === 'activity-month');
    expect(rows).toHaveLength(1);
    expect(rows[0].childNodes).toHaveLength(0);
    v.unmount();
  });

  test('the arrow keys, Home and End move between the segments and choose as they go', () => {
    expect([segmentKey('ArrowRight', 2, 3), segmentKey('ArrowLeft', 0, 3), segmentKey('Home', 2, 3), segmentKey('End', 0, 3), segmentKey('a', 0, 3)]).toEqual([0, 2, 0, 2, null]);
    const v = mount();
    const [list] = v.all((e) => e.getAttribute('role') === 'tablist');
    key(list, 'ArrowRight');
    expect(v.selected()).toEqual(['Spending']);
    expect(dom.document.activeElement).toBe(v.tab('Spending'));
    key(list, 'End');
    expect(v.selected()).toEqual(['Shared']);
    key(list, 'Home');
    expect(v.selected()).toEqual(['Transactions']);
    // One tab stop: the chosen one.
    expect(v.all((e) => e.getAttribute('role') === 'tab').map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    v.unmount();
  });

  // One month control (look and feel, step 2b1): the list of the months with
  // transactions over the name, and the way back to the month the tab opens on.
  test('the list picks any month with transactions, and This month returns', () => {
    const v = mount();
    const list = () => v.all((e) => e.tagName === 'SELECT')[0];
    expect(list().getAttribute('aria-label')).toBe(`Month to show: ${longName(month)}`);
    expect(list().findAll((e) => e.tagName === 'OPTION').map((o) => o.textContent)).toEqual([`${longName(month)} (this month)`, longName(lastMonth)]);
    expect(v.all((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'This month')).toHaveLength(0);
    act(() => type(list(), lastMonth));
    expect(v.month()).toBe(longName(lastMonth));
    expect(v.text()).toContain('Trader Joes');
    const back = v.all((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'This month')[0];
    act(() => click(back));
    expect(v.month()).toBe(longName(month));
    expect(v.all((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'This month')).toHaveLength(0);
    expect(dom.document.activeElement).toBe(list());
    v.unmount();
  });

  test('while this month has no transactions, the tab opens on the latest, and the way back says Latest month', () => {
    const older = addMonths(month, -2);
    const v = mount({ txns: [row(`${lastMonth}-10`, 'Trader Joes', 188, 'groceries'), row(`${older}-10`, 'Safeway', 50, 'groceries')] });
    expect(v.month()).toBe(longName(lastMonth));
    act(() => click(v.button('Earlier month')));
    expect(v.month()).toBe(longName(older));
    const back = v.all((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Latest month')[0];
    expect(back).toBeDefined();
    expect(v.all((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'This month')).toHaveLength(0);
    act(() => click(back));
    expect(v.month()).toBe(longName(lastMonth));
    v.unmount();
  });

  test('the arrows step through the months listed, and stop at either end', () => {
    const v = mount();
    // At either end the arrow says so but stays focusable, so a press that
    // reaches the end keeps focus where it was.
    expect(v.button('Later month').getAttribute('aria-disabled')).toBe('true');
    expect(v.button('Earlier month').getAttribute('aria-disabled')).toBe('false');
    act(() => click(v.button('Earlier month')));
    expect(v.month()).toBe(longName(lastMonth));
    expect(v.text()).toContain('Trader Joes');
    expect(v.text()).not.toContain('Whole Foods');
    expect(v.button('Earlier month').getAttribute('aria-disabled')).toBe('true');
    expect(v.button('Earlier month').hasAttribute('disabled')).toBe(false);
    // Pressed at the end, nothing moves.
    act(() => click(v.button('Earlier month')));
    expect(v.month()).toBe(longName(lastMonth));
    act(() => click(v.button('Later month')));
    expect(v.month()).toBe(longName(month));
    // Said as it changes.
    expect(v.all((e) => e.getAttribute('class') === 'month-stepper-title')[0].getAttribute('aria-live')).toBe('polite');
    v.unmount();
  });

  test('a pick on the cash flow lists its transactions on Transactions, and focus goes to the line saying so', () => {
    scrolled.length = 0;
    const v = mount();
    act(() => click(v.tab('Spending')));
    const [groceries] = v.all((e) => e.getAttribute('class') === 'cash-flow-show' && e.textContent.startsWith('Groceries'));
    act(() => click(groceries));
    expect(v.selected()).toEqual(['Transactions']);
    const [shown] = v.all((e) => e.getAttribute('class') === 'flow-shown');
    expect(shown.textContent).toContain('Groceries');
    expect(dom.document.activeElement).toBe(shown);
    expect(scrolled).toHaveLength(1);
    // A month chosen ends the pick, as tapping a month on Net by month does.
    act(() => click(v.button('Earlier month')));
    expect(v.all((e) => e.getAttribute('class') === 'flow-shown')).toHaveLength(0);
    v.unmount();
  });

  test('the ⋯ adds or imports where a manual account takes them, and is left out where none does', () => {
    const calls: string[] = [];
    const v = mount({ onAddTransaction: () => calls.push('add'), onImport: () => calls.push('import') });
    const trigger = v.button('Activity options');
    act(() => click(trigger));
    const items = v.all((e) => e.getAttribute('role') === 'menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Add a transaction', 'Import a file']);
    act(() => click(items[1]));
    act(() => click(trigger));
    act(() => click(v.all((e) => e.getAttribute('role') === 'menuitem')[0]));
    expect(calls).toEqual(['import', 'add']);
    v.unmount();
    const none = mount();
    expect(none.button('Activity options')).toBeUndefined();
    // On Shared, which isn't by month, the month's row stays, as tall,
    // so the segments don't move: with nothing in it here.
    act(() => click(none.tab('Shared')));
    const rows = none.all((e) => e.getAttribute('class') === 'activity-month');
    expect(rows).toHaveLength(1);
    expect(rows[0].childNodes).toHaveLength(0);
    none.unmount();
    // With a ⋯, the row holds it.
    const some = mount({ onAddTransaction: () => {} });
    act(() => click(some.tab('Shared')));
    const [row] = some.all((e) => e.getAttribute('class') === 'activity-month');
    expect(row.findAll((e) => e.getAttribute('aria-label') === 'Activity options')).toHaveLength(1);
    some.unmount();
  });

  test('the bar shows while the transactions load, and Shared doesn’t wait for them', () => {
    const v = mount({ txns: null, loading: true });
    expect(v.all((e) => e.getAttribute('role') === 'tablist')).toHaveLength(1);
    // The list as it will be, said once (components/LoadingSkeletons.tsx), not a spinner.
    expect(v.all((e) => e.getAttribute('role') === 'status' && e.textContent === 'Loading transactions')).toHaveLength(1);
    expect(v.all((e) => (e.getAttribute('class') ?? '').split(' ').includes('spinner'))).toHaveLength(0);
    expect(v.all((e) => e.getAttribute('aria-busy') === 'true')).toHaveLength(1);
    // No month yet to show: its row is held with a placeholder for its name,
    // its arrows unavailable, so the list doesn't move down when it comes.
    expect(v.month()).toBe('');
    expect(v.all((e) => e.getAttribute('class') === 'month-stepper')).toHaveLength(1);
    expect(v.button('Earlier month').getAttribute('aria-disabled')).toBe('true');
    expect(v.button('Later month').getAttribute('aria-disabled')).toBe('true');
    // Reports doesn't wait for the list either.
    act(() => click(v.tab('Spending')));
    expect(v.text()).toContain('Open reports');
    act(() => click(v.tab('Shared')));
    expect(v.all((e) => e.getAttribute('class') === 'shared-here')).toHaveLength(1);
    expect(v.all((e) => e.getAttribute('role') === 'status' && e.textContent === 'Loading transactions')).toHaveLength(0);
    // Shared isn't by month: no row for one.
    expect(v.all((e) => e.getAttribute('class') === 'month-stepper')).toHaveLength(0);
    v.unmount();
  });

  test('the month arriving fills its held row: the same arrows and heading, now working', () => {
    const v = mount({ txns: null, loading: true });
    const [earlier, heading, later] = [v.button('Earlier month'), v.all((e) => e.getAttribute('class') === 'month-stepper-title')[0], v.button('Later month')];
    v.render({ txns: ROWS, loading: false });
    // The same elements, so focus on an arrow survives the month arriving.
    expect(v.button('Earlier month')).toBe(earlier);
    expect(v.button('Later month')).toBe(later);
    expect(v.all((e) => e.getAttribute('class') === 'month-stepper-title')[0]).toBe(heading);
    expect(v.month()).toBe(longName(month));
    expect(earlier.getAttribute('aria-disabled')).toBe('false');
    v.unmount();
  });

  test('a segment chosen while the bar is pinned opens at its top; one chosen above, where it is', () => {
    scrolled.length = 0;
    const v = mount();
    const [bar] = v.all((e) => e.getAttribute('class') === 'activity-bar');
    const [panel] = v.all((e) => e.getAttribute('role') === 'tabpanel');
    const place = (el: FakeElement, top: number, bottom: number) => {
      (el as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ x: 0, y: top, top, bottom, left: 0, right: 0, width: 0, height: bottom - top });
    };
    // Above the fold: the panel starts under the bar.
    place(bar, 40, 160);
    place(panel, 160, 2000);
    act(() => click(v.tab('Spending')));
    expect(scrolled).toHaveLength(0);
    // Scrolled down: the bar is pinned over the panel.
    place(bar, 0, 120);
    place(panel, -900, 1000);
    act(() => click(v.tab('Transactions')));
    // By identity: a fake element's diff never finishes printing.
    expect([scrolled.length, scrolled[0] === panel]).toEqual([1, true]);
    // The segment already shown: nothing.
    act(() => click(v.tab('Transactions')));
    expect(scrolled).toHaveLength(1);
    v.unmount();
  });

  test('with nothing to list, the bar is there and adding stays in view as buttons', () => {
    const v = mount({ txns: [], onAddTransaction: () => {} });
    expect(v.all((e) => e.getAttribute('role') === 'tablist')).toHaveLength(1);
    expect(v.button('Activity options')).toBeUndefined();
    expect(v.all((e) => e.localName === 'button' && e.textContent === 'Add a transaction')).toHaveLength(1);
    // And Reports at Spending's foot, which needs no transactions.
    act(() => click(v.tab('Spending')));
    expect(v.text()).toContain('Open reports');
    v.unmount();
  });

  test('kept by the caller: a choice goes to it, and the segment it gives is shown', () => {
    const chosen: Segment[] = [];
    const v = mount({ segment: 'spending', onSegment: (s) => chosen.push(s) });
    expect(v.selected()).toEqual(['Spending']);
    act(() => click(v.tab('Shared')));
    expect(chosen).toEqual(['shared']);
    // Not until the caller says so.
    expect(v.selected()).toEqual(['Spending']);
    v.render({ segment: 'shared', onSegment: (s) => chosen.push(s) });
    expect(v.selected()).toEqual(['Shared']);
    v.unmount();
  });
});

describe('Activity in the dashboard', () => {
  const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8').replace(/\r/g, '');

  test('the segment is the dashboard’s, so the tab comes back on the last one chosen', () => {
    expect(dashboard).toContain("const [activitySegment, setActivitySegment] = useState<ActivitySegment>('transactions');");
    expect(dashboard).toContain('segment={activitySegment}');
    expect(dashboard).toContain('onSegment={setActivitySegment}');
  });

  test('the review jump from Home lands on Transactions, where the review count is', () => {
    const jump = dashboard.slice(dashboard.indexOf("case 'review':"), dashboard.indexOf('return;', dashboard.indexOf("case 'review':")));
    expect(jump).toContain("setActivitySegment('transactions');");
    expect(jump).toContain("focus('review-count', 'activity', null);");
  });

  test('the Shared sheets stay mounted on every segment, since a row on Transactions opens them', () => {
    const sheets = dashboard.indexOf('<SharedSheets');
    expect(sheets).toBeGreaterThan(-1);
    // Outside MonthBreakdown (and so outside its Shared segment), on the tab.
    expect(dashboard.slice(dashboard.lastIndexOf('{tab ===', sheets), sheets)).toMatch(/^\{tab === 'activity' && \(\s*$/);
    const card = readFileSync(join(import.meta.dir, '..', 'components', 'SharedExpensesCard.tsx'), 'utf8');
    const body = card.slice(card.indexOf('export default function SharedExpensesCard'), card.indexOf('export function SharedSheets'));
    for (const sheet of ['<ShareCostSheet', '<ConfirmPaymentSheet', '<IouSheet', '<PersonSheet', '<SettleSheet', '<HandoffSheet']) expect(body).not.toContain(sheet);
  });
});
