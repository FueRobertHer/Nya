import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, outline, holdPress, pressThrough, FakeElement } from './mini-dom';

// The Plan tab with scenarios, rendered and used as a person would
// (react-dom/client over test/mini-dom.ts): what is saved where when a
// scenario opens, closes under an open form or is changed on another device;
// "They're in" held back while the accounts haven't all loaded without a
// problem; nothing compared while the saved Plan can't be read; a scenario
// refused for lasting changes below zero still fixable; and focus on the
// bar's Scenarios button after its arrow back to your plan. Scenarios are
// opened as a person opens them since rollout phase 6b: the Scenarios sheet,
// from the bar's button (or the open scenario's card's), then a row's Open.
// And each drawer's own
// binding, by itself: the allocation card's and the life events card's, the
// allocation settings refused inside a scenario, and the tab's forms refused
// once another plan is shown, even pressed through a disabled Save. Every
// request is answered here, by path; nothing reaches a network.
//
// A rendered element never goes into toEqual or another matcher that diffs:
// Bun's diff walks it, and the React fibers on it, whole (a million lines,
// and once more memory than the machine had). Elements are counted, or
// outlined first; toBe and toBeNull print an element's outline.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
// React's client reads what the document supports once, when it loads (the
// input event among it). In a run of many suites it may have loaded before
// this file put a document there: it is loaded afresh, after.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: PlanTab } = await import('@/components/PlanTab');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { NO_CHANGES } = await import('@/lib/fire/scenarios');
const { default: AllocationCard } = await import('@/components/AllocationCard');
const { LifeEventsCard } = await import('@/components/PlanEvents');
const { allocate, planMix } = await import('@/lib/allocation/allocation');
const { initialListState } = await import('@/lib/whole-list-store');
const { wholeMoney } = await import('@/components/plan-text');
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type Entry = import('@/components/plan-scenarios').ScenarioEntry;
type AllocationCardProps = import('@/components/AllocationCard').AllocationCardProps;
type AllocationSettings = import('@/lib/allocation/settings').AllocationSettings;
type LifeEvent = import('@/lib/fire/events').LifeEvent;
type FirePlan = import('@/lib/fire/plan').FirePlan;

const PLAN = { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, savings: 30_000, assets: 300_000 };
const entry = (over: Partial<Entry> = {}): Entry => ({
  id: 's1',
  version: 1,
  name: 'Retire at 50',
  currency: 'USD',
  createdAt: '2026-10-01T00:00:00.000Z',
  savedAt: '2026-10-01T00:00:00.000Z',
  rev: 'r1',
  ...NO_CHANGES,
  set: { targetAge: 50 },
  ...over,
});

type Call = { method: string; url: string; body: any };
type Answer = (call: Call) => [number, unknown];

/** Answers by "METHOD /path", the last given for each winning; records every call. */
function serve(answers: Record<string, Answer | [number, unknown]>) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const a = answers[`${call.method} ${url}`];
    const [status, body] = typeof a === 'function' ? a(call) : (a ?? [404, { error: 'not here' }]);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

const listing = (...scenarios: Entry[]): [number, unknown] => [200, { scenarios, unreadable_ids: [], unrecognised_ids: [] }];
const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

