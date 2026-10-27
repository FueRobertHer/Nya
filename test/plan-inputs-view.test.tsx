import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { installDom, click, type, FakeElement, FakeNode } from './mini-dom';

// The figures the Plan rests on (rollout phase 6c, docs/design/rollout.md),
// used as a person would (react-dom/client over test/mini-dom.ts): Your
// figures under the FI card on Your path, five rows that each open their
// sheet, saying where the figure comes from and the figure, measured
// savings' rate as its second line; focus back on the row when the sheet
// closes, also after a press that didn't focus it (Safari's), and never on a
// figure's row after another sheet; the rows opening whatever the state,
// their sheet's Save off and saying why while saving is paused, and the rows
// held while the saved plan is read again; each row's notes under it,
// outside its button, one in full and two or more gathered into a line that
// opens to every note; Why? in a figure's sheet; and the Stress test's
// notice when an input the simulation uses may be low. What each figure
// says, in every state, is test/plan-figure-notes.test.ts's. Every request
// is answered here, by path; nothing reaches a network.
//
// A rendered element never goes into toEqual or another matcher that diffs
// (test/plan-tab-scenarios.test.tsx says why): elements are compared with
// toBe, or their words and attributes are.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;

// A scheduler a test can step (the currency recording itself, below), as in
// test/plan-bar-view.test.tsx: while `manual`, the work React schedules waits
// in `queue`, to run a task at a time. Put in before React's client loads.
type Task = (didTimeout: boolean) => Task | null | undefined | void;
const Scheduler = require('scheduler') as {
  unstable_scheduleCallback: (level: number, cb: Task, opts?: unknown) => unknown;
  unstable_cancelCallback: (t: unknown) => void;
};
const realSchedule = Scheduler.unstable_scheduleCallback;
const realCancel = Scheduler.unstable_cancelCallback;
let manual = false;
const queue: { cb: Task; cancelled: boolean }[] = [];
Scheduler.unstable_scheduleCallback = (level, cb, opts) => {
  if (!manual) return realSchedule(level, cb, opts);
  const t = { cb, cancelled: false };
  queue.push(t);
  return t;
};
Scheduler.unstable_cancelCallback = (t) => {
  const waiting = queue.find((q) => q === t);
  if (waiting) waiting.cancelled = true;
  else realCancel(t);
};
/** Runs the next task waiting (one not done comes back first); false when none is. */
function runOne(): boolean {
  while (queue.length) {
    const t = queue.shift()!;
    if (t.cancelled) continue;
    const next = t.cb(false);
    if (typeof next === 'function') queue.unshift({ cb: next, cancelled: false });
    return true;
  }
  return false;
}
afterAll(() => {
  Scheduler.unstable_scheduleCallback = realSchedule;
  Scheduler.unstable_cancelCallback = realCancel;
});

// React's client reads what the document supports once, when it loads: it is
// loaded afresh, after this file put a document there.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: PlanTab } = await import('@/components/PlanTab');
const { FigureForm } = await import('@/components/PlanForms');
const { planPanelId } = await import('@/components/PlanBar');
const { RIGHT } = await import('@/components/ActivityBar');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { typedAmounts } = await import('@/lib/fire/plan-currency');
const { PAYROLL_NOTE, dayName } = await import('@/components/plan-text');
const { localDate } = await import('@/lib/local-date');
const { NO_CHANGES } = await import('@/lib/fire/scenarios');
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type PlanSegment = import('@/components/PlanBar').PlanSegment;
type Txn = import('@/components/MonthBreakdown').Txn;
type AssetInstitution = import('@/lib/fire/inputs').AssetInstitution;
type AssetAccount = import('@/lib/fire/inputs').AssetAccount;
type NoTransactionsView = import('@/lib/no-transactions').NoTransactionsView;
type Entry = import('@/components/plan-scenarios').ScenarioEntry;

// mini-dom's window has no scrollBy, and no layout: a switch scrolls nowhere.
(globalThis as unknown as { window: { scrollBy: () => void } }).window.scrollBy = () => {};
afterEach(() => {
  dom.document.activeElement = dom.document.body;
});

/** The local day `n` days before today, as the tab measures from. */
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
};
let made = 0;
const txn = (over: Partial<Txn>): Txn =>
  ({ transaction_id: `t${++made}`, date: daysAgo(10), name: 'Shop', amount: 100, pending: false, account_name: 'Checking', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'USD', ...over }) as Txn;

// A whole year of transactions, its first 364 days ago, so nothing is scaled
// up: $2,950 spent and $5,000 earned each month, and $600 taken out in cash.
// $36,000 spent and $24,000 saved, a 40% savings rate.
const YEAR: Txn[] = [
  ...Array.from({ length: 12 }, (_, m) => [txn({ date: daysAgo(34 + m * 30), amount: 2_950 }), txn({ date: daysAgo(34 + m * 30), amount: -5_000, name: 'Payroll', category: 'income' })]).flat(),
  txn({ date: daysAgo(20), amount: 600, name: 'ATM', category: 'transfer out', transaction_code: 'atm' } as Partial<Txn>),
];
const FIRST = daysAgo(364);
const brokerage = (over: Partial<AssetAccount> = {}): AssetAccount => ({ account_id: 'brk', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balance: 300_000, currency: 'USD', ...over });
const broker = (accounts: AssetAccount[] = [brokerage()], over: Partial<AssetInstitution> = {}): AssetInstitution[] => [
  { name: 'Broker', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts, ...over },
];
// 3:12 PM on Oct 6 where the test runs.
const AS_OF = new Date(2026, 9, 6, 15, 12).toISOString();

// Nothing typed: every figure measured, and its currency the accounts'.
const PLAN = { ...DEFAULT_PLAN, age: 40, targetAge: 55 };
const TYPED = { ...PLAN, spending: 40_000 };

// Connections that bring in no transactions (lib/no-transactions.ts).
const INVESTMENTS_ONLY: NoTransactionsView = {
  without: [
    { institution_name: 'Empower', reason: 'investment_accounts' },
    { institution_name: 'Vanguard', reason: 'investment_accounts' },
  ],
  connections: 2,
};
const REFUSED: NoTransactionsView = { without: [{ institution_name: 'Acme CU', reason: 'refused' }], connections: 2 };

/** Each row's title, and the title of the sheet it opens. */
const ROWS: [string, string][] = [
  ['Annual spending', 'Annual spending'],
  ['Invested assets', 'Invested assets'],
  ['Annual savings', 'Annual savings'],
  ['Ages', 'Your ages'],
  ['Assumptions', 'Assumptions'],
];

type Call = { method: string; url: string; body: any };
type Answer = (call: Call) => [number, unknown] | undefined | Promise<[number, unknown] | undefined>;

/** The routes the tab calls: the plan (`plan`, the GET's answer), no
 *  scenarios, no allocation settings; `answers`, by "METHOD /path", go first
 *  where they give one. Every call is recorded. */
function serve({ plan = { plan: PLAN, currency: null } as unknown, answers = {} as Record<string, Answer> } = {}) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const answer = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const given = await answers[`${method} ${url}`]?.(call);
    if (given) return answer(given[1], given[0]);
    if (url === '/api/fire-plan' && method === 'GET') return answer(plan);
    if (url === '/api/plan-scenarios') return answer({ scenarios: [], unreadable_ids: [], unrecognised_ids: [] });
    if (url === '/api/allocation-settings') return answer({ settings: null });
    return answer({ error: 'not here' }, 404);
  };
  return calls;
}

/** A sheet slides in a frame after it mounts, and a request is answered. */
const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

/** A click, after the focus a browser gives the button pressed. */
const press = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => {
    el.focus();
    click(el);
  });
  await settle();
};

