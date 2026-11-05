import { describe, expect, test } from 'bun:test';
import { TEST_CONTAINER } from './fake-redis';
import { planPage } from './plan-page';

// T4 on the page, on the real routes: How you draw, Compare conversions, a rule's sheet
// and Try it, Tax after you stop, Assumptions without its tax field, the opt-in's before
// and after, and a new plan that starts worked out.

const page = await planPage();
const { PLAN, seedPlan, seedCopy, render, press, button, field, fill, pick, calls, settle, classOf, stored, openCopy } = page;
type Tab = Awaited<ReturnType<typeof render>>;
type Node = NonNullable<ReturnType<Tab['dialog']>>;

async function flagged() {
  const { flagsStore } = await import('@/lib/flag-store');
  await flagsStore.update('plan-tax', async () => ({ on: 'nobody', containers: [TEST_CONTAINER], updatedAt: new Date().toISOString() }) as never, TEST_CONTAINER);
}
const WAY_IN = 'Work it out from your accounts';

async function detailed(plan = PLAN, props: Parameters<typeof render>[0] = {}) {
  await flagged();
  await seedPlan(plan);
  const tab = await render({ planTax: true, ...props });
  await pick(tab.container, 'Drawdown');
  await press(tab.row(WAY_IN));
  await press(button(tab.dialog(), 'Work it out'));
  return tab;
}
/** With the ACA set, so the ACA rule and the credit's column show. */
async function onAca(plan = PLAN, props: Parameters<typeof render>[0] = {}) {
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
const subOf = (row: Node | null) => row?.findAll((e) => classOf(e).includes('list-row-sub'))[0]?.textContent;
const lastSave = () => calls().filter((c) => c.method === 'PUT' && c.path === '/api/fire-plan').at(-1)!.body;
const compareTable = (tab: Tab) => tab.container.findAll((e) => e.tagName === 'TABLE' && classOf(e).includes('plan-rules-table'))[0];
const bodyRows = (table: Node) => table.findAll((e) => e.tagName === 'TR').filter((r) => r.findAll((c) => c.getAttribute('scope') === 'row').length > 0);
const ruleOf = (row: Node) => row.findAll((c) => c.getAttribute('scope') === 'row')[0].findAll((e) => e.tagName === 'BUTTON')[0];
const ruleNames = (table: Node) => bodyRows(table).map((r) => ruleOf(r).textContent);
const heading = (table: Node, text: string) => table.findAll((e) => e.getAttribute('scope') === 'col' && (e.textContent ?? '').startsWith(text))[0];
const sortButton = (th: Node) => th.findAll((e) => e.tagName === 'BUTTON')[0];
const choose = (tab: Tab, label: string) => pick(tab.dialog()!, label);
/** A 401(k), so the years have tax in them. */
const WITH_ACCOUNTS = { institutions: [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [{ account_id: 'k', name: '401(k)', type: 'investment', subtype: '401k', balance: 600_000, currency: 'USD' }] }] as never };
/** Holds what `path` is sent by POST, outside the page's own count, until it is let go. */
const holdingPost = async (path: string, run: (letGo: () => void) => Promise<void>) => {
  const real = globalThis.fetch;
  const waiting: (() => void)[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith(path) && init?.method === 'POST' ? new Promise<Response>((resolve) => waiting.push(() => resolve(real(input, init)))) : real(input, init)) as typeof fetch;
  try {
    await run(() => waiting.splice(0).forEach((go) => go()));
  } finally {
    globalThis.fetch = real;
  }
};

