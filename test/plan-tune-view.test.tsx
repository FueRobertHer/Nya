import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { planPage } from './plan-page';

// Tune to a goal on the page, on the real routes: the row, nothing chosen by default, the
// job's states, the table and its sort, a row's own sheet, and what Use and Try send.

const page = await planPage();
const { PLAN, WITH_BALANCES, seedPlan, render, press, button, closeOf, fill, pick, calls, settle, classOf, stored, answers, act, click } = page;
type Tab = Awaited<ReturnType<typeof render>>;
type Node = NonNullable<ReturnType<Tab['dialog']>>;

const WAY_IN = 'Work out tax from your accounts';
const account = (subtype: string, balance: number) => ({ institutions: [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [{ account_id: 'k', name: subtype, type: 'investment', subtype, balance, currency: 'USD' }] }] as never });
/** A 401(k), so the rules have something to convert. */
const WITH_ACCOUNTS = account('401k', 600_000);

async function detailed(plan = PLAN, props: Parameters<typeof render>[0] = WITH_ACCOUNTS) {
  await seedPlan(plan);
  const tab = await render({ ...WITH_BALANCES, ...props });
  await pick(tab.container, 'Drawdown');
  await press(tab.row(WAY_IN));
  await press(button(tab.dialog(), 'Work it out'));
  return tab;
}
/** With the ACA set, so its limit is offered. */
async function onAca(plan = PLAN, props: Parameters<typeof render>[0] = WITH_ACCOUNTS) {
  const tab = await detailed(plan, props);
  await pick(tab.container, 'Your path');
  await press(tab.row('Health coverage'));
  await pick(tab.dialog()!, 'ACA marketplace');
  await fill(tab.dialog()!, 'Benchmark plan', '11,000');
  await fill(tab.dialog()!, 'Quoted for age', '50');
  await press(button(tab.dialog(), 'Save'));
  await settle(200);
  await pick(tab.container, 'Drawdown');
  return tab;
}
const TUNE = 'Tune to a goal';
const LEFT = 'Most left';
const COST = 'Least tax and health costs';

const open = async (tab: Tab) => {
  await press(tab.row(TUNE));
  return tab.dialog()!;
};
const tableOf = (tab: Tab) => tab.dialog()?.findAll((e) => e.tagName === 'TABLE' && classOf(e).includes('plan-rules-table'))[0] ?? null;
/** The job is real and takes some rests of the page's clock. */
const waitForTable = async (tab: Tab) => {
  for (let i = 0; i < 400 && !tableOf(tab); i++) await settle(50);
  if (!tableOf(tab)) throw new Error('no table');
  return tableOf(tab)!;
};
/** Opens the sheet and tunes it for a goal and any limits. */
const tuned = async (tab: Tab, goal = LEFT, limits: string[] = []) => {
  const sheet = await open(tab);
  await pick(sheet, goal);
  for (const limit of limits) await pick(tab.dialog()!, limit);
  await press(button(tab.dialog(), 'Tune'));
  return waitForTable(tab);
};

const bodyRows = (table: Node) => table.findAll((e) => e.tagName === 'TR').filter((r) => r.findAll((c) => c.getAttribute('scope') === 'row').length > 0);
const ruleOf = (row: Node) => row.findAll((c) => c.getAttribute('scope') === 'row')[0].findAll((e) => e.tagName === 'BUTTON')[0];
const nameOf = (row: Node) => ruleOf(row).textContent ?? '';
const noteOf = (row: Node) => row.findAll((e) => classOf(e).includes('list-row-sub'))[0]?.textContent ?? '';
const ruleNames = (table: Node) => bodyRows(table).map(nameOf);
const named = (table: Node, start: string) => bodyRows(table).find((r) => nameOf(r).startsWith(start))!;
const heading = (table: Node, text: string) => table.findAll((e) => e.getAttribute('scope') === 'col' && (e.textContent ?? '').startsWith(text))[0];
const sortButton = (th: Node) => th.findAll((e) => e.tagName === 'BUTTON')[0];
const cell = (row: Node, n: number) => row.findAll((c) => c.tagName === 'TD')[n].textContent ?? '';
const figure = (row: Node, n: number) => Number(cell(row, n).replace(/[^\d]/g, ''));
const backOf = (sheet: Node) => sheet.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Back')[0];
const subOf = (row: Node | null) => row?.findAll((e) => classOf(e).includes('list-row-sub'))[0]?.textContent;
const inputs = (sheet: Node, type: string) => sheet.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === type);
const puts = () => calls().filter((c) => c.method === 'PUT' && c.path === '/api/fire-plan');
const posts = () => calls().filter((c) => c.method === 'POST' && c.path === '/api/plans');
const disabled = (el: Node | null) => el?.getAttribute('disabled') !== undefined && el?.getAttribute('disabled') !== null;

/** The setting a row's name says, as a person would read it. */
const untilOf = (name: string) => Number(/until (\d+)/.exec(name)?.[1] ?? /at (\d+) only/.exec(name)?.[1]);

