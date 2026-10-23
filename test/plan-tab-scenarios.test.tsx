import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, outline, FakeElement } from './mini-dom';

// The Plan tab with scenarios, rendered and used as a person would
// (react-dom/client over test/mini-dom.ts): what is saved where when a
// scenario opens, closes under an open form or is changed on another device;
// "They're in" held back while the accounts haven't all loaded without a
// problem; nothing compared while the saved Plan can't be read; a scenario
// refused for lasting changes below zero still fixable; and focus back on
// the scenario's row after "Back to your plan". Every request is answered
// here, by path; nothing reaches a network.
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
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type Entry = import('@/components/plan-scenarios').ScenarioEntry;

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

async function render(props: Partial<PlanTabProps> = {}) {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const all: PlanTabProps = { txns: [], txnsLoading: false, txnNotes: [], institutions: [], balancesAsOf: null, currency: 'USD', holdings: [], ...props };
  await act(async () => root.render(<PlanTab {...all} />));
  await settle();
  return {
    container,
    rerender: async (more: Partial<PlanTabProps>) => {
      await act(async () => root.render(<PlanTab {...all} {...more} />));
      await settle();
    },
    unmount: () => act(async () => root.unmount()),
    text: () => container.textContent,
    byLabel: (label: string) => container.findAll((e) => e.getAttribute('aria-label') === label)[0] ?? null,
    buttons: (text: string) => container.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === text),
    dialog: () => container.findAll((e) => e.getAttribute('role') === 'dialog')[0] ?? null,
  };
}

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
      'GET /api/fire-plan': [200, { plan: PLAN }],
      'GET /api/plan-scenarios': () => (gone ? listing() : listing(entry())),
      'PUT /api/plan-scenarios': () => {
        gone = true;
        return [404, { error: 'That scenario isn’t there any more: it was deleted.' }];
      },
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    await press(tab.byLabel('Open Retire at 50'));
    expect(tab.text()).toContain('Scenario: Retire at 50');
    await press(tab.byLabel('Edit your ages'));
    const dialog = tab.dialog();
    expect(dialog?.textContent).toContain('Saved to the scenario “Retire at 50”, not your plan.');
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
      'GET /api/fire-plan': [200, { plan: PLAN }],
      'GET /api/plan-scenarios': listing(entry()),
      'PUT /api/plan-scenarios': [409, { error: 'This scenario was changed on another device: here it is as it is now.', stale: true, scenario: newer }],
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    await press(tab.byLabel('Open Retire at 50'));
    await press(tab.byLabel('Edit assumptions'));
    const dialog = tab.dialog()!;
    const [, ret] = dialog.findAll((e) => e.tagName === 'INPUT');
    await act(async () => type(ret, '4'));
    await press(dialog.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0]);
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(1);
    expect(tab.text()).toContain('This scenario was changed on another device: here it is as it is now. Nothing of your change was kept');
    // The newer version is what is shown, and the stale form is gone.
    expect(tab.text()).toContain('Withdrawal rate: 3.5%');
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
      'GET /api/fire-plan': [200, { plan: PLAN }],
      'GET /api/plan-scenarios': () => listing(listed),
      'PUT /api/plan-scenarios': () => {
        listed = newer;
        return [409, { error: stale, stale: true, scenario: newer }];
      },
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    await press(tab.byLabel('Open Retire at 50'));
    await press(tab.byLabel('Use your plan’s retirement age'));
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(1);
    expect(tab.text().split(stale).length - 1).toBe(1);
    expect(tab.text()).toContain('Nothing of your change was kept');
    await press(tab.buttons('Back to your plan').find((b) => b.getAttribute('aria-label') === null) ?? null);
    await press(tab.byLabel('Open Retire at 50'));
    expect(tab.text()).toContain('Scenario: Retire at 50');
    expect(tab.text()).not.toContain(stale);
    await tab.unmount();
  });

  test('with the Plan open, its forms save the Plan, and never a scenario', async () => {
    const calls = serve({
      'GET /api/fire-plan': [200, { plan: PLAN }],
      'PUT /api/fire-plan': (c) => [200, { plan: c.body.plan }],
      'GET /api/plan-scenarios': listing(entry()),
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render();
    await press(tab.byLabel('Edit your ages'));
    const dialog = tab.dialog()!;
    expect(dialog.textContent).not.toContain('Saved to the scenario');
    const [, target] = dialog.findAll((e) => e.tagName === 'INPUT');
    await act(async () => type(target, '58'));
    await press(dialog.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0]);
    expect(savedPlan(calls).map((c) => c.body.plan.targetAge)).toEqual([58]);
    expect(calls.filter((c) => c.url === '/api/plan-scenarios' && c.method !== 'GET')).toEqual([]);
    await tab.unmount();
  });

  test('back to your plan puts focus on the scenario’s row', async () => {
    serve({ 'GET /api/fire-plan': [200, { plan: PLAN }], 'GET /api/plan-scenarios': listing(entry()), 'GET /api/allocation-settings': [200, { settings: null }] });
    const tab = await render();
    await press(tab.byLabel('Open Retire at 50'));
    expect((dom.document.activeElement as FakeElement).textContent).toBe('Scenario: Retire at 50');
    await press(tab.buttons('Back to your plan').find((b) => b.getAttribute('aria-label') === null) ?? null);
    expect(tab.text()).not.toContain('Scenario: Retire at 50');
    expect((dom.document.activeElement as FakeElement).getAttribute('aria-label')).toBe('Open Retire at 50');
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

  test('“They’re in” only once the accounts have all loaded without a problem, transactions included', async () => {
    const calls = serve({
      'GET /api/fire-plan': [200, { plan: PLAN }],
      'GET /api/plan-scenarios': listing(inEuros),
      'PUT /api/plan-scenarios': (c) => [200, { scenario: { ...inEuros, ...c.body.scenario, rev: 'r2' } }],
      'GET /api/allocation-settings': [200, { settings: null }],
    });
    const tab = await render({ institutions, balancesAsOf: '2026-10-23T12:00:00.000Z', txnNotes: ['Chase: needs to be reconnected'] });
    await press(tab.byLabel('Open Retire at 50'));
    expect(tab.text()).toContain('Its amounts were typed in EUR, and your plan is now in USD.');
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
    expect(tab.text()).toContain('Your saved plan couldn’t be read, so scenarios can’t be worked out against it');
    expect(tab.text()).not.toContain('Choose two to four plans.');
    expect(tab.byLabel('Open Retire at 50')?.disabled).toBe(true);
    await tab.unmount();
  });

  test('a scenario refused for lasting changes below zero shows its life events, to change', async () => {
    const below = entry({ set: {}, events: [{ id: 'x', kind: 'spending', label: 'Mortgage paid off', fromAge: 41, yearly: -45_000, years: null }] });
    serve({ 'GET /api/fire-plan': [200, { plan: PLAN }], 'GET /api/plan-scenarios': listing(below), 'GET /api/allocation-settings': [200, { settings: null }] });
    const tab = await render();
    await press(tab.byLabel('Open Retire at 50'));
    expect(tab.text()).toContain('Its lasting changes in spending take your spending in retirement below zero');
    expect(tab.text()).toContain('Life events');
    expect(tab.byLabel('Edit Mortgage paid off')).not.toBeNull();
    // Nothing is worked out for it meanwhile.
    expect(tab.text()).not.toContain('Will it last?');
    await tab.unmount();
  });
});