describe('How you draw', () => {
  test('a flat plan has no such card', async () => {
    await flagged();
    await seedPlan();
    const flat = await render({ planTax: true });
    await pick(flat.container, 'Drawdown');
    expect(flat.text()).not.toContain('How you draw');
    expect(flat.text()).not.toContain('Compare conversions');
    await flat.unmount();
  }, 30_000);

  test('a detailed plan’s two rows, with no rule to begin with', async () => {
    const tab = await detailed();
    expect(tab.text()).toContain('How you draw');
    expect(subOf(tab.row('Order'))).toBe('Taxable, then tax-deferred, then Roth');
    expect(subOf(tab.row('Roth conversions'))).toBe('None');
    await tab.unmount();
  }, 30_000);

  test('Order saves in one request, with the plan, and the row says so', async () => {
    const tab = await detailed();
    await press(tab.row('Order'));
    await choose(tab, 'Taxable, then Roth, then tax-deferred');
    await press(button(tab.dialog(), 'Save'));
    await settle(200);
    expect(tab.dialog()).toBeNull();
    expect(lastSave().tax.strategy.order).toBe('roth-before-deferred');
    expect(subOf(tab.row('Order'))).toBe('Taxable, then Roth, then tax-deferred');
    await tab.unmount();
  }, 30_000);

  test('Roth conversions: a rule, its preview, a Save, and the row, Compare and your plan moving with it', async () => {
    const tab = await detailed(PLAN, WITH_ACCOUNTS);
    await press(tab.row('Roth conversions'));
    expect(tab.dialog()!.textContent).not.toContain('With this rule');
    // Nothing moved until Save: the ACA rule isn't offered with no one on the ACA.
    expect(tab.dialog()!.textContent).not.toContain('Up to the ACA limit');
    await choose(tab, 'Fill a bracket');
    expect(tab.dialog()!.textContent).toContain('Nya starts with none');
    expect(tab.dialog()!.textContent).toMatch(/With this rule: about \$[\d,]+ converted by \d+, tax and health costs \$[\d,]+ in all, and .*With none: \$[\d,]+/);
    await press(button(tab.dialog(), 'Save'));
    await settle(300);
    expect(tab.dialog()).toBeNull();
    expect(lastSave().tax.strategy.conversions).toEqual({ kind: 'bracket', top: 0.12 });
    expect(calls().filter((c) => c.method === 'PUT' && c.path === '/api/fire-plan').length).toBe(1);
    expect(subOf(tab.row('Roth conversions'))).toMatch(/^Fill the 12% bracket, until \d+$/);
    const table = compareTable(tab);
    const mine = bodyRows(table).filter((r) => (r.textContent ?? '').includes('Your plan'));
    expect(mine.length).toBe(1);
    expect(ruleOf(mine[0]).textContent).toBe('Fill 12%');
    await tab.unmount();
  }, 30_000);

  test('a typed amount and an age out of range are said under their fields', async () => {
    const tab = await detailed();
    await press(tab.row('Roth conversions'));
    await choose(tab, 'A fixed amount');
    await press(button(tab.dialog(), 'Save'));
    await settle(100);
    expect(tab.dialog()!.textContent).toContain('How much a year is needed.');
    await fill(tab.dialog()!, 'How much a year', '40000');
    await fill(tab.dialog()!, 'Until age', '10');
    await press(button(tab.dialog(), 'Save'));
    await settle(100);
    expect(tab.dialog()!.textContent).toContain('Until age must be from 18 to 100.');
    // An age you've passed is in range but can't run.
    await fill(tab.dialog()!, 'Until age', '30');
    await press(button(tab.dialog(), 'Save'));
    await settle(100);
    expect(tab.dialog()!.textContent).toContain('Until age must be 40 or later: you’re 40 now.');
    await fill(tab.dialog()!, 'Until age', '60');
    await press(button(tab.dialog(), 'Save'));
    await settle(200);
    expect(lastSave().tax.strategy).toEqual({ order: 'standard', conversions: { kind: 'fixed', yearly: 40_000 }, convertUntil: 60 });
    expect(subOf(tab.row('Roth conversions'))).toBe('$40,000 a year, until 60');
    // Its own row in Compare, as no rule there is that one, and a sheet whose title holds no amount.
    const mine = bodyRows(compareTable(tab)).find((r) => (r.textContent ?? '').includes('Your plan'))!;
    expect(ruleOf(mine).textContent).toBe('$40,000 a year, until 60');
    expect(ruleNames(compareTable(tab)).slice(0, 4)).toEqual(['None', 'Fill 10%', 'Fill 12%', 'Fill 22%']);
    await press(ruleOf(mine));
    expect(tab.dialog()!.getAttribute('aria-label')).toBe('A fixed amount, until 60');
    await tab.unmount();
  }, 30_000);

  test('the age by default, for one person: the year before their RMDs', async () => {
    const tab = await detailed();
    await press(tab.row('Roth conversions'));
    await choose(tab, 'Fill a bracket');
    expect(tab.dialog()!.textContent).toContain('The year before your RMDs start at 75.');
    await tab.unmount();
  }, 30_000);

  test('the age by default, with an older partner: the first RMDs are theirs, in your age', async () => {
    const tab = await detailed({ ...PLAN, partnerAge: 50 });
    await pick(tab.container, 'Your path');
    await press(tab.row('Household'));
    await fill(tab.dialog()!, 'Filing status', 'joint');
    await press(button(tab.dialog(), 'Save'));
    await settle(300);
    await pick(tab.container, 'Drawdown');
    await press(tab.row('Roth conversions'));
    await choose(tab, 'Fill a bracket');
    expect(tab.dialog()!.textContent).toContain('The year before the first RMDs, when you’re 65.');
    await tab.unmount();
  }, 30_000);

  test('the age by default, with a partner on a return of your own: your RMDs, as their accounts count as yours', async () => {
    const tab = await detailed({ ...PLAN, partnerAge: 50 });
    await press(tab.row('Roth conversions'));
    await choose(tab, 'Fill a bracket');
    expect(tab.dialog()!.textContent).toContain('The year before your RMDs start at 75.');
    await tab.unmount();
  }, 30_000);

  test('from your FI number, any change to the rule says the start moves, and none doesn’t', async () => {
    const tab = await detailed();
    const says = () => (tab.dialog()!.textContent ?? '').includes('Your FI number moves with the rule');
    await press(tab.row('Roth conversions'));
    expect(says()).toBe(false);
    await choose(tab, 'Fill a bracket');
    expect(says()).toBe(true);
    await press(button(tab.dialog(), 'Save'));
    await settle(300);
    await press(tab.row('Roth conversions'));
    expect(says()).toBe(false);
    // The same rule to another age.
    await fill(tab.dialog()!, 'Until age', '60');
    expect(says()).toBe(true);
    await tab.unmount();
  }, 30_000);

  test('a rule to an age of its own isn’t taken for the same rule to its usual age', async () => {
    const tab = await detailed();
    await press(tab.row('Roth conversions'));
    await choose(tab, 'Fill a bracket');
    await fill(tab.dialog()!, 'Until age', '60');
    await press(button(tab.dialog(), 'Save'));
    await settle(300);
    expect(ruleNames(compareTable(tab))).toContain('Fill 12%');
    const mine = bodyRows(compareTable(tab)).find((r) => (r.textContent ?? '').includes('Your plan'))!;
    expect(ruleOf(mine).textContent).toBe('Fill 12%, until 60');
    await press(ruleOf(mine));
    expect(tab.dialog()!.getAttribute('aria-label')).toBe('Fill 12%, until 60');
    await tab.unmount();
  }, 30_000);
});

