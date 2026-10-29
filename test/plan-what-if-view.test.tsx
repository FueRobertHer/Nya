import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, FakeElement } from './mini-dom';

// The What if… card on Your path (rollout phase 8c), rendered in the Plan tab
// and used as a person would (react-dom/client over test/mini-dom.ts): where
// it sits, a template's form with nothing filled in but its name, the FI age
// it moves as the figures are typed, "Try it" making an ordinary scenario
// and opening it, and the scenarios listed as life choices with their FI
// age against your plan's. And its words on their own
// (components/plan-what-if.ts). Every request is answered here, by path;
// nothing reaches a network.
//
// A rendered element never goes into toEqual or another matcher that diffs
// (test/plan-tab-scenarios.test.tsx says why).

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
// React's client reads what the document supports once, when it loads: it is
// loaded afresh, after this file put a document there.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: PlanTab } = await import('@/components/PlanTab');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { NO_CHANGES, MAX_PLAN_SCENARIOS } = await import('@/lib/fire/scenarios');
const { WHAT_IF_TEMPLATES, whatIfName, lifeChoiceText, previewText, fiWhen, scenarioRowText, withDraft } = await import('@/components/plan-what-if');
const { setAmountsHidden } = await import('@/lib/format');
type PlanTabProps = import('@/components/PlanTab').PlanTabProps;
type Entry = import('@/components/plan-scenarios').ScenarioEntry;
type LifeEvent = import('@/lib/fire/events').LifeEvent;

// FI around 52 (51.8), with a 4% rate and 5% growth after inflation.
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
  ...over,
});
const home = (cost: number, atAge = 45): LifeEvent => ({ id: 'h', kind: 'house', label: 'Buying a home', atAge, cost, yearly: 0, years: null });

type Call = { method: string; url: string; body: any };
type Answer = (call: Call) => [number, unknown];

/** Answers by "METHOD /path"; records every call. */
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
const classOf = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');

async function render(answers: Record<string, Answer | [number, unknown]>, over: Partial<PlanTabProps> = {}) {
  const calls = serve({ 'GET /api/fire-plan': [200, { plan: PLAN, currency: 'USD' }], 'GET /api/allocation-settings': [200, { settings: null }], ...answers });
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const props: PlanTabProps = { txns: [], txnsLoading: false, txnNotes: [], institutions: [], balancesAsOf: null, currency: 'USD', holdings: [], ...over };
  await act(async () => root.render(<PlanTab {...props} />));
  await settle();
  const find = (pred: (e: FakeElement) => boolean) => container.findAll(pred)[0] ?? null;
  return {
    calls,
    container,
    unmount: () => act(async () => root.unmount()),
    card: () => find((e) => classOf(e).includes('plan-what-if')),
    chip: (label: string) => find((e) => e.tagName === 'BUTTON' && classOf(e).includes('chip') && e.textContent.trim() === label),
    /** The card's rows: each scenario's name and what it says. */
    rows: () =>
      (find((e) => classOf(e).includes('plan-what-if'))?.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row')) ?? []).map((b) => [
        b.findAll((e) => classOf(e).includes('list-row-title'))[0]?.textContent ?? '',
        b.findAll((e) => classOf(e).includes('list-row-sub'))[0]?.textContent ?? '',
      ]),
    row: (name: string) =>
      find((e) => classOf(e).includes('plan-what-if'))?.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && e.findAll((t) => classOf(t).includes('list-row-title'))[0]?.textContent === name)[0] ?? null,
    dialog: () => find((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true'),
    bar: () => find((e) => e.getAttribute('class') === 'plan-bar'),
  };
}

const press = async (el: FakeElement | null) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => click(el));
  await settle();
};
/** A field in an element, by the words of its label. */
const field = (within: FakeElement, words: string) => within.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(words))[0]?.findAll((e) => e.tagName === 'INPUT')[0] ?? null;
const fill = async (within: FakeElement, words: string, value: string) => {
  const el = field(within, words);
  if (!el) throw new Error(`no field ${words}`);
  await act(async () => type(el, value));
  await settle();
};
const button = (within: FakeElement, words: string) => within.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
/** The preview's first line, what the draft does to the FI age. */
const preview = (sheet: FakeElement) => previewLines(sheet)[0] ?? null;
/** Every line of the preview: its notes, and the scenario Try it makes. */
const previewLines = (sheet: FakeElement) => (sheet.findAll((e) => classOf(e).includes('notice') && classOf(e).includes('info'))[0]?.findAll((e) => e.tagName === 'P') ?? []).map((p) => p.textContent);

