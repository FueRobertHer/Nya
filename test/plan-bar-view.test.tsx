import { afterAll, afterEach, describe, expect, jest, test } from 'bun:test';
import { installDom, trackRoots, click, type, outline, fakeClock, FakeElement, FakeEvent } from './mini-dom';
import { simulateOnPage } from './plan-on-page';

// The Plan tab's pinned bar and segments (rollout phase 6b,
// docs/design/information-architecture.md#plan), used as a person would
// (react-dom/client over test/mini-dom.ts): "Your plan" or the copy open as
// its heading, over Your path, Drawdown and Portfolio, each its own panel and
// all three mounted; the bar there before the plan has loaded, and the same
// bar, heading and Plans sheet once it has; the Plans sheet from the bar and
// from the open copy's card, and where focus goes as a copy opens and is
// left; the copy's card above the panels, saying why one isn't worked out
// whatever segment is chosen; where a switch scrolls to, one --sp-2 under the
// bar; focus where it belongs when the click comes between a commit in the
// background and its effects; what the tab closes by itself, moving no
// focus; and Home's FI line landing on the heading. The sheet's own levels
// are test/plans-sheet-view.test.tsx's; the dashboard's side of the landing
// is test/plan-landing-source.test.ts's. Every request is answered here, by
// path; nothing reaches a network.
//
// A rendered element never goes into toEqual or another matcher that diffs
// (test/plan-tab-copies.test.tsx says why): elements are compared with
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
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: PlanTab } = await import('@/components/PlanTab');
const { default: PlanBar, PLAN_TITLE, openingSegment } = await import('@/components/PlanBar');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { itemFromEvent } = await import('@/lib/fire/items');
const { plansListing, copyRow } = await import('./plans-listing');
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type PlanSegment = import('@/components/PlanBar').PlanSegment;
type Row = import('./plans-listing').Row;

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
const RETIRE = copyRow(PLAN, 'a', 'Retire at 50', { targetAge: 50 }, 'USD', 1);
const SABBATICAL = copyRow(PLAN, 'b', 'Sabbatical 2029', { spending: 30_000 }, 'USD', 2);
// Its stop before your age now: a value that doesn't fit your plan as it is
// now, so it is shown repaired, and its card says what to save.
const TOO_SOON = copyRow(PLAN, 'c', 'Retire at 30', { targetAge: 30 }, 'USD', 3);
// Its amounts typed in euros, your plan's figures recorded in dollars: not
// worked out, so its life event is on no card.
const IN_EUROS = copyRow(PLAN, 'f', 'In euros', { spending: 45_000, items: [itemFromEvent({ id: 'w', kind: 'spending', label: 'Wedding', fromAge: 42, yearly: 20_000, years: 1 })] }, 'EUR', 4);
// Lasting changes that take spending in retirement below zero: refused.
const BELOW_ZERO = copyRow(PLAN, 'd', 'Mortgage gone', { items: [itemFromEvent({ id: 'x', kind: 'spending', label: 'Mortgage paid off', fromAge: 41, yearly: -45_000, years: null })] }, 'USD', 5);
const GYM = copyRow(PLAN, 'e', 'Gym', { items: [itemFromEvent({ id: 'g', kind: 'spending', label: 'Gym', fromAge: 41, yearly: 1_000, years: 5 })] }, 'USD', 6);

type Call = { method: string; url: string; body: any };

type Answer = (call: Call) => [number, unknown] | undefined | Promise<[number, unknown] | undefined>;

/** The routes the tab calls, answered as the real ones would: the plan
 *  (`plan`, or a promise of it, to hold its load open; else the one that is
 *  yours now), and your plans (yours, "First plan", then `copies`, or null
 *  for a list that can't be loaded), kept here as they are changed; `answers`, by "METHOD /path", go first where they
 *  give one. Every call is recorded. */
function serve({ plan = undefined as unknown, copies = [] as Row[] | null, answers = {} as Record<string, Answer> } = {}) {
  let rows = (plansListing(PLAN, copies ?? [])[1] as { plans: Row[] }).plans;
  let main = 'main';
  let made = 0;
  let stamps = 0;
  const stamp = () => `2026-11-01T00:00:${String(++stamps).padStart(2, '0')}.000Z`;
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const call = { method, url, body };
    calls.push(call);
    const answer = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const given = await answers[`${method} ${url}`]?.(call);
    if (given) return answer(given[1], given[0]);
    if (url === '/api/plan-inputs' && method === 'GET') return answer(plan !== undefined ? await plan : { plan: rows.find((r) => r.id === main)!.plan, currency: 'USD' });
    if (url === '/api/plans') {
      if (copies === null) return answer({ error: 'Your plans couldn’t be loaded.' }, 500);
      if (method === 'POST') {
        const at = stamp();
        const row: Row = { id: `new${++made}`, name: body.name, plan: body.plan, currency: body.currency, created_at: at, updated_at: at };
        rows = [...rows, row];
        return answer({ plan: row });
      }
      if (method === 'PUT') {
        const saved: Row[] = body.saves.map((x: { id: string; plan: Row['plan']; currency: string | null }) => ({ ...rows.find((r) => r.id === x.id)!, plan: x.plan, currency: x.currency, updated_at: stamp() }));
        rows = rows.map((r) => saved.find((x) => x.id === r.id) ?? r);
        return answer({ plans: saved, main: null });
      }
      if (method === 'PATCH' && 'main' in body) {
        main = body.main;
        const row = rows.find((r) => r.id === main)!;
        return answer({ id: row.id, plan: row.plan, currency: row.currency, updated_at: row.updated_at });
      }
      if (method === 'PATCH') {
        const row = { ...rows.find((r) => r.id === body.id)!, ...('name' in body ? { name: body.name } : { currency: body.currency }), updated_at: stamp() };
        rows = rows.map((r) => (r.id === row.id ? row : r));
        return answer({ plan: row });
      }
      if (method === 'DELETE') {
        rows = rows.filter((r) => r.id !== body.id);
        return answer({ ok: true });
      }
      return answer({ main, missing: false, plans: rows, unreadable_ids: [], unrecognised_ids: [] });
    }
    if (url === '/api/allocation-settings') return answer({ settings: null });
    return answer({ error: 'not here' }, 404);
  };
  return calls;
}