/** Holds what `path` is sent by `method`, outside the page's own count, until it is let go. */
const holding = async (method: string, path: string, run: (letGo: () => void) => Promise<void>) => {
  const real = globalThis.fetch;
  const waiting: (() => void)[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith(path) && init?.method === method ? new Promise<Response>((resolve) => waiting.push(() => resolve(real(input, init)))) : real(input, init)) as typeof fetch;
  try {
    await run(() => waiting.splice(0).forEach((go) => go()));
  } finally {
    globalThis.fetch = real;
  }
};

const { planTune, planSearch } = await import('@/components/plan-search');
const { TunedAnswer, TuneForm, TuneLevel } = await import('@/components/PlanTune');
const { wholeMoney } = await import('@/components/plan-text');
const { DEFAULT_TAX_CHOICES } = await import('@/lib/fire/tax-choices');
const { DEFAULT_TAX_FACTS } = await import('@/lib/fire/tax-facts');
const { NO_STRATEGY } = await import('@/lib/fire/tax/rules');

describe('the row', () => {
  test('only where Compare is: in the detailed model', async () => {
    await seedPlan();
    const simple = await render({ ...WITH_BALANCES, ...WITH_ACCOUNTS });
    await pick(simple.container, 'Drawdown');
    expect(simple.row(TUNE)).toBeNull();
    await press(simple.row(WAY_IN));
    await press(button(simple.dialog(), 'Work it out'));
    const row = simple.row(TUNE)!;
    expect(subOf(row)).toBe('Each rule’s settings worked out for a goal you pick');
    expect(row.getAttribute('aria-haspopup')).toBe('dialog');
    await simple.unmount();
  }, 30_000);

  test('a rule that spends differently under each setting says why it isn’t offered', async () => {
    const tab = await detailed({ ...PLAN, rule: 'vpw' });
    expect(tab.row(TUNE)).toBeNull();
    expect(tab.text()).toContain('Tune to a goal needs the Constant withdrawal rule.');
    await tab.unmount();
  }, 30_000);

  for (const rule of ['percent', 'guardrails', 'floor-ceiling'] as const) {
    test(`nor ${rule}`, async () => {
      const tab = await detailed({ ...PLAN, rule });
      expect(tab.row(TUNE)).toBeNull();
      expect(tab.text()).toContain('needs the Constant withdrawal rule');
      await tab.unmount();
    }, 30_000);
  }

  test('on the Constant rule it says nothing of the kind', async () => {
    const tab = await detailed();
    expect(tab.row(TUNE)).not.toBeNull();
    expect(tab.text()).not.toContain('needs the Constant withdrawal rule');
    await tab.unmount();
  }, 30_000);

  test('About these numbers has the tie rule and what it holds', async () => {
    const tab = await detailed();
    await press(tab.row('About these numbers'));
    const about = tab.dialog()!.textContent ?? '';
    expect(about).toContain('Tune to a goal keeps a setting only if it stays inside the limits you set');
    expect(about).toContain('Where settings tie, to the dollar, it keeps your plan’s own');
    await tab.unmount();
  }, 30_000);
});

