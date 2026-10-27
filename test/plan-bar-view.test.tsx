import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { installDom, click, type, outline, FakeElement, FakeEvent } from './mini-dom';

// The Plan tab's pinned bar and segments (rollout phase 6b,
// docs/design/information-architecture.md#plan), used as a person would
// (react-dom/client over test/mini-dom.ts): "Your plan" or the scenario open
// as its heading, over Your path, Stress test and Portfolio, each its own
// panel and all three mounted; the bar there before the plan has loaded, and
// the same bar, heading and Scenarios sheet once it has; the Scenarios sheet
// from the bar and from the open scenario's card, and where focus goes as a
// scenario opens and is left; the scenario's card above the panels, saying
// why one isn't worked out whatever segment is chosen; where a switch
// scrolls to, one --sp-2 under the bar; focus where it belongs when the
// click comes between a commit in the background and its effects; what the
// tab closes by itself, moving no focus; and Home's FI line landing on the
// heading. The sheet's own
// levels are test/plan-scenarios-sheet-view.test.tsx's; the dashboard's side
// of the landing is test/plan-landing-source.test.ts's. Every request is
// answered here, by path; nothing reaches a network.
//
// A rendered element never goes into toEqual or another matcher that diffs
// (test/plan-tab-scenarios.test.tsx says why): elements are compared with
// toBe, or outlined first.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;

// A scheduler a test can step (the race, below): while `manual`, the work
// React schedules waits in `queue`, to run a task at a time. Put in before
// React's client loads, which keeps the scheduler's functions it finds then.
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
const { default: PlanBar, PLAN_TITLE } = await import('@/components/PlanBar');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { NO_CHANGES } = await import('@/lib/fire/scenarios');
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type PlanSegment = import('@/components/PlanBar').PlanSegment;
type Entry = import('@/components/plan-scenarios').ScenarioEntry;

// mini-dom's window has no scrollBy: each scroll the tab asks for is kept.
const scrolls: number[] = [];
(globalThis as unknown as { window: { scrollBy: (x: number, y: number) => void } }).window.scrollBy = (_x, y) => {
  scrolls.push(y);
};
// And no layout: every rect is zero, so nothing scrolls, unless a test lays
// the page out (layout, below). The tokens are app/globals.css's: --sp-2 is
// the gap a segment lands under the bar with.
(globalThis as unknown as { window: { getComputedStyle: () => { getPropertyValue: (k: string) => string } } }).window.getComputedStyle = () => ({
  getPropertyValue: (k: string) => (k === '--sp-2' ? ' 8px' : ''),
});
const realRect = FakeElement.prototype.getBoundingClientRect;
afterEach(() => {
  FakeElement.prototype.getBoundingClientRect = realRect;
  scrolls.length = 0;
  dom.document.activeElement = dom.document.body;
});

const PLAN = { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, savings: 30_000, assets: 300_000 };
const entry = (id: string, name: string, over: Partial<Entry> = {}): Entry => ({
  id,
  version: 1,
  name,
  currency: 'USD',
  createdAt: '2026-10-01T00:00:00.000Z',
  savedAt: '2026-10-01T00:00:00.000Z',
  rev: 'r1',
  ...NO_CHANGES,
  set: { targetAge: 50 },
  ...over,
});
const RETIRE = entry('a', 'Retire at 50');
const SABBATICAL = entry('b', 'Sabbatical 2029', { set: { spending: 30_000 } });
// Retiring before the age now breaks a rule of the Plan's: not worked out,
// so its life event is on no card.
const TOO_SOON = entry('c', 'Retire at 30', { set: { targetAge: 30 }, events: [{ id: 'w', kind: 'spending', label: 'Wedding', fromAge: 42, yearly: 20_000, years: 1 }] });
// Its amounts typed in euros, the Plan's figures recorded in dollars.
const IN_EUROS = entry('f', 'In euros', { currency: 'EUR', set: { spending: 45_000 } });
// Lasting changes that take spending in retirement below zero: refused.
const BELOW_ZERO = entry('d', 'Mortgage gone', { set: {}, events: [{ id: 'x', kind: 'spending', label: 'Mortgage paid off', fromAge: 41, yearly: -45_000, years: null }] });
const GYM = entry('e', 'Gym', { set: {}, events: [{ id: 'g', kind: 'spending', label: 'Gym', fromAge: 41, yearly: 1_000, years: 5 }] });

type Call = { method: string; url: string; body: any };

type Answer = (call: Call) => [number, unknown] | undefined | Promise<[number, unknown] | undefined>;