/** A click on a button that doesn't focus it (Safari's, and mini-dom's),
 *  with focus on the page itself beforehand. */
const tap = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to tap');
  dom.document.activeElement = dom.document.body;
  await act(async () => click(el));
  await settle();
};

const has = (e: FakeNode | null, cls: string) => e instanceof FakeElement && (e.getAttribute('class') ?? '').split(' ').includes(cls);
/** The first element under `el` with this class. */
const part = (el: FakeElement, cls: string) => el.findAll((e) => has(e, cls))[0] ?? null;
const button = (within: FakeElement, words: string) => within.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
/** A sheet's close button, its cross. */
const closeOf = (sheet: FakeElement) => sheet.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Close')[0] ?? null;
/** What a sheet says above its buttons while saving is paused (PlanForms.tsx
 *  Buttons, its own .plan-paused line), or null. */
const pausedLine = (sheet: FakeElement): string | null => part(sheet, 'plan-paused')?.textContent ?? null;
/** Whether an element is inside a <details>, a line that may be closed. */
const folded = (el: FakeElement) => {
  for (let n = el.parentNode; n; n = n.parentNode) if (n instanceof FakeElement && n.tagName === 'DETAILS') return true;
  return false;
};
/** An element's own child elements. */
const kids = (el: FakeNode) => el.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);

async function mount(props: Partial<PlanTabProps> = {}) {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const all: PlanTabProps = { txns: YEAR, txnsLoading: false, txnNotes: [], institutions: broker(), balancesAsOf: AS_OF, currency: 'USD', holdings: [], ...props };
  await act(async () => root.render(<PlanTab {...all} />));
  await settle();
  const find = (t: (e: FakeElement) => boolean) => container.findAll(t);
  const card = () => find((e) => e.tagName === 'SECTION' && has(e, 'plan-inputs'))[0] ?? null;
  const rows = () => card()?.findAll((e) => e.tagName === 'BUTTON' && has(e, 'list-row')) ?? [];
  const panel = (s: PlanSegment) => find((e) => e.getAttribute('id') === planPanelId(s))[0];
  return {
    container,
    /** The tab drawn again in the background with `more` (a default-priority
     *  render), then `then` run once that has committed and before its
     *  effects have (test/plan-bar-view.test.tsx). */
    inTheGap: async (more: Partial<PlanTabProps>, then: () => void) => {
      const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
      g.IS_REACT_ACT_ENVIRONMENT = false;
      manual = true;
      try {
        root.render(<PlanTab {...all} {...more} />);
        for (let i = 0; i < 5; i++) await Promise.resolve();
        // The render and its commit; its effects wait, a task of their own.
        runOne();
        expect(queue.some((t) => !t.cancelled)).toBe(true);
        then();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      } finally {
        manual = false;
        while (runOne());
        g.IS_REACT_ACT_ENVIRONMENT = true;
      }
      await settle(100);
    },
    unmount: () => act(async () => root.unmount()),
    card,
    rows,
    /** A row by its title. */
    row: (title: string) => rows().find((r) => part(r, 'list-row-title')?.textContent === title) ?? null,
    /** The sheet open now, not one sliding out. */
    dialog: () => find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null,
    panel,
    tab: (label: string) => find((e) => e.getAttribute('role') === 'tab' && e.textContent === label)[0],
    /** The currency card at the top, when one is drawn. */
    region: () => find((e) => e.getAttribute('aria-label') === 'Your plan’s currency')[0] ?? null,
    /** The card titles in a panel, top to bottom: a card's name, its total's
     *  label, or the heading in its header. */
    titles: (p: FakeElement) => p.findAll((e) => has(e, 'inst-name') || has(e, 'total-label') || (/^H\d$/.test(e.tagName) && has(e.parentNode, 'card-header'))).map((e) => e.textContent),
    /** The notes under a row, in its item: what TotalCaveats drew. */
    notesOf: (title: string) => {
      const item = rows().find((r) => part(r, 'list-row-title')?.textContent === title)!.parentNode as FakeElement;
      return kids(item).filter((e) => has(e, 'row-notes'))[0] ?? null;
    },
  };
}
type Tab = Awaited<ReturnType<typeof mount>>;

/** Opens a row's sheet, reads it, and closes it again: its title, whether
 *  its Save is on, and what it says is paused. The next one may open while
 *  this one still slides out, as a quick hand's would. */
async function sheetOf(tab: Tab, title: string) {
  await press(tab.row(title));
  const d = tab.dialog();
  if (!d) return null;
  const said = { title: d.getAttribute('aria-label'), save: button(d, 'Save')?.disabled === false, paused: pausedLine(d) };
  await press(button(d, 'Cancel'));
  expect(tab.dialog()).toBeNull();
  return said;
}

/** Every row's sheet, each as sheetOf reads it. */
async function everySheet(tab: Tab) {
  const out = [];
  for (const [title] of ROWS) out.push(await sheetOf(tab, title));
  return out;
}

/** Each row's sheet with its Save on or off, saying `paused`. */
const sheets = (save: boolean, paused: string | null) => ROWS.map(([, title]) => ({ title, save, paused }));

/** What a sheet says above its buttons while saving is paused, for each reason
 *  (PlanTab.tsx `paused`). */
const DEFAULTS = "Your saved plan couldn't be read, so this shows the defaults and can't be saved yet: try again at the top of the Plan tab.";
const LOAD_KEPT = "Your saved plan couldn't be read, so this can't be saved yet: try again at the top of the Plan tab.";
const NOT_KNOWN = "Which currency your plan's figures are in isn't known yet (at the top of the Plan tab), so this can't be saved yet.";

/** A row's figure, the first line of its value. */
const valueOf = (row: FakeElement) => {
  const value = part(row, 'list-row-value');
  return value ? kids(value)[0].textContent : null;
};

/** A saved scenario, as the scenarios route lists it. */
const scenario = (over: Partial<Entry>): Entry => ({
  id: 's1',
  version: 1,
  name: 'A scenario',
  currency: 'USD',
  createdAt: '2026-10-01T00:00:00.000Z',
  savedAt: '2026-10-01T00:00:00.000Z',
  rev: 'r1',
  ...NO_CHANGES,
  ...over,
});

/** Opens a scenario as a person does: the Scenarios sheet (the bar's
 *  button, or the open scenario's card's), then its row's Open. */
async function openScenario(tab: Tab, name: string) {
  await press(tab.container.findAll((e) => e.tagName === 'BUTTON' && /^Scenarios(?: \(\d+\))?$/.test(e.textContent.trim()))[0]);
  await press(tab.dialog()?.findAll((e) => e.getAttribute('aria-label') === `Open ${name}`)[0]);
  await settle(400);
}