describe('Compare conversions', () => {
  test('the rules, none marked best', async () => {
    const tab = await detailed();
    const table = compareTable(tab);
    expect(ruleNames(table)).toEqual(['None', 'Fill 10%', 'Fill 12%', 'Fill 22%']);
    expect(table.textContent).not.toContain('Years with an ACA credit');
    expect(tab.text()).not.toMatch(/\bbest\b/i);
    await tab.unmount();
  }, 30_000);

  test('the ACA rule and its column, only for someone on the ACA', async () => {
    const tab = await onAca();
    const withAca = compareTable(tab);
    expect(ruleNames(withAca)).toEqual(['None', 'Fill 10%', 'Fill 12%', 'Fill 22%', 'ACA limit, then 12%']);
    expect(withAca.textContent).toContain('Years with an ACA credit');
    expect(bodyRows(withAca)[0].textContent).toContain('Your plan');
    // For one person, it says so.
    await press(tab.row('Roth conversions'));
    expect(tab.dialog()!.textContent).toContain('Under the limit while you’re on the ACA, then a bracket.');
    expect(tab.dialog()!.textContent).not.toContain('no cliff');
    await tab.unmount();
  }, 30_000);

  test('with the enhanced credits back, the ACA rule says it still stops at the limit', async () => {
    const tab = await onAca();
    await pick(tab.container, 'Your path');
    await press(tab.row('Health coverage'));
    await pick(tab.dialog()!, 'If the enhanced credits return');
    await press(button(tab.dialog(), 'Save'));
    await settle(200);
    await pick(tab.container, 'Drawdown');
    await press(tab.row('Roth conversions'));
    expect(tab.dialog()!.textContent).toContain('With the enhanced credits there’s no cliff at that limit, but this rule still stops there.');
    await tab.unmount();
  }, 30_000);

  test('nothing sorted until a heading is tapped: highest first, then lowest', async () => {
    const tab = await detailed();
    const before = ruleNames(compareTable(tab));
    expect(heading(compareTable(tab), 'Tax and health').getAttribute('aria-sort')).toBe('none');
    const money = (r: Node) => Number((r.findAll((c) => c.tagName === 'TD')[1].textContent ?? '').replace(/[^\d]/g, ''));
    await press(sortButton(heading(compareTable(tab), 'Tax and health')));
    expect(heading(compareTable(tab), 'Tax and health').getAttribute('aria-sort')).toBe('descending');
    const high = bodyRows(compareTable(tab)).map(money);
    expect(high).toEqual([...high].sort((a, b) => b - a));
    await press(sortButton(heading(compareTable(tab), 'Tax and health')));
    expect(heading(compareTable(tab), 'Tax and health').getAttribute('aria-sort')).toBe('ascending');
    const low = bodyRows(compareTable(tab)).map(money);
    expect(low).toEqual([...low].sort((a, b) => a - b));
    expect(heading(compareTable(tab), 'Left at').getAttribute('aria-sort')).toBe('none');
    expect([...ruleNames(compareTable(tab))].sort()).toEqual([...before].sort());
    await tab.unmount();
  }, 30_000);

  test('a rule’s sheet: its figures, stage by stage, and Try it makes a copy with that rule', async () => {
    const tab = await detailed();
    const row = bodyRows(compareTable(tab)).find((r) => ruleOf(r).textContent === 'Fill 12%')!;
    await press(ruleOf(row));
    const sheet = tab.dialog()!;
    expect(sheet.getAttribute('aria-label')).toBe('Fill 12%');
    expect(sheet.textContent).toContain('Tax and health costs, in all');
    expect(sheet.textContent).toContain('Stage by stage');
    expect(sheet.textContent).toContain('2026 tax law. Not tax advice.');
    await press(button(sheet, 'Try it in a copy'));
    await settle(300);
    expect(tab.dialog()).toBeNull();
    const made = calls().filter((c) => c.method === 'POST' && c.path === '/api/plans').at(-1)!.body;
    expect(made.name).toBe('Fill 12%');
    expect(made.tax.strategy.conversions).toEqual({ kind: 'bracket', top: 0.12 });
    const { byName } = await stored();
    expect(byName['Fill 12%']).toBeTruthy();
    // It opens where it was tried, on Drawdown, with its rule.
    expect(tab.text()).toContain('Year by year');
    expect(subOf(tab.row('Roth conversions'))).toMatch(/^Fill the 12% bracket, until \d+$/);
    expect(tab.text()).toMatch(/Roth conversions: Fill the 12% bracket, until \d+ \(your plan: None\)/);
    // The rule in use is this copy's: your plan's is another.
    const tagged = bodyRows(compareTable(tab)).filter((r) => (r.textContent ?? '').includes('This copy'));
    expect(tagged.map((r) => ruleOf(r).textContent)).toEqual(['Fill 12%']);
    expect(compareTable(tab).textContent).not.toContain('Your plan');
    // And in the Plans sheet, with the sheet's own words for how it differs.
    await press(tab.plans());
    expect(tab.dialog()!.textContent).toMatch(/Roth conversions: Fill the 12% bracket, until \d+ \(your plan: None\)/);
    await tab.unmount();
  }, 30_000);

  test('Try it takes a number where another plan has its name, in any case', async () => {
    await (await detailed()).unmount();
    await seedCopy('fill 12%', { targetAge: 52 });
    const tab = await render({ planTax: true });
    await pick(tab.container, 'Drawdown');
    await press(ruleOf(bodyRows(compareTable(tab)).find((r) => ruleOf(r).textContent === 'Fill 12%')!));
    await press(button(tab.dialog(), 'Try it in a copy'));
    await settle(300);
    expect(tab.dialog()).toBeNull();
    expect(calls().filter((c) => c.method === 'POST' && c.path === '/api/plans').at(-1)!.body.name).toBe('Fill 12% 2');
    await tab.unmount();
  }, 30_000);

  test('the rule a plan has offers no copy of itself', async () => {
    const tab = await detailed();
    await press(ruleOf(bodyRows(compareTable(tab))[0]));
    expect(tab.dialog()!.textContent).toContain('Your plan has this rule.');
    expect(button(tab.dialog()!, 'Try it in a copy')).toBeFalsy();
    await tab.unmount();
  }, 30_000);
});