/** The routes the tab calls, answered as the real ones would: the plan (or
 *  a promise of it, to hold its load open), and the scenarios, kept here as
 *  they are changed; `answers`, by "METHOD /path", go first where they give
 *  one. Every call is recorded. */
function serve({ plan = { plan: PLAN, currency: 'USD' } as unknown, scenarios = [] as Entry[] | null, answers = {} as Record<string, Answer> } = {}) {
  let list = scenarios ? [...scenarios] : [];
  let made = 0;
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const call = { method, url, body };
    calls.push(call);
    const answer = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const given = await answers[`${method} ${url}`]?.(call);
    if (given) return answer(given[1], given[0]);
    if (url === '/api/fire-plan' && method === 'GET') return answer(await plan);
    if (url === '/api/plan-scenarios') {
      if (scenarios === null) return answer({ error: 'Your saved scenarios couldn’t be loaded.' }, 500);
      if (method === 'POST') {
        const created = { ...entry(`new${++made}`, body.scenario.name), ...body.scenario };
        list = [...list, created];
        return answer({ scenario: created });
      }
      if (method === 'PUT') {
        const now = { ...list.find((s) => s.id === body.id)!, ...body.scenario, rev: 'r2' };
        list = list.map((s) => (s.id === body.id ? now : s));
        return answer({ scenario: now });
      }
      if (method === 'DELETE') {
        list = list.filter((s) => s.id !== body.id);
        return answer({ ok: true });
      }
      return answer({ scenarios: list, unreadable_ids: [], unrecognised_ids: [] });
    }
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

const key = (el: FakeElement, k: string) =>
  act(() => {
    const e = new FakeEvent('keydown');
    e.key = k;
    el.dispatchEvent(e);
  });

const has = (e: FakeElement, cls: string) => (e.getAttribute('class') ?? '').split(' ').includes(cls);

/** Stress test's rows, by their titles (rollout 6d). */
const stressRows = (tab: { panelOf: (label: string) => FakeElement }) =>
  tab.panelOf('Stress test').findAll((e) => has(e, 'list-row-title')).map((e) => e.textContent);

async function mount(props: Partial<PlanTabProps> = {}) {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const all: PlanTabProps = { txns: [], txnsLoading: false, txnNotes: [], institutions: [], balancesAsOf: null, currency: 'USD', holdings: [], ...props };
  await act(async () => root.render(<PlanTab {...all} />));
  await settle();
  const find = (test: (e: FakeElement) => boolean) => container.findAll(test);
  const bar = () => find((e) => has(e, 'plan-bar'))[0];
  const tabs = () => bar().findAll((e) => e.getAttribute('role') === 'tab');
  const tab = (label: string) => tabs().filter((e) => e.textContent === label)[0];
  const panels = () => find((e) => e.getAttribute('role') === 'tabpanel' && has(e, 'plan-panel'));
  const panelOf = (label: string) => panels().find((p) => p.getAttribute('aria-labelledby') === tab(label).getAttribute('id'))!;
  const card = () => find((e) => has(e, 'plan-scenario-card'))[0] ?? null;
  const dialog = () => find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  return {
    container,
    rerender: (more: Partial<PlanTabProps>) => act(async () => root.render(<PlanTab {...all} {...more} />)),
    /** The tab drawn again in the background with `more` (a default-priority
     *  render, as a simulation's answer is), then `then` run once that has
     *  committed and before its effects have: a click in that moment. */
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
      await settle(400);
    },
    unmount: () => act(async () => root.unmount()),
    text: () => container.textContent,
    bar,
    tabs,
    tab,
    panels,
    panelOf,
    selected: () => tabs().filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.textContent),
    /** The panels a person can see (mini-dom draws hidden ones too), by
     *  the tab each is labelled by. */
    shown: () => panels().filter((p) => !p.hasAttribute('hidden')).map((p) => tabs().find((t) => t.getAttribute('id') === p.getAttribute('aria-labelledby'))?.textContent),
    title: () => find((e) => e.getAttribute('id') === PLAN_TITLE)[0],
    /** The bar's Scenarios button, drawn on your plan. */
    scenarios: () => bar().findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Scenarios'))[0] ?? null,
    arrow: () => bar().findAll((e) => e.getAttribute('aria-label') === 'Back to your plan')[0] ?? null,
    card,
    /** The card's Scenarios button, at its foot. */
    cardScenarios: () => card()?.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Scenarios'))[0] ?? null,
    dialog,
    /** The open sheet with this title. */
    sheet: (title: string) => find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true' && e.getAttribute('aria-label') === title)[0] ?? null,
    /** A control in the open sheet, by its name. */
    inSheet: (label: string) => dialog()?.findAll((e) => e.getAttribute('aria-label') === label || (e.tagName === 'BUTTON' && e.textContent.trim() === label))[0] ?? null,
    /** The card titles in a panel: a card's name, its total's label, or the
     *  heading in its header (Your figures'). */
    titles: (p: FakeElement) =>
      p.findAll((e) => has(e, 'inst-name') || has(e, 'total-label') || (/^H\d$/.test(e.tagName) && e.parentNode instanceof FakeElement && has(e.parentNode, 'card-header'))).map((e) => e.textContent),
    /** One of Your figures' rows, by its title. */
    row: (title: string) => find((e) => e.tagName === 'BUTTON' && has(e, 'list-row') && e.findAll((t) => has(t, 'list-row-title'))[0]?.textContent === title)[0] ?? null,
    /** Where an element comes in the page, top to bottom. */
    order: (el: FakeElement) => find(() => true).indexOf(el),
  };
}
type Tab = Awaited<ReturnType<typeof mount>>;