describe('Your figures, under the FI card', () => {
  test('five rows in today’s order, each a button that opens its sheet: its title, where the figure comes from, the figure (savings with its rate under it) and a chevron', async () => {
    serve();
    const tab = await mount();
    const card = tab.card()!;
    // A card of its own on Your path, between the FI card and the What if… card (8c).
    expect(tab.panel('path').contains(card)).toBe(true);
    expect(tab.titles(tab.panel('path'))).toEqual(['Financial independence', 'Your figures', 'What if…', 'Income and one-off expenses', 'Progress']);
    const heading = card.findAll((e) => e.tagName === 'H3')[0];
    expect([heading.textContent, heading.getAttribute('id'), card.getAttribute('aria-labelledby')]).toEqual(['Your figures', 'plan-inputs-title', 'plan-inputs-title']);
    expect(has(heading.parentNode, 'card-header')).toBe(true);
    // One list, an item a row.
    const list = kids(card).filter((e) => e.tagName === 'UL');
    expect(list.map((e) => e.getAttribute('class'))).toEqual(['list-rows']);
    expect(kids(list[0]).map((li) => [li.tagName, kids(li)[0].tagName])).toEqual(ROWS.map(() => ['LI', 'BUTTON']));
    const said = tab.rows().map((r) => {
      const value = part(r, 'list-row-value');
      return [
        part(r, 'list-row-title')?.textContent,
        part(r, 'list-row-sub')?.textContent.replace(/\s/g, ' '),
        value ? kids(value)[0].textContent : null,
        part(r, 'plan-input-line')?.textContent ?? null,
      ];
    });
    expect(said).toEqual([
      ['Annual spending', 'A year, from transactions', '$36,000', null],
      ['Invested assets', '1 account, as of Oct 6, 3:12 PM', '$300,000', null],
      ['Annual savings', 'Estimated from a year', '$24,000', '40% savings rate'],
      // Their figures are their subs, with no value beside them.
      ['Ages', '40 now, stop at 55', null, null],
      ['Assumptions', '4% withdrawal · 5% growth after inflation until FI · 0% tax', null, null],
    ]);
    for (const r of tab.rows()) {
      // Named by its own words, a button that opens a sheet, ending in a chevron.
      expect([r.getAttribute('type'), r.getAttribute('aria-haspopup'), r.getAttribute('aria-label'), r.getAttribute('aria-disabled'), r.disabled]).toEqual(['button', 'dialog', null, null, false]);
      const chevron = kids(r).at(-1)!;
      expect([chevron.tagName, chevron.getAttribute('aria-hidden'), kids(chevron)[0].getAttribute('d')]).toEqual(['svg', 'true', RIGHT]);
    }
    // Each opens its own sheet, which can be saved: nothing is paused.
    expect(await everySheet(tab)).toEqual(sheets(true, null));
    await tab.unmount();
  }, 20_000);

  test('ages not set, or one of them; part-time income among the assumptions', async () => {
    serve({ plan: { plan: { ...PLAN, age: null, targetAge: null, partTimeIncome: 28_000 }, currency: 'USD' } });
    const none = await mount();
    expect(part(none.row('Ages')!, 'list-row-sub')?.textContent).toBe('Add them for Coast FI and to place income by age');
    expect(part(none.row('Assumptions')!, 'list-row-sub')?.textContent).toBe('4% withdrawal · 5% growth after inflation until FI · 0% tax · $28,000 part-time');
    await none.unmount();
    serve({ plan: { plan: { ...PLAN, age: null }, currency: null } });
    const one = await mount();
    expect(part(one.row('Ages')!, 'list-row-sub')?.textContent).toBe('? now, stop at 55');
    await one.unmount();
  });
});

describe('focus back on the row', () => {
  test('a sheet closed gives focus back to the row that opened it, pressed with focus or without (as Safari does)', async () => {
    serve();
    const tab = await mount();
    for (const [title, sheet] of ROWS) {
      // Focused as it was pressed: the sheet gives it back by itself.
      await press(tab.row(title));
      expect(tab.dialog()?.getAttribute('aria-label')).toBe(sheet);
      await press(button(tab.dialog()!, 'Cancel'));
      await settle(400);
      expect(dom.document.activeElement).toBe(tab.row(title)!);
      // Pressed without taking focus: the sheet has the page to give back,
      // and the row takes it instead.
      await tap(tab.row(title));
      expect(tab.dialog()?.getAttribute('aria-label')).toBe(sheet);
      await press(closeOf(tab.dialog()!));
      await settle(400);
      expect(tab.dialog()).toBeNull();
      expect(dom.document.activeElement).toBe(tab.row(title)!);
    }
    await tab.unmount();
  }, 20_000);

  test('an income’s or a one-off’s sheet, opened after a figure’s, never gives focus to the figure’s row', async () => {
    serve();
    const tab = await mount();
    for (const [add, sheet] of [
      ['Add income', 'Other income'],
      ['Add a one-off', 'One-off expense'],
    ]) {
      await tap(tab.row('Annual savings'));
      await press(button(tab.dialog()!, 'Cancel'));
      await settle(400);
      expect(dom.document.activeElement).toBe(tab.row('Annual savings')!);
      await tap(button(tab.container, add));
      expect(tab.dialog()?.getAttribute('aria-label')).toBe(sheet);
      await press(button(tab.dialog()!, 'Cancel'));
      await settle(400);
      // Back where the sheet found it: on the page, not on a figure's row.
      expect(dom.document.activeElement).toBe(dom.document.body);
      expect(tab.rows().some((r) => r === dom.document.activeElement)).toBe(false);
    }
    await tab.unmount();
  }, 20_000);

  test('the row drawn again while its sheet was open (the plan read after a first load failed): focus goes from the sheet to the row drawn now', async () => {
    let gets = 0;
    serve({ answers: { 'GET /api/fire-plan': () => (++gets === 1 ? [500, { error: 'no' }] : undefined) } });
    const tab = await mount();
    const pressed = tab.row('Assumptions')!;
    await press(pressed);
    const sheet = tab.dialog()!;
    await act(async () => click(button(tab.container, 'Try again')!));
    await settle(100);
    // Each panel was a spinner while the plan was read: its rows are new.
    const now = tab.row('Assumptions')!;
    expect([pressed.isConnected, now === pressed]).toEqual([false, false]);
    // Closed from inside it: what it would give focus back to has gone, so
    // focus is still in the sheet, and goes to the row drawn now.
    await press(button(sheet, 'Cancel'));
    await settle(400);
    expect(tab.dialog()).toBeNull();
    expect(dom.document.activeElement).toBe(now);
    await tab.unmount();
  });
});