describe('the sheet', () => {
  test('nothing is chosen for you: no goal, no limit, Tune off until a goal, nothing called best', async () => {
    const tab = await detailed();
    const sheet = await open(tab);
    expect(sheet.getAttribute('aria-label')).toBe(TUNE);
    expect(sheet.textContent).toContain('It doesn’t recommend one, and nothing changes until you choose.');
    expect(inputs(sheet, 'radio').filter((i) => i.checked).length).toBe(0);
    expect(inputs(sheet, 'checkbox').filter((i) => i.checked).length).toBe(0);
    expect(disabled(button(sheet, 'Tune'))).toBe(true);
    expect(sheet.textContent).not.toMatch(/\bbest\b/i);
    await pick(sheet, COST);
    expect(disabled(button(tab.dialog(), 'Tune'))).toBe(false);
    // A pick alone saves nothing and asks nothing.
    expect(tableOf(tab)).toBeNull();
    expect(puts().filter((c) => c.body.tax?.strategy?.conversions?.kind !== 'none')).toEqual([]);
    await tab.unmount();
  }, 30_000);

  const LIMITS = ['Stay under the ACA limit', 'Stay out of IRMAA’s surcharges', 'No higher than the 22% bracket'];
  const limitsIn = (sheet: Node) => LIMITS.filter((l) => (sheet.textContent ?? '').includes(l));

  test('the limits offered: the 22% bracket and, where Medicare is reached, IRMAA’s', async () => {
    const tab = await detailed();
    expect(limitsIn(await open(tab))).toEqual(LIMITS.slice(1));
    await tab.unmount();
  }, 30_000);

  test('the ACA’s only for someone on it, under the law that has a limit', async () => {
    const aca = await onAca();
    expect(limitsIn(await open(aca))).toEqual(LIMITS);
    await press(closeOf(aca.dialog()!));
    // With the enhanced credits back there’s no limit to stay under.
    await pick(aca.container, 'Your path');
    await press(aca.row('Health coverage'));
    await pick(aca.dialog()!, 'If the enhanced credits return');
    await press(button(aca.dialog(), 'Save'));
    await settle(200);
    await pick(aca.container, 'Drawdown');
    expect(limitsIn(await open(aca))).toEqual(LIMITS.slice(1));
    await aca.unmount();
  }, 60_000);

  test('after a tap on Tune, and only then, the answer takes focus; a level starts at its top and Back returns', async () => {
    const tab = await detailed();
    const table = await tuned(tab);
    const section = tab.dialog()!.findAll((e) => e.tagName === 'SECTION' && e.getAttribute('aria-labelledby') === 'plan-tune-answer')[0];
    expect(page.dom.document.activeElement).toBe(section);
    const body = tab.dialog()!.findAll((e) => classOf(e).includes('sheet-body'))[0];
    body.scrollTop = 240;
    await press(ruleOf(named(table, 'Fill the 12%')));
    await settle(300);
    expect(body.scrollTop).toBe(0);
    await press(backOf(tab.dialog()!));
    expect(body.scrollTop).toBe(240);
    await tab.unmount();
  }, 30_000);

  test('Tuning… while the job is out, then the table', async () => {
    const tune = planTune();
    const real = tune.answer;
    const tab = await detailed();
    const sheet = await open(tab);
    await pick(sheet, LEFT);
    try {
      tune.answer = () => null;
      await press(button(tab.dialog(), 'Tune'));
      const busy = button(tab.dialog(), 'Tuning…')!;
      expect(disabled(busy)).toBe(true);
      expect(tableOf(tab)).toBeNull();
    } finally {
      tune.answer = real;
      tune.retry();
    }
    await waitForTable(tab);
    expect(button(tab.dialog(), 'Tuning…')).toBeNull();
    await tab.unmount();
  }, 30_000);

  test('a job that fails says so, Try again asks again, and nothing was saved', async () => {
    const tune = planTune();
    const real = tune.answer;
    const tab = await detailed();
    const sheet = await open(tab);
    await pick(sheet, LEFT);
    const before = puts().length;
    try {
      tune.answer = () => ({ ok: false, error: 'nope' });
      await press(button(tab.dialog(), 'Tune'));
      expect(tab.dialog()!.textContent).toContain('This couldn’t be tuned. Try again.');
      expect(tab.dialog()!.textContent).not.toContain('nope');
      expect(tableOf(tab)).toBeNull();
      expect(disabled(button(tab.dialog(), 'Tune'))).toBe(false);
    } finally {
      tune.answer = real;
    }
    await press(button(tab.dialog(), 'Try again'));
    await waitForTable(tab);
    expect(tab.dialog()!.textContent).not.toContain('couldn’t be tuned');
    expect(puts().length).toBe(before);
    await tab.unmount();
  }, 30_000);

  test('a row for each rule in Compare’s order, sorted by nothing, with what is true of them all', async () => {
    const tab = await detailed();
    const table = await tuned(tab);
    const names = ruleNames(table);
    expect(names.length).toBe(4);
    expect(names[0]).toBe('None');
    expect(names[1]).toMatch(/^Fill the 10% bracket(, until \d+|, at \d+ only)?$/);
    expect(names[2]).toMatch(/^Fill the 12% bracket(, until \d+|, at \d+ only)?$/);
    expect(names[3]).toMatch(/^Fill the 22% bracket(, until \d+|, at \d+ only)?$/);
    expect(heading(table, 'Left at').getAttribute('aria-sort')).toBe('none');
    expect(heading(table, 'Tax and health').getAttribute('aria-sort')).toBe('none');
    const said = tab.dialog()!.textContent ?? '';
    expect(said).toMatch(/Tuned for the most left at \d+/);
    expect(said).toContain('Sort by your goal');
    expect(said).not.toContain('Nothing here is called best');
    expect(said).toContain('Each rule here keeps your stop, your start and what’s timed on them where they are now');
    expect(said).toContain('Tap a rule for Use in your plan or Try it in a copy.');
    expect(said).toMatch(/With None, your plan leaves \$[\d,]+\./);
    expect(said).toContain('Tuned for the goal you set, under these assumptions. Hypothetical, 2026 tax law, steady growth, health costs');
    expect(said).toContain('Not tax advice.');
    await tab.unmount();
  }, 30_000);

  test('it sorts by the goal when you ask, and says you asked', async () => {
    const tab = await detailed();
    const table = await tuned(tab);
    const compareOrder = ruleNames(table);
    // The button goes once used: focus goes to the answer, not to nothing.
    const section = tab.dialog()!.findAll((e) => e.tagName === 'SECTION' && e.getAttribute('aria-labelledby') === 'plan-tune-answer')[0];
    const sort = button(tab.dialog(), 'Sort by your goal')!;
    sort.focus();
    expect(page.dom.document.activeElement).toBe(sort);
    await press(sort);
    expect(page.dom.document.activeElement).toBe(section);
    const left = bodyRows(tableOf(tab)!).map((r) => figure(r, 0));
    expect(left).toEqual([...left].sort((a, b) => b - a));
    expect(heading(tableOf(tab)!, 'Left at').getAttribute('aria-sort')).toBe('descending');
    expect(tab.dialog()!.textContent).toContain('Sorted by your goal because you asked. Nothing here is called best.');
    expect(button(tab.dialog(), 'Sort by your goal')).toBeNull();
    // Sorting by another column brings the button back and takes the line away.
    await press(sortButton(heading(tableOf(tab)!, 'Tax and health')));
    expect(tab.dialog()!.textContent).not.toContain('Nothing here is called best');
    expect(button(tab.dialog(), 'Sort by your goal')).not.toBeNull();
    // Another goal is asked of the table afresh, in Compare's order.
    await pick(tab.dialog()!, COST);
    await press(button(tab.dialog(), 'Tune'));
    const cost = await waitForTable(tab);
    expect(heading(cost, 'Tax and health').getAttribute('aria-sort')).toBe('none');
    expect(ruleNames(cost)[0]).toBe('None');
    expect(ruleNames(cost).map((n) => n.split(',')[0])).toEqual(compareOrder.map((n) => n.split(',')[0]));
    // Which sorts lowest first.
    await press(button(tab.dialog(), 'Sort by your goal'));
    const costs = bodyRows(tableOf(tab)!).map((r) => figure(r, 1));
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
    expect(heading(tableOf(tab)!, 'Tax and health').getAttribute('aria-sort')).toBe('ascending');
    await tab.unmount();
  }, 30_000);

  test('changing a choice takes the table away, and Tune brings it back without another run', async () => {
    const tune = planTune();
    const tab = await detailed();
    await tuned(tab);
    await pick(tab.dialog()!, COST);
    expect(tableOf(tab)).toBeNull();
    expect(tab.dialog()!.textContent).not.toMatch(/Tuned for the/);
    const real = tune.answer;
    let asked = 0;
    tune.answer = (slot, job) => {
      const a = real(slot, job);
      if (a === null) asked++;
      return a;
    };
    try {
      await press(button(tab.dialog(), 'Tune'));
      // At once: the runs don't depend on the goal.
      expect(tableOf(tab)).not.toBeNull();
      expect(asked).toBe(0);
      expect(tab.dialog()!.textContent).toContain('Tuned for the least tax and health costs');
    } finally {
      tune.answer = real;
    }
    await tab.unmount();
  }, 30_000);

  test('a goal’s figures are the goal’s: the least cost is no more than any it could have shown, and each row says what it’s tuned for', async () => {
    const tab = await detailed();
    const left = await tuned(tab);
    const whenLeft = new Map(bodyRows(left).map((r) => [nameOf(r).split(',')[0], [figure(r, 0), figure(r, 1)]]));
    await pick(tab.dialog()!, COST);
    await press(button(tab.dialog(), 'Tune'));
    const cost = await waitForTable(tab);
    for (const r of bodyRows(cost)) {
      const was = whenLeft.get(nameOf(r).split(',')[0])!;
      expect(figure(r, 1)).toBeLessThanOrEqual(was[1]);
    }
    await tab.unmount();
  }, 30_000);

  test('where every setting of a rule breaks a limit, its row says what it crosses, and None breaking one means nothing is compared with it', async () => {
    const tab = await detailed();
    const table = await tuned(tab, LEFT, ['No higher than the 22% bracket']);
    const none = named(table, 'None');
    expect(noteOf(none)).toMatch(/Goes past the 22% bracket in \d+ years?/);
    for (const r of bodyRows(table)) expect(noteOf(r)).not.toContain('than None');
    await tab.unmount();
  }, 30_000);

  test('a rule that comes to no better than None on the goal says so, in the goal’s words', async () => {
    const tab = await detailed();
    const table = await tuned(tab, COST);
    const noneCost = figure(named(table, 'None'), 1);
    for (const r of bodyRows(table).slice(1)) {
      if (figure(r, 1) >= noneCost) expect(noteOf(r)).toContain('Costs no less than None');
      else expect(noteOf(r)).not.toContain('than None');
    }
    await tab.unmount();
  }, 30_000);

  test('an ACA limit asked of a plan on the ACA keeps a setting inside it, where one is', async () => {
    const tab = await onAca();
    const table = await tuned(tab, LEFT, ['Stay under the ACA limit']);
    const names = ruleNames(table);
    expect(names.at(-1)).toMatch(/^ACA limit, then the \d+% bracket/);
    expect(noteOf(named(table, 'ACA limit'))).not.toContain('Crosses the ACA limit');
    await tab.unmount();
  }, 30_000);
});