/** A sheet slides in a frame after it mounts, and a request is answered. */
const pass = fakeClock();
const realWorkers = simulateOnPage();
const settle = (ms = 30) => pass(ms);

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

/** Drawdown's rows, by their titles (rollout 6d). */
const drawdownRows = (tab: { panelOf: (label: string) => FakeElement }) =>
  tab.panelOf('Drawdown').findAll((e) => has(e, 'list-row-title')).map((e) => e.textContent);

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
  const card = () => find((e) => has(e, 'plan-copy-card'))[0] ?? null;
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
      // React's own scheduling, stepped by hand, on real timers: on the fake
      // clock the effects aren't left waiting after the commit.
      jest.useRealTimers();
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
        jest.useFakeTimers();
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
    /** The bar's Plans button, drawn on your plan. */
    plans: () => bar().findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Plans'))[0] ?? null,
    arrow: () => bar().findAll((e) => e.getAttribute('aria-label') === 'Back to your plan')[0] ?? null,
    card,
    /** The card's Plans button, at its foot. */
    cardPlans: () => card()?.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Plans'))[0] ?? null,
    /** A button on the card, by its words. */
    onCard: (words: string) => card()?.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null,
    dialog,
    /** The open sheet with this title. */
    sheet: (title: string) => find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true' && e.getAttribute('aria-label') === title)[0] ?? null,
    /** A control in the open sheet, by its name. */
    inSheet: (label: string) => dialog()?.findAll((e) => e.getAttribute('aria-label') === label || (e.tagName === 'BUTTON' && e.textContent.trim() === label))[0] ?? null,
    /** A row in an open sheet, by its title: a plan in the Plans sheet's
     *  list, or one of a plan's actions. */
    rowIn: (title: string) =>
      find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')
        .flatMap((d) => d.findAll((e) => e.tagName === 'BUTTON' && has(e, 'list-row') && e.findAll((t) => has(t, 'list-row-title'))[0]?.textContent === title))[0] ?? null,
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

/** Opens a plan from the sheet already open: its row, then Open it in its
 *  level. */
async function openInSheet(tab: Tab, name: string) {
  await press(tab.rowIn(name));
  await press(tab.rowIn('Open it'));
}

/** Opens a copy from the bar's Plans sheet. */
async function openFromBar(tab: Tab, name: string) {
  await press(tab.plans());
  await openInSheet(tab, name);
}

/** Lays the page out: the bar pinned at the top, with `rects` saying where
 *  the copy's card and the panels are. */
function layout(rects: { card?: number; panel?: number }) {
  FakeElement.prototype.getBoundingClientRect = function (this: FakeElement) {
    const at = (top: number, bottom: number) => ({ x: 0, y: top, top, bottom, left: 0, right: 0, width: 0, height: bottom - top });
    if (has(this, 'plan-bar')) return at(0, 120);
    // The card's place: the slot that holds it (and its life events, when refused).
    if (rects.card !== undefined && this.childNodes.some((c) => c instanceof FakeElement && has(c, 'plan-copy-card'))) return at(rects.card, rects.card + 400);
    if (rects.panel !== undefined && this.getAttribute('role') === 'tabpanel') return at(rects.panel, rects.panel + 3000);
    return realRect.call(this);
  };
}