describe('rows open while saving is paused, and the sheet says why', () => {
  test('a repair waiting', async () => {
    serve({ plan: { plan: { ...PLAN, withdrawalRate: 0.5 }, currency: null } });
    const tab = await mount();
    expect(button(tab.container, 'Save it this way')).not.toBeNull();
    expect(await everySheet(tab)).toEqual(sheets(false, "Your saved plan has values to fix first (at the top of the Plan tab), so this can't be saved yet."));
    await tab.unmount();
  }, 20_000);

  test('the currency the plan’s figures are in not known: the card at the top asks', async () => {
    serve({ plan: { plan: TYPED, currency: null } });
    // As many accounts in each currency: it can't be told.
    const tab = await mount({ institutions: broker([brokerage({ account_id: 'eur', name: 'Depot', currency: 'EUR' }), brokerage()]) });
    expect(tab.region()?.textContent).toContain('Which currency are they in?');
    expect(await everySheet(tab)).toEqual(sheets(false, "Which currency your plan's figures are in isn't known yet (at the top of the Plan tab), so this can't be saved yet."));
    await tab.unmount();
  }, 20_000);

  test('the currency recording itself, nothing said at the top: the sheet says it is being recorded, and once it is, Save is on', async () => {
    let release!: () => void;
    const calls = serve({
      plan: { plan: TYPED, currency: null },
      answers: { 'POST /api/fire-plan': (c) => new Promise((r) => (release = () => r([200, { plan: TYPED, currency: c.body.currency }]))) },
    });
    // The accounts still loading: the currency can't be told yet.
    const tab = await mount({ balancesAsOf: null });
    await press(tab.row('Ages'));
    const sheet = tab.dialog()!;
    expect(tab.region()?.textContent).toContain('Nya is waiting for your accounts to load');
    expect(pausedLine(sheet)).toBe("Which currency your plan's figures are in isn't known yet (at the top of the Plan tab), so this can't be saved yet.");
    // The balances in: the tab records it by itself, and says nothing at the
    // top meanwhile.
    let between: (string | boolean | null)[] = [];
    await tab.inTheGap({ balancesAsOf: AS_OF }, () => {
      between = [pausedLine(sheet), button(sheet, 'Save')?.disabled ?? null, tab.region() === null];
    });
    expect(between).toEqual(["Your plan's currency is still being recorded, so this can't be saved yet.", true, true]);
    expect(calls.filter((c) => c.url === '/api/fire-plan' && c.method === 'POST').map((c) => c.body)).toEqual([{ currency: 'USD', amounts: typedAmounts(TYPED) }]);
    // Recorded: the same sheet can save, and says nothing is paused.
    await act(async () => release());
    await settle(100);
    expect(tab.dialog()).toBe(sheet);
    expect([button(sheet, 'Save')?.disabled, pausedLine(sheet)]).toEqual([false, null]);
    await tab.unmount();
  });

  test('the saved plan couldn’t be read: the sheets show the defaults, and say so', async () => {
    serve({ answers: { 'GET /api/fire-plan': () => [500, { error: 'no' }] } });
    const tab = await mount();
    expect(part(tab.row('Ages')!, 'list-row-sub')?.textContent).toBe('Add them for Coast FI and to place income by age');
    expect(await everySheet(tab)).toEqual(
      sheets(false, "Your saved plan couldn't be read, so this shows the defaults and can't be saved yet: try again at the top of the Plan tab.")
    );
    await tab.unmount();
  }, 20_000);

  test('read again and failed, with the plan kept: said so; held while it is read again, and open once it has', async () => {
    let gets = 0;
    let release!: () => void;
    serve({
      answers: {
        // The first load, then the one after the refused save below (which
        // fails), then Try again's (held open).
        'GET /api/fire-plan': () => (++gets === 1 ? undefined : gets === 2 ? [500, { error: 'no' }] : new Promise((r) => (release = () => r(undefined)))),
        'PUT /api/fire-plan': () => [409, { error: 'Your plan was changed on another device.' }],
      },
    });
    const tab = await mount();
    await press(tab.row('Ages'));
    const form = tab.dialog()!;
    await act(async () => type(form.findAll((e) => e.tagName === 'INPUT')[1], '58'));
    await press(button(form, 'Save'));
    await settle(100);
    expect(gets).toBe(2);
    await press(button(form, 'Cancel'));
    await settle(400);
    // The plan as it was loaded, its ages kept, and nothing can be saved.
    expect(part(tab.row('Ages')!, 'list-row-sub')?.textContent).toBe('40 now, stop at 55');
    expect(await everySheet(tab)).toEqual(sheets(false, "Your saved plan couldn't be read, so this can't be saved yet: try again at the top of the Plan tab."));
    // Read again: every row held, still a button in the tab order, and a press opens nothing.
    await press(button(tab.container, 'Try again'));
    expect(gets).toBe(3);
    expect(tab.rows().map((r) => [r.getAttribute('aria-disabled'), r.disabled, r.getAttribute('tabindex')])).toEqual(ROWS.map(() => ['true', false, null]));
    for (const [title] of ROWS) {
      await tap(tab.row(title));
      expect(tab.dialog()).toBeNull();
      await press(tab.row(title));
      expect(tab.dialog()).toBeNull();
      expect(dom.document.activeElement).toBe(tab.row(title)!);
    }
    // Loaded: open, and saving again, focus still on the row pressed last.
    await act(async () => release());
    await settle(100);
    expect(dom.document.activeElement).toBe(tab.row('Assumptions')!);
    expect(tab.rows().map((r) => r.getAttribute('aria-disabled'))).toEqual(ROWS.map(() => null));
    expect(await everySheet(tab)).toEqual(sheets(true, null));
    await tab.unmount();
  }, 30_000);

  test('a repair waiting while the currency isn’t known: the currency is said, as the repair saves only once it is', async () => {
    serve({ plan: { plan: { ...TYPED, withdrawalRate: 0.5 }, currency: null } });
    const tab = await mount({ institutions: broker([brokerage({ account_id: 'eur', name: 'Depot', currency: 'EUR' }), brokerage()]) });
    expect(button(tab.container, 'Save it this way')?.disabled).toBe(true);
    expect(tab.region()?.textContent).toContain('Which currency are they in?');
    expect(await everySheet(tab)).toEqual(sheets(false, NOT_KNOWN));
    await tab.unmount();
  }, 20_000);

  test('a repair waiting, and the plan couldn’t be read again: the load error is said', async () => {
    let gets = 0;
    serve({
      plan: { plan: { ...PLAN, withdrawalRate: 0.5 }, currency: null },
      answers: {
        'GET /api/fire-plan': () => (++gets === 1 ? undefined : [500, { error: 'no' }]),
        'PUT /api/fire-plan': () => [409, { error: 'Your plan was changed on another device.' }],
      },
    });
    const tab = await mount();
    // Its save refused, and the plan read again failing: kept, the repair still waiting.
    await press(button(tab.container, 'Save it this way'));
    await settle(100);
    expect(gets).toBe(2);
    expect([button(tab.container, 'Try again') !== null, button(tab.container, 'Save it this way') !== null]).toEqual([true, true]);
    expect(await everySheet(tab)).toEqual(sheets(false, LOAD_KEPT));
    await tab.unmount();
  }, 20_000);

  test('read again behind an open sheet: nothing said while it is read, and once it is, what holds it', async () => {
    // A repair waiting, and the currency the tab records by itself refused
    // as stale: the plan is read again, held, with a sheet open.
    let refuse!: () => void;
    let reread!: () => void;
    let gets = 0;
    serve({
      plan: { plan: { ...TYPED, withdrawalRate: 0.5 }, currency: null },
      answers: {
        'GET /api/fire-plan': () => (++gets === 1 ? undefined : new Promise((r) => (reread = () => r(undefined)))),
        'POST /api/fire-plan': () => new Promise((r) => (refuse = () => r([409, { error: 'Your plan was changed since this page loaded it, so nothing was recorded: load it again.', stale: true }]))),
      },
    });
    const tab = await mount();
    await press(tab.row('Ages'));
    const sheet = tab.dialog()!;
    expect([button(sheet, 'Save')?.disabled, pausedLine(sheet)]).toEqual([true, NOT_KNOWN]);
    await act(async () => refuse());
    await settle(100);
    expect(gets).toBe(2);
    expect(tab.dialog()).toBe(sheet);
    expect([button(sheet, 'Save')?.disabled, pausedLine(sheet)]).toEqual([true, null]);
    // Read: the same plan, its currency not recorded (the tab tried once), so asked.
    await act(async () => reread());
    await settle(100);
    expect(tab.region()?.textContent).toContain('Which currency are they in?');
    expect([button(sheet, 'Save')?.disabled, pausedLine(sheet)]).toEqual([true, NOT_KNOWN]);
    await tab.unmount();
  });
});