describe('a row’s own sheet', () => {
  /** A row that isn't the plan's, whose order is the plan's. */
  const otherRow = (table: Node) => bodyRows(table).find((r) => !(r.textContent ?? '').includes('Your plan') && nameOf(r).startsWith('Fill the 12%'))!;

  test('its figures, then Try and Use, and Back keeps the table, its goal and its sort', async () => {
    const tab = await detailed();
    const table = await tuned(tab);
    await press(button(tab.dialog(), 'Sort by your goal'));
    const row = otherRow(tableOf(tab)!);
    const name = nameOf(row);
    await press(ruleOf(row));
    await settle(300);
    const level = tab.dialog()!;
    expect(level.getAttribute('aria-label')).toBe(name);
    expect(level.textContent).toContain('Tax and health costs, in all');
    expect(level.textContent).toContain('Stage by stage');
    expect(level.textContent).toContain('Tuned for the goal you set');
    expect(tableOf(tab)).toBeNull();
    expect(button(level, 'Try it in a copy')).not.toBeNull();
    expect(button(level, 'Use in your plan')).not.toBeNull();
    await press(backOf(level));
    expect(ruleNames(tableOf(tab)!)).toContain(name);
    expect(tab.dialog()!.textContent).toContain('Sorted by your goal because you asked.');
    expect(table).toBeTruthy();
    await tab.unmount();
  }, 30_000);

  test('Use saves that setting, once, with its order and its age, and the page moves to it', async () => {
    const tab = await detailed();
    const table = await tuned(tab);
    const row = otherRow(table);
    const name = nameOf(row);
    await press(ruleOf(row));
    await settle(300);
    const before = puts().length;
    await press(button(tab.dialog(), 'Use in your plan'));
    await settle(300);
    expect(tab.dialog()).toBeNull();
    expect(puts().length).toBe(before + 1);
    const strategy = puts().at(-1)!.body.tax.strategy;
    expect(strategy.conversions).toEqual({ kind: 'bracket', top: 0.12 });
    expect(strategy.convertUntil).toBe(untilOf(name));
    expect(['standard', 'roth-before-deferred']).toContain(strategy.order);
    expect(subOf(tab.row('Roth conversions'))).toMatch(new RegExp(`^Fill the 12% bracket, until ${untilOf(name)}$`));
    // Tune again: the row now says it is your plan's, and its sheet offers nothing.
    const again = await tuned(tab);
    const mine = named(again, 'Fill the 12%');
    expect(mine.textContent).toContain('Your plan');
    // Its row is now what your plan comes to, as the line under the table says.
    expect(tab.dialog()!.textContent).toContain(`Your plan’s rule, until ${untilOf(nameOf(mine))}, leaves ${cell(mine, 0)}.`);
    const mineName = nameOf(mine);
    await press(ruleOf(mine));
    await settle(300);
    const level = tab.dialog()!;
    expect(level.textContent).toContain('Your plan has this rule.');
    expect(button(level, 'Use in your plan')).toBeNull();
    expect(button(level, 'Try it in a copy')).toBeNull();
    expect(level.getAttribute('aria-label')).toBe(mineName);
    await tab.unmount();
  }, 30_000);

  test('Use asks for no other table on its way out', async () => {
    const tune = planTune();
    const real = tune.answer;
    const tab = await detailed();
    const table = await tuned(tab);
    await press(ruleOf(otherRow(table)));
    await settle(300);
    let asked = 0;
    tune.answer = (slot, job) => {
      asked++;
      return real(slot, job);
    };
    try {
      await press(button(tab.dialog(), 'Use in your plan'));
      await settle(300);
    } finally {
      tune.answer = real;
    }
    expect(tab.dialog()).toBeNull();
    expect(asked).toBe(0);
    await tab.unmount();
  }, 30_000);

  test('a row in the other order says so, and Use carries it', async () => {
    const tab = await detailed(PLAN, { institutions: [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [{ account_id: 'k', name: '401(k)', type: 'investment', subtype: '401k', balance: 400_000, currency: 'USD' }, { account_id: 'r', name: 'Roth IRA', type: 'investment', subtype: 'roth', balance: 400_000, currency: 'USD' }] }] as never });
    const table = await tuned(tab);
    const row = named(table, 'Fill the 10%');
    expect(noteOf(row)).toContain('Roth before tax-deferred');
    await press(ruleOf(row));
    await settle(300);
    expect(tab.dialog()!.textContent).toContain('Order: Taxable, then Roth, then tax-deferred (your plan: Taxable, then tax-deferred, then Roth)');
    await press(button(tab.dialog(), 'Use in your plan'));
    await settle(300);
    expect(puts().at(-1)!.body.tax.strategy.order).toBe('roth-before-deferred');
    await tab.unmount();
  }, 30_000);

  test('Try makes one copy with that setting, named for it, opened on Drawdown, and your plan is as it was', async () => {
    const tab = await detailed();
    const table = await tuned(tab);
    const row = otherRow(table);
    const name = nameOf(row);
    await press(ruleOf(row));
    await settle(300);
    const was = posts().length;
    const before = puts().length;
    await press(button(tab.dialog(), 'Try it in a copy'));
    await settle(300);
    expect(tab.dialog()).toBeNull();
    expect(posts().length).toBe(was + 1);
    expect(puts().length).toBe(before);
    const made = posts().at(-1)!.body;
    expect(made.name).toBe(name);
    expect(made.tax.strategy.conversions).toEqual({ kind: 'bracket', top: 0.12 });
    expect(made.tax.strategy.convertUntil).toBe(untilOf(name));
    expect((await stored()).byName[name]).toBeTruthy();
    expect(tab.text()).toContain('Year by year');
    // In the copy, a row says it's the copy's, and Use goes to the copy.
    const inCopy = await tuned(tab);
    expect(named(inCopy, 'Fill the 12%').textContent).toContain('This copy');
    expect(inCopy.textContent).not.toContain('Your plan');
    expect(tab.dialog()!.textContent).toContain('Tap a rule for Use in this copy or Try it in a copy.');
    expect(tab.dialog()!.textContent).toMatch(/This copy’s rule, until \d+, leaves/);
    const none = named(inCopy, 'None');
    await press(ruleOf(none));
    await settle(300);
    const copyPuts = () => calls().filter((c) => c.method === 'PUT' && c.path === '/api/plans').length;
    const puttedBefore = copyPuts();
    await press(button(tab.dialog(), 'Use in this copy'));
    await settle(300);
    expect(tab.dialog()).toBeNull();
    expect(copyPuts()).toBe(puttedBefore + 1);
    expect(puts().length).toBe(before);
    expect(JSON.stringify(calls().filter((c) => c.method === 'PUT' && c.path === '/api/plans').at(-1)!.body)).toContain('"conversions":{"kind":"none"}');
    await tab.unmount();
  }, 30_000);

  test('a setting that comes to the same as your plan says so and offers nothing', async () => {
    // Only Roth money and no saving: there is nothing to convert.
    const tab = await detailed({ ...PLAN, savings: 0 }, account('roth', 600_000));
    const table = await tuned(tab);
    const row = bodyRows(table).find((r) => !(r.textContent ?? '').includes('Your plan'));
    if (!row) throw new Error('no row but your plan’s');
    await press(ruleOf(row));
    await settle(300);
    const level = tab.dialog()!;
    expect(level.textContent).toContain('This comes to the same as your plan.');
    expect(button(level, 'Use in your plan')).toBeNull();
    expect(button(level, 'Try it in a copy')).toBeNull();
    await tab.unmount();
  }, 30_000);

  test('a refused save is said on the sheet it belongs to, with Back and Close held while it is out', async () => {
    const tab = await detailed();
    const table = await tuned(tab);
    await press(ruleOf(otherRow(table)));
    await settle(300);
    await holding('PUT', '/api/fire-plan', async (letGo) => {
      answers['PUT /api/fire-plan'] = () => Response.json({ error: 'Not now, says the server.' }, { status: 500 });
      await act(async () => click(button(tab.dialog(), 'Use in your plan')!));
      await settle(100);
      const level = tab.dialog()!;
      expect(button(level, 'Saving…')).not.toBeNull();
      expect(disabled(button(level, 'Try it in a copy'))).toBe(true);
      // Its own save is why no copy can be made yet, and it needs no words.
      expect(level.textContent).not.toContain('A copy can’t be made just yet');
      await act(async () => click(backOf(level)));
      await act(async () => click(closeOf(level)!));
      await settle(50);
      expect(tab.dialog()!.textContent).toContain('Tax and health costs, in all');
      letGo();
      await settle(400);
    });
    const after = tab.dialog()!;
    expect(after.textContent).toContain('Stage by stage');
    expect(after.findAll((e) => e.getAttribute('role') === 'alert').length).toBe(1);
    expect(button(after, 'Use in your plan')).not.toBeNull();
    await tab.unmount();
  }, 30_000);

  test('a refused copy is said on that sheet too, with Back and Close held', async () => {
    const tab = await detailed();
    const table = await tuned(tab);
    await press(ruleOf(otherRow(table)));
    await settle(300);
    await holding('POST', '/api/plans', async (letGo) => {
      answers['POST /api/plans'] = () => Response.json({ error: 'Not now, says the server.' }, { status: 500 });
      await act(async () => click(button(tab.dialog(), 'Try it in a copy')!));
      await settle(100);
      const level = tab.dialog()!;
      expect(button(level, 'Saving…')).not.toBeNull();
      expect(disabled(button(level, 'Use in your plan'))).toBe(true);
      expect(level.textContent).not.toContain('A copy can’t be made just yet');
      await act(async () => click(backOf(level)));
      await act(async () => click(closeOf(level)!));
      await settle(50);
      expect(tab.dialog()!.textContent).toContain('Tax and health costs, in all');
      letGo();
      await settle(400);
    });
    const after = tab.dialog()!;
    expect(after.textContent).toContain('Stage by stage');
    expect(after.findAll((e) => e.getAttribute('role') === 'alert').length).toBe(1);
    await tab.unmount();
  }, 30_000);
});