describe('the What if… card', () => {
  test('sits on Your path under Your figures, above income and one-offs, with your plan shown; not inside a scenario', async () => {
    const tab = await render({ 'GET /api/plan-scenarios': listing(entry({ name: 'Buy a home at 45', events: [home(200_000)] })) });
    const path = tab.container.findAll((e) => e.getAttribute('role') === 'tabpanel')[0];
    const cards = path.findAll((e) => e.tagName === 'SECTION' || classOf(e).includes('card'));
    const at = (pred: (e: FakeElement) => boolean) => cards.findIndex(pred);
    const figures = at((e) => classOf(e).includes('plan-inputs'));
    const whatIf = at((e) => classOf(e).includes('plan-what-if'));
    expect(figures).toBeGreaterThanOrEqual(0);
    expect(whatIf).toBeGreaterThan(figures);
    expect(tab.card()?.textContent).toContain('What if…');
    expect(WHAT_IF_TEMPLATES.map((t) => tab.chip(t.label) !== null)).toEqual(WHAT_IF_TEMPLATES.map(() => true));
    // Opened, the scenario's own figures are shown, and the card goes.
    await press(tab.row('Buy a home at 45'));
    expect(tab.bar()?.textContent).toContain('Scenario: Buy a home at 45');
    expect(tab.card()).toBeNull();
    await tab.unmount();
  });

  test('a template opens its life event’s form with nothing filled in but the name, and the FI age moves as it is typed', async () => {
    const tab = await render({ 'GET /api/plan-scenarios': listing() });
    await press(tab.chip('Buy a home'));
    const sheet = tab.dialog() as FakeElement;
    expect(sheet.textContent).toContain('Buy a home');
    const inputs = sheet.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'number');
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.map((i) => (i as unknown as { value: string }).value)).toEqual(inputs.map(() => ''));
    expect((field(sheet, 'Name') as unknown as { value: string }).value).toBe('Buying a home');
    expect(preview(sheet)).toBe('Fill in the figures to see how it moves your FI age.');
    await fill(sheet, 'At age', '45');
    expect(preview(sheet)).toBe('Fill in the figures to see how it moves your FI age.');
    await fill(sheet, 'Paid from your investments', '200000');
    expect(previewLines(sheet)).toEqual(['In this what-if, FI moves from around 52 to around 56 (4 years later).', 'Try it makes this the scenario “Buy a home at 45”, and opens it.']);
    // Only the move is said as it changes.
    const live = sheet.findAll((e) => e.getAttribute('role') === 'status');
    expect(live.map((e) => e.textContent)).toEqual(['In this what-if, FI moves from around 52 to around 56 (4 years later).']);
    // A cost its investments can't pay: why, with its amounts.
    await fill(sheet, 'Paid from your investments', '900000');
    expect(preview(sheet)).toBe('In this what-if, you’d have about $548,653 at 45, less than the $900,000 it takes from your investments, so there is no FI date: change the cost, or when it comes.');
    expect(button(sheet, 'Try it')).not.toBeNull();
    expect(button(sheet, 'Save')).toBeNull();
    await tab.unmount();
  });

  test('“Try it” makes an ordinary scenario of your plan with that one event, named after it, and opens it', async () => {
    let made: unknown = null;
    const tab = await render({
      'GET /api/plan-scenarios': listing(),
      'POST /api/plan-scenarios': (call) => {
        made = call.body.scenario;
        return [200, { scenario: { ...call.body.scenario, id: 'new1', version: 1, createdAt: '2026-10-26T00:00:00.000Z', savedAt: '2026-10-26T00:00:00.000Z', rev: 'r1' } }];
      },
    });
    await press(tab.chip('A career break'));
    const sheet = tab.dialog() as FakeElement;
    await fill(sheet, 'From age', '45');
    await fill(sheet, 'For how many years', '2');
    await fill(sheet, 'Saved less a year', '30000');
    expect(preview(sheet)).toBe('In this what-if, FI moves from around 52 to around 53 (1 year later).');
    await press(button(sheet, 'Try it'));
    const { events, ...rest } = made as { events: LifeEvent[] } & Record<string, unknown>;
    expect(rest).toEqual({ name: 'A career break at 45', currency: 'USD', set: {}, income: { leaveOut: [], add: [] }, expenses: { leaveOut: [], add: [] } });
    expect(events.length).toBe(1);
    const { id, ...event } = events[0];
    expect(typeof id).toBe('string');
    expect(event).toEqual({ kind: 'sabbatical', label: 'A career break', fromAge: 45, years: 2, savingsLost: 30_000 });
    expect(tab.bar()?.textContent).toContain('Scenario: A career break at 45');
    // The sheet slides out (it is still on the page, closed), and the card is gone.
    expect(tab.container.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'false').length).toBe(1);
    expect(tab.card()).toBeNull();
    // Focus on the bar's heading, as a scenario opened from the Scenarios sheet.
    expect(dom.document.activeElement?.tagName).toMatch(/^H[1-6]$/);
    expect(dom.document.activeElement?.textContent).toContain('A career break at 45');
    // Nothing was saved to your plan.
    expect(tab.calls.filter((c) => c.url === '/api/fire-plan' && c.method !== 'GET')).toEqual([]);
    await tab.unmount();
  });

  test('what an event leaves out is said under the preview, and part-time work says it doesn’t move the FI age', async () => {
    const tab = await render({ 'GET /api/plan-scenarios': listing() });
    await press(tab.chip('Buy a home'));
    let sheet = tab.dialog() as FakeElement;
    await fill(sheet, 'At age', '35');
    await fill(sheet, 'Paid from your investments', '0');
    await fill(sheet, 'Change in yearly spending from then', '5000');
    await fill(sheet, 'For how many years', '10');
    expect(previewLines(sheet)).toContain('Some of it is before today: it counts from today, and your measured figures may already count what has begun.');
    await press(button(sheet, 'Cancel'));
    await press(tab.chip('Part-time work'));
    sheet = tab.dialog() as FakeElement;
    await fill(sheet, 'From age', '55');
    await fill(sheet, 'To age', '60');
    await fill(sheet, 'Income a year', '20000');
    expect(preview(sheet)).toBe('In this what-if, FI stays around 52, as in your plan: part-time work counts from your stop age on, in Will it last?, not in when you reach FI.');
    // Every field filled, one out of range: not "fill in".
    await fill(sheet, 'To age', '50');
    expect(preview(sheet)).toBe('Once the figures are in range, this says how they move your FI age.');
    await tab.unmount();
  });

  test('8d’s kinds as templates: a windfall, a raise and a loan paid off move FI sooner; one before today is left out, and says so', async () => {
    const tab = await render({ 'GET /api/plan-scenarios': listing() });
    await press(tab.chip('A windfall'));
    let sheet = tab.dialog() as FakeElement;
    expect((field(sheet, 'Name') as unknown as { value: string }).value).toBe('A windfall');
    expect(preview(sheet)).toBe('Fill in the figures to see how it moves your FI age.');
    await fill(sheet, 'At age', '45');
    await fill(sheet, 'Amount, after tax', '200000');
    expect(previewLines(sheet)).toEqual(['In this what-if, FI moves from around 52 to around 49 (3 years sooner).', 'Try it makes this the scenario “A windfall at 45”, and opens it.']);
    await press(button(sheet, 'Cancel'));
    await press(tab.chip('A raise'));
    sheet = tab.dialog() as FakeElement;
    await fill(sheet, 'From age', '42');
    await fill(sheet, 'Saved more a year', '10000');
    expect(preview(sheet)).toBe('In this what-if, FI moves from around 52 to around 50 (2 years sooner).');
    // From before today: your savings may already have it.
    await fill(sheet, 'From age', '38');
    expect(previewLines(sheet)[0]).toBe('In this what-if, FI stays around 52, as in your plan.');
    expect(previewLines(sheet)).toContain('It is before today, so it is left out: your measured figures may already count it.');
    await press(button(sheet, 'Cancel'));
    await press(tab.chip('Pay off a loan'));
    sheet = tab.dialog() as FakeElement;
    expect((field(sheet, 'Name') as unknown as { value: string }).value).toBe('A loan paid off');
    await fill(sheet, 'Paid off at age', '45');
    await fill(sheet, 'Spending less a year', '12000');
    expect(previewLines(sheet)).toEqual(['In this what-if, FI moves from around 52 to around 47 (5 years sooner).', 'Try it makes this the scenario “Pay off a loan at 45”, and opens it.']);
    await tab.unmount();
  });

  test('“Buy a car” every few years: Try it makes the scenario with that car, named after its first', async () => {
    let made: { events: LifeEvent[]; name: string } | null = null;
    const tab = await render({
      'GET /api/plan-scenarios': listing(),
      'POST /api/plan-scenarios': (call) => {
        made = call.body.scenario;
        return [200, { scenario: { ...call.body.scenario, id: 'new1', version: 1, createdAt: '2026-10-26T00:00:00.000Z', savedAt: '2026-10-26T00:00:00.000Z', rev: 'r1' } }];
      },
    });
    await press(tab.chip('Buy a car'));
    const sheet = tab.dialog() as FakeElement;
    await fill(sheet, 'At age', '45');
    await fill(sheet, 'Paid from your investments, each', '80000');
    const repeats = sheet.findAll((e) => e.tagName === 'LABEL' && e.textContent.trim() === 'Every few years')[0].findAll((e) => e.tagName === 'INPUT')[0];
    await act(async () => {
      repeats.checked = true;
      click(repeats);
    });
    await settle();
    expect(preview(sheet)).toBe('Fill in the figures to see how it moves your FI age.');
    await fill(sheet, 'Every how many years', '4');
    await fill(sheet, 'How many in all', '3');
    expect(preview(sheet)).toBe('In this what-if, FI moves from around 52 to around 56 (4 years later).');
    await press(button(sheet, 'Try it'));
    const { id: _, ...event } = made!.events[0];
    expect([made!.name, made!.events.length, event]).toEqual(['Buy a car at 45', 1, { kind: 'car', label: 'A car', atAge: 45, cost: 80_000, every: 4, times: 3 }]);
    expect(tab.bar()?.textContent).toContain('Scenario: Buy a car at 45');
    await tab.unmount();
  });

  test('a child wholly before today leaves the FI age where it is, and says why, without the part-time words', async () => {
    const tab = await render({ 'GET /api/plan-scenarios': listing() });
    await press(tab.chip('A child'));
    const sheet = tab.dialog() as FakeElement;
    await fill(sheet, 'From age', '30');
    await fill(sheet, 'More spending a year', '10000');
    await fill(sheet, 'For how many years', '5');
    expect(previewLines(sheet)[0]).toBe('In this what-if, FI stays around 52, as in your plan.');
    expect(previewLines(sheet)).toContain('Some of it is before today: it counts from today, and your measured figures may already count what has begun.');
    await tab.unmount();
  });

  test('without your age the templates are off, and why comes first: the same ask as the answer’s, before the choices; with a saved plan that can’t be read, there is no card', async () => {
    const tab = await render({ 'GET /api/fire-plan': [200, { plan: { ...PLAN, age: null }, currency: 'USD' }], 'GET /api/plan-scenarios': listing() });
    expect(tab.chip('Buy a home')?.getAttribute('disabled')).not.toBeNull();
    const card = tab.card()!;
    expect(card.textContent).toContain('A life choice is placed by age.Add your age');
    expect(card.textContent).not.toContain('Type your age first');
    // Read before the choices it is about (the screen review).
    const order = card.findAll(() => true);
    const ask = button(card, 'Add your age')!;
    expect(classOf(ask)).toEqual(['btn', 'ghost', 'hero-ask']);
    expect(order.indexOf(ask)).toBeLessThan(order.indexOf(tab.chip('Buy a home')!));
    await tab.unmount();
    const broken = await render({ 'GET /api/fire-plan': [500, { error: 'no' }], 'GET /api/plan-scenarios': listing(entry({ name: 'Buy a home at 45', events: [home(200_000)] })) });
    expect(broken.card()).toBeNull();
    await broken.unmount();
  });

  /** The plan without an age, saved back as the Ages sheet sends it. */
  const ageless = (over: Record<string, unknown> = {}, plan: Record<string, unknown> = PLAN) => {
    let current: unknown = { ...plan, age: null };
    return {
      'GET /api/fire-plan': () => [200, { plan: current, currency: 'USD', ...over }] as [number, unknown],
      'PUT /api/fire-plan': (c: Call) => {
        current = c.body.plan;
        return [200, { plan: current, currency: 'USD', ...over }] as [number, unknown];
      },
    };
  };
  /** Types an age in the open Ages sheet and saves it. */
  const saveAge = async (tab: Awaited<ReturnType<typeof render>>) => {
    const form = tab.dialog()!;
    expect(form.getAttribute('aria-label')).toBe('Your ages');
    const [age] = form.findAll((e) => e.tagName === 'INPUT');
    await act(async () => type(age, '40'));
    await press(button(form, 'Save'));
    await settle(400);
  };
  const closeOf = (sheet: FakeElement) => sheet.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Close')[0] ?? null;

  test('its ask opens the Ages sheet; closed, focus is back on it, and once the age is saved, on the first life choice', async () => {
    const tab = await render({ ...ageless(), 'GET /api/plan-scenarios': listing() });
    const ask = () => (tab.card() ? button(tab.card()!, 'Add your age') : null);
    await press(ask());
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Your ages');
    await press(closeOf(tab.dialog()!));
    await settle(400);
    expect(dom.document.activeElement).toBe(ask()!);
    await press(ask());
    await saveAge(tab);
    expect(ask()).toBeNull();
    expect(tab.chip('Buy a home')?.getAttribute('disabled')).toBeNull();
    expect(dom.document.activeElement).toBe(tab.chip('Buy a home')!);
    await tab.unmount();
  }, 20_000);

  test('once the age is saved and the choices are still off (no currency, or the most scenarios kept), focus goes to the card’s title', async () => {
    const title = (tab: Awaited<ReturnType<typeof render>>) => tab.card()!.findAll((e) => e.getAttribute('id') === 'plan-what-if-title')[0];
    const full = Array.from({ length: MAX_PLAN_SCENARIOS }, (_, i) => entry({ id: `s${i}`, name: `Scenario ${i}` }));
    for (const [answers, said, over] of [
      // Nothing typed, no accounts and no currency: none to give a
      // scenario's amounts, and none needed to save the age.
      [{ ...ageless({ currency: null }, { ...DEFAULT_PLAN, targetAge: 55 }), 'GET /api/plan-scenarios': listing() }, 'Your plan has no currency yet', { currency: null }],
      [{ ...ageless(), 'GET /api/plan-scenarios': listing(...full) }, `You have ${MAX_PLAN_SCENARIOS} scenarios`, {}],
    ] as const) {
      const tab = await render(answers, over);
      const card = tab.card()!;
      // Why, before the choices, as the age is.
      const order = card.findAll(() => true);
      const reason = card.findAll((e) => e.tagName === 'P' && e.textContent.startsWith(said))[0];
      expect(order.indexOf(reason)).toBeLessThan(order.indexOf(tab.chip('Buy a home')!));
      await press(button(card, 'Add your age'));
      await saveAge(tab);
      expect(tab.chip('Buy a home')?.getAttribute('disabled')).not.toBeNull();
      expect(title(tab).getAttribute('tabindex')).toBe('-1');
      expect(dom.document.activeElement).toBe(title(tab));
      await tab.unmount();
    }
  }, 30_000);

  test('a refused save is said in the form, which stays open', async () => {
    const tab = await render({ 'GET /api/plan-scenarios': listing(), 'POST /api/plan-scenarios': [409, { error: 'Another scenario has that name: choose another, so they can be told apart.' }] });
    await press(tab.chip('A child'));
    const sheet = tab.dialog() as FakeElement;
    await fill(sheet, 'From age', '42');
    await fill(sheet, 'More spending a year', '15000');
    await fill(sheet, 'For how many years', '18');
    await press(button(sheet, 'Try it'));
    expect(tab.dialog()?.textContent).toContain('Another scenario has that name: choose another, so they can be told apart.');
    expect(tab.bar()?.textContent).not.toContain('Scenario:');
    await tab.unmount();
  });

  test('lists the scenarios as life choices, each with its FI age against your plan’s', async () => {
    const tab = await render({
      'GET /api/plan-scenarios': listing(
        entry({ id: 'a', name: 'Buy a home at 45', events: [home(200_000)] }),
        entry({ id: 'b', name: 'Spend less', events: [{ id: 'x', kind: 'spending', label: 'Less', fromAge: 41, yearly: -10_000, years: null }] }),
        entry({ id: 'c', name: 'A trip at 60', events: [{ id: 'x', kind: 'spending', label: 'Trip', fromAge: 60, yearly: 100, years: 1 }] }),
        entry({ id: 'd', name: 'A big home', events: [home(900_000, 42)] }),
        entry({ id: 'e', name: 'In euros', currency: 'EUR', set: { spending: 30_000 } })
      ),
    });
    expect(tab.rows()).toEqual([
      ['Buy a home at 45', 'FI around 56, 4 years later'],
      ['Spend less', 'FI around 47, 5 years sooner'],
      ['A trip at 60', 'FI around 52, as in your plan'],
      ['A big home', 'No FI date: a cost it can’t pay from its investments'],
      ['In euros', 'Not worked out: open it to see why'],
    ]);
    await press(tab.row('Spend less'));
    expect(tab.bar()?.textContent).toContain('Scenario: Spend less');
    // What the row said is what the scenario's FI card says.
    expect(tab.container.textContent).toContain('Financial independenceAround age 47');
    await tab.unmount();
  });

  test('with ten scenarios the templates are off, and it says why; a list that can’t load says so, with Try again', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => entry({ id: `s${i}`, name: `S${i}` }));
    const tab = await render({ 'GET /api/plan-scenarios': listing(...ten) });
    expect(tab.chip('Buy a home')?.getAttribute('disabled')).not.toBeNull();
    expect(tab.card()?.textContent).toContain('You have 10 scenarios, the most Nya keeps: delete one in Scenarios to try another.');
    await tab.unmount();

    // Unreadable and unrecognised ones count, as the server counts them.
    const stored = await render({ 'GET /api/plan-scenarios': [200, { scenarios: ten.slice(0, 8), unreadable_ids: ['u1'], unrecognised_ids: ['n1'] }] });
    expect(stored.chip('Buy a home')?.getAttribute('disabled')).not.toBeNull();
    expect(stored.card()?.textContent).toContain('You have 10 scenarios');
    await stored.unmount();

    let fail = true;
    const broken = await render({ 'GET /api/plan-scenarios': () => (fail ? [500, { error: 'Your saved scenarios couldn’t be loaded.' }] : listing(entry({ name: 'Back' }))) });
    expect(broken.card()?.textContent).toContain('Your saved scenarios couldn’t be loaded.');
    expect(broken.chip('Buy a home')?.getAttribute('disabled')).not.toBeNull();
    fail = false;
    await press(button(broken.card() as FakeElement, 'Try again'));
    expect(broken.rows()).toEqual([['Back', 'FI around 52, as in your plan']]);
    await broken.unmount();
  });

  test('with amounts hidden, the preview’s amounts are masked', async () => {
    setAmountsHidden(true);
    try {
      const tab = await render({ 'GET /api/plan-scenarios': listing() });
      await press(tab.chip('Buy a home'));
      const sheet = tab.dialog() as FakeElement;
      await fill(sheet, 'At age', '42');
      await fill(sheet, 'Paid from your investments', '900000');
      expect(preview(sheet)).toContain('you’d have about');
      expect(preview(sheet)).not.toMatch(/\d{3},\d{3}/);
      await tab.unmount();
    } finally {
      setAmountsHidden(false);
    }
  });
});

