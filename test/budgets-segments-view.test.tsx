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
  const tab = (label: string) => all((e) => e.getAttribute('role') === 'tab' && e.textContent === label)[0];
  const panels = () => all((e) => e.getAttribute('role') === 'tabpanel');
  const panelOf = (label: string) => panels().find((p) => p.getAttribute('aria-labelledby') === tab(label).getAttribute('id'))!;
  return {
    host,
    render,
    all,
    tab,
    panelOf,
    button: (label: string) => all((e) => e.getAttribute('aria-label') === label)[0],
    // The month's pick, named by the month it lies over.
    pick: () => all((e) => e.tagName === 'SELECT' && (e.getAttribute('aria-label') ?? '').startsWith('Month to show'))[0],
    selected: () => all((e) => e.getAttribute('role') === 'tab' && e.getAttribute('aria-selected') === 'true').map((e) => e.textContent),
    // The panels a person can see.
    shown: () => panels().filter((p) => !p.hasAttribute('hidden')),
    heading: () => all((e) => e.tagName === 'H2' && e.getAttribute('class') === 'budgets-title')[0],
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
    // The segment's name is the heading, not announced: choosing it said so.
    expect(v.heading().textContent).toBe('Upcoming');
    expect(v.heading().hasAttribute('aria-live')).toBe(false);
    expect(v.heading().hasAttribute('id')).toBe(false);
    act(() => click(v.tab('Goals')));
    expect(v.shown()).toEqual([v.panelOf('Goals')]);
    expect(v.panelOf('Goals').textContent).toContain('No goals yet');
    expect(v.heading().textContent).toBe('Goals');
    v.unmount();
  });

  test('the arrow keys, Home and End move between the segments and choose as they go', () => {
    const v = mount();
    const [list] = v.all((e) => e.getAttribute('role') === 'tablist');
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
    expect(v.all((e) => e.getAttribute('role') === 'tab').map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
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

  test('another segment and back: the month picked and what was typed are still there', () => {
    // A draft inline in a panel (adding a budget is a sheet since 6a2): the
    // forecast's warning, being changed.
    const checking = { account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 1900, currency: 'USD' };
    const v = mount({ institutions: [{ institution_name: 'Chase', item_id: 'item_1', accounts: [checking] }], onSavePlanned: async () => true });
    act(() => click(v.tab('Upcoming')));
    act(() => click(v.panelOf('Upcoming').findAll((e) => e.tagName === 'BUTTON' && e.textContent === 'Change')[0]));
    const warn = v.button('Warn when the forecast drops below, in USD');
    act(() => type(warn, '250'));
    act(() => click(v.tab('Goals')));
    act(() => click(v.tab('Upcoming')));
    // The same field, keeping what was typed, since the panel stayed mounted.
    expect(v.button('Warn when the forecast drops below, in USD') === warn).toBe(true);
    expect(warn.value).toBe('250');
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
    expect(v.panelOf('Month').findAll((e) => e.getAttribute('aria-label') === 'Loading budgets')).toHaveLength(1);
    expect(v.panelOf('Upcoming').findAll((e) => e.getAttribute('aria-label') === 'Loading what is coming')).toHaveLength(1);
    expect(v.panelOf('Goals').findAll((e) => e.getAttribute('role') === 'status')).toHaveLength(0);
    expect(v.panelOf('Goals').textContent).toContain('No goals yet');
    // Nothing to step to or pick until the month's budgets are there.
    expect(v.pick()).toBeUndefined();
    expect(v.button('Earlier month').getAttribute('aria-disabled')).toBe('true');
    // Once loaded, Goals is the same panel, its goals the same: a goal being
    // added while the rest loaded isn't lost.
    const goals = v.panelOf('Goals');
    const add = v.all((e) => e.tagName === 'BUTTON' && e.textContent === 'Add Goal')[0];
    v.render({ loading: false });
    expect(v.panelOf('Goals') === goals).toBe(true);
    expect(v.all((e) => e.tagName === 'BUTTON' && e.textContent === 'Add Goal')[0] === add).toBe(true);
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