describe('what only some plans see', () => {
  test('once required withdrawals have started, the order is all there is to tune', async () => {
    const tab = await detailed({ ...PLAN, age: 76, targetAge: 76 });
    const table = await tuned(tab);
    expect(ruleNames(table)).toEqual(['None']);
    expect(tab.dialog()!.textContent).toContain('Required withdrawals have started, so the order is all there is to tune.');
    await tab.unmount();
  }, 30_000);

  test('a plan with rules to tune doesn’t say so', async () => {
    const tab = await detailed();
    await tuned(tab);
    expect(tab.dialog()!.textContent).not.toContain('Required withdrawals have started');
    await tab.unmount();
  }, 30_000);

  test('where Medicare’s first years have no income to read, IRMAA’s limit says so once it is picked', async () => {
    const tab = await detailed({ ...PLAN, age: 64, targetAge: 64 });
    const sheet = await open(tab);
    const WORDS = 'Medicare’s first years here have no income from two years before to read';
    expect(sheet.textContent).not.toContain(WORDS);
    await pick(sheet, 'Stay out of IRMAA’s surcharges');
    expect(tab.dialog()!.textContent).toContain(WORDS);
    await tab.unmount();
  }, 30_000);
});

describe('the sheet’s other states, drawn alone', () => {
  const row = (over = {}) => ({ key: 'fill-12', crossing: [], beatsNone: true, mine: false, run: { row: 'fill-12', strategy: { order: 'standard' as const, conversions: { kind: 'bracket' as const, top: 0.12 as const }, convertUntil: 60 }, left: 1_000_000, cost: 200_000, short: null, unpaid: 0, converted: 50_000, crosses: { aca: 0, irmaa: 0, 'bracket-22': 0 } }, ...over });
  const money = (n: number) => wholeMoney(n, 'USD');
  const form = { choices: { ...DEFAULT_TAX_CHOICES, strategy: NO_STRATEGY }, facts: DEFAULT_TAX_FACTS, factsLocked: false, stateTaxes: {} as never, statute: {} as never, calendarYear: 2026, save: async () => true as const };
  const shared = { plan: PLAN, onSave: async () => true, onDone: () => {}, editable: true, detail: form, money, lawYear: 2026, healthGrowth: 0.021, copyOpen: false, whyNot: null, now: null, onTry: async () => true as const };
  const NO_ANSWER = { drawn: null, stop: null, start: null, working: false, failed: false };
  const ASK_LEFT = { goal: 'left', limits: [] } as const;
  const drew = (over: object) => ({ ...NO_ANSWER, drawn: { leftAtEnd: 900_000, taxAndHealth: 300_000, runsOutAt: null, years: [], stages: [], aca: { on: 0, withCredit: 0 }, ...over } as never });
  /** Worked out, with figures of its own. */
  const READY = drew({});

  test('with no drawdown to tune it says so, and Tune stays off', () => {
    const html = renderToStaticMarkup(<TuneForm {...shared} used={() => NO_ANSWER} job={null} offers={{ aca: false, irmaa: false }} irmaaUnknown={false} held={false} level={null} onLevel={() => {}} />);
    expect(html).toContain('These can’t be tuned right now.');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Tune</);
  });

  test('a setting that can’t be worked out once used shows the row’s figures, says so, and offers neither', () => {
    const html = renderToStaticMarkup(<TuneLevel {...shared} row={row()} ask={ASK_LEFT} used={() => ({ ...NO_ANSWER, failed: true })} />);
    expect(html).toContain('This couldn’t be worked out once used, so Use in your plan and Try it in a copy are off.');
    expect(html).toContain('$1,000,000');
    expect(html).toContain('$200,000');
    expect(html).not.toContain('>Use in your plan<');
    expect(html).not.toContain('>Try it in a copy<');
  });

  test('saving paused: its words above the buttons, and Use off', () => {
    const html = renderToStaticMarkup(<TuneLevel {...shared} editable={false} paused="Your plan is out of date." whyNot="Your plan is out of date." row={row()} ask={ASK_LEFT} used={() => READY} />);
    expect(html.match(/Your plan is out of date\./g)?.length).toBe(1);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Use in your plan</);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Try it in a copy</);
  });

  test('why no copy can be made is said, with Try off', () => {
    const html = renderToStaticMarkup(<TuneLevel {...shared} whyNot="A copy can’t be made just yet." row={row()} ask={ASK_LEFT} used={() => READY} />);
    expect(html).toContain('A copy can’t be made just yet.');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Try it in a copy</);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Use in your plan</);
  });

  test('what a level says it crosses is of the figures on show, not the row’s', () => {
    const year = (irmaaTier: number) => ({ age: 60, conversion: 0, care: { overLimit: false, people: [{ irmaaTier }] }, law: { topRate: 0.12 } });
    const irmaa = { goal: 'left', limits: ['irmaa'] } as const;
    const level = (over: object, ask: typeof irmaa | typeof ASK_LEFT, answer: object) => renderToStaticMarkup(<TuneLevel {...shared} row={row(over)} ask={ask} used={() => answer as never} />);
    // The row crossed nothing, and as used it does.
    expect(level({}, irmaa, drew({ years: [year(1), year(1), year(0)] }))).toContain('Pays IRMAA’s surcharge in 2 years');
    // The row crossed, and as used it doesn't.
    expect(level({ crossing: [{ limit: 'irmaa', years: 5 }] }, irmaa, drew({ years: [year(0)] }))).not.toContain('IRMAA');
    // What wasn't asked isn't said.
    expect(level({}, ASK_LEFT, drew({ years: [year(1)] }))).not.toContain('IRMAA');
    // No figures of its own: those on show are the row's, and so are the words.
    expect(level({ crossing: [{ limit: 'irmaa', years: 5 }] }, irmaa, { ...NO_ANSWER, failed: true })).toContain('Pays IRMAA’s surcharge in 5 years');
  });

  test('how a level stands to None is said only where its figures are the row’s', () => {
    const level = (answer: object) => renderToStaticMarkup(<TuneLevel {...shared} row={row({ beatsNone: false })} ask={ASK_LEFT} used={() => answer as never} />);
    const WORDS = 'Leaves no more than None';
    expect(level(READY)).not.toContain(WORDS);
    expect(level(drew({ leftAtEnd: 1_000_000, taxAndHealth: 200_000 }))).toContain(WORDS);
    expect(level({ ...NO_ANSWER, failed: true })).toContain(WORDS);
    // Still being worked out, its figures aren't known to be the row's.
    expect(level({ ...drew({ leftAtEnd: 1_000_000, taxAndHealth: 200_000 }), working: true })).not.toContain(WORDS);
  });

  test('once required withdrawals have started, a rule of the plan’s own beside None doesn’t hide why', () => {
    const answer = (until: number) => renderToStaticMarkup(<TunedAnswer ask={ASK_LEFT} rows={[row({ key: 'none' }), row()]} own={NO_STRATEGY} until={until} now={{ drawn: { leftAtEnd: 1, taxAndHealth: 1, runsOutAt: null, years: [{ age: 76 }] } as never, stop: 76, start: 1 }} sort={null} onSort={() => {}} held={false} onRow={() => {}} money={money} lawYear={2026} healthGrowth={0.021} copyOpen={false} />);
    expect(answer(72)).toContain('Required withdrawals have started');
    expect(answer(80)).not.toContain('Required withdrawals have started');
  });
});