describe('life choices stacked in a scenario', () => {
  /** Saves a scenario as the server would, recording what was sent. */
  const saving = (sent: any[]): Record<string, Answer> => ({
    'PUT /api/plan-scenarios': (call) => {
      sent.push(call.body);
      return [200, { scenario: { ...entry(), ...call.body.scenario, id: call.body.id, rev: `r${sent.length + 1}` } }];
    },
  });
  const panel = (tab: Awaited<ReturnType<typeof render>>) => tab.container.findAll((e) => e.getAttribute('role') === 'tabpanel')[0];
  const titled = (words: string) => (e: FakeElement) => classOf(e).includes('card') && e.findAll((t) => classOf(t).includes('inst-name') && t.textContent.trim() === words).length > 0;
  const lifeCard = (tab: Awaited<ReturnType<typeof render>>) => panel(tab).findAll(titled('Life events'))[0] ?? null;
  const chipIn = (within: FakeElement, label: string) => within.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('chip') && e.textContent.trim() === label)[0] ?? null;
  const spending = (n: number): LifeEvent => ({ id: `g${n}`, kind: 'spending', label: `Gym ${n}`, fromAge: 60, yearly: 10, years: 1 });

  test('in an open scenario its life events take the What if… card’s place, with the same choices, and one more adds to it, previewed against the scenario', async () => {
    const sent: any[] = [];
    const tab = await render({ 'GET /api/plan-scenarios': listing(entry({ name: 'Buy a home at 45', events: [home(200_000)] })), ...saving(sent) });
    await press(tab.row('Buy a home at 45'));
    const cards = panel(tab).findAll((e) => e.tagName === 'SECTION' || classOf(e).includes('card'));
    const at = (pred: (e: FakeElement) => boolean) => cards.findIndex(pred);
    const figures = at((e) => classOf(e).includes('plan-inputs'));
    const life = at(titled('Life events'));
    expect(life).toBeGreaterThan(figures);
    expect(at(titled('Income and one-off expenses'))).toBeGreaterThan(life);
    const card = lifeCard(tab)!;
    expect(WHAT_IF_TEMPLATES.map((t) => chipIn(card, t.label) !== null)).toEqual(WHAT_IF_TEMPLATES.map(() => true));
    await press(chipIn(card, 'A career break'));
    const sheet = tab.dialog() as FakeElement;
    expect(sheet.textContent).toContain('A career break (Buy a home at 45)');
    expect((field(sheet, 'Name') as unknown as { value: string }).value).toBe('A career break');
    expect(preview(sheet)).toBe('Fill in the figures to see how it moves your FI age.');
    await fill(sheet, 'From age', '45');
    await fill(sheet, 'For how many years', '2');
    await fill(sheet, 'Saved less a year', '30000');
    // Against the scenario as it is (FI around 56 with its home), not your plan.
    expect(previewLines(sheet)).toEqual(['In this scenario, FI moves from around 56 to around 57 (1 year later).']);
    expect(button(sheet, 'Save')).toBeNull();
    await press(button(sheet, 'Add to this scenario'));
    expect(sent.length).toBe(1);
    expect(sent[0].based_on).toBe('r1');
    expect(sent[0].scenario.events.map((e: LifeEvent) => e.kind)).toEqual(['house', 'sabbatical']);
    // Both are listed, and the scenario's answer counts both.
    expect(tab.dialog()).toBeNull();
    expect(lifeCard(tab)!.textContent).toContain('Buying a home');
    expect(lifeCard(tab)!.textContent).toContain('A career break');
    expect(panel(tab).textContent).toContain('Around age 57');
    // Nothing was saved to your plan.
    expect(tab.calls.filter((c) => c.url === '/api/fire-plan' && c.method !== 'GET')).toEqual([]);
    await tab.unmount();
  });

  test('changing one of its events previews the change alone, against the scenario as it is', async () => {
    const tab = await render({ 'GET /api/plan-scenarios': listing(entry({ name: 'Buy a home at 45', events: [home(200_000)] })) });
    await press(tab.row('Buy a home at 45'));
    await press(lifeCard(tab)!.findAll((e) => e.getAttribute('aria-label') === 'Edit Buying a home')[0]);
    const sheet = tab.dialog() as FakeElement;
    expect(preview(sheet)).toBe('In this scenario, FI stays around 56.');
    await fill(sheet, 'Paid from your investments', '100000');
    expect(preview(sheet)).toBe('In this scenario, FI moves from around 56 to around 54 (2 years sooner).');
    expect(button(sheet, 'Save')).not.toBeNull();
    await tab.unmount();
  });

  test('the tenth turns the choices off, says why, and focus goes to the card’s title', async () => {
    const sent: any[] = [];
    const nine = Array.from({ length: 9 }, (_, i) => spending(i));
    const tab = await render({ 'GET /api/plan-scenarios': listing(entry({ name: 'Many', events: nine })), ...saving(sent) });
    await press(tab.row('Many'));
    const windfall = chipIn(lifeCard(tab)!, 'A windfall')!;
    expect(windfall.disabled).toBe(false);
    // As a browser: pressed, it takes focus, and once off it can't (mini-dom
    // would focus it anyway), so the sheet's giving focus back to it leaves
    // focus in the sheet as it slides out.
    const focusIt = windfall.focus.bind(windfall);
    windfall.focus = () => {
      if (!windfall.disabled) focusIt();
    };
    await act(async () => windfall.focus());
    await press(windfall);
    const sheet = tab.dialog() as FakeElement;
    await fill(sheet, 'At age', '60');
    await fill(sheet, 'Amount, after tax', '1000');
    await press(button(sheet, 'Add to this scenario'));
    await settle(400);
    expect(sent[0].scenario.events.length).toBe(10);
    const card = lifeCard(tab)!;
    expect(WHAT_IF_TEMPLATES.every((t) => chipIn(card, t.label)?.disabled)).toBe(true);
    expect(card.textContent).toContain('A scenario holds at most 10 life events.');
    expect(dom.document.activeElement?.textContent).toBe('Life events');
    await tab.unmount();
  });

  test('an event removed: its Edit is gone, so focus goes to the card’s title', async () => {
    const sent: any[] = [];
    const tab = await render({ 'GET /api/plan-scenarios': listing(entry({ name: 'Two', events: [spending(1), spending(2)] })), ...saving(sent) });
    await press(tab.row('Two'));
    const edit = lifeCard(tab)!.findAll((e) => e.getAttribute('aria-label') === 'Edit Gym 1')[0];
    await act(async () => edit.focus());
    await press(edit);
    await press(button(tab.dialog() as FakeElement, 'Remove from this scenario'));
    await settle(400);
    expect(sent[0].scenario.events.map((e: LifeEvent) => e.id)).toEqual(['g2']);
    expect(dom.document.activeElement?.textContent).toBe('Life events');
    await tab.unmount();
  });

  test('what the scenario’s other events leave out isn’t said under a new one’s preview', async () => {
    const child: LifeEvent = { id: 'c', kind: 'child', label: 'A child', fromAge: 30, yearly: 10_000, years: 5 };
    const tab = await render({ 'GET /api/plan-scenarios': listing(entry({ name: 'Kids', events: [child] })) });
    await press(tab.row('Kids'));
    // The child is before today, and its row says so.
    expect(lifeCard(tab)!.textContent).toContain('Some of it is before today');
    await press(chipIn(lifeCard(tab)!, 'A career break'));
    const sheet = tab.dialog() as FakeElement;
    await fill(sheet, 'From age', '45');
    await fill(sheet, 'For how many years', '2');
    await fill(sheet, 'Saved less a year', '30000');
    expect(previewLines(sheet)).toEqual(['In this scenario, FI moves from around 52 to around 53 (1 year later).']);
    await tab.unmount();
  });

  test('a scenario with more than one life event says how many in its row', async () => {
    const tab = await render({ 'GET /api/plan-scenarios': listing(entry({ name: 'Two', events: [spending(1), spending(2)] })) });
    expect(tab.rows()[0][1]).toMatch(/ \(2 life events\)$/);
    await tab.unmount();
  });
});