/** Opens a scenario from the bar's Scenarios sheet. */
async function openFromBar(tab: Tab, name: string) {
  await press(tab.scenarios());
  await press(tab.inSheet(`Open ${name}`));
}

/** Lays the page out: the bar pinned at the top, with `rects` saying where
 *  the scenario's card and the panels are. */
function layout(rects: { card?: number; panel?: number }) {
  FakeElement.prototype.getBoundingClientRect = function (this: FakeElement) {
    const at = (top: number, bottom: number) => ({ x: 0, y: top, top, bottom, left: 0, right: 0, width: 0, height: bottom - top });
    if (has(this, 'plan-bar')) return at(0, 120);
    // The card's place: the slot that holds it (and its life events, when refused).
    if (rects.card !== undefined && this.childNodes.some((c) => c instanceof FakeElement && has(c, 'plan-scenario-card'))) return at(rects.card, rects.card + 400);
    if (rects.panel !== undefined && this.getAttribute('role') === 'tabpanel') return at(rects.panel, rects.panel + 3000);
    return realRect.call(this);
  };
}

describe('the bar, before and after the plan loads', () => {
  test('before the saved plan has loaded: the bar with "Your plan", three segments, each a spinner, and no figure', async () => {
    serve({ plan: new Promise(() => {}), scenarios: [RETIRE] });
    const tab = await mount();
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.title().tagName).toBe('H2');
    // Focusable by script, so Home's FI line and an opened scenario land on it.
    expect(tab.title().getAttribute('tabindex')).toBe('-1');
    expect(tab.tabs().map((e) => e.textContent)).toEqual(['Your path', 'Stress test', 'Portfolio']);
    expect(tab.panels().length).toBe(3);
    for (const p of tab.panels()) expect(p.findAll((e) => e.getAttribute('role') === 'status' && e.getAttribute('aria-label') === 'Loading your plan').length).toBe(1);
    expect(tab.text()).not.toContain('FI number');
    // The sheet can be opened meanwhile: it says why nothing opens yet.
    expect(tab.scenarios()?.textContent).toBe('Scenarios (1)');
    await tab.unmount();
  });

  test('landed on while the plan loads, the heading keeps focus as it arrives: the same bar, the same heading', async () => {
    let release!: () => void;
    serve({ plan: new Promise((r) => (release = () => r({ plan: PLAN, currency: 'USD' }))), scenarios: [RETIRE] });
    let landed = 0;
    const tab = await mount({ landing: Date.now(), onLanded: () => landed++ });
    const title = tab.title();
    expect(dom.document.activeElement).toBe(title);
    expect(landed).toBe(1);
    await act(async () => release());
    await settle();
    expect(tab.text()).toContain('FI number');
    expect(tab.title()).toBe(title);
    expect(dom.document.activeElement).toBe(title);
    await tab.unmount();
  });

  test('a Scenarios sheet opened while the plan loads lists nothing, says why, and is still open, listing them, once it has loaded', async () => {
    let release!: () => void;
    serve({ plan: new Promise((r) => (release = () => r({ plan: PLAN, currency: 'USD' }))), scenarios: [RETIRE] });
    const tab = await mount();
    await press(tab.scenarios());
    const sheet = tab.dialog();
    expect(sheet?.getAttribute('aria-label')).toBe('Scenarios');
    expect(sheet?.textContent).toContain('Your plan is still loading: scenarios open, and are compared, once it has.');
    expect(tab.inSheet('Open Retire at 50')).toBeNull();
    await act(async () => release());
    await settle();
    expect(tab.dialog()).toBe(sheet!);
    expect(tab.inSheet('Open Retire at 50')?.disabled).toBe(false);
    await tab.unmount();
  });
});