describe('Your figures', () => {
  test('Tax after you stop, and its sheet: by stage, in your FI number, and back to flat', async () => {
    const tab = await detailed();
    await pick(tab.container, 'Your path');
    const row = tab.row('Tax after you stop')!;
    expect(subOf(row)).toMatch(/^Of what your years after \d+ cost, from your FI number · your accounts and 2026 law$/);
    expect(subOf(tab.row('FI number'))).toBe('Worked out from spending, health coverage and tax, at 4%');
    await press(row);
    const sheet = tab.dialog()!;
    expect(sheet.getAttribute('aria-label')).toBe('Tax after you stop');
    expect(sheet.textContent).toContain('By stage');
    expect(sheet.textContent).toMatch(/· before 59½[\d.]+%/);
    expect(sheet.textContent).toContain('In your FI number');
    expect(sheet.textContent).toContain('Health coverage, on average');
    expect(sheet.textContent).toContain('At a 4% withdrawal rate');
    expect(sheet.textContent).toContain('no conversions');
    const flat = tab.dialog()!.findAll((e) => e.tagName === 'BUTTON' && (e.textContent ?? '').includes('Use a flat rate instead'))[0];
    await press(flat);
    await settle(200);
    expect(tab.dialog()).toBeNull();
    const facts = calls().filter((c) => c.method === 'POST' && c.path === '/api/plan-facts').at(-1)!.body;
    expect(facts).toEqual({ kind: 'model', model: 'flat' });
    await tab.unmount();
  }, 30_000);

  test('flat with the flag on, the row says the rate as set and opens the way in; with it off, nothing new', async () => {
    await flagged();
    await seedPlan();
    const off = await render({ planTax: false });
    expect(off.row('Tax after you stop')).toBeNull();
    await off.unmount();
    const tab = await render({ planTax: true });
    const row = tab.row('Tax after you stop')!;
    expect(subOf(row)).toBe('As set · work it out from your accounts');
    await press(row);
    expect(tab.dialog()!.getAttribute('aria-label')).toBe(WAY_IN);
    await tab.unmount();
  }, 30_000);

  test('the FI number’s sheet has its lines, from its own run', async () => {
    const tab = await detailed(PLAN, WITH_ACCOUNTS);
    await pick(tab.container, 'Your path');
    await press(tab.row('FI number'));
    const sheet = tab.dialog()!;
    expect(sheet.textContent).toContain('+ Health coverage');
    expect(sheet.textContent).toContain('÷ (1 − tax)');
    expect(sheet.textContent).toContain('FI number');
    expect(sheet.textContent).not.toContain('Your spending, health and tax');
    await tab.unmount();
  }, 30_000);

  test('beside your own number, it says what the years cost of it', async () => {
    const tab = await detailed({ ...PLAN, fiNumber: 1_500_000 });
    await pick(tab.container, 'Your path');
    await press(tab.row('FI number'));
    expect(tab.dialog()!.textContent).toMatch(/Your spending, health and tax, \$[\d,]+ a year, are [\d.]+% of \$1,500,000; your withdrawal rate is 4%/);
    await tab.unmount();
  }, 30_000);

  test('while a job is out, the last answer’s figures aren’t printed as this one’s', async () => {
    const { planSearch } = await import('@/components/plan-search');
    const search = planSearch();
    const real = search.answer;
    const tab = await detailed({ ...PLAN, stopAtFi: true, targetAge: null, spending: 60_000, savings: 40_000 } as typeof PLAN, WITH_ACCOUNTS);
    await settle(400);
    await pick(tab.container, 'Your path');
    const row = (title: string) => tab.row(title)!.textContent ?? '';
    expect(row('FI number')).toMatch(/\$[\d,]+/);
    try {
      search.answer = () => null;
      await press(tab.row('Annual spending'));
      await fill(tab.dialog()!, 'Spending a year', '90000');
      await press(button(tab.dialog(), 'Save'));
      await settle(300);
      expect(row('FI number')).toContain('--');
      expect(row('Tax after you stop')).toContain('--');
      expect(row('Tax after you stop')).toContain('Working it out');
      await pick(tab.container, 'Drawdown');
      const compare = tab.container.findAll((e) => e.tagName === 'SECTION' && e.getAttribute('aria-labelledby') === 'plan-compare-rules')[0];
      expect(compare.getAttribute('aria-busy')).toBe('true');
      expect(classOf(compare)).toContain('plan-answer-pending');
      await pick(tab.container, 'Your path');
    } finally {
      search.answer = real;
      search.retry();
    }
    await settle(800);
    await settle(800);
    expect(row('FI number')).toMatch(/\$[\d,]+/);
    expect(row('Tax after you stop')).toMatch(/[\d.]+%/);
    await tab.unmount();
  }, 60_000);

  test('Health coverage is said to be in your FI number', async () => {
    const tab = await onAca();
    await pick(tab.container, 'Your path');
    expect(subOf(tab.row('Health coverage'))).toBe('ACA before 65, then Medicare · in your FI number');
    await tab.unmount();
  }, 30_000);

  test('beside your own number, Health coverage isn’t said to be in it', async () => {
    const tab = await onAca({ ...PLAN, fiNumber: 1_500_000 });
    await pick(tab.container, 'Your path');
    expect(subOf(tab.row('Health coverage'))).toBe('ACA before 65, then Medicare');
    await tab.unmount();
  }, 30_000);

  test('from today, a lasting change before the stop is in the FI number’s lines, and not left out', async () => {
    const change = { id: 'c', label: 'A bigger place', kind: 'spending', from: { anchor: { at: 'age', age: 45 }, offset: 0 }, until: null, once: null, yearly: 12_000, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false };
    const begun = { ...change, id: 'b', label: 'A car', from: { anchor: { at: 'age', age: (PLAN.age as number) - 2 }, offset: 0 }, yearly: 10_000 };
    const tab = await detailed({ ...PLAN, start: 'assets', items: [begun, change] } as typeof PLAN);
    await pick(tab.container, 'Your path');
    // The answer's line and the sheet's say the same, not what has begun by today.
    expect(tab.container.textContent).toContain('FI number from $62,000 a year in retirement: $40,000 now, and $22,000 a year of lasting changes');
    await press(tab.row('FI number'));
    const sheet = tab.dialog()!;
    expect(sheet.textContent).toContain('Spending in retirement$62,000 a year');
    expect(sheet.textContent).not.toContain('this plan’s items after you stop');
    await tab.unmount();
  }, 30_000);

  test('from today, a lasting change not begun yet still makes it spending in retirement', async () => {
    const change = { id: 'c', label: 'A bigger place', kind: 'spending', from: { anchor: { at: 'age', age: (PLAN.age as number) + 5 }, offset: 0 }, until: null, once: null, yearly: 12_000, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false };
    const tab = await detailed({ ...PLAN, start: 'assets', items: [change] } as typeof PLAN);
    await pick(tab.container, 'Your path');
    await press(tab.row('FI number'));
    expect(tab.dialog()!.textContent).toContain('Spending in retirement$52,000 a year');
    await tab.unmount();
  }, 30_000);

  test('Assumptions, going to your FI number: what it withdraws holds health coverage and tax', async () => {
    const tab = await detailed({ ...PLAN, start: 'assets' } as typeof PLAN);
    await pick(tab.container, 'Your path');
    await press(tab.row('Assumptions'));
    await fill(tab.dialog()!, 'Start with', 'fi-number');
    expect(tab.dialog()!.textContent).toContain('withdrawing 4% of it: your spending of $40,000 a year and health coverage, with their tax.');
    await tab.unmount();
  }, 30_000);

  test('Assumptions has no flat rate to type, and says nothing of a rate not yet saved', async () => {
    const tab = await detailed({ ...PLAN, taxRate: 0.15 });
    await pick(tab.container, 'Your path');
    expect(subOf(tab.row('Assumptions'))).not.toContain('tax');
    await press(tab.row('Assumptions'));
    const form = tab.dialog()!;
    expect(field(form, 'Tax on withdrawals')).toBeFalsy();
    expect(form.textContent).not.toContain('Use a flat rate instead');
    const select = field(form, 'Start with') as Node;
    const fi = () => select.findAll((e) => e.tagName === 'OPTION')[0].textContent;
    expect(fi()).toMatch(/^FI number \(\$[\d,]+\)$/);
    await fill(form, 'Withdrawal rate', '3');
    expect(fi()).toBe('FI number');
    await fill(tab.dialog()!, 'Withdrawal rate', '4');
    await press(button(tab.dialog(), 'Save'));
    await settle(200);
    expect(calls().filter((c) => c.method === 'PUT' && c.path === '/api/fire-plan').length === 0 || lastSave().plan.taxRate === 0.15).toBe(true);
    await tab.unmount();
  }, 30_000);
});