describe('the notes under each row', () => {
  test('outside its button: one in full, two or more as one line in the worst one’s color that opens to every note; the savings rate outside any of them', async () => {
    serve();
    const tab = await mount({
      // Transactions entered by hand, one of them excluded, and connections
      // that bring in none; and one account at Broker that couldn't be shown.
      txns: [...YEAR, txn({ date: daysAgo(15), amount: 80, excluded: true } as Partial<Txn>)],
      txnWithout: INVESTMENTS_ONLY,
      institutions: broker([brokerage()], { missing: 1 }),
    });
    const named = 'Empower and Vanguard hold no bank account or card, so no transactions come from them.';
    // Under the button, in the row's item, never in the button.
    for (const r of tab.rows()) expect(r.findAll((e) => e.tagName === 'DETAILS' || has(e, 'notice')).length).toBe(0);
    expect(ROWS.map(([title]) => kids(tab.row(title)!.parentNode!).map((e) => e.getAttribute('class')))).toEqual([
      ['list-row', 'row-notes'],
      ['list-row', 'row-notes'],
      ['list-row', 'row-notes'],
      ['list-row'],
      ['list-row'],
    ]);
    /** A row's notes: the gathered line's class and words, then each note's
     *  class and words, or the one note's in full. */
    const notes = (title: string) => {
      const under = tab.notesOf(title)!;
      const line = under.findAll((e) => e.tagName === 'DETAILS')[0];
      const each = under.findAll((e) => e.tagName === 'DIV' && /^notice (caution|info)$/.test(e.getAttribute('class') ?? ''));
      return {
        line: line ? [kids(line)[0].getAttribute('class'), kids(line)[0].textContent] : null,
        each: each.map((n) => [n.getAttribute('class'), n.textContent, line ? line.contains(n) : false]),
      };
    };
    // Two lesser notes, both information: one line in its color.
    expect(notes('Annual spending')).toEqual({
      line: ['notice info', 'Note: 2 notes: excluded transactions and connections with no transactions'],
      each: [
        ['notice info', 'Note: Leaves out 1 transaction you excluded from budgets and reports.', true],
        ['notice info', `Note: ${named}`, true],
      ],
    });
    // One: in full, no line to open.
    expect(notes('Invested assets')).toEqual({ line: null, each: [['notice caution', "Caution: 1 account at Broker couldn't be shown, so this figure may be low.", false]] });
    // A caution and information: the line in caution, its kind named first.
    expect(notes('Annual savings')).toEqual({
      line: ['notice caution', 'Caution: 2 notes: pay before it reaches a bank and connections with no transactions'],
      each: [
        ['notice caution', `Caution: ${PAYROLL_NOTE}`, true],
        ['notice info', `Note: ${named}`, true],
      ],
    });
    // The savings rate is the value's second line, in the button: no line folds it away.
    const rate = part(tab.row('Annual savings')!, 'plan-input-line')!;
    expect([rate.textContent, folded(rate)]).toEqual(['40% savings rate', false]);
    // Each row with notes is described by them, its own; one without, by nothing.
    const described = ROWS.map(([title]) => {
      const id = tab.row(title)!.getAttribute('aria-describedby');
      const by = id === null ? [] : tab.container.findAll((e) => e.getAttribute('id') === id);
      return [title, id === null ? null : by.length === 1 && by[0] === tab.notesOf(title)];
    });
    expect(described).toEqual([
      ['Annual spending', true],
      ['Invested assets', true],
      ['Annual savings', true],
      ['Ages', null],
      ['Assumptions', null],
    ]);
    await tab.unmount();
  });
});

describe('Why? in a figure’s sheet', () => {
  /** The sheet's Why?: its words and what it opens to, or null. */
  const whyOf = (sheet: FakeElement) => {
    const why = sheet.findAll((e) => e.tagName === 'DETAILS' && has(e, 'why'))[0];
    return why ? [kids(why)[0].textContent, part(why, 'why-body')?.textContent] : null;
  };
  /** The year measured, as the sheet's measured line names it. */
  const span = `your last 12 months of transactions (${dayName(FIRST)} to ${dayName(daysAgo(0))})`;

  test('a measured figure: under Nya’s figure, how it was worked out; none for invested assets, the cash box ticked or not', async () => {
    serve();
    const tab = await mount();
    await press(tab.row('Annual spending'));
    let sheet = tab.dialog()!;
    const measured = sheet.findAll((e) => e.tagName === 'P' && e.textContent.includes(span))[0];
    expect(measured.textContent).toBe(`$36,000 from ${span}`);
    expect(whyOf(sheet)).toEqual(['Why?', 'Includes $600 of cash withdrawals.']);
    // Under the measured line.
    expect(measured.nextSibling).toBe(sheet.findAll((e) => has(e, 'why'))[0]);
    await press(button(sheet, 'Cancel'));
    await settle(400);
    await press(tab.row('Annual savings'));
    sheet = tab.dialog()!;
    expect(whyOf(sheet)).toEqual(['Why?', 'An estimate: income minus spending over the same 12 months. That is a savings rate of 40% of income.']);
    await press(button(sheet, 'Cancel'));
    await settle(400);
    await press(tab.row('Invested assets'));
    sheet = tab.dialog()!;
    expect(sheet.textContent).toContain('$300,000 from 1 account');
    expect(whyOf(sheet)).toBeNull();
    const box = sheet.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'checkbox')[0];
    await act(async () => {
      box.checked = true;
      click(box);
    });
    expect(box.checked).toBe(true);
    expect(whyOf(sheet)).toBeNull();
    await tab.unmount();
  });

  test('a typed figure: its sheet opens on My own, and Nya’s figure, chosen, is explained', async () => {
    serve({ plan: { plan: { ...PLAN, spending: 50_000 }, currency: 'USD' } });
    const tab = await mount();
    expect(part(tab.row('Annual spending')!, 'list-row-sub')?.textContent).toBe('Typed by you');
    await press(tab.row('Annual spending'));
    const sheet = tab.dialog()!;
    expect(button(sheet, 'My own')?.getAttribute('aria-checked')).toBe('true');
    expect(whyOf(sheet)).toBeNull();
    await press(button(sheet, 'Nya’s figure'));
    expect(sheet.textContent).toContain(`$36,000 from ${span}`);
    expect(whyOf(sheet)).toEqual(['Why?', 'Includes $600 of cash withdrawals.']);
    await tab.unmount();
  });

  test('invested assets with a Why? (FigureForm by itself): gone once the cash box says otherwise than the plan, back with it', async () => {
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const account = { account_id: 'brk', name: 'Brokerage', institution: 'Broker', balance: 300_000, currency: 'USD' };
    const cash = { account_id: 'chk', name: 'Checking', institution: 'Bank', balance: 10_000, currency: 'USD' };
    await act(async () =>
      root.render(
        <FigureForm
          plan={PLAN}
          onSave={async () => true}
          onDone={() => {}}
          editable
          kind="assets"
          measured={300_000}
          measuredText="from 1 account"
          why="Said of the accounts the plan counts."
          currency="USD"
          assetsFor={(withCash) => (withCash ? { total: 310_000, accounts: [account, cash] } : { total: 300_000, accounts: [account] })}
        />
      )
    );
    const why = (): string | null => container.findAll((e) => e.tagName === 'DETAILS' && has(e, 'why'))[0]?.textContent ?? null;
    const box = container.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'checkbox')[0];
    expect(why()).toBe('Why?Said of the accounts the plan counts.');
    await act(async () => {
      box.checked = true;
      click(box);
    });
    expect([container.textContent.includes('$310,000 from 2 accounts'), why()]).toEqual([true, null]);
    await act(async () => {
      box.checked = false;
      click(box);
    });
    expect(why()).toBe('Why?Said of the accounts the plan counts.');
    await act(async () => root.unmount());
  });
});