describe('the segments', () => {
  test('each tab controls its own panel, labelled by it; one tab stop, and the arrow keys, Home and End choose as they go', async () => {
    serve();
    const tab = await mount();
    expect(tab.selected()).toEqual(['Your path']);
    for (const label of ['Your path', 'Stress test', 'Portfolio']) {
      expect(tab.tab(label).getAttribute('aria-controls')).toBe(tab.panelOf(label).getAttribute('id'));
      expect(tab.panelOf(label).getAttribute('aria-labelledby')).toBe(tab.tab(label).getAttribute('id'));
    }
    expect(tab.tabs().map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    const list = tab.bar().findAll((e) => e.getAttribute('role') === 'tablist')[0];
    expect(list.getAttribute('aria-label')).toBe('Plan');
    key(list, 'ArrowRight');
    expect(tab.selected()).toEqual(['Stress test']);
    expect(dom.document.activeElement).toBe(tab.tab('Stress test'));
    key(list, 'End');
    expect(tab.selected()).toEqual(['Portfolio']);
    key(list, 'ArrowRight');
    expect(tab.selected()).toEqual(['Your path']);
    key(list, 'ArrowLeft');
    expect(tab.selected()).toEqual(['Portfolio']);
    key(list, 'Home');
    expect(tab.selected()).toEqual(['Your path']);
    expect(tab.tabs().map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    await tab.unmount();
  });

  test('each card is in its segment’s panel, all three mounted, the others hidden', async () => {
    serve();
    const tab = await mount();
    expect(tab.shown()).toEqual(['Your path']);
    expect(tab.titles(tab.panelOf('Your path'))).toEqual(['Financial independence', 'Your figures', 'What if…', 'Income and one-off expenses', 'Progress']);
    const stress = tab.titles(tab.panelOf('Stress test'));
    expect(stress).toEqual(['Will it last?', 'By withdrawal rate and length']);
    // Then its settings and About these numbers, as rows (rollout 6d).
    expect(stressRows(tab)).toEqual(['Assumptions', 'About these numbers']);
    expect(tab.titles(tab.panelOf('Portfolio'))[0]).toBe('Allocation');
    for (const label of ['Stress test', 'Portfolio']) expect(tab.panelOf(label).hasAttribute('hidden')).toBe(true);
    await act(async () => click(tab.tab('Stress test')));
    expect(tab.shown()).toEqual(['Stress test']);
    expect(tab.panelOf('Your path').hasAttribute('hidden')).toBe(true);
    // The bar comes before the panels.
    expect(tab.order(tab.bar())).toBeLessThan(Math.min(...tab.panels().map(tab.order)));
    await tab.unmount();
  });

  test('kept by the dashboard: shown as it says, and a choice handed to it', async () => {
    serve();
    const chosen: PlanSegment[] = [];
    const tab = await mount({ segment: 'stress', onSegment: (s) => chosen.push(s) });
    expect(tab.selected()).toEqual(['Stress test']);
    expect(tab.shown()).toEqual(['Stress test']);
    await act(async () => click(tab.tab('Portfolio')));
    expect(chosen).toEqual(['portfolio']);
    // Still what the dashboard says, until it says otherwise.
    expect(tab.selected()).toEqual(['Stress test']);
    await tab.rerender({ segment: 'portfolio', onSegment: (s) => chosen.push(s) });
    expect(tab.shown()).toEqual(['Portfolio']);
    await tab.unmount();
  });
});

describe('Scenarios, from the bar and from the card', () => {
  test('"Scenarios (N)" counts them once listed, and says no number while none is known', async () => {
    serve({ scenarios: [RETIRE, SABBATICAL] });
    const two = await mount();
    expect(two.scenarios()?.textContent).toBe('Scenarios (2)');
    expect(two.scenarios()?.getAttribute('class')).toBe('btn ghost');
    expect(two.scenarios()?.getAttribute('aria-haspopup')).toBe('dialog');
    await two.unmount();
    serve({ scenarios: [] });
    const none = await mount();
    expect(none.scenarios()?.textContent).toBe('Scenarios');
    await none.unmount();
    serve({ scenarios: null });
    const failed = await mount();
    expect(failed.scenarios()?.textContent).toBe('Scenarios');
    await press(failed.scenarios());
    expect(failed.dialog()?.textContent).toContain('Your saved scenarios couldn’t be loaded.');
    await failed.unmount();
  });

  test('the sheet holds the list; New scenario is its second level, and back; a rename saved goes back to the list', async () => {
    const calls = serve({ scenarios: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await press(tab.scenarios());
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Scenarios');
    expect(tab.inSheet('Open Retire at 50')).not.toBeNull();
    expect(tab.inSheet('Open Sabbatical 2029')).not.toBeNull();
    await press(tab.inSheet('New scenario'));
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('New scenario');
    await press(tab.inSheet('Back'));
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Scenarios');
    await press(tab.inSheet('Rename Retire at 50'));
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Rename');
    await act(async () => type(tab.dialog()!.findAll((e) => e.tagName === 'INPUT')[0], 'Retire at 52'));
    await press(tab.inSheet('Save'));
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.scenario.name)).toEqual(['Retire at 52']);
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Scenarios');
    expect(tab.inSheet('Open Retire at 52')).not.toBeNull();
    // Nothing opened by it: your plan is still the one shown.
    expect(tab.title().textContent).toBe('Your plan');
    await tab.unmount();
  });

  test('Open closes the sheet with the scenario shown, on the segment chosen: the heading names it and has focus, and its card is above the panels', async () => {
    serve({ scenarios: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await act(async () => click(tab.tab('Stress test')));
    const title = tab.title();
    await openFromBar(tab, 'Retire at 50');
    expect(tab.dialog()).toBeNull();
    expect(tab.title()).toBe(title);
    expect(title.textContent).toBe('Scenario: Retire at 50');
    expect(dom.document.activeElement).toBe(title);
    expect(tab.selected()).toEqual(['Stress test']);
    // The bar has its arrow back, and no Scenarios of its own: the card has it.
    expect(tab.arrow()).not.toBeNull();
    expect(tab.scenarios()).toBeNull();
    const card = tab.card()!;
    expect(card.textContent).toContain('Everything below is this scenario');
    expect(tab.cardScenarios()?.textContent).toBe('Scenarios (2)');
    expect(tab.cardScenarios()?.getAttribute('class')).toBe('btn secondary');
    // Under the bar, above every panel, in none of them.
    expect(tab.order(card)).toBeGreaterThan(tab.order(tab.bar()));
    expect(tab.order(card)).toBeLessThan(Math.min(...tab.panels().map(tab.order)));
    for (const p of tab.panels()) expect(p.findAll((e) => e === card).length).toBe(0);
    await tab.unmount();
  });

  test('inside a scenario the card’s Scenarios opens the sheet: another opened there takes the heading, and the open one’s row leads back to your plan, to the bar’s Scenarios', async () => {
    serve({ scenarios: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    await press(tab.cardScenarios());
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Scenarios');
    await press(tab.inSheet('Open Sabbatical 2029'));
    expect(tab.dialog()).toBeNull();
    expect(tab.title().textContent).toBe('Scenario: Sabbatical 2029');
    expect(dom.document.activeElement).toBe(tab.title());
    await press(tab.cardScenarios());
    // The open one's row: "Back to your plan".
    await press(tab.inSheet('Back to your plan'));
    expect(tab.dialog()).toBeNull();
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.card()).toBeNull();
    expect(dom.document.activeElement).toBe(tab.scenarios()!);
    await tab.unmount();
  });

  test('the bar’s arrow back to your plan does the same: "Your plan", and focus on the bar’s Scenarios', async () => {
    serve({ scenarios: [RETIRE] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    expect(tab.arrow()?.getAttribute('class')).toBe('secondary icon-btn');
    await press(tab.arrow());
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.arrow()).toBeNull();
    expect(tab.card()).toBeNull();
    expect(dom.document.activeElement).toBe(tab.scenarios()!);
    await tab.unmount();
  });

  test('the open scenario deleted in the sheet: the sheet stays on its list, and closed, gives focus to the bar’s Scenarios, the card’s having gone', async () => {
    const calls = serve({ scenarios: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    await press(tab.cardScenarios());
    await press(tab.inSheet('Delete Retire at 50'));
    const confirm = tab.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Delete' && has(e, 'danger'))[0];
    await press(confirm);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.body.id)).toEqual(['a']);
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Scenarios');
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.card()).toBeNull();
    // Closing it moved nothing out of the sheet meanwhile.
    expect(tab.dialog()!.findAll((e) => e === dom.document.activeElement).length).toBe(1);
    await press(tab.inSheet('Close'));
    expect(tab.dialog()).toBeNull();
    expect(dom.document.activeElement).toBe(tab.scenarios()!);
    expect(tab.scenarios()?.textContent).toBe('Scenarios (1)');
    await tab.unmount();
  });
});

describe('what the tab does by itself', () => {
  test('after a reload of the scenarios fails, no count is said, on the card or the bar, and the sheet shows only why', async () => {
    let loads = 0;
    serve({
      scenarios: [RETIRE, SABBATICAL],
      answers: {
        'GET /api/plan-scenarios': () => (loads++ === 0 ? undefined : [500, { error: 'Your saved scenarios couldn’t be loaded.' }]),
        // A save refused: the list is loaded again, and that fails.
        'PUT /api/plan-scenarios': () => [500, { error: 'It wasn’t saved. Try again in a moment.' }],
      },
    });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    expect(tab.cardScenarios()?.textContent).toBe('Scenarios (2)');
    await press(tab.card()!.findAll((e) => e.getAttribute('aria-label') === 'Use your plan’s stop age')[0]);
    expect(loads).toBe(2);
    // The scenario stays open on the list the client kept, its count unsaid.
    expect(tab.title().textContent).toBe('Scenario: Retire at 50');
    expect(tab.cardScenarios()?.textContent).toBe('Scenarios');
    await press(tab.cardScenarios());
    expect(tab.dialog()?.textContent).toContain('Your saved scenarios couldn’t be loaded.');
    expect(tab.inSheet('Open Sabbatical 2029')).toBeNull();
    expect(tab.inSheet('Back to your plan')).toBeNull();
    await press(tab.inSheet('Close'));
    await press(tab.arrow());
    expect(tab.scenarios()?.textContent).toBe('Scenarios');
    await tab.unmount();
  });

  test('a scenario deleted elsewhere closes, and focus stays where it was', async () => {
    let gone = false;
    serve({
      scenarios: [RETIRE],
      answers: {
        'GET /api/plan-scenarios': () => (gone ? [200, { scenarios: [], unreadable_ids: [], unrecognised_ids: [] }] : undefined),
        'PUT /api/plan-scenarios': () => {
          gone = true;
          return [404, { error: 'That scenario isn’t there any more: it was deleted.' }];
        },
      },
    });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    const pressed = tab.card()!.findAll((e) => e.getAttribute('aria-label') === 'Use your plan’s stop age')[0];
    await press(pressed);
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.card()).toBeNull();
    expect(dom.document.activeElement).toBe(pressed);
    await tab.unmount();
  });

  test('a scenario closed while a repair of the Plan waits: focus stays where it was, and the sheet says why none opens', async () => {
    let plans = 0;
    let refuse!: () => void;
    serve({
      scenarios: [RETIRE],
      answers: {
        // Read again after the save below is refused: a value this version
        // can't use, so a repair waits.
        'GET /api/fire-plan': () => (plans++ === 0 ? undefined : [200, { plan: { ...PLAN, withdrawalRate: 0.5 }, currency: 'USD' }]),
        'PUT /api/fire-plan': () => new Promise((r) => (refuse = () => r([409, { error: 'Your plan was changed on another device.' }]))),
      },
    });
    const tab = await mount();
    // A save of the Plan under way, and a scenario opened meanwhile.
    await press(tab.row('Ages'));
    const form = tab.sheet('Your ages')!;
    await act(async () => type(form.findAll((e) => e.tagName === 'INPUT')[1], '58'));
    await press(form.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0]);
    await press(tab.scenarios());
    await press(tab.sheet('Scenarios')!.findAll((e) => e.getAttribute('aria-label') === 'Open Retire at 50')[0]);
    expect(tab.title().textContent).toBe('Scenario: Retire at 50');
    const portfolio = tab.tab('Portfolio');
    portfolio.focus();
    await act(async () => refuse());
    await settle(100);
    expect(tab.text()).toContain('Save it this way');
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.card()).toBeNull();
    expect(dom.document.activeElement).toBe(portfolio);
    await press(tab.scenarios());
    expect(tab.dialog()?.textContent).toContain('Your saved plan has values to fix first (at the top of the Plan tab): scenarios open once it is saved.');
    await tab.unmount();
  });
});

describe('the scenario’s card, on every segment', () => {
  test('one that isn’t worked out says why above the panels, whatever segment is chosen, and the panels draw nothing for it', async () => {
    serve({ scenarios: [TOO_SOON] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 30');
    const card = tab.card()!;
    expect(card.textContent).toContain('It stops working at 30, before your age now (40).');
    // Its life event is on no card: the line says where neither is.
    expect(card.textContent).toContain('1 life event.');
    expect(card.textContent).not.toContain('1 life event, below.');
    expect(card.textContent).not.toContain('1 life event, on Your path.');
    for (const label of ['Your path', 'Stress test', 'Portfolio']) {
      await act(async () => click(tab.tab(label)));
      expect(tab.card()).toBe(card);
      expect(tab.order(card)).toBeLessThan(tab.order(tab.panelOf(label)));
    }
    // Only the Progress card, which is about the plan saved as your plan, never the scenario.
    expect(tab.titles(tab.panelOf('Your path'))).toEqual(['Progress']);
    expect(tab.titles(tab.panelOf('Stress test'))).toEqual([]);
    expect(stressRows(tab)).toEqual(['Assumptions', 'About these numbers']);
    expect(tab.titles(tab.panelOf('Portfolio'))).toEqual([]);
    // No life events card to point to.
    expect(tab.text()).not.toContain('Life events');
    await tab.unmount();
  });

  test('one refused for lasting changes below zero has its life events with it, above the panels, to change', async () => {
    serve({ scenarios: [BELOW_ZERO] });
    const tab = await mount();
    await openFromBar(tab, 'Mortgage gone');
    const slot = tab.card()!.parentNode as FakeElement;
    expect(slot.textContent).toContain('Its lasting changes in spending take your spending in retirement below zero');
    expect(tab.card()!.textContent).toContain('1 life event, below.');
    const edit = slot.findAll((e) => e.getAttribute('aria-label') === 'Edit Mortgage paid off');
    expect(edit.length).toBe(1);
    for (const p of tab.panels()) expect(p.textContent).not.toContain('Life events');
    expect(tab.text()).not.toContain('Will it last?');
    await tab.unmount();
  });

  test('one worked out with life events: they are on Your path, and the card says so', async () => {
    serve({ scenarios: [GYM] });
    const tab = await mount();
    await openFromBar(tab, 'Gym');
    expect(tab.card()!.textContent).toContain('1 life event, on Your path.');
    expect(tab.titles(tab.panelOf('Your path'))).toEqual(['Financial independence', 'Your figures', 'Income and one-off expenses', 'Life events', 'Progress']);
    expect(tab.panelOf('Stress test').textContent).toContain('as the Life events card on Your path says');
    await tab.unmount();
  });
});

describe('where a switch scrolls to, under the pinned bar', () => {
  test('a segment chosen while the bar is pinned opens at its top; one chosen with its top in view stays where it is', async () => {
    serve();
    const tab = await mount();
    layout({ panel: 160 });
    await act(async () => click(tab.tab('Stress test')));
    expect(scrolls).toEqual([]);
    layout({ panel: -900 });
    await act(async () => click(tab.tab('Portfolio')));
    // Its top, at -900, to one --sp-2 (8px) under the bar's bottom, at 120.
    expect(scrolls).toEqual([-1028]);
    // Chosen again: nothing to switch to.
    await act(async () => click(tab.tab('Portfolio')));
    expect(scrolls).toEqual([-1028]);
    await tab.unmount();
  });

  test('a scenario opened lands on its card; a switch then lands on the panel, unless the card says why it isn’t worked out', async () => {
    serve({ scenarios: [RETIRE, TOO_SOON] });
    const tab = await mount();
    layout({ card: -500, panel: -900 });
    await openFromBar(tab, 'Retire at 50');
    expect(scrolls).toEqual([-628]);
    await act(async () => click(tab.tab('Stress test')));
    expect(scrolls).toEqual([-628, -1028]);
    await press(tab.cardScenarios());
    await press(tab.inSheet('Open Retire at 30'));
    expect(scrolls).toEqual([-628, -1028, -628]);
    // What it says isn't scrolled past.
    await act(async () => click(tab.tab('Your path')));
    expect(scrolls).toEqual([-628, -1028, -628, -628]);
    await tab.unmount();
  });

  test('nor is its amounts typed in another currency than the Plan’s', async () => {
    serve({ scenarios: [IN_EUROS] });
    const tab = await mount();
    await openFromBar(tab, 'In euros');
    expect(tab.card()!.textContent).toContain('Its amounts were typed in EUR, and your plan is now in USD.');
    layout({ card: -500, panel: -900 });
    await act(async () => click(tab.tab('Portfolio')));
    expect(scrolls).toEqual([-628]);
    await tab.unmount();
  });

  test('nor a save’s notice, left with no form to say it in', async () => {
    const newer = { ...RETIRE, rev: 'r2', set: { targetAge: 50, withdrawalRate: 0.035 } };
    const stale = 'This scenario was changed on another device: here it is as it is now.';
    serve({ scenarios: [RETIRE], answers: { 'PUT /api/plan-scenarios': () => [409, { error: stale, stale: true, scenario: newer }] } });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    await press(tab.card()!.findAll((e) => e.getAttribute('aria-label') === 'Use your plan’s stop age')[0]);
    // Worked out still, its notice on the card.
    expect(tab.card()!.textContent).toContain(stale);
    expect(tab.titles(tab.panelOf('Stress test'))[0]).toBe('Will it last?');
    layout({ card: -500, panel: -900 });
    await act(async () => click(tab.tab('Stress test')));
    expect(scrolls).toEqual([-628]);
    await tab.unmount();
  });
});

describe('a click between a commit in the background and its effects', () => {
  // The tab draws again whenever an answer comes back (a simulation's, the
  // grid's, Compare's), and React runs that commit's effects in a task of its
  // own. A click in between has them run first, before its own render: what
  // that click asks to focus must wait for the commit that draws it.
  test('the bar’s arrow: focus on the bar’s Scenarios, drawn once the scenario is left', async () => {
    serve({ scenarios: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    const arrow = tab.arrow()!;
    arrow.focus();
    await tab.inTheGap({ balancesSaved: true }, () => click(arrow));
    expect(tab.title().textContent).toBe('Your plan');
    expect(dom.document.activeElement).toBe(tab.scenarios()!);
    await tab.unmount();
  });

  test('another scenario opened from the card’s sheet: focus on the heading, and the card scrolled to', async () => {
    serve({ scenarios: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    await press(tab.cardScenarios());
    layout({ card: -500, panel: -900 });
    const open = tab.inSheet('Open Sabbatical 2029')!;
    open.focus();
    await tab.inTheGap({ balancesFailed: true }, () => click(open));
    expect(tab.title().textContent).toBe('Scenario: Sabbatical 2029');
    expect(dom.document.activeElement).toBe(tab.title());
    expect(scrolls).toEqual([-628]);
    await tab.unmount();
  });

  test('one opened from the bar’s sheet: the card scrolled to', async () => {
    serve({ scenarios: [RETIRE] });
    const tab = await mount();
    await press(tab.scenarios());
    layout({ card: -500, panel: -900 });
    const open = tab.inSheet('Open Retire at 50')!;
    open.focus();
    await tab.inTheGap({ balancesSaved: true }, () => click(open));
    expect(tab.title().textContent).toBe('Scenario: Retire at 50');
    expect(dom.document.activeElement).toBe(tab.title());
    expect(scrolls).toEqual([-628]);
    await tab.unmount();
  });
});

describe('Home’s FI line landing on the heading', () => {
  test('a landing just made focuses the heading and is said to be done; one older than ten seconds, or none, does nothing', async () => {
    serve();
    let landed = 0;
    const fresh = await mount({ landing: Date.now(), onLanded: () => landed++ });
    expect(dom.document.activeElement).toBe(fresh.title());
    expect(landed).toBe(1);
    await fresh.unmount();
    dom.document.activeElement = dom.document.body;
    const old = await mount({ landing: Date.now() - 11_000, onLanded: () => landed++ });
    expect(dom.document.activeElement).toBe(dom.document.body);
    expect(landed).toBe(1);
    await old.unmount();
    const none = await mount({ landing: null, onLanded: () => landed++ });
    expect(dom.document.activeElement).toBe(dom.document.body);
    expect(landed).toBe(1);
    await none.unmount();
  });
});

describe('the bar by itself', () => {
  test('with a scenario open: the arrow back, then "Scenario: " and its whole name as the heading, and no Scenarios button', async () => {
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    let back = 0;
    const name = 'Retire at 45 and travel for a year first';
    await act(async () =>
      root.render(<PlanBar segment="path" onSegment={() => {}} scenario={name} scenariosCount={3} onScenarios={() => {}} onBack={() => back++} />)
    );
    const heading = container.findAll((e) => e.tagName === 'H2')[0];
    expect(outline(heading)).toBe(`<h2>Scenario: ${name}</h2>`);
    expect([heading.getAttribute('id'), heading.getAttribute('tabindex'), heading.getAttribute('class')]).toEqual([PLAN_TITLE, '-1', 'plan-title']);
    const buttons = container.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('role') !== 'tab');
    expect(buttons.map(outline)).toEqual(['<button aria-label="Back to your plan"></button>']);
    await act(async () => click(buttons[0]));
    expect(back).toBe(1);
    await act(async () => root.unmount());
  });
});