/** Renders a node into the document, with what a test looks for in it. */
async function mount(node: React.ReactNode) {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(node));
  await settle();
  return {
    container,
    show: async (next: React.ReactNode) => {
      await act(async () => root.render(next));
      await settle();
    },
    /** Shown, and nothing more waited for: a drawer closing on it is still
     *  on the page (it slides out for a third of a second). */
    showNow: (next: React.ReactNode) => act(async () => root.render(next)),
    unmount: () => act(async () => root.unmount()),
    text: () => container.textContent,
    byLabel: (label: string) => container.findAll((e) => e.getAttribute('aria-label') === label)[0] ?? null,
    /** One of Your figures' rows on Your path, by its title: each opens its
     *  sheet (rollout phase 6c). */
    row: (title: string) =>
      container.findAll((e) => e.tagName === 'BUTTON' && (e.getAttribute('class') ?? '').split(' ').includes('list-row') && e.findAll((t) => t.getAttribute('class') === 'list-row-title')[0]?.textContent === title)[0] ?? null,
    buttons: (text: string) => container.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === text),
    /** The open drawer: one closing slides out for a third of a second, and
     *  is still on the page meanwhile. */
    dialog: () => container.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null,
    /** The pinned bar's arrow back to your plan (the Scenarios sheet's row for
     *  the open scenario has the same name). */
    arrow: () => container.findAll((e) => e.getAttribute('class') === 'plan-bar')[0]?.findAll((e) => e.getAttribute('aria-label') === 'Back to your plan')[0] ?? null,
    /** "Scenarios (N)", which opens the Scenarios sheet: the bar's on your
     *  plan, the open scenario's card's inside one. */
    scenarios: () => container.findAll((e) => e.tagName === 'BUTTON' && /^Scenarios(?: \(\d+\))?$/.test(e.textContent.trim()))[0] ?? null,
    /** The open scenario's card under the bar, and the place that holds it
     *  (with its life events, when it is refused): what it says is read there,
     *  not from the whole tab, where the Scenarios sheet, sliding out for a
     *  third of a second, says the same in its Compare. */
    card: () => container.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes('plan-scenario-card'))[0] ?? null,
    slot: () => (container.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes('plan-scenario-card'))[0]?.parentNode as FakeElement | null) ?? null,
  };
}

/** Opens a scenario as a person does: the Scenarios sheet, then its row's Open. */
async function openScenario(tab: Awaited<ReturnType<typeof mount>>, name: string) {
  await press(tab.scenarios());
  await press(tab.dialog()?.findAll((e) => e.getAttribute('aria-label') === `Open ${name}`)[0] ?? null);
}

async function render(props: Partial<PlanTabProps> = {}) {
  const all: PlanTabProps = { txns: [], txnsLoading: false, txnNotes: [], institutions: [], balancesAsOf: null, currency: 'USD', holdings: [], ...props };
  const view = await mount(<PlanTab {...all} />);
  return { ...view, rerender: (more: Partial<PlanTabProps>) => view.show(<PlanTab {...all} {...more} />) };
}

/** A button in an element, by its words. */
const button = (within: FakeElement, words: string) => within.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;

/** What a figure's sheet says above its buttons while saving is paused
 *  (components/PlanForms.tsx), or null while it isn't. */
const pausedLine = (sheet: FakeElement): string | null => sheet.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes('plan-paused'))[0]?.textContent ?? null;

/** What one of Your figures' rows says: where its figure comes from, and the figure. */
const said = (row: FakeElement | null) => {
  const of = (cls: string) => row?.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes(cls))[0] ?? null;
  return [of('list-row-sub')?.textContent ?? null, of('list-row-value')?.childNodes.filter((c): c is FakeElement => c instanceof FakeElement)[0]?.textContent ?? null];
};

const press = async (el: FakeElement | null) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => click(el));
  await settle();
};

/** The Plan's own store was written to. */
const savedPlan = (calls: Call[]) => calls.filter((c) => c.url === '/api/fire-plan' && c.method !== 'GET');