describe('the bar, before and after the plan loads', () => {
  test('before the saved plan has loaded: the bar with "Your plan", three segments, each its skeleton, and no figure', async () => {
    serve({ plan: new Promise(() => {}), copies: [RETIRE] });
    const tab = await mount();
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.title().tagName).toBe('H2');
    // Focusable by script, so Home's FI line and an opened copy land on it.
    expect(tab.title().getAttribute('tabindex')).toBe('-1');
    expect(tab.tabs().map((e) => e.textContent)).toEqual(['Your path', 'Drawdown', 'Portfolio']);
    expect(tab.panels().length).toBe(3);
    for (const p of tab.panels()) {
      expect(p.findAll((e) => e.getAttribute('role') === 'status' && e.textContent === 'Loading your plan').length).toBe(1);
      expect(p.findAll((e) => e.getAttribute('aria-busy') === 'true').length).toBe(1);
    }
    expect(tab.text()).not.toContain('FI number');
    // The sheet can be opened meanwhile: it says why nothing opens yet. Your
    // plan and its copy, counted once listed.
    expect(tab.plans()?.textContent).toBe('Plans (2)');
    await tab.unmount();
  });

  test('landed on while the plan loads, the heading keeps focus as it arrives: the same bar, the same heading', async () => {
    let release!: () => void;
    serve({ plan: new Promise((r) => (release = () => r({ plan: PLAN, currency: 'USD' }))), copies: [RETIRE] });
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

  test('a Plans sheet opened while the plan loads lists nothing, says why, and is still open, listing them, once it has loaded', async () => {
    let release!: () => void;
    serve({ plan: new Promise((r) => (release = () => r({ plan: PLAN, currency: 'USD' }))), copies: [RETIRE] });
    const tab = await mount();
    await press(tab.plans());
    const sheet = tab.dialog();
    expect(sheet?.getAttribute('aria-label')).toBe('Plans');
    expect(sheet?.textContent).toContain('Your plan is still loading: plans open, and are compared, once it has.');
    expect(tab.rowIn('Retire at 50')).toBeNull();
    await act(async () => release());
    await settle();
    expect(tab.dialog()).toBe(sheet!);
    expect(tab.rowIn('Retire at 50')?.disabled).toBe(false);
    await tab.unmount();
  });
});

describe('the segments', () => {
  test('each tab controls its own panel, labelled by it; one tab stop, and the arrow keys, Home and End choose as they go', async () => {
    serve();
    const tab = await mount();
    expect(tab.selected()).toEqual(['Your path']);
    for (const label of ['Your path', 'Drawdown', 'Portfolio']) {
      expect(tab.tab(label).getAttribute('aria-controls')).toBe(tab.panelOf(label).getAttribute('id'));
      expect(tab.panelOf(label).getAttribute('aria-labelledby')).toBe(tab.tab(label).getAttribute('id'));
    }
    expect(tab.tabs().map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    const list = tab.bar().findAll((e) => e.getAttribute('role') === 'tablist')[0];
    expect(list.getAttribute('aria-label')).toBe('Plan');
    key(list, 'ArrowRight');
    expect(tab.selected()).toEqual(['Drawdown']);
    expect(dom.document.activeElement).toBe(tab.tab('Drawdown'));
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
    expect(tab.titles(tab.panelOf('Your path'))).toEqual(['Financial independence', 'Your figures', 'Timeline', 'Progress']);
    const drawdown = tab.titles(tab.panelOf('Drawdown'));
    expect(drawdown).toEqual(['Will it last?', 'By withdrawal rate and length']);
    // Then its settings and About these numbers, as rows (rollout 6d).
    expect(drawdownRows(tab)).toEqual(['Assumptions', 'About these numbers']);
    expect(tab.titles(tab.panelOf('Portfolio'))[0]).toBe('Allocation');
    for (const label of ['Drawdown', 'Portfolio']) expect(tab.panelOf(label).hasAttribute('hidden')).toBe(true);
    await act(async () => click(tab.tab('Drawdown')));
    expect(tab.shown()).toEqual(['Drawdown']);
    expect(tab.panelOf('Your path').hasAttribute('hidden')).toBe(true);
    // The bar comes before the panels.
    expect(tab.order(tab.bar())).toBeLessThan(Math.min(...tab.panels().map(tab.order)));
    await tab.unmount();
  });

  test('kept by the dashboard: shown as it says, and a choice handed to it', async () => {
    serve();
    const chosen: PlanSegment[] = [];
    const tab = await mount({ segment: 'drawdown', onSegment: (s) => chosen.push(s) });
    expect(tab.selected()).toEqual(['Drawdown']);
    expect(tab.shown()).toEqual(['Drawdown']);
    await act(async () => click(tab.tab('Portfolio')));
    expect(chosen).toEqual(['portfolio']);
    // Still what the dashboard says, until it says otherwise.
    expect(tab.selected()).toEqual(['Drawdown']);
    await tab.rerender({ segment: 'portfolio', onSegment: (s) => chosen.push(s) });
    expect(tab.shown()).toEqual(['Portfolio']);
    await tab.unmount();
  });
});

// Where the Plan opens (D2 of the tax plan, T1): on Your path, as every tab
// does, but on Drawdown once the stop age is today or earlier, when "will it
// last?" is the live question. Picked once the plan has loaded, with none
// selected until then, so nothing jumps under the person; then kept, by the
// dashboard as a segment chosen is.
describe('where the Plan opens', () => {
  const STOPPED = { ...PLAN, age: 50, targetAge: 50 };

  test('Drawdown once the stop age is today or earlier, else Your path', () => {
    expect(openingSegment({ age: 50, targetAge: 50 })).toBe('drawdown');
    expect(openingSegment({ age: 51, targetAge: 50 })).toBe('drawdown');
    expect(openingSegment({ age: 40, targetAge: 55 })).toBe('path');
    expect(openingSegment({ age: null, targetAge: 50 })).toBe('path');
    expect(openingSegment({ age: 50, targetAge: null })).toBe('path');
  });

  test('a plan whose stop age has come opens on Drawdown, and hands it to the dashboard to keep', async () => {
    serve({ plan: { plan: STOPPED, currency: 'USD' } });
    const chosen: PlanSegment[] = [];
    const tab = await mount({ onSegment: (s) => chosen.push(s) });
    expect(tab.selected()).toEqual(['Drawdown']);
    expect(tab.shown()).toEqual(['Drawdown']);
    expect(chosen).toEqual(['drawdown']);
    await tab.unmount();
    // Kept by the tab itself, the same.
    serve({ plan: { plan: STOPPED, currency: 'USD' } });
    const own = await mount();
    expect(own.shown()).toEqual(['Drawdown']);
    expect(own.tabs().map((e) => e.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    await own.unmount();
  });

  test('a stop still to come, or no ages, opens on Your path', async () => {
    for (const plan of [PLAN, DEFAULT_PLAN]) {
      serve({ plan: { plan, currency: 'USD' } });
      const chosen: PlanSegment[] = [];
      const tab = await mount({ onSegment: (s) => chosen.push(s) });
      expect(tab.shown()).toEqual(['Your path']);
      expect(chosen).toEqual(['path']);
      await tab.unmount();
    }
  });

  test('before the plan has loaded: no segment selected, the first the tab stop, every panel hidden, and one skeleton in none of them', async () => {
    serve({ plan: new Promise(() => {}) });
    const chosen: PlanSegment[] = [];
    const tab = await mount({ onSegment: (s) => chosen.push(s) });
    expect(tab.selected()).toEqual([]);
    expect(tab.tabs().map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(tab.shown()).toEqual([]);
    // mini-dom draws the hidden panels' skeletons too: the one shown is the
    // one in none of them, with no segment's words.
    const shown = tab.container.findAll((e) => e.getAttribute('aria-busy') === 'true' && !tab.panels().some((p) => p.contains(e)));
    expect(shown.length).toBe(1);
    expect(shown[0].findAll((e) => has(e, 'plan-skeleton-label')).length).toBe(1);
    expect(shown[0].textContent).toBe('Loading your plan');
    // Nothing is handed on until the Plan has decided.
    expect(chosen).toEqual([]);
    // The keys move from the tab stop, the first.
    const list = tab.bar().findAll((e) => e.getAttribute('role') === 'tablist')[0];
    key(list, 'ArrowRight');
    expect(chosen).toEqual(['drawdown']);
    await tab.unmount();
  });

  test('a segment chosen while the plan loads is kept as it arrives, whatever the stop age', async () => {
    let release!: () => void;
    serve({ plan: new Promise((r) => (release = () => r({ plan: STOPPED, currency: 'USD' }))) });
    const tab = await mount();
    await act(async () => click(tab.tab('Your path')));
    expect(tab.selected()).toEqual(['Your path']);
    await act(async () => release());
    await settle();
    expect(tab.text()).toContain('FI number');
    expect(tab.selected()).toEqual(['Your path']);
    expect(tab.shown()).toEqual(['Your path']);
    await tab.unmount();
  });

  test('decided once: a stop age saved as today on Your path doesn’t move the screen', async () => {
    serve({ answers: { 'PUT /api/fire-plan': (c) => [200, { plan: c.body.plan, currency: 'USD' }] } });
    // Handed to a dashboard that doesn't say it back, so the tab's own
    // decision is all that holds Your path.
    const chosen: PlanSegment[] = [];
    const tab = await mount({ onSegment: (s) => chosen.push(s) });
    expect(tab.shown()).toEqual(['Your path']);
    await press(tab.row('Household'));
    const form = tab.sheet('Household')!;
    await act(async () => type(form.findAll((e) => e.tagName === 'INPUT')[1], '40'));
    await press(form.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0]);
    await settle(100);
    expect(tab.text()).toContain('stop at 40');
    expect(tab.shown()).toEqual(['Your path']);
    expect(chosen).toEqual(['path']);
    await tab.unmount();
  });

  test('the dashboard’s segment wins over the rule', async () => {
    serve({ plan: { plan: STOPPED, currency: 'USD' } });
    const chosen: PlanSegment[] = [];
    const tab = await mount({ segment: 'portfolio', onSegment: (s) => chosen.push(s) });
    expect(tab.shown()).toEqual(['Portfolio']);
    expect(chosen).toEqual([]);
    await tab.unmount();
  });

  test('a load that fails shows Your path over the defaults, decides nothing, and Try again opens where the plan says', async () => {
    let gets = 0;
    serve({ plan: { plan: STOPPED, currency: 'USD' }, answers: { 'GET /api/plan-inputs': () => (++gets === 1 ? [500, { error: 'no' }] : undefined) } });
    const chosen: PlanSegment[] = [];
    const tab = await mount({ onSegment: (s) => chosen.push(s) });
    expect(tab.shown()).toEqual(['Your path']);
    expect(tab.selected()).toEqual(['Your path']);
    expect(chosen).toEqual([]);
    await press(tab.container.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Try again')[0]);
    await settle(100);
    expect(tab.shown()).toEqual(['Drawdown']);
    expect(chosen).toEqual(['drawdown']);
    await tab.unmount();
  });

  test('nothing on screen says "stress test" any more: the three segments, and the sheets that point there', async () => {
    /** What a person reads or hears of an element: its text and every label. */
    const said = (el: FakeElement) => [el.textContent, ...el.findAll((e) => e.hasAttribute('aria-label')).map((e) => e.getAttribute('aria-label'))].join(' ');
    for (const row of ['Assumptions', 'Household']) {
      serve({ copies: [RETIRE] });
      const tab = await mount();
      expect(said(tab.container)).not.toMatch(/stress/i);
      await press(tab.row(row));
      expect(tab.dialog()).not.toBeNull();
      expect(said(tab.dialog()!)).not.toMatch(/stress/i);
      await tab.unmount();
    }
  });
});

describe('Plans, from the bar and from the card', () => {
  test('"Plans (N)" counts every plan, yours included, from two, and says no number while none is known', async () => {
    serve({ copies: [RETIRE, SABBATICAL] });
    const three = await mount();
    expect(three.plans()?.textContent).toBe('Plans (3)');
    expect(three.plans()?.getAttribute('class')).toBe('btn ghost');
    expect(three.plans()?.getAttribute('aria-haspopup')).toBe('dialog');
    await three.unmount();
    serve({ copies: [] });
    const one = await mount();
    expect(one.plans()?.textContent).toBe('Plans');
    await one.unmount();
    serve({ copies: null });
    const failed = await mount();
    expect(failed.plans()?.textContent).toBe('Plans');
    await press(failed.plans());
    expect(failed.dialog()?.textContent).toContain('Your plans couldn’t be loaded.');
    await failed.unmount();
  });

  test('the sheet holds the list, yours first; a row opens its plan’s level, New copy is a level of its own, and back; a rename saved goes back to the plan’s level', async () => {
    const calls = serve({ copies: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await press(tab.plans());
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Plans');
    expect(tab.dialog()!.findAll((e) => has(e, 'list-row-title')).map((e) => e.textContent)).toEqual(['First plan', 'Retire at 50', 'Sabbatical 2029']);
    expect(tab.rowIn('First plan')!.findAll((e) => has(e, 'badge')).map((e) => e.textContent)).toEqual(['Your plan']);
    await press(tab.inSheet('New copy'));
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('New copy');
    await press(tab.inSheet('Back'));
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Plans');
    await press(tab.rowIn('Retire at 50'));
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Retire at 50');
    await press(tab.rowIn('Rename'));
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Rename');
    await act(async () => type(tab.dialog()!.findAll((e) => e.tagName === 'INPUT')[0], 'Retire at 52'));
    await press(tab.inSheet('Save'));
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ id: 'a', name: 'Retire at 52', based_on: RETIRE.updated_at }]);
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Retire at 52');
    await press(tab.inSheet('Back'));
    expect(tab.rowIn('Retire at 52')).not.toBeNull();
    // Nothing opened by it: your plan is still the one shown.
    expect(tab.title().textContent).toBe('Your plan');
    await tab.unmount();
  });

  test('Open it closes the sheet with the copy shown, on the segment chosen: the heading names it and has focus, and its card is above the panels', async () => {
    serve({ copies: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await act(async () => click(tab.tab('Drawdown')));
    const title = tab.title();
    await openFromBar(tab, 'Retire at 50');
    expect(tab.dialog()).toBeNull();
    expect(tab.title()).toBe(title);
    expect(title.textContent).toBe('Copy: Retire at 50');
    expect(dom.document.activeElement).toBe(title);
    expect(tab.selected()).toEqual(['Drawdown']);
    // The bar has its arrow back, and no Plans of its own: the card has it.
    expect(tab.arrow()).not.toBeNull();
    expect(tab.plans()).toBeNull();
    const card = tab.card()!;
    // How it differs from your plan, then Make this your plan and Plans.
    expect(card.textContent).toContain('Stop age: 50 (your plan: 55).');
    expect(tab.cardPlans()?.textContent).toBe('Plans (3)');
    expect(tab.cardPlans()?.getAttribute('class')).toBe('btn ghost');
    expect(tab.onCard('Make this your plan')?.getAttribute('class')).toBe('btn ghost');
    // Under the bar, above every panel, in none of them.
    expect(tab.order(card)).toBeGreaterThan(tab.order(tab.bar()));
    expect(tab.order(card)).toBeLessThan(Math.min(...tab.panels().map(tab.order)));
    for (const p of tab.panels()) expect(p.findAll((e) => e === card).length).toBe(0);
    await tab.unmount();
  });

  test('inside a copy the card’s Plans opens the sheet: another opened there takes the heading, and your plan’s Open it leads back to it, to the bar’s Plans', async () => {
    serve({ copies: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    await press(tab.cardPlans());
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Plans');
    await openInSheet(tab, 'Sabbatical 2029');
    expect(tab.dialog()).toBeNull();
    expect(tab.title().textContent).toBe('Copy: Sabbatical 2029');
    expect(dom.document.activeElement).toBe(tab.title());
    await press(tab.cardPlans());
    // Your plan's row, then Open it.
    await openInSheet(tab, 'First plan');
    expect(tab.dialog()).toBeNull();
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.card()).toBeNull();
    expect(dom.document.activeElement).toBe(tab.plans()!);
    await tab.unmount();
  });

  test('the bar’s arrow back to your plan does the same: "Your plan", and focus on the bar’s Plans', async () => {
    serve({ copies: [RETIRE] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    expect(tab.arrow()?.getAttribute('class')).toBe('icon-btn');
    await press(tab.arrow());
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.arrow()).toBeNull();
    expect(tab.card()).toBeNull();
    expect(dom.document.activeElement).toBe(tab.plans()!);
    await tab.unmount();
  });

  test('the open copy deleted in the sheet, after its level asks: the sheet goes back to its list, and closed, gives focus to the bar’s Plans, the card’s having gone', async () => {
    const calls = serve({ copies: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    await press(tab.cardPlans());
    await press(tab.rowIn('Retire at 50'));
    // The destructive row, last.
    const del = tab.rowIn('Delete')!;
    expect(has(del, 'neg')).toBe(true);
    await press(del);
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Delete');
    expect(tab.dialog()?.textContent).toContain('Delete “Retire at 50”? Your plan isn’t changed. This can’t be undone.');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    await press(tab.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Delete' && has(e, 'danger'))[0]);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.body)).toEqual([{ id: 'a', based_on: RETIRE.updated_at }]);
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Plans');
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.card()).toBeNull();
    // Closing it moved nothing out of the sheet meanwhile.
    expect(tab.dialog()!.findAll((e) => e === dom.document.activeElement).length).toBe(1);
    await press(tab.inSheet('Close'));
    expect(tab.dialog()).toBeNull();
    expect(dom.document.activeElement).toBe(tab.plans()!);
    expect(tab.plans()?.textContent).toBe('Plans (2)');
    await tab.unmount();
  });

  test('Make this your plan on the card: the copy is your plan, shown as yours, focus on the bar’s Plans, and the status line says so', async () => {
    const calls = serve({ copies: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    await press(tab.onCard('Make this your plan'));
    await settle(100);
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ main: 'a', based_on: RETIRE.updated_at }]);
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.card()).toBeNull();
    expect(dom.document.activeElement).toBe(tab.plans()!);
    expect(tab.text()).toContain('stop at 50');
    expect(tab.container.findAll((e) => e.getAttribute('role') === 'status').map((e) => e.textContent)).toContain('“Retire at 50” is your plan now.');
    await tab.unmount();
  });
});

describe('what the tab does by itself', () => {
  test('after a reload of the plans fails, no count is said, on the card or the bar, and the sheet shows only why', async () => {
    let loads = 0;
    serve({
      copies: [RETIRE, SABBATICAL],
      answers: {
        'GET /api/plans': () => (loads++ === 0 ? undefined : [500, { error: 'Your plans couldn’t be loaded.' }]),
        // A change refused: the list is loaded again, and that fails.
        'PATCH /api/plans': () => [500, { error: 'It wasn’t made your plan. Try again in a moment.' }],
      },
    });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    expect(tab.cardPlans()?.textContent).toBe('Plans (3)');
    await press(tab.onCard('Make this your plan'));
    expect(loads).toBe(2);
    // The copy stays open on the list the client kept, its count unsaid.
    expect(tab.title().textContent).toBe('Copy: Retire at 50');
    expect(tab.card()!.textContent).toContain('It wasn’t made your plan. Try again in a moment.');
    expect(tab.cardPlans()?.textContent).toBe('Plans');
    await press(tab.cardPlans());
    expect(tab.dialog()?.textContent).toContain('Your plans couldn’t be loaded.');
    expect(tab.rowIn('First plan')).toBeNull();
    expect(tab.rowIn('Sabbatical 2029')).toBeNull();
    await press(tab.inSheet('Close'));
    await press(tab.arrow());
    expect(tab.plans()?.textContent).toBe('Plans');
    await tab.unmount();
  });

  test('a copy deleted elsewhere closes, and focus stays where it was', async () => {
    let gone = false;
    serve({
      copies: [RETIRE],
      answers: {
        'GET /api/plans': () => (gone ? plansListing(PLAN) : undefined),
        'PATCH /api/plans': () => {
          gone = true;
          return [404, { error: 'That plan isn’t there any more: it was deleted.' }];
        },
      },
    });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    const pressed = tab.onCard('Make this your plan')!;
    await press(pressed);
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.card()).toBeNull();
    expect(dom.document.activeElement).toBe(pressed);
    await tab.unmount();
  });

  test('a copy closed while a repair of your plan waits: focus stays where it was, and the sheet says why none opens', async () => {
    let plans = 0;
    let refuse!: () => void;
    serve({
      copies: [RETIRE],
      answers: {
        // Read again after the save below is refused: a value this version
        // can't use, so a repair waits.
        'GET /api/plan-inputs': () => (plans++ === 0 ? undefined : [200, { plan: { ...PLAN, withdrawalRate: 0.5 }, currency: 'USD' }]),
        'PUT /api/fire-plan': () => new Promise((r) => (refuse = () => r([409, { error: 'Your plan was changed on another device.' }]))),
      },
    });
    const tab = await mount();
    // A save of your plan under way, and a copy opened meanwhile.
    await press(tab.row('Household'));
    const form = tab.sheet('Household')!;
    await act(async () => type(form.findAll((e) => e.tagName === 'INPUT')[1], '58'));
    await press(form.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0]);
    await press(tab.plans());
    await openInSheet(tab, 'Retire at 50');
    expect(tab.title().textContent).toBe('Copy: Retire at 50');
    const portfolio = tab.tab('Portfolio');
    portfolio.focus();
    await act(async () => refuse());
    await settle(100);
    expect(tab.text()).toContain('Save it this way');
    expect(tab.title().textContent).toBe('Your plan');
    expect(tab.card()).toBeNull();
    expect(dom.document.activeElement).toBe(portfolio);
    await press(tab.plans());
    expect(tab.sheet('Plans')?.textContent).toContain('Your saved plan has values to fix first (at the top of the Plan tab): plans open once it is saved.');
    await tab.unmount();
  });
});

describe('the copy’s card, on every segment', () => {
  test('one that isn’t worked out says why above the panels, whatever segment is chosen, and the panels draw nothing for it', async () => {
    serve({ copies: [IN_EUROS] });
    const tab = await mount();
    await openFromBar(tab, 'In euros');
    const card = tab.card()!;
    expect(card.textContent).toContain('Its amounts were typed in EUR, and your plan is now in USD.');
    // Its life event is said in how it differs, and is on no card.
    expect(card.textContent).toContain('Adds “Wedding”');
    for (const label of ['Your path', 'Drawdown', 'Portfolio']) {
      await act(async () => click(tab.tab(label)));
      expect(tab.card()).toBe(card);
      expect(tab.order(card)).toBeLessThan(tab.order(tab.panelOf(label)));
    }
    // Only the Progress card, which is about the plan saved as your plan, never the copy.
    expect(tab.titles(tab.panelOf('Your path'))).toEqual(['Progress']);
    expect(tab.titles(tab.panelOf('Drawdown'))).toEqual([]);
    expect(drawdownRows(tab)).toEqual(['Assumptions', 'About these numbers']);
    expect(tab.titles(tab.panelOf('Portfolio'))).toEqual([]);
    // No Timeline to point to.
    expect(tab.titles(tab.panelOf('Your path'))).not.toContain('Timeline');
    await tab.unmount();
  });

  // A copy is shown with your plan's facts in it (lib/fire/copies.ts): a stop
  // before your age now is a value that doesn't fit them, repaired.
  test('one with a value that doesn’t fit your plan now says so on every segment, and offers to save it that way', async () => {
    serve({ copies: [TOO_SOON] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 30');
    const card = tab.card()!;
    expect(card.textContent).toContain('nothing is saved to it until you choose Save it this way.');
    expect(tab.onCard('Save it this way')).not.toBeNull();
    for (const label of ['Your path', 'Drawdown', 'Portfolio']) {
      await act(async () => click(tab.tab(label)));
      expect(tab.card()).toBe(card);
    }
    // Worked out, on the values it shows.
    expect(tab.titles(tab.panelOf('Drawdown'))[0]).toBe('Will it last?');
    await tab.unmount();
  });

  test('one refused for lasting changes below zero has its Timeline with it, above the panels, to change', async () => {
    serve({ copies: [BELOW_ZERO] });
    const tab = await mount();
    await openFromBar(tab, 'Mortgage gone');
    const slot = tab.card()!.parentNode as FakeElement;
    expect(tab.card()!.textContent).toContain('Its lasting changes in spending take your spending in retirement below zero');
    const edit = slot.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Mortgage paid off'));
    expect(edit.length).toBe(1);
    for (const p of tab.panels()) expect(p.textContent).not.toContain('Mortgage paid off');
    expect(tab.text()).not.toContain('Will it last?');
    await tab.unmount();
  });

  // Worked out in lib/fire/plan.worker.ts, on its own thread, as in a
  // browser: the one test in these suites whose answers come from there.
  test('one worked out with items: they are on Your path, and the card says what it adds', async () => {
    const posted = realWorkers();
    jest.useRealTimers();
    serve({ copies: [GYM] });
    const tab = await mount();
    await openFromBar(tab, 'Gym');
    expect(tab.card()!.textContent).toContain('Adds “Gym”');
    expect(tab.titles(tab.panelOf('Your path'))).toEqual(['Financial independence', 'Your figures', 'Timeline', 'Progress']);
    expect(tab.panelOf('Drawdown').textContent).toContain('From Your pathGym: ');
    expect(posted()).toBeGreaterThan(0);
    await tab.unmount();
  });
});

describe('where a switch scrolls to, under the pinned bar', () => {
  test('a segment chosen while the bar is pinned opens at its top; one chosen with its top in view stays where it is', async () => {
    serve();
    const tab = await mount();
    layout({ panel: 160 });
    await act(async () => click(tab.tab('Drawdown')));
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

  test('a copy opened lands on its card; a switch then lands on the panel, unless the card says what isn’t to be scrolled past', async () => {
    serve({ copies: [RETIRE, TOO_SOON] });
    const tab = await mount();
    layout({ card: -500, panel: -900 });
    await openFromBar(tab, 'Retire at 50');
    expect(scrolls).toEqual([-628]);
    await act(async () => click(tab.tab('Drawdown')));
    expect(scrolls).toEqual([-628, -1028]);
    await press(tab.cardPlans());
    await openInSheet(tab, 'Retire at 30');
    expect(scrolls).toEqual([-628, -1028, -628]);
    // What it says (a value to fix) isn't scrolled past.
    await act(async () => click(tab.tab('Your path')));
    expect(scrolls).toEqual([-628, -1028, -628, -628]);
    await tab.unmount();
  });

  test('nor is its amounts typed in another currency than your plan’s', async () => {
    serve({ copies: [IN_EUROS] });
    const tab = await mount();
    await openFromBar(tab, 'In euros');
    expect(tab.card()!.textContent).toContain('Its amounts were typed in EUR, and your plan is now in USD.');
    layout({ card: -500, panel: -900 });
    await act(async () => click(tab.tab('Portfolio')));
    expect(scrolls).toEqual([-628]);
    await tab.unmount();
  });

  test('nor a save’s notice, left with no form to say it in', async () => {
    // Said in the page's words, the list being read again already.
    const stale = 'Changed on another device, so nothing of your change was kept: make it again if it still applies.';
    let refused = false;
    serve({
      copies: [RETIRE],
      answers: {
        'PUT /api/plans': () => {
          refused = true;
          return [409, { error: 'Your plan changed: load the page again', stale: true }];
        },
        // Read again after: the copy as another device saved it.
        'GET /api/plans': () => (refused ? plansListing(PLAN, [copyRow(PLAN, 'a', 'Retire at 50', { targetAge: 50, withdrawalRate: 0.035 }, 'USD', 20)]) : undefined),
      },
    });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    await press(tab.row('Household'));
    const form = tab.sheet('Household')!;
    await act(async () => type(form.findAll((e) => e.tagName === 'INPUT')[1], '52'));
    await press(form.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0]);
    await settle(400);
    // The drawer closed with the version it was opened on; its notice is on
    // the card, the copy worked out still.
    expect(tab.sheet('Household')).toBeNull();
    expect(tab.card()!.textContent).toContain(stale);
    expect(tab.titles(tab.panelOf('Drawdown'))[0]).toBe('Will it last?');
    layout({ card: -500, panel: -900 });
    await act(async () => click(tab.tab('Drawdown')));
    expect(scrolls).toEqual([-628]);
    await tab.unmount();
  });
});

describe('a click between a commit in the background and its effects', () => {
  // The tab draws again whenever an answer comes back (a simulation's, the
  // grid's, Compare's), and React runs that commit's effects in a task of its
  // own. A click in between has them run first, before its own render: what
  // that click asks to focus must wait for the commit that draws it.
  test('the bar’s arrow: focus on the bar’s Plans, drawn once the copy is left', async () => {
    serve({ copies: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    const arrow = tab.arrow()!;
    arrow.focus();
    await tab.inTheGap({ balancesSaved: true }, () => click(arrow));
    expect(tab.title().textContent).toBe('Your plan');
    expect(dom.document.activeElement).toBe(tab.plans()!);
    await tab.unmount();
  });

  test('another copy opened from the card’s sheet: focus on the heading, and the card scrolled to', async () => {
    serve({ copies: [RETIRE, SABBATICAL] });
    const tab = await mount();
    await openFromBar(tab, 'Retire at 50');
    await press(tab.cardPlans());
    await press(tab.rowIn('Sabbatical 2029'));
    layout({ card: -500, panel: -900 });
    const open = tab.rowIn('Open it')!;
    open.focus();
    await tab.inTheGap({ balancesFailed: true }, () => click(open));
    expect(tab.title().textContent).toBe('Copy: Sabbatical 2029');
    expect(dom.document.activeElement).toBe(tab.title());
    expect(scrolls).toEqual([-628]);
    await tab.unmount();
  });

  test('one opened from the bar’s sheet: the card scrolled to', async () => {
    serve({ copies: [RETIRE] });
    const tab = await mount();
    await press(tab.plans());
    await press(tab.rowIn('Retire at 50'));
    layout({ card: -500, panel: -900 });
    const open = tab.rowIn('Open it')!;
    open.focus();
    await tab.inTheGap({ balancesSaved: true }, () => click(open));
    expect(tab.title().textContent).toBe('Copy: Retire at 50');
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
  test('on your plan: "Your plan" as the heading, then Plans, counting every plan from two', async () => {
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    let opened = 0;
    for (const [count, words] of [
      [3, 'Plans (3)'],
      [2, 'Plans (2)'],
      [1, 'Plans'],
      [null, 'Plans'],
    ] as const) {
      await act(async () => root.render(<PlanBar segment="path" onSegment={() => {}} copy={null} plansCount={count} onPlans={() => opened++} onBack={() => {}} />));
      const heading = container.findAll((e) => e.tagName === 'H2')[0];
      expect(outline(heading)).toBe('<h2>Your plan</h2>');
      const buttons = container.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('role') !== 'tab');
      expect(buttons.map((b) => [b.textContent, b.getAttribute('class'), b.getAttribute('aria-haspopup')])).toEqual([[words, 'btn ghost', 'dialog']]);
    }
    await act(async () => click(container.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('role') !== 'tab')[0]));
    expect(opened).toBe(1);
    await act(async () => root.unmount());
  });

  test('with a copy open: the arrow back, then "Copy: " and its whole name as the heading, and no Plans button', async () => {
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    let back = 0;
    const name = 'Retire at 45 and travel for a year first';
    await act(async () => root.render(<PlanBar segment="path" onSegment={() => {}} copy={name} plansCount={3} onPlans={() => {}} onBack={() => back++} />));
    const heading = container.findAll((e) => e.tagName === 'H2')[0];
    expect(outline(heading)).toBe(`<h2>Copy: ${name}</h2>`);
    expect([heading.getAttribute('id'), heading.getAttribute('tabindex'), heading.getAttribute('class')]).toEqual([PLAN_TITLE, '-1', 'plan-title']);
    const buttons = container.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('role') !== 'tab');
    expect(buttons.map(outline)).toEqual(['<button aria-label="Back to your plan"></button>']);
    await act(async () => click(buttons[0]));
    expect(back).toBe(1);
    await act(async () => root.unmount());
  });
});