describe('the way in', () => {
  test('before and after, and nothing saved until Work it out', async () => {
    await flagged();
    await seedPlan();
    const tab = await render({ planTax: true });
    await pick(tab.container, 'Drawdown');
    await press(tab.row(WAY_IN));
    await settle(200);
    const sheet = tab.dialog()!;
    expect(sheet.textContent).toMatch(/Your FI number\$[\d,]+, then \$[\d,]+/);
    expect(sheet.textContent).toMatch(/Tax after you stop0%, as set, then [\d.]+%/);
    expect(sheet.textContent).toMatch(/Health coverageNone, then \$[\d,]+ a year from Medicare/);
    expect(sheet.textContent).toContain('Coverage before 65 is yours to set next');
    expect(sheet.textContent).toContain('Each account’s tax bucket, owner and cost basis');
    expect(calls().filter((c) => c.method !== 'GET' && (c.path === '/api/plan-facts' || c.path === '/api/fire-plan'))).toEqual([]);
    // The page behind it stays flat.
    expect(tab.text()).not.toContain('Year by year');
    await press(button(tab.dialog(), 'Work it out'));
    await settle(200);
    expect(tab.text()).toContain('Year by year');
    await tab.unmount();
  }, 30_000);

  test('a search that can’t run says so, in place of an after, and it can still be turned on', async () => {
    const { planSearch } = await import('@/components/plan-search');
    const search = planSearch();
    const real = search.answer;
    search.answer = () => ({ ok: false, error: 'nope' });
    try {
      await flagged();
      await seedPlan({ ...PLAN, stopAtFi: true, targetAge: null } as typeof PLAN);
      const tab = await render({ planTax: true, ...WITH_ACCOUNTS });
      await pick(tab.container, 'Drawdown');
      await press(tab.row(WAY_IN));
      await settle(300);
      const sheet = tab.dialog()!;
      expect(sheet.textContent).toContain('What it comes to can’t be worked out yet.');
      expect(sheet.textContent).not.toMatch(/Your FI number\$/);
      expect(button(sheet, 'Work it out')?.getAttribute('disabled')).toBeFalsy();
      await tab.unmount();
    } finally {
      search.answer = real;
    }
  }, 30_000);
});