describe('a plan that moves when a rule is used', () => {
  const MOVES = { ...PLAN, stopAtFi: true, targetAge: null, spending: 60_000, savings: 40_000 } as typeof PLAN;

  test('its row is the plan held where it is; its sheet works out what it comes to, with Use off until then, and says what moved', async () => {
    const search = planSearch();
    const real = search.answer;
    const tab = await detailed(MOVES);
    await settle(400);
    const table = await tuned(tab);
    const row = named(table, 'Fill the 22%');
    const said = cell(row, 0);
    try {
      search.answer = () => null;
      await press(ruleOf(row));
      const level = tab.dialog()!;
      expect(level.textContent).toContain('Working it out');
      expect(level.findAll((e) => e.getAttribute('aria-busy') === 'true').length).toBe(1);
      expect(disabled(button(level, 'Use in your plan'))).toBe(true);
      expect(disabled(button(level, 'Try it in a copy'))).toBe(true);
      expect(level.textContent).not.toContain('differs from the table');
    } finally {
      search.answer = real;
      search.retry();
    }
    for (let i = 0; i < 400 && (tab.dialog()!.textContent ?? '').includes('Working it out'); i++) await settle(50);
    const level = tab.dialog()!;
    expect(level.textContent).toMatch(/Once used, your plan (stops at \d+, not \d+|starts from \$[\d,]+, not \$[\d,]+|more of your plan moves)/);
    expect(level.textContent).toContain('so this differs from the table.');
    expect(level.textContent).not.toContain(said);
    expect(level.textContent).not.toContain('than None');
    expect(disabled(button(level, 'Use in your plan'))).toBe(false);
    await tab.unmount();
  }, 60_000);

  test('Close lets a level’s search go, as Back does', async () => {
    const search = planSearch();
    const real = search.drop;
    const tab = await detailed(MOVES);
    await settle(400);
    const table = await tuned(tab);
    await press(ruleOf(named(table, 'Fill the 22%')));
    await settle(400);
    const dropped: string[] = [];
    search.drop = (slot) => {
      dropped.push(slot);
      real(slot);
    };
    try {
      await press(closeOf(tab.dialog()!));
      await settle(300);
    } finally {
      search.drop = real;
    }
    expect(tab.dialog()).toBeNull();
    expect(dropped).toContain('tune-level');
    await tab.unmount();
  }, 60_000);

  test('while the plan’s own date is being worked out, neither the row nor a rule of an open table opens anything', async () => {
    const search = planSearch();
    const real = search.answer;
    const tab = await detailed(MOVES);
    await settle(400);
    await tuned(tab);
    try {
      search.answer = () => null;
      await act(async () => search.retry());
      await settle(100);
      const rule = ruleOf(named(tableOf(tab)!, 'Fill the 12%'));
      expect(rule.getAttribute('aria-disabled')).toBe('true');
      await press(rule);
      expect(tableOf(tab)).not.toBeNull();
      await press(closeOf(tab.dialog()!));
      const row = tab.row(TUNE)!;
      expect(row.getAttribute('aria-disabled')).toBe('true');
      await press(row);
      expect(tab.dialog()).toBeNull();
    } finally {
      search.answer = real;
      search.retry();
    }
    await settle(800);
    await settle(800);
    await tab.unmount();
  }, 60_000);
});