describe('a form left open never saves to another plan', () => {
  test('the scenario is deleted elsewhere while a form is open: the drawer closes, and nothing reaches the Plan', async () => {
    let gone = false;
    const calls = serve({
      'GET /api/fire-plan': [200, { plan: PLAN, currency: 'USD' }],
      'GET /api/plan-scenarios': () => (gone ? listing() : listing(entry())),
      'PUT /api/plan-scenarios': () => {
        gone = true;
        return [404, { error: 'That scenario isn’t there any more: it was deleted.' }];
      },
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    expect(said(tab.row('Ages'))).toEqual(['40 now, 55 target', null]);
    await openScenario(tab, 'Retire at 50');
    expect(tab.text()).toContain('Scenario: Retire at 50');
    // Its row says the scenario's ages, as its sheet holds them.
    expect(said(tab.row('Ages'))).toEqual(['40 now, 50 target', null]);
    await press(tab.row('Ages'));
    const dialog = tab.dialog();
    expect(dialog?.textContent).toContain('Saved to the scenario “Retire at 50”, not your plan.');
    // Saving isn't paused: Save is on, and nothing says otherwise.
    expect([button(dialog!, 'Save')?.disabled, pausedLine(dialog!)]).toEqual([false, null]);
    const [age, target] = dialog!.findAll((e) => e.tagName === 'INPUT');
    expect(age.disabled).toBe(true);
    await act(async () => type(target, '48'));
    const save = dialog!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0];
    await press(save);
    // The PUT went to the scenario, which was gone; the list reloaded without
    // it, so the tab shows the Plan, and the drawer closed with it.
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual(['/api/plan-scenarios']);
    expect(tab.text()).not.toContain('Scenario: Retire at 50');
    // Pressed again while the drawer slides out: still nothing to the Plan.
    for (const again of dialog!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')) await press(again);
    await settle(400);
    expect(tab.dialog()).toBeNull();
    expect(savedPlan(calls)).toEqual([]);
    await tab.unmount();
  });

  test('changed on another device: the drawer closes on the new version, says so, and a second Save can’t undo it', async () => {
    const newer = entry({ rev: 'r2', set: { targetAge: 50, withdrawalRate: 0.035 } });
    const calls = serve({
      'GET /api/fire-plan': [200, { plan: PLAN, currency: 'USD' }],
      'GET /api/plan-scenarios': listing(entry()),
      'PUT /api/plan-scenarios': [409, { error: 'This scenario was changed on another device: here it is as it is now.', stale: true, scenario: newer }],
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    await openScenario(tab, 'Retire at 50');
    await press(tab.row('Assumptions'));
    const dialog = tab.dialog()!;
    expect(dialog.getAttribute('aria-label')).toBe('Assumptions (Retire at 50)');
    expect([button(dialog, 'Save')?.disabled, pausedLine(dialog)]).toEqual([false, null]);
    const [, ret] = dialog.findAll((e) => e.tagName === 'INPUT');
    await act(async () => type(ret, '4'));
    const save = button(dialog, 'Save')!;
    // A second press of this Save, held to make once the save has been
    // refused: by then the drawer is closing (its Save disabled), or gone.
    const late = holdPress(save);
    await press(save);
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(1);
    expect(tab.text()).toContain('This scenario was changed on another device: here it is as it is now. Nothing of your change was kept');
    // The newer version is what is shown, and the stale form is gone.
    expect(tab.text()).toContain('Withdrawal rate: 3.5%');
    // Even a press that gets past its Save, disabled or gone, saves nothing:
    // the form was opened for the version before (PlanTab's saveFor, on its
    // own).
    expect(save.disabled).toBe(true);
    await act(async () => void (await late()));
    await settle();
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(1);
    for (const again of dialog.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')) await press(again);
    await settle(400);
    expect(tab.dialog()).toBeNull();
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(1);
    expect(savedPlan(calls)).toEqual([]);
    await tab.unmount();
  });

  test('a change on the scenario’s card made to an older version is said once, and not again once it is left', async () => {
    const newer = entry({ rev: 'r2', set: { targetAge: 50, withdrawalRate: 0.035 } });
    const stale = 'This scenario was changed on another device: here it is as it is now.';
    let listed = entry();
    const calls = serve({
      'GET /api/fire-plan': [200, { plan: PLAN, currency: 'USD' }],
      'GET /api/plan-scenarios': () => listing(listed),
      'PUT /api/plan-scenarios': () => {
        listed = newer;
        return [409, { error: stale, stale: true, scenario: newer }];
      },
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    await openScenario(tab, 'Retire at 50');
    await press(tab.byLabel('Use your plan’s retirement age'));
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(1);
    expect(tab.text().split(stale).length - 1).toBe(1);
    expect(tab.text()).toContain('Nothing of your change was kept');
    await press(tab.arrow());
    await openScenario(tab, 'Retire at 50');
    expect(tab.text()).toContain('Scenario: Retire at 50');
    expect(tab.text()).not.toContain(stale);
    await tab.unmount();
  });

  test('with the Plan open, its forms save the Plan, and never a scenario', async () => {
    const calls = serve({
      'GET /api/fire-plan': [200, { plan: PLAN, currency: 'USD' }],
      'PUT /api/fire-plan': (c) => [200, { plan: c.body.plan }],
      'GET /api/plan-scenarios': listing(entry()),
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    await press(tab.row('Ages'));
    const dialog = tab.dialog()!;
    expect(dialog.getAttribute('aria-label')).toBe('Your ages');
    expect(dialog.textContent).not.toContain('Saved to the scenario');
    expect([button(dialog, 'Save')?.disabled, pausedLine(dialog)]).toEqual([false, null]);
    const [, target] = dialog.findAll((e) => e.tagName === 'INPUT');
    await act(async () => type(target, '58'));
    await press(dialog.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0]);
    expect(savedPlan(calls).map((c) => c.body.plan.targetAge)).toEqual([58]);
    expect(calls.filter((c) => c.url === '/api/plan-scenarios' && c.method !== 'GET')).toEqual([]);
    await tab.unmount();
  });

  test('back to your plan puts focus on the bar’s Scenarios button, where it can be opened again: the arrow and the card are gone', async () => {
    serve({ 'GET /api/fire-plan': [200, { plan: PLAN, currency: 'USD' }], 'GET /api/plan-scenarios': listing(entry()), 'GET /api/allocation-settings': [200, { settings: null }] });
    const tab = await render();
    await openScenario(tab, 'Retire at 50');
    expect((dom.document.activeElement as FakeElement).textContent).toBe('Scenario: Retire at 50');
    await press(tab.arrow());
    expect(tab.text()).not.toContain('Scenario: Retire at 50');
    const focused = dom.document.activeElement as FakeElement;
    expect([focused.textContent, focused.getAttribute('class')]).toEqual(['Scenarios (1)', 'btn ghost']);
    await tab.unmount();
  });
});

describe('Your figures with a scenario open', () => {
  test('are the scenario’s: a figure it types is said as typed, at its amount, and the FI number is worked out from it', async () => {
    serve({
      'GET /api/fire-plan': [200, { plan: { ...PLAN, spending: null }, currency: 'USD' }],
      'GET /api/plan-scenarios': listing(entry({ name: 'Spend more', set: { spending: 55_000 } })),
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    // Your plan measures it, from no transactions yet.
    expect(said(tab.row('Annual spending'))).toEqual(['Not enough transactions yet', '--']);
    await openScenario(tab, 'Spend more');
    expect(tab.text()).toContain('Scenario: Spend more');
    expect(said(tab.row('Annual spending'))).toEqual(['Typed by you', '$55,000']);
    expect(tab.text()).toContain('$1,375,000');
    // Back on your plan: its own again.
    await press(tab.arrow());
    expect(said(tab.row('Annual spending'))).toEqual(['Not enough transactions yet', '--']);
    await tab.unmount();
  });
});

describe('what the tab waits for', () => {
  const institutions = [
    {
      name: 'Vanguard',
      item_id: 'i1',
      error: false,
      staleAsOf: null,
      staleAsOfAt: null,
      missing: 0,
      accounts: [{ account_id: 'brk', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balance: 300_000, currency: 'USD' }],
    },
  ];
  const inEuros = entry({ currency: 'EUR', set: { targetAge: 50, spending: 45_000 } });

  test('with the Plan’s currency recorded, “They’re in” is offered at once: it can’t move while the accounts load, or with a problem', async () => {
    const calls = serve({
      'GET /api/fire-plan': [200, { plan: PLAN, currency: 'USD' }],
      'GET /api/plan-scenarios': listing(inEuros),
      'PUT /api/plan-scenarios': (c) => [200, { scenario: { ...inEuros, ...c.body.scenario, rev: 'r2' } }],
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render({ institutions, balancesAsOf: null, txns: null, txnsLoading: true, txnNotes: ['Chase: needs to be reconnected'] });
    await openScenario(tab, 'Retire at 50');
    expect(tab.card()?.textContent).toContain('Its amounts were typed in EUR, and your plan is now in USD.');
    const confirm = tab.buttons('They’re in USD')[0];
    expect(confirm).toBeDefined();
    await press(confirm);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.scenario.currency)).toEqual(['USD']);
    expect(savedPlan(calls)).toEqual([]);
    await tab.unmount();
  });

  test('with nothing typed in the Plan, its currency is the accounts’: “They’re in” waits until they have all loaded without a problem, transactions included', async () => {
    const untyped = { ...DEFAULT_PLAN, age: 40, targetAge: 55 };
    const calls = serve({
      'GET /api/fire-plan': [200, { plan: untyped, currency: null }],
      'GET /api/plan-scenarios': listing(inEuros),
      'PUT /api/plan-scenarios': (c) => [200, { scenario: { ...inEuros, ...c.body.scenario, rev: 'r2' } }],
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render({ institutions, balancesAsOf: '2026-10-23T12:00:00.000Z', txnNotes: ['Chase: needs to be reconnected'] });
    await openScenario(tab, 'Retire at 50');
    expect(tab.card()?.textContent).toContain('Its amounts were typed in EUR, and your plan is now in USD.');
    expect(tab.buttons('They’re in USD').map(outline)).toEqual([]);
    await tab.rerender({ txnNotes: [], txns: null, txnsLoading: true });
    expect(tab.buttons('They’re in USD').map(outline)).toEqual([]);
    await tab.rerender({ txnNotes: [], txns: [], txnsLoading: false });
    const confirm = tab.buttons('They’re in USD')[0];
    expect(confirm).toBeDefined();
    await press(confirm);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.scenario.currency)).toEqual(['USD']);
    expect(savedPlan(calls)).toEqual([]);
    await tab.unmount();
  });

  test('a saved Plan that can’t be read: no scenario opens, nothing is compared against the defaults, and it says why', async () => {
    serve({
      'GET /api/fire-plan': [409, { error: 'Your plan assumptions could not be read.', unreadable: true }],
      'GET /api/plan-scenarios': listing(entry()),
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    // Said, and nothing compared or opened, in the Scenarios sheet, where
    // the list and Compare are.
    await press(tab.scenarios());
    const sheet = tab.dialog()!;
    expect(sheet.textContent).toContain('Your saved plan couldn’t be read, so scenarios can’t be worked out against it: try again at the top of the Plan tab.');
    expect(sheet.textContent).toContain('Retire at 50');
    expect(sheet.textContent).not.toContain('Choose two to four plans.');
    expect(sheet.findAll((e) => e.getAttribute('aria-label') === 'Open Retire at 50')[0]?.disabled).toBe(true);
    await tab.unmount();
  });

  test('a scenario refused for lasting changes below zero shows its life events, to change', async () => {
    const below = entry({ set: {}, events: [{ id: 'x', kind: 'spending', label: 'Mortgage paid off', fromAge: 41, yearly: -45_000, years: null }] });
    serve({ 'GET /api/fire-plan': [200, { plan: PLAN, currency: 'USD' }], 'GET /api/plan-scenarios': listing(below), 'GET /api/allocation-settings': [200, { settings: null }] });
    const tab = await render();
    await openScenario(tab, 'Retire at 50');
    expect(tab.card()?.textContent).toContain('Its lasting changes in spending take your spending in retirement below zero');
    // Its life events are with the card, above the panels.
    const slot = tab.slot()!;
    expect(slot.textContent).toContain('Life events');
    expect(slot.findAll((e) => e.getAttribute('aria-label') === 'Edit Mortgage paid off').length).toBe(1);
    // Nothing is worked out for it meanwhile.
    expect(tab.text()).not.toContain('Will it last?');
    await tab.unmount();
  });
});

describe('each drawer is bound to the plan it was opened for, on its own', () => {
  const allocInstitutions = [
    { name: 'Vanguard', item_id: 'i1', error: false, staleAsOf: null, missing: 0, accounts: [{ account_id: 'brk', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balance: 100_000, currency: 'USD' }] },
  ];
  const allocHoldings = [
    { account_id: 'brk', ticker: 'VTI', name: 'VTI', security_type: 'etf', is_cash_equivalent: false, value: 60_000 },
    { account_id: 'brk', ticker: 'BND', name: 'BND', security_type: 'etf', is_cash_equivalent: false, value: 40_000 },
  ];
  const allocated = allocate({ institutions: allocInstitutions, holdings: allocHoldings, settings: null, currency: 'USD' });
  /** The card, saving the plan into `plans` and the settings into `settings`. */
  const card = (over: Partial<AllocationCardProps>, plans: FirePlan[], settings: AllocationSettings[]) => (
    <AllocationCard
      allocation={{
        settings: { ...initialListState<AllocationSettings | null>(null), status: 'ready' },
        load: async () => {},
        save: async (next) => {
          settings.push(next);
          return true;
        },
        withSettings: true,
        alloc: allocated,
        mix: planMix(allocated),
      }}
      plan={PLAN}
      onSavePlan={async (p) => {
        plans.push(p);
        return true;
      }}
      planEditable
      institutions={allocInstitutions}
      balancesAsOf={null}
      scenarioName="Retire at 50"
      planKey="s1@r1"
      {...over}
    />
  );

  test('the allocation card: its drawer closes when another plan is shown, and its confirm, pressed as it slides out, saves nothing', async () => {
    serve({ 'POST /api/allocation-history': [500, { error: 'not here' }] });
    const plans: FirePlan[] = [];
    const view = await mount(card({}, plans, []));
    // Confirmed for the plan it was opened for: saved.
    await press(view.buttons('Use my allocation in the plan')[0] ?? null);
    await press(button(view.dialog()!, 'Use 60/40/0'));
    expect(plans.map((p) => `${p.stocksPct}/${p.bondsPct}`)).toEqual(['60/40']);
    await settle(400);
    // Opened again, and another plan shown before it is confirmed.
    await press(view.buttons('Use my allocation in the plan')[0] ?? null);
    const dialog = view.dialog()!;
    const confirm = button(dialog, 'Use 60/40/0')!;
    await view.showNow(card({ planKey: 's1@r2' }, plans, []));
    expect(confirm.disabled).toBe(false);
    await press(confirm);
    expect(plans.length).toBe(1);
    await settle(400);
    expect(view.dialog()).toBeNull();
    await view.unmount();
  });

  test('the allocation settings are never saved from inside a scenario, even by a press its disabled controls let through', async () => {
    serve({ 'POST /api/allocation-history': [500, { error: 'not here' }] });
    const saved: AllocationSettings[] = [];
    const target = async (view: Awaited<ReturnType<typeof mount>>, through: boolean) => {
      const set = view.buttons('Set a target')[0]!;
      if (through) await act(async () => void pressThrough(set));
      else await press(set);
      await settle();
      const dialog = view.dialog()!;
      const fields = dialog.findAll((e) => e.tagName === 'INPUT');
      // US stocks and bonds, in the form's order of classes.
      await act(async () => type(fields[0], '60'));
      await act(async () => type(fields[2], '40'));
      const save = button(dialog, 'Save')!;
      if (through) await act(async () => void (await pressThrough(save)));
      else await press(save);
      await settle(400);
      return { save, dialog };
    };
    // With the plan open, saved.
    const plan = await mount(card({ scenarioName: null, planKey: 'plan@r1' }, [], saved));
    await target(plan, false);
    expect(saved.map((s) => s.target)).toEqual([{ 'us-stocks': 60, bonds: 40 }]);
    await plan.unmount();
    // In a scenario, its controls are disabled, and what gets past them is refused.
    const view = await mount(card({ settingsLocked: true }, [], saved));
    expect(view.buttons('Set a target')[0]?.disabled).toBe(true);
    const { save, dialog } = await target(view, true);
    expect(save.disabled).toBe(true);
    expect(saved.length).toBe(1);
    expect(dialog.textContent).toContain('It was not saved.');
    await view.unmount();
  });

  test('the life events card: its drawer closes on a new version of the scenario, and its Save, pressed as it slides out, saves nothing', async () => {
    const events: LifeEvent[] = [{ id: 'x', kind: 'spending', label: 'Gym', fromAge: 41, yearly: 1_000, years: 5 }];
    const sent: LifeEvent[][] = [];
    const lifeEvents = (version: string) => (
      <LifeEventsCard
        scenarioName="Retire at 50"
        version={version}
        events={events}
        notes={[]}
        money={(n) => wholeMoney(n, 'USD')}
        editable
        onSave={async (next) => {
          sent.push(next);
          return true;
        }}
      />
    );
    const view = await mount(lifeEvents('s1@r1'));
    // Saved on the version it was opened on.
    await press(view.byLabel('Edit Gym'));
    await press(button(view.dialog()!, 'Save'));
    expect(sent.length).toBe(1);
    await settle(400);
    // Opened again, and the scenario changes before Save.
    await press(view.byLabel('Edit Gym'));
    const dialog = view.dialog()!;
    const save = button(dialog, 'Save')!;
    await view.showNow(lifeEvents('s1@r2'));
    expect(save.disabled).toBe(false);
    await press(save);
    expect(sent.length).toBe(1);
    expect(dialog.textContent).toContain('This scenario changed since this was opened, so nothing was saved: open it again.');
    await settle(400);
    expect(view.dialog()).toBeNull();
    await view.unmount();
  });
});