describe('a sheet holds the saved plan it opened on', () => {
  /** A sheet open while its plan was read again behind it. */
  const READ_AGAIN = "Your saved plan was read again since this opened, so this can't be saved: close it and open it again.";
  const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT' && c.url === '/api/fire-plan');

  test('opened on the defaults after a first load failed, and the saved plan read while it is open: Save stays off, says why, and sends nothing', async () => {
    for (const title of ['Assumptions', 'Annual spending']) {
      let gets = 0;
      const calls = serve({ answers: { 'GET /api/fire-plan': () => (++gets === 1 ? [500, { error: 'no' }] : undefined) } });
      const tab = await mount();
      await press(tab.row(title));
      const sheet = tab.dialog()!;
      expect([title, button(sheet, 'Save')?.disabled, pausedLine(sheet)]).toEqual([title, true, DEFAULTS]);
      // Read again behind the sheet (a press past it here): the plan lands
      // while it is open, its ages with it.
      await act(async () => click(button(tab.container, 'Try again')!));
      await settle(100);
      expect(gets).toBe(2);
      expect(part(tab.row('Ages')!, 'list-row-sub')?.textContent).toBe('40 now, stop at 55');
      expect(tab.dialog()).toBe(sheet);
      expect([title, button(sheet, 'Save')?.disabled, pausedLine(sheet)]).toEqual([title, true, READ_AGAIN]);
      await press(button(sheet, 'Save'));
      await settle(100);
      expect(puts(calls).length).toBe(0);
      // Opened again, on the plan read: it saves.
      await press(button(sheet, 'Cancel'));
      await settle(400);
      expect(await sheetOf(tab, title)).toEqual({ title, save: true, paused: null });
      await tab.unmount();
    }
  }, 20_000);

  test('opened while the tab records the currency, and the record refused as stale: the plan read again replaces the one it opened on, and Save stays off', async () => {
    for (const title of ['Assumptions', 'Annual spending']) {
      const NEWER = { ...TYPED, spending: 45_000 };
      let stored = TYPED;
      let refuse!: () => void;
      let posts = 0;
      const calls = serve({
        answers: {
          'GET /api/fire-plan': () => [200, { plan: stored, currency: null }],
          'POST /api/fire-plan': (c) =>
            ++posts === 1
              ? new Promise((r) => (refuse = () => r([409, { error: 'Your plan was changed since this page loaded it, so nothing was recorded: load it again.', stale: true }])))
              : [200, { plan: stored, currency: c.body.currency }],
        },
      });
      const tab = await mount();
      // The tab records the currency by itself, held: a sheet opened
      // meanwhile says it isn't known yet.
      expect(posts).toBe(1);
      await press(tab.row(title));
      const sheet = tab.dialog()!;
      expect([title, button(sheet, 'Save')?.disabled, pausedLine(sheet)]).toEqual([title, true, NOT_KNOWN]);
      // Changed on another device meanwhile: the record is refused, the plan
      // read again, and its currency recorded for it.
      stored = NEWER;
      await act(async () => refuse());
      await settle(100);
      expect([calls.filter((c) => c.method === 'GET' && c.url === '/api/fire-plan').length, posts]).toEqual([2, 2]);
      expect(valueOf(tab.row('Annual spending')!)).toBe('$45,000');
      expect(tab.dialog()).toBe(sheet);
      expect([title, button(sheet, 'Save')?.disabled, pausedLine(sheet)]).toEqual([title, true, READ_AGAIN]);
      await press(button(sheet, 'Save'));
      await settle(100);
      expect(puts(calls).length).toBe(0);
      await press(button(sheet, 'Cancel'));
      await settle(400);
      expect(await sheetOf(tab, title)).toEqual({ title, save: true, paused: null });
      await tab.unmount();
    }
  }, 20_000);

  test('a save that ends after its sheet was dismissed closes only that one: a sheet opened since stays open, with what was typed in it', async () => {
    let release!: () => void;
    let n = 0;
    const calls = serve({
      answers: {
        'PUT /api/fire-plan': (c) =>
          ++n === 1 ? new Promise((r) => (release = () => r([200, { plan: c.body.plan, currency: c.body.currency }]))) : [200, { plan: c.body.plan, currency: c.body.currency }],
      },
    });
    const tab = await mount();
    await press(tab.row('Ages'));
    const ages = tab.dialog()!;
    await act(async () => type(ages.findAll((e) => e.tagName === 'INPUT')[1], '58'));
    await press(button(ages, 'Save'));
    expect(puts(calls).length).toBe(1);
    // Dismissed while it saves (its Cancel waits for the save; the cross
    // doesn't), and another sheet opened.
    await press(closeOf(ages));
    await settle(400);
    expect(tab.dialog()).toBeNull();
    await press(tab.row('Assumptions'));
    const assumptions = tab.dialog()!;
    expect(assumptions.getAttribute('aria-label')).toBe('Assumptions');
    const rate = assumptions.findAll((e) => e.tagName === 'INPUT')[0];
    await act(async () => type(rate, '3.5'));
    // A save under way: Save off for the moment, and nothing said.
    expect([button(assumptions, 'Save')?.disabled, pausedLine(assumptions)]).toEqual([true, null]);
    await act(async () => release());
    await settle(400);
    // The ages' save closed nothing: this sheet is open, as typed, and saves.
    expect(tab.dialog()).toBe(assumptions);
    expect(rate.value).toBe('3.5');
    expect([button(assumptions, 'Save')?.disabled, pausedLine(assumptions)]).toEqual([false, null]);
    await press(button(assumptions, 'Save'));
    await settle(400);
    expect(puts(calls).map((c) => [c.body.plan.targetAge, c.body.plan.withdrawalRate])).toEqual([
      [58, 0.04],
      [58, 0.035],
    ]);
    expect(tab.dialog()).toBeNull();
    await tab.unmount();
  });

  test('a save that failed reads the plan again; the same plan back, its sheet stays open and Save on, to try again', async () => {
    let n = 0;
    let gets = 0;
    const calls = serve({
      answers: {
        'GET /api/fire-plan': () => void gets++,
        'PUT /api/fire-plan': (c) => (++n === 1 ? [500, { error: 'no' }] : [200, { plan: c.body.plan, currency: c.body.currency }]),
      },
    });
    const tab = await mount();
    await press(tab.row('Ages'));
    const sheet = tab.dialog()!;
    await act(async () => type(sheet.findAll((e) => e.tagName === 'INPUT')[1], '58'));
    await press(button(sheet, 'Save'));
    await settle(100);
    expect(gets).toBe(2);
    expect(tab.dialog()).toBe(sheet);
    expect(sheet.textContent).toContain('It was not saved. Try again in a moment.');
    expect([button(sheet, 'Save')?.disabled, pausedLine(sheet)]).toEqual([false, null]);
    await press(button(sheet, 'Save'));
    await settle(400);
    expect(puts(calls).map((c) => c.body.plan.targetAge)).toEqual([58, 58]);
    expect(tab.dialog()).toBeNull();
    await tab.unmount();
  });
});

