import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installDom, click, type, FakeElement, FakeEvent } from './mini-dom';
import { categoriesFor } from './category-fixture';

// The Budgets tab's pinned bar and segments (rollout phase 6a1,
// docs/design/information-architecture.md#budgets), used as a person would
// (react-dom/client over test/mini-dom.ts): Month, Upcoming and Goals, each
// its own panel and all three mounted; the month as the bar's heading, with
// arrows and a pick of any month; the debt payoff plan on Goals; Home's budget
// alerts landing on the month's heading.

const dom = installDom();
// A past month is read from the server; here it never answers, so it shows
// as loading.
const realFetch = globalThis.fetch;
const asked: string[] = [];
globalThis.fetch = ((url: string) => {
  asked.push(String(url));
  return new Promise(() => {});
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: BudgetsTab } = await import('@/components/BudgetsTab');
const { BUDGETS_MONTH_TITLE } = await import('@/components/BudgetsBar');
const { localMonth } = await import('@/lib/local-date');
const { addMonths, monthName } = await import('@/lib/rollover');
type BudgetMonthState = import('@/components/budget-month-state').BudgetMonthState;
type BudgetMonthView = import('@/components/budget-month-state').BudgetMonthView;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scrolled: FakeElement[] = [];
(FakeElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: FakeElement) {
  scrolled.push(this);
};

const NOW = localMonth();
const { taxonomy } = categoriesFor({}, { words: ['groceries'], groups: { groceries: 'Food' } });
const GROCERIES = taxonomy.categories.find((c) => c.name === 'groceries')!.id;
const budgets = { categories: { [GROCERIES]: { amount: 300 } }, groups: {} };

// This month as the server works it out, with history back two months.
const view = (over: Partial<BudgetMonthView> = {}): BudgetMonthView => ({
  history: true,
  month: NOW,
  today: NOW,
  currency: 'USD',
  budgets,
  assumed: { categories: [], groups: [] },
  recorded_since: addMonths(NOW, -2),
  carries: { categories: {}, groups: {} },
  rollover: { categories: {}, groups: {} },
  starts: { categories: {}, groups: {} },
  ended: { categories: {}, groups: {} },
  spent: {},
  income: null,
  pool: null,
  earliest: addMonths(NOW, -2),
  gaps: [],
  left_out_text: null,
  counted_left_out_text: null,
  notes: [],
  ...over,
});
const state = (v: BudgetMonthView | null): BudgetMonthState => ({ status: 'ready', view: v, error: null, reload: () => {} });

type Props = Partial<React.ComponentProps<typeof BudgetsTab>>;
function mount(props: Props = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = (p: Props) =>
    act(() =>
      root.render(
        <BudgetsTab
          txns={[]}
          budgets={budgets}
          taxonomy={taxonomy}
          onSave={async () => true}
          goals={[]}
          onSaveGoals={async () => true}
          accounts={[]}
          loading={false}
          series={[]}
          budgetMonth={state(view())}
          {...p}
        />
      )
    );
  render(props);
  const all = (test: (e: FakeElement) => boolean) => host.findAll(test);
  // The bar's tabs and the segments' panels, not Upcoming's own List and
  // Calendar inside one.
  const bar = () => all((e) => e.getAttribute('role') === 'tablist' && e.getAttribute('aria-label') === 'Budgets')[0];
  const tabs = () => bar().findAll((e) => e.getAttribute('role') === 'tab');
  const tab = (label: string) => tabs().filter((e) => e.textContent === label)[0];
  const panels = () => all((e) => e.getAttribute('role') === 'tabpanel' && e.getAttribute('class') === 'budgets-panel');
  const panelOf = (label: string) => panels().find((p) => p.getAttribute('aria-labelledby') === tab(label).getAttribute('id'))!;
  return {
    host,
    render,
    all,
    bar,
    tabs,
    tab,
    panelOf,
    // The bar's own (the calendar, mounted in Upcoming's hidden panel, has arrows of the same names).
    button: (label: string) => all((e) => e.getAttribute('class') === 'budgets-bar')[0].findAll((e) => e.getAttribute('aria-label') === label)[0],
    // The month's pick, named by the month it lies over.
    pick: () => all((e) => e.tagName === 'SELECT' && (e.getAttribute('aria-label') ?? '').startsWith('Month to show'))[0],
    selected: () => tabs().filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.textContent),
    // The panels a person can see.
    shown: () => panels().filter((p) => !p.hasAttribute('hidden')),
    // The bar's heading: the month's name on Month (components/MonthStepper.tsx), the segment's on the others, read alone.
    heading: () => all((e) => e.getAttribute('class') === 'budgets-bar')[0].findAll((e) => e.tagName === 'H2')[0],
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

describe('Budgets: the bar and its segments', () => {
  test('opens on Month: the month as its heading, and only the month’s panel shown', () => {
    const v = mount();
    expect(v.selected()).toEqual(['Month']);
    expect(v.heading().textContent).toBe(monthName(NOW));
    expect(v.heading().getAttribute('id')).toBe(BUDGETS_MONTH_TITLE);
    expect(v.heading().getAttribute('aria-live')).toBe('polite');
    // Focusable by script, so Home's jump can land on it.
    expect(v.heading().getAttribute('tabindex')).toBe('-1');
    expect(v.shown()).toEqual([v.panelOf('Month')]);
    expect(v.panelOf('Month').textContent).toContain('Spent');
    // Each tab controls its own panel, labelled by it.
    for (const label of ['Month', 'Upcoming', 'Goals']) expect(v.tab(label).getAttribute('aria-controls')).toBe(v.panelOf(label).getAttribute('id'));
    v.unmount();
  });

  test('Upcoming holds the forecast and the lists of what is coming; Goals the goals', () => {
    const v = mount();
    act(() => click(v.tab('Upcoming')));
    expect(v.selected()).toEqual(['Upcoming']);
    expect(v.shown()).toEqual([v.panelOf('Upcoming')]);
    expect(v.panelOf('Upcoming').textContent).toContain('Cash forecast');
    expect(v.panelOf('Month').textContent).not.toContain('Cash forecast');
    // The segment's name is the heading, read alone and not announced:
    // choosing it said so, and on screen the month's row stays, empty, as
    // tall, so the segments don't move and nothing repeats the tab.
    expect(v.heading().textContent).toBe('Upcoming');
    expect(v.heading().getAttribute('class')).toBe('visually-hidden');
    expect((v.heading().parentNode as FakeElement).getAttribute('class')).toBe('budgets-heading');
    expect(v.all((e) => e.getAttribute('class') === 'budgets-heading')[0].childNodes).toHaveLength(1);
    expect(v.heading().hasAttribute('aria-live')).toBe(false);
    expect(v.heading().hasAttribute('id')).toBe(false);
    act(() => click(v.tab('Goals')));
    expect(v.shown()).toEqual([v.panelOf('Goals')]);
    expect(v.panelOf('Goals').textContent).toContain('No goals yet');
    expect(v.heading().textContent).toBe('Goals');
    expect(v.heading().getAttribute('class')).toBe('visually-hidden');
    v.unmount();
  });

  test('the arrow keys, Home and End move between the segments and choose as they go', () => {
    const v = mount();
    const list = v.bar();
    key(list, 'ArrowRight');
    expect(v.selected()).toEqual(['Upcoming']);
    expect(dom.document.activeElement).toBe(v.tab('Upcoming'));
    key(list, 'End');
    expect(v.selected()).toEqual(['Goals']);
    key(list, 'ArrowRight');
    expect(v.selected()).toEqual(['Month']);
    key(list, 'End');
    key(list, 'Home');
    expect(v.selected()).toEqual(['Month']);
    expect(v.tabs().map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    v.unmount();
  });

  test('the arrows step through the months there are, and stop at either end', () => {
    asked.length = 0;
    const v = mount();
    expect(v.button('Later month').getAttribute('aria-disabled')).toBe('true');
    expect(v.button('Earlier month').getAttribute('aria-disabled')).toBe('false');
    act(() => click(v.button('Earlier month')));
    expect(v.heading().textContent).toBe(monthName(addMonths(NOW, -1)));
    // Read from the server, and said to be loading meanwhile.
    expect(asked.some((u) => u.includes(addMonths(NOW, -1)))).toBe(true);
    expect(v.panelOf('Month').textContent).toContain(`Loading ${monthName(addMonths(NOW, -1), NOW)}`);
    act(() => click(v.button('Earlier month')));
    expect(v.heading().textContent).toBe(monthName(addMonths(NOW, -2)));
    expect(v.button('Earlier month').getAttribute('aria-disabled')).toBe('true');
    expect(v.button('Earlier month').hasAttribute('disabled')).toBe(false);
    act(() => click(v.button('Earlier month')));
    expect(v.heading().textContent).toBe(monthName(addMonths(NOW, -2)));
    act(() => click(v.button('Later month')));
    act(() => click(v.button('Later month')));
    expect(v.heading().textContent).toBe(monthName(NOW));
    v.unmount();
  });

  test('away from this month, This month returns to it, and focus stays on the month', () => {
    const v = mount();
    const back = () => v.all((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'This month')[0];
    expect(back()).toBeUndefined();
    act(() => type(v.pick(), addMonths(NOW, -1)));
    expect(v.heading().textContent).toBe(monthName(addMonths(NOW, -1)));
    act(() => click(back()));
    expect(v.heading().textContent).toBe(monthName(NOW));
    expect(back()).toBeUndefined();
    expect(dom.document.activeElement).toBe(v.pick());
    v.unmount();
  });

  test('a tap on the month’s name picks any month; with only this month there is nothing to pick', () => {
    const v = mount();
    const select = v.pick();
    // Its name holds the month shown, which is what a person sees on it.
    expect(select.getAttribute('aria-label')).toBe(`Month to show: ${monthName(NOW)}`);
    expect(select.options.map((o) => o.value)).toEqual([NOW, addMonths(NOW, -1), addMonths(NOW, -2)]);
    act(() => type(select, addMonths(NOW, -2)));
    expect(v.heading().textContent).toBe(monthName(addMonths(NOW, -2)));
    expect(v.pick().getAttribute('aria-label')).toBe(`Month to show: ${monthName(addMonths(NOW, -2))}`);
    expect(v.button('Later month').getAttribute('aria-disabled')).toBe('false');
    v.unmount();
    const only = mount({ budgetMonth: state(view({ earliest: null })) });
    expect(only.pick()).toBeUndefined();
    expect(only.button('Earlier month').getAttribute('aria-disabled')).toBe('true');
    expect(only.button('Later month').getAttribute('aria-disabled')).toBe('true');
    only.unmount();
  });

  test('another segment and back: the month picked, how far ahead, List or Calendar, and what was typed are still there', async () => {
    // What holds state outside a sheet (the warning's figure is typed in a
    // sheet since 6a3): the forecast's range, the view of what is coming,
    // and the what-if's amount, kept after its sheet closes.
    const checking = { account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 1900, currency: 'USD' };
    const v = mount({ institutions: [{ institution_name: 'Chase', item_id: 'item_1', accounts: [checking] }], onSavePlanned: async () => true });
    const settle = (ms = 5) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
    const upcoming = () => v.panelOf('Upcoming');
    const range = (label: string) => upcoming().findAll((e) => e.getAttribute('role') === 'radio' && e.textContent === label)[0];
    const view = (label: string) => upcoming().findAll((e) => e.getAttribute('role') === 'tab' && e.textContent === label)[0];
    const whatIf = () => upcoming().findAll((e) => e.tagName === 'BUTTON' && e.textContent === 'What if I buy…')[0];
    const dialog = () => upcoming().findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0];
    const amount = () => dialog().findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith('Amount'))[0].findAll((e) => e.tagName === 'INPUT')[0];
    act(() => click(v.tab('Upcoming')));
    act(() => click(range('60 days')));
    act(() => click(view('Calendar')));
    act(() => click(whatIf()));
    await settle();
    act(() => type(amount(), '250'));
    act(() => click(dialog().findAll((e) => e.tagName === 'BUTTON' && e.textContent === 'Done')[0]));
    // Slid out and gone from the page.
    await settle(400);
    expect(upcoming().findAll((e) => e.getAttribute('role') === 'dialog')).toHaveLength(0);
    act(() => click(v.tab('Goals')));
    act(() => click(v.tab('Upcoming')));
    // As they were, since the panel stayed mounted.
    expect(range('60 days').getAttribute('aria-checked')).toBe('true');
    expect(view('Calendar').getAttribute('aria-selected')).toBe('true');
    act(() => click(whatIf()));
    await settle();
    expect(amount().value).toBe('250');
    act(() => click(dialog().findAll((e) => e.tagName === 'BUTTON' && e.textContent === 'Done')[0]));
    await settle(400);
    act(() => click(v.tab('Month')));
    act(() => click(v.button('Earlier month')));
    act(() => click(v.tab('Goals')));
    act(() => click(v.tab('Month')));
    expect(v.heading().textContent).toBe(monthName(addMonths(NOW, -1)));
    v.unmount();
  });

  test('while transactions load, the bar and the month’s heading are there, and Goals doesn’t wait', () => {
    const v = mount({ loading: true });
    expect(v.heading().getAttribute('id')).toBe(BUDGETS_MONTH_TITLE);
    // Each segment as it will be, said once (components/LoadingSkeletons.tsx), not a spinner.
    expect(v.panelOf('Month').findAll((e) => e.getAttribute('role') === 'status' && e.textContent === 'Loading budgets')).toHaveLength(1);
    expect(v.panelOf('Upcoming').findAll((e) => e.getAttribute('role') === 'status' && e.textContent === 'Loading what is coming')).toHaveLength(1);
    for (const s of ['Month', 'Upcoming']) {
      expect(v.panelOf(s).findAll((e) => e.getAttribute('aria-busy') === 'true')).toHaveLength(1);
      expect(v.panelOf(s).findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes('spinner'))).toHaveLength(0);
    }
    expect(v.panelOf('Goals').findAll((e) => e.getAttribute('role') === 'status')).toHaveLength(0);
    expect(v.panelOf('Goals').textContent).toContain('No goals yet');
    // Nothing to step to or pick until the month's budgets are there.
    expect(v.pick()).toBeUndefined();
    expect(v.button('Earlier month').getAttribute('aria-disabled')).toBe('true');
    // Once loaded, Goals is the same panel, its goals the same: a goal being
    // added while the rest loaded isn't lost.
    const goals = v.panelOf('Goals');
    const add = v.all((e) => e.tagName === 'BUTTON' && e.textContent === 'Add goal')[0];
    expect(add).toBeDefined();
    v.render({ loading: false });
    expect(v.panelOf('Goals') === goals).toBe(true);
    expect(v.all((e) => e.tagName === 'BUTTON' && e.textContent === 'Add goal')[0] === add).toBe(true);
    expect(v.pick()).toBeDefined();
    v.unmount();
  });

  test('while the budgets themselves load, the month can’t be stepped or picked', () => {
    const v = mount({ budgetsStatus: 'loading' });
    expect(v.heading().textContent).toBe(monthName(NOW));
    expect(v.pick()).toBeUndefined();
    expect(v.button('Earlier month').getAttribute('aria-disabled')).toBe('true');
    expect(v.button('Later month').getAttribute('aria-disabled')).toBe('true');
    v.unmount();
  });

  test('the debt payoff plan is on Goals when it is offered, and opens', () => {
    const none = mount();
    expect(none.host.textContent).not.toContain('Payoff plan');
    none.unmount();
    let opened = 0;
    const v = mount({ onPayoff: () => opened++ });
    const [row] = v.all((e) => e.tagName === 'BUTTON' && e.textContent === 'Payoff plan');
    expect(v.panelOf('Goals').findAll((e) => e === row)).toHaveLength(1);
    expect(v.panelOf('Goals').textContent).toContain('Debt payoff');
    act(() => click(row));
    expect(opened).toBe(1);
    v.unmount();
  });

  test('a segment chosen while the bar is pinned opens at its top; one chosen above, where it is', () => {
    scrolled.length = 0;
    const v = mount();
    const [bar] = v.all((e) => e.getAttribute('class') === 'budgets-bar');
    const place = (el: FakeElement, top: number, bottom: number) => {
      (el as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ x: 0, y: top, top, bottom, left: 0, right: 0, width: 0, height: bottom - top });
    };
    place(bar, 40, 160);
    for (const label of ['Month', 'Upcoming', 'Goals']) place(v.panelOf(label), 160, 2000);
    act(() => click(v.tab('Upcoming')));
    expect(scrolled).toHaveLength(0);
    place(bar, 0, 120);
    place(v.panelOf('Goals'), -900, 1000);
    act(() => click(v.tab('Goals')));
    expect([scrolled.length, scrolled[0] === v.panelOf('Goals')]).toEqual([1, true]);
    act(() => click(v.tab('Goals')));
    expect(scrolled).toHaveLength(1);
    v.unmount();
  });
});

describe('the dashboard', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
  test('Home’s budget alerts open Month and land on its heading', () => {
    const at = src.indexOf("case 'budgets':");
    const body = src.slice(at, src.indexOf('return;', at));
    expect(body).toContain("setBudgetsSegment('month')");
    expect(body).toContain("focus(BUDGETS_MONTH_TITLE, 'budgets', null)");
  });

  test('the payoff plan moved from Accounts to Goals, offered by the accounts on screen', () => {
    expect(src).not.toContain('Payoff plan</span>');
    expect(src).toContain('onPayoff={allAccounts.some((a) => isOwedType(a.type)) ? () => setPayoffOpen(true) : undefined}');
    expect(src).toContain('<DebtPayoff open={payoffOpen}');
  });
});