describe('a new plan', () => {
  test('starts worked out once both ages are given, with no rate typed', async () => {
    await flagged();
    const tab = await render({ planTax: true });
    await settle(100);
    await press(tab.row('Household'));
    await fill(tab.dialog()!, 'Your age', '40');
    await fill(tab.dialog()!, 'Stop', '50');
    await press(button(tab.dialog(), 'Save'));
    await settle(300);
    expect(calls().filter((c) => c.method === 'POST' && c.path === '/api/plan-facts').map((c) => c.body)).toEqual([{ kind: 'opt-in' }]);
    await tab.unmount();
  }, 30_000);

  test('its sheet closes on the save, with no word of the plan being read again', async () => {
    await flagged();
    await holdingPost('/api/plan-facts', async (letGo) => {
      const tab = await render({ planTax: true });
      await settle(100);
      await press(tab.row('Household'));
      await fill(tab.dialog()!, 'Your age', '40');
      await fill(tab.dialog()!, 'Stop', '50');
      await press(button(tab.dialog(), 'Save'));
      await settle(200);
      expect(tab.dialog()).toBeNull();
      letGo();
      await settle(300);
      await tab.unmount();
    });
  }, 30_000);

  test('a plan taken back to a flat rate isn’t worked out again by a change of ages', async () => {
    const tab = await detailed();
    await pick(tab.container, 'Your path');
    await press(tab.row('Tax after you stop'));
    await press(tab.dialog()!.findAll((e) => e.tagName === 'BUTTON' && (e.textContent ?? '').includes('Use a flat rate instead'))[0]);
    await settle(200);
    const optIns = () => calls().filter((c) => c.method === 'POST' && c.path === '/api/plan-facts' && c.body.kind === 'opt-in').length;
    const was = optIns();
    await press(tab.row('Household'));
    await fill(tab.dialog()!, 'Stop', '');
    await press(button(tab.dialog(), 'Save'));
    await settle(200);
    expect(tab.dialog()).toBeNull();
    await press(tab.row('Household'));
    await fill(tab.dialog()!, 'Stop', '55');
    await press(button(tab.dialog(), 'Save'));
    await settle(300);
    expect(optIns()).toBe(was);
    expect(subOf(tab.row('Tax after you stop'))).toBe('As set · work it out from your accounts');
    await tab.unmount();
  }, 30_000);

  test('a plan with a rate typed stays flat, its offer still there', async () => {
    await flagged();
    await seedPlan({ ...PLAN, age: null, targetAge: null, taxRate: 0.15 });
    const tab = await render({ planTax: true });
    await press(tab.row('Household'));
    await fill(tab.dialog()!, 'Your age', '40');
    await fill(tab.dialog()!, 'Stop', '50');
    await press(button(tab.dialog(), 'Save'));
    await settle(300);
    expect(calls().filter((c) => c.method === 'POST' && c.path === '/api/plan-facts')).toEqual([]);
    await pick(tab.container, 'Drawdown');
    expect(tab.row(WAY_IN)).not.toBeNull();
    await tab.unmount();
  }, 30_000);

  test('a plan with its ages already stays flat', async () => {
    await flagged();
    await seedPlan({ ...PLAN, age: 40, targetAge: 50 });
    const tab = await render({ planTax: true });
    await press(tab.row('Household'));
    await fill(tab.dialog()!, 'Stop', '52');
    await press(button(tab.dialog(), 'Save'));
    await settle(200);
    expect(calls().filter((c) => c.method === 'POST' && c.path === '/api/plan-facts')).toEqual([]);
    await tab.unmount();
  }, 30_000);
});

describe('a copy', () => {
  test('a copy’s rule is its own, and a stage’s sheet says which plan it is', async () => {
    const tab0 = await detailed();
    await tab0.unmount();
    await seedCopy('Stop at 52', { targetAge: 52 });
    const tab = await render({ planTax: true });
    await openCopy(tab, 'Stop at 52');
    await pick(tab.container, 'Drawdown');
    await press(tab.row('Roth conversions'));
    await choose(tab, 'Fill a bracket');
    await press(button(tab.dialog(), 'Save'));
    await settle(300);
    const copySaves = calls().filter((c) => c.method === 'PUT' && c.path === '/api/plans');
    expect(JSON.stringify(copySaves.at(-1)!.body)).toContain('"top":0.12');
    expect(tab.text()).toMatch(/Roth conversions: Fill the 12% bracket/);
    const stage = tab.container.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && (e.textContent ?? '').includes('tax a year'))[0];
    await press(stage);
    expect(tab.dialog()!.textContent).toContain('Stop at 52');
    await tab.unmount();
  }, 30_000);
});