describe('the Stress test’s notice', () => {
  const SPENDING = "Your annual spending may be low: it is missing transactions Plaid doesn't provide, and the simulation withdraws it (Your path says which).";
  const ASSETS = "Your invested assets may be low: some couldn't be counted (Your path says which).";
  /** The simulation card's own start note, drawn when it starts with more
   *  than the walk from today's assets comes to (lib/fire/plan-figures.ts
   *  startsWith.more). */
  const MORE = 'it starts with money it wouldn’t have then';
  /** The first thing in the Stress test's panel, inside its stack. */
  const top = (tab: Tab) => kids(kids(tab.panel('stress'))[0])[0];
  /** What the notice at the top says: the gathered line's, then each
   *  note's class and words; null when the panel opens on the simulation,
   *  which `none` checks says nothing of the kind anywhere in the panel. */
  const notice = (tab: Tab) => {
    const first = top(tab);
    if (!has(first, 'stack') || !has(first, 'tight')) return null;
    const line = first.findAll((e) => e.tagName === 'SUMMARY')[0];
    const each = first.findAll((e) => e.tagName === 'DIV' && /^notice (caution|info|critical)$/.test(e.getAttribute('class') ?? ''));
    return { line: line ? [line.getAttribute('class'), line.textContent] : null, each: each.map((n) => [n.getAttribute('class'), n.textContent]) };
  };
  /** No notice: nothing at the top, and no "may be low" anywhere in the panel. */
  const none = (tab: Tab) => {
    expect(notice(tab)).toBeNull();
    expect(tab.panel('stress').textContent).not.toContain('may be low');
  };

  test('one caution in full at the top of its panel, above the simulation, hidden with the panel; none on Your path or Portfolio', async () => {
    serve();
    const tab = await mount({ txnWithout: REFUSED });
    expect(notice(tab)).toEqual({ line: null, each: [['notice caution', `Caution: ${SPENDING}`]] });
    const stack = kids(tab.panel('stress'))[0];
    expect(stack.getAttribute('class')).toBe('stack loose');
    expect(tab.titles(tab.panel('stress'))[0]).toBe('Will it last?');
    // Inside the panel, so hidden while another segment is shown.
    expect([tab.panel('stress').hasAttribute('hidden'), tab.panel('stress').contains(top(tab))]).toEqual([true, true]);
    await act(async () => click(tab.tab('Stress test')));
    expect(tab.panel('stress').hasAttribute('hidden')).toBe(false);
    expect(notice(tab)?.each).toEqual([['notice caution', `Caution: ${SPENDING}`]]);
    for (const s of ['path', 'portfolio'] as const) {
      expect(tab.panel(s).textContent).not.toContain('Your annual spending may be low');
      expect(tab.panel(s).textContent).not.toContain('the simulation withdraws it');
    }
    // Your path says which, under the row.
    expect(tab.notesOf('Annual spending')?.textContent).toContain("Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so this figure may be low.");
    await tab.unmount();
  });

  test('both inputs short: one line in caution, opening to both', async () => {
    serve({ plan: { plan: { ...PLAN, start: 'assets' }, currency: null } });
    const tab = await mount({ txnWithout: REFUSED, institutions: broker([brokerage()], { missing: 1 }) });
    expect(notice(tab)).toEqual({
      line: ['notice caution', 'Caution: 2 notes: spending may be low and invested assets may be low'],
      each: [
        ['notice caution', `Caution: ${SPENDING}`],
        ['notice caution', `Caution: ${ASSETS}`],
      ],
    });
    await tab.unmount();
  });

  test('under VPW, which sets its own spending: said of the FI number it starts from, or of the first year’s spending its card compares with it', async () => {
    serve({ plan: { plan: { ...PLAN, rule: 'vpw' }, currency: null } });
    const fromFi = await mount({ txnWithout: REFUSED });
    expect(notice(fromFi)).toEqual({
      line: null,
      each: [['notice caution', "Caution: Your annual spending may be low: it is missing transactions Plaid doesn't provide, and the simulation starts from the FI number worked out from it (Your path says which)."]],
    });
    await fromFi.unmount();
    const COMPARED = "Your annual spending may be low: it is missing transactions Plaid doesn't provide, and the simulation compares its first year's spending with it (Your path says which).";
    serve({ plan: { plan: { ...PLAN, rule: 'vpw', start: 'assets' }, currency: null } });
    const fromAssets = await mount({ txnWithout: REFUSED });
    expect(notice(fromAssets)).toEqual({ line: null, each: [['notice caution', `Caution: ${COMPARED}`]] });
    await fromAssets.unmount();
    // Its assets short too: both, the spending first.
    const short = await mount({ txnWithout: REFUSED, institutions: broker([brokerage()], { missing: 1 }) });
    expect(notice(short)).toEqual({
      line: ['notice caution', 'Caution: 2 notes: spending may be low and invested assets may be low'],
      each: [
        ['notice caution', `Caution: ${COMPARED}`],
        ['notice caution', `Caution: ${ASSETS}`],
      ],
    });
    await short.unmount();
  });

  test('invested assets short: said when the simulation starts from them or its card says it starts with more than they would grow to, and not otherwise', async () => {
    const short = { institutions: broker([brokerage()], { missing: 1 }) };
    const said = { line: null, each: [['notice caution', `Caution: ${ASSETS}`]] };
    serve({ plan: { plan: { ...PLAN, start: 'assets' }, currency: null } });
    const fromThem = await mount(short);
    expect(notice(fromThem)).toEqual(said);
    await fromThem.unmount();
    // From the FI number at 42: the walk from today's assets comes to less,
    // and the card says it starts with money it wouldn't have.
    serve({ plan: { plan: { ...PLAN, targetAge: 42 }, currency: null } });
    const more = await mount(short);
    expect(notice(more)).toEqual(said);
    expect(more.panel('stress').textContent).toContain(MORE);
    await more.unmount();
    // At 55 they would grow past it: projected, but the card says nothing of them.
    serve();
    const enough = await mount(short);
    none(enough);
    expect(enough.panel('stress').textContent).not.toContain(MORE);
    await enough.unmount();
    // No age: nothing is projected from them.
    serve({ plan: { plan: { ...PLAN, age: null }, currency: null } });
    const noAge = await mount(short);
    none(noAge);
    // Your path still says so, under the row.
    expect(noAge.notesOf('Invested assets')?.textContent).toContain("1 account at Broker couldn't be shown, so this figure may be low.");
    await noAge.unmount();
  });

  test('none while the simulation needs an input first, which its card says', async () => {
    // From today's assets, with none to count, and the spending short.
    serve({ plan: { plan: { ...PLAN, start: 'assets' }, currency: null } });
    const tab = await mount({ txnWithout: REFUSED, institutions: [] });
    none(tab);
    expect(tab.panel('stress').textContent).toContain('The simulation starts with your invested assets, and there are none to count yet.');
    await tab.unmount();
  });

  test('with a scenario open, of the scenario’s inputs: kept while it measures the spending, gone once it types its own', async () => {
    const later = scenario({ id: 's1', name: 'Retire at 50', set: { targetAge: 50 } });
    const typed = scenario({ id: 's2', name: 'Spend more', set: { spending: 55_000 } });
    serve({ answers: { 'GET /api/plan-scenarios': () => [200, { scenarios: [later, typed], unreadable_ids: [], unrecognised_ids: [] }] } });
    const tab = await mount({ txnWithout: REFUSED });
    expect(notice(tab)?.each).toEqual([['notice caution', `Caution: ${SPENDING}`]]);
    await openScenario(tab, 'Retire at 50');
    expect(tab.container.textContent).toContain('Scenario: Retire at 50');
    expect(notice(tab)).toEqual({ line: null, each: [['notice caution', `Caution: ${SPENDING}`]] });
    await openScenario(tab, 'Spend more');
    expect(tab.container.textContent).toContain('Scenario: Spend more');
    none(tab);
    // Under the row too, the spending is the scenario's own.
    expect(part(tab.row('Annual spending')!, 'list-row-sub')?.textContent).toBe('Typed by you');
    await tab.unmount();
  });
});