describe('its words', () => {
  const plan = { kind: 'age', age: 52 } as const;
  test('in a scenario: the preview against it as it is, a stack’s row, and a draft among its events', () => {
    const money = (n: number) => `$${n}`;
    const now = { kind: 'age', age: 56 } as const;
    const say = (when: Parameters<typeof previewText>[0], kind: LifeEvent['kind'] | null = null) => previewText(when, now, money, kind, true, 'scenario');
    expect(say({ kind: 'age', age: 57 })).toBe('In this scenario, FI moves from around 56 to around 57 (1 year later).');
    expect(say({ kind: 'age', age: 56 })).toBe('In this scenario, FI stays around 56.');
    expect(say({ kind: 'age', age: 56 }, 'part-time')).toBe('In this scenario, FI stays around 56: part-time work counts from the stop age on, in Will it last?, not in when you reach FI.');
    expect(previewText({ kind: 'age', age: 50 }, { kind: 'not-run' }, money, null, true, 'scenario')).toBe('In this scenario, FI comes around 50.');
    expect(say({ kind: 'now' })).toBe('In this scenario, you’re at FI.');
    expect(say({ kind: 'never' })).toBe('In this scenario, FI isn’t reached at this savings rate.');
    expect(say({ kind: 'not-run' })).toBe('In this scenario, the figures can’t be worked out: a lasting change takes spending in retirement below zero.');
    expect(say(null)).toBe('Fill in the figures to see how it moves your FI age.');
    expect(scenarioRowText(0, { kind: 'age', age: 53 }, plan)).toBe('FI around 53, 1 year later');
    expect(scenarioRowText(1, { kind: 'age', age: 53 }, plan)).toBe('FI around 53, 1 year later');
    expect(scenarioRowText(3, { kind: 'age', age: 53 }, plan)).toBe('FI around 53, 1 year later (3 life events)');
    const a = home(1);
    const b = { ...home(2), id: 'b' };
    expect(withDraft([a], b)).toEqual([a, b]);
    // The same id: in its place.
    expect(withDraft([a, b], home(5))).toEqual([home(5), b]);
  });
  test('a scenario’s line', () => {
    expect(lifeChoiceText({ kind: 'age', age: 53 }, plan)).toBe('FI around 53, 1 year later');
    expect(lifeChoiceText({ kind: 'age', age: 49 }, plan)).toBe('FI around 49, 3 years sooner');
    expect(lifeChoiceText({ kind: 'age', age: 49 }, { kind: 'none' })).toBe('FI around 49');
    expect(lifeChoiceText({ kind: 'now' }, plan)).toBe('You’re at FI');
    expect(lifeChoiceText({ kind: 'now' }, { kind: 'now' })).toBe('You’re at FI, as in your plan');
    expect(lifeChoiceText({ kind: 'never' }, plan)).toBe('Not reached at this savings rate');
    expect(lifeChoiceText({ kind: 'age', age: 49 }, { kind: 'never' })).toBe('FI around 49, where your plan isn’t reached at this savings rate');
    expect(lifeChoiceText({ kind: 'none' }, plan)).toBe('No FI age worked out');
  });
  test('a plan’s FI age as the FI card’s headline says it', () => {
    const f = (yearsToFi: number | null, fiAge: number | null, age: number | null = 40) => ({ view: { yearsToFi, fiAge }, plan: { age, targetAge: 55 }, short: null }) as unknown as import('@/lib/fire/plan-figures').PlanFigures;
    expect(fiWhen(f(11.6, 51.6))).toEqual({ kind: 'age', age: 52 });
    expect(fiWhen(f(0, 40))).toEqual({ kind: 'now' });
    expect(fiWhen(f(Infinity, null))).toEqual({ kind: 'never' });
    expect(fiWhen(f(70, 110))).toEqual({ kind: 'said', text: 'Not before age 100 at this savings rate' });
    expect(lifeChoiceText(fiWhen(f(70, 110)), plan)).toBe('Not before age 100 at this savings rate');
    expect(fiWhen(f(null, null))).toEqual({ kind: 'none' });
    expect(fiWhen(null)).toEqual({ kind: 'not-run' });
  });
  test('the preview', () => {
    const money = (n: number) => `$${n}`;
    expect(previewText({ kind: 'age', age: 52 }, plan, money)).toBe('In this what-if, FI stays around 52, as in your plan.');
    expect(previewText({ kind: 'never' }, plan, money)).toBe('In this what-if: Not reached at this savings rate.');
  });
  test('a scenario’s name, from the event’s age, and another when it is taken', () => {
    const t = WHAT_IF_TEMPLATES.find((x) => x.id === 'home')!;
    const e = home(1, 38);
    expect(whatIfName(t, e, [])).toBe('Buy a home at 38');
    expect(whatIfName(t, e, [{ id: 'a', name: 'buy a home at 38' }])).toBe('Buy a home at 38 (2)');
    expect(whatIfName(t, e, [{ id: 'a', name: 'Buy a home at 38' }, { id: 'b', name: 'Buy a home at 38 (2)' }])).toBe('Buy a home at 38 (3)');
    const part = WHAT_IF_TEMPLATES.find((x) => x.id === 'part-time')!;
    expect(whatIfName(part, { id: 'p', kind: 'part-time', label: 'P', fromAge: 50, toAge: 60, yearly: 1 }, [])).toBe('Part-time work from 50');
    // 8d's kinds, from their first age.
    const of = (id: string) => WHAT_IF_TEMPLATES.find((x) => x.id === id)!;
    expect([
      whatIfName(of('car'), { id: 'v', kind: 'car', label: 'C', atAge: 45, cost: 1, every: 4, times: 3 }, []),
      whatIfName(of('raise'), { id: 'r', kind: 'raise', label: 'R', fromAge: 42, yearly: 1 }, []),
      whatIfName(of('windfall'), { id: 'w', kind: 'windfall', label: 'W', atAge: 60, amount: 1 }, []),
      whatIfName(of('loan-end'), { id: 'l', kind: 'loan-end', label: 'L', atAge: 48, yearly: 1 }, []),
    ]).toEqual(['Buy a car at 45', 'A raise at 42', 'A windfall at 60', 'Pay off a loan at 48']);
  });
  test('no template suggests an amount', () => {
    for (const t of WHAT_IF_TEMPLATES) expect(`${t.label} ${t.name}`).not.toMatch(/\d|\$/);
  });
});