// Rollout 6d: every rate and setting in one Assumptions sheet, opened from
// Your figures and from Stress test's own row; About these numbers said once,
// in a sheet; and a badge on each Stress test card its notice is about.
describe('the Assumptions sheet, and Stress test’s rows', () => {
  const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT' && c.url === '/api/fire-plan');
  /** A sheet's field by the words of its label. */
  const field = (sheet: FakeElement, label: string) =>
    sheet.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(label))[0]?.findAll((e) => e.tagName === 'INPUT' || e.tagName === 'SELECT')[0] ?? null;
  /** Stress test's rows, by title. */
  const stressRow = (tab: Tab, title: string) =>
    tab.panel('stress').findAll((e) => e.tagName === 'BUTTON' && has(e, 'list-row') && part(e, 'list-row-title')?.textContent === title)[0] ?? null;

  test('one sheet of the FI number’s and the stress test’s settings, under their headings; one Save sends them all, and the rest of the plan as it was', async () => {
    const calls = serve({ answers: { 'PUT /api/fire-plan': (c) => [200, { plan: c.body.plan, currency: c.body.currency }] } });
    const tab = await mount();
    await press(tab.row('Assumptions'));
    const sheet = tab.dialog()!;
    expect(sheet.getAttribute('aria-label')).toBe('Assumptions');
    expect(sheet.findAll((e) => e.tagName === 'H3' && has(e, 'plan-heading')).map((e) => e.textContent)).toEqual(['FI number', 'Stress test']);
    for (const label of ['Withdrawal rate', 'Growth after inflation until FI', 'Tax on withdrawals', 'Part-time income', 'Method', 'Withdrawal rule', 'Start with', 'Length in years', 'Stocks %', 'Bonds %', 'Rebalancing', 'Fund fees']) {
      expect([label, field(sheet, label) !== null]).toEqual([label, true]);
    }
    // Each says what it changes, under it.
    expect(sheet.textContent).toContain("How much you'd draw each year, as a share of what you have: it sets the FI number (spending divided by it) and the rate the simulation tests.");
    // The rule is said at the rate typed, as it is typed.
    await act(async () => type(field(sheet, 'Withdrawal rate')!, '3.5'));
    expect(sheet.textContent).toContain("The first year withdraws 3.5% of the starting balance");
    await act(async () => type(field(sheet, 'Fund fees')!, '0.2'));
    await act(async () => type(field(sheet, 'Method')!, 'monte-carlo'));
    await press(button(sheet, 'Save'));
    await settle(100);
    expect(puts(calls).length).toBe(1);
    const sent = puts(calls)[0].body.plan;
    expect([sent.withdrawalRate, sent.fee, sent.method]).toEqual([0.035, 0.002, 'monte-carlo']);
    expect({ ...sent, withdrawalRate: PLAN.withdrawalRate, fee: PLAN.fee, method: PLAN.method }).toEqual(PLAN);
    await settle(400);
    expect(tab.dialog()).toBeNull();
    // Said on the card and on its row.
    expect(tab.panel('stress').textContent).toContain('Will it last?Monte Carlo');
    expect(part(stressRow(tab, 'Assumptions')!, 'list-row-sub')?.textContent).toBe('Monte Carlo · 75/25/0 · Constant · 0.2% fee');
    expect(part(tab.row('Assumptions')!, 'list-row-sub')?.textContent).toBe('3.5% withdrawal · 5% growth after inflation until FI · 0% tax');
    await tab.unmount();
  });

  test('Stress test’s rows open the sheet and About these numbers, and focus comes back to the row', async () => {
    serve();
    const tab = await mount();
    await act(async () => click(tab.tab('Stress test')));
    const assumptions = stressRow(tab, 'Assumptions')!;
    expect(part(assumptions, 'list-row-sub')?.textContent).toBe('Historical cycles · 75/25/0 · Constant · 0.1% fee');
    // The About card is gone: its words are in the row's sheet.
    expect(tab.panel('stress').textContent).not.toContain('These results are hypothetical');
    await tap(stressRow(tab, 'About these numbers'));
    const about = tab.dialog()!;
    expect(about.getAttribute('aria-label')).toBe('About these numbers');
    expect(about.textContent).toContain(
      "These results are hypothetical. They show how this plan would have fared in US market history from 1871 to 2023, or in sequences resampled from it, in today's dollars. They are not a prediction and not advice."
    );
    expect(about.textContent).toContain('the S&P Composite (the S&P 500 since 1957) with dividends reinvested');
    expect(about.textContent).toContain("What this can't tell you: other countries' markets");
    await act(async () => click(closeOf(about)!));
    await settle(400);
    expect(dom.document.activeElement).toBe(stressRow(tab, 'About these numbers'));
    await tap(assumptions);
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Assumptions');
    await act(async () => click(closeOf(tab.dialog()!)!));
    await settle(400);
    expect(dom.document.activeElement).toBe(stressRow(tab, 'Assumptions'));
    await tab.unmount();
  });

  test('with a scenario open, the method and the part-time income are the plan’s, and say so', async () => {
    const later = scenario({ id: 's1', name: 'Retire at 50', set: { targetAge: 50 } });
    serve({ answers: { 'GET /api/plan-scenarios': () => [200, { scenarios: [later], unreadable_ids: [], unrecognised_ids: [] }] } });
    const tab = await mount();
    await openScenario(tab, 'Retire at 50');
    await press(tab.row('Assumptions'));
    const sheet = tab.dialog()!;
    expect(sheet.getAttribute('aria-label')).toBe('Assumptions (Retire at 50)');
    expect(field(sheet, 'Method')?.disabled).toBe(true);
    expect(field(sheet, 'Part-time income')?.disabled).toBe(true);
    expect(field(sheet, 'Withdrawal rate')?.disabled).toBe(false);
    expect(sheet.textContent).toContain('The method is the same in every scenario: change it with your plan open.');
    expect(sheet.textContent).toContain('Saved to the scenario “Retire at 50”, not your plan.');
    await tab.unmount();
  });

  test('a badge on each card Stress test’s notice is about, and none without it', async () => {
    serve();
    const badges = (tab: Tab) => tab.panel('stress').findAll((e) => has(e, 'plan-card-badge')).map((e) => e.textContent);
    const short = await mount({ txnWithout: REFUSED });
    expect(badges(short)).toEqual(['An input may be low', 'An input may be low']);
    await short.unmount();
    serve();
    const whole = await mount();
    expect(badges(whole)).toEqual([]);
    await whole.unmount();
  });
});

describe('the answer asks for the ages it needs (rollout phase 8b)', () => {
  test('a button under the answer opens the Ages sheet; closed, focus is back on it, and once the ages are saved (the button gone) on the Ages row', async () => {
    let current: unknown = { ...DEFAULT_PLAN };
    serve({
      answers: {
        'GET /api/fire-plan': () => [200, { plan: current, currency: null }],
        'PUT /api/fire-plan': (c) => {
          current = c.body.plan;
          return [200, { plan: current, currency: null }];
        },
      },
    });
    const tab = await mount();
    const ask = () => button(tab.panel('path'), 'Add your age and when you’d like to stop');
    expect(ask()).not.toBeNull();
    await press(ask());
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Your ages');
    await press(closeOf(tab.dialog()!));
    await settle(400);
    expect(dom.document.activeElement).toBe(ask()!);
    // Saved: the answer is against the stop age, and nothing asks.
    await press(ask());
    const form = tab.dialog()!;
    const [age, stop] = form.findAll((e) => e.tagName === 'INPUT');
    await act(async () => type(age, '40'));
    await act(async () => type(stop, '55'));
    await press(button(form, 'Save'));
    await settle(400);
    expect(ask()).toBeNull();
    expect(tab.panel('path').textContent).toContain('Financial independenceAround age');
    expect(tab.panel('path').textContent).toMatch(/years? (before|after) you stop at 55|Right when you stop at 55/);
    expect(dom.document.activeElement).toBe(tab.row('Ages')!);
    await tab.unmount();
  }, 20_000);

  test('only the age missing, or only the stop age: it asks for that one', async () => {
    for (const [over, words] of [
      [{ targetAge: 55 }, 'Add your age'],
      [{ age: 40 }, 'Add when you’d like to stop'],
    ] as const) {
      serve({ plan: { plan: { ...DEFAULT_PLAN, ...over }, currency: null } });
      const tab = await mount();
      expect(button(tab.panel('path'), words)).not.toBeNull();
      await tab.unmount();
    }
  });
});
