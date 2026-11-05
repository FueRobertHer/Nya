import { describe, expect, test } from 'bun:test';
import { TEST_CONTAINER } from './fake-redis';
import { planPage } from './plan-page';

// A detailed plan's forms on the page, on the real routes: Health coverage, Household's
// fields and Assumptions', what each one saves in its one request, and what a copy keeps
// to itself.

const page = await planPage();
const { PLAN, seedPlan, seedCopy, stored, render, press, button, field, fill, pick, openCopy, calls, settle } = page;
type Tab = Awaited<ReturnType<typeof render>>;

async function flagged() {
  const { flagsStore } = await import('@/lib/flag-store');
  await flagsStore.update('plan-tax', async () => ({ on: 'nobody', containers: [TEST_CONTAINER], updatedAt: new Date().toISOString() }) as never, TEST_CONTAINER);
}
async function optedIn(props: Parameters<typeof render>[0] = {}, plan = PLAN) {
  await seedPlan(plan);
  await flagged();
  const tab = await render({ planTax: true, ...props });
  await pick(tab.container, 'Drawdown');
  await press(tab.row('Work it out from your accounts'));
  await press(button(tab.dialog(), 'Work it out'));
  await pick(tab.container, 'Your path');
  return tab;
}
const sheet = async (tab: Tab, title: string) => {
  await press(tab.row(title));
  return tab.dialog()!;
};
const save = async (tab: Tab) => {
  await press(button(tab.dialog(), 'Save'));
  await settle(200);
};
const read = async () => {
  const { GET } = await import('@/app/api/fire-plan/route');
  return (await GET()).json();
};
const planSaves = () => calls().filter((c) => c.method === 'PUT' && c.path === '/api/fire-plan');
const lastSave = () => planSaves().at(-1)!.body;
const subOf = (tab: Tab, title: string) => tab.row(title)?.findAll((e) => (e.getAttribute('class') ?? '').includes('list-row-sub'))[0]?.textContent;

describe('Health coverage', () => {
  test('no row in the flat model, even with the flag', async () => {
    await seedPlan();
    await flagged();
    const tab = await render({ planTax: true });
    expect(tab.row('Health coverage')).toBeNull();
    await tab.unmount();
  }, 20_000);

  test('not set, it says so, under the row, and Part B alone is counted', async () => {
    const tab = await optedIn();
    expect(subOf(tab, 'Health coverage')).toBe('Not set yet');
    expect(tab.text()).toContain('Not set: measured spending leaves out coverage through work.');
    await tab.unmount();
  }, 30_000);

  test('the ACA’s parts only under the ACA, and its Save carries the choices alone', async () => {
    const tab = await optedIn();
    const form = await sheet(tab, 'Health coverage');
    expect(form.getAttribute('aria-label')).toBe('Health coverage');
    expect(form.textContent).toContain('Premiums only');
    expect(field(form, 'Benchmark plan')).toBeNull();
    await pick(form, 'ACA marketplace');
    expect(field(tab.dialog()!, 'Benchmark plan')).not.toBeNull();
    expect(tab.dialog()!.textContent).toContain('If the enhanced credits return');
    await fill(tab.dialog()!, 'Benchmark plan', '11,000');
    await fill(tab.dialog()!, 'Quoted for age', '50');
    await save(tab);
    expect(tab.dialog()).toBeNull();
    const sent = lastSave();
    expect(sent.tax.health.beforeMedicare).toEqual({ kind: 'aca', adult: 11_000, quotedAge: 50, child: null });
    expect(sent.household).toBeUndefined();
    expect((await read()).tax.health.beforeMedicare.adult).toBe(11_000);
    expect(subOf(tab, 'Health coverage')).toBe('ACA before 65, then Medicare · in Drawdown');
    expect(tab.row('Health coverage')?.textContent).toMatch(/About \$[\d,]+ a year/);
    await tab.unmount();
  }, 30_000);

  test('something else asks only what it costs', async () => {
    const tab = await optedIn();
    const form = await sheet(tab, 'Health coverage');
    await pick(form, 'Something else');
    const open = tab.dialog()!;
    expect(field(open, 'Benchmark plan')).toBeNull();
    expect(open.textContent).not.toContain('Medicaid');
    await save(tab);
    expect(tab.dialog()?.textContent).toContain('What it costs is needed.');
    await fill(tab.dialog()!, 'What it costs', '9000');
    await save(tab);
    expect(lastSave().tax.health.beforeMedicare).toEqual({ kind: 'other', yearly: 9_000 });
    await tab.unmount();
  }, 30_000);

  test('what already pays goes with the household, in the same request', async () => {
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    const txns = Array.from({ length: 13 }, (_, m) => [
      { transaction_id: `p${m}`, amount: 800, date: day(5 + m * 30), category: 'Health insurance', name: 'Premium', account_id: 'a', source: 'plaid' },
      { transaction_id: `f${m}`, amount: 3_000, date: day(5 + m * 30), category: 'Food', name: 'Food', account_id: 'a', source: 'plaid' },
    ]).flat() as never;
    const tab = await optedIn({ txns }, { ...PLAN, spending: null });
    expect(tab.text()).toMatch(/Your spending has \$[\d,]+ a year in Health insurance\./);
    const form = await sheet(tab, 'Health coverage');
    await pick(form, 'You already pay for coverage');
    const open = tab.dialog()!;
    await fill(open, 'What pays for it', 'category:Health insurance');
    await save(tab);
    const sent = lastSave();
    expect(sent.household.paidToday).toEqual({ kind: 'category', name: 'Health insurance' });
    expect(sent.household_were.paidToday).toBeNull();
    expect((await read()).tax_facts.paidToday).toEqual({ kind: 'category', name: 'Health insurance' });
    await tab.unmount();
  }, 30_000);

  test('a save with nothing changed sends nothing', async () => {
    const tab = await optedIn();
    const before = planSaves().length;
    await sheet(tab, 'Health coverage');
    await save(tab);
    expect(tab.dialog()).toBeNull();
    expect(planSaves().length).toBe(before);
    await tab.unmount();
  }, 30_000);
});

describe('Household', () => {
  test('filing, state and a rate where the state has one', async () => {
    const tab = await optedIn({}, { ...PLAN, partnerAge: 38 });
    const form = await sheet(tab, 'Household');
    expect(field(form, 'Filing status')).not.toBeNull();
    const set = (words: string, value: string) => fill(tab.dialog()!, words, value);
    await set('Filing status', 'joint');
    await set('State', 'NV');
    expect(tab.dialog()!.textContent).toContain('Nevada has no income tax');
    expect(field(tab.dialog()!, 'Nevada income tax')).toBeNull();
    await set('State', 'CA');
    expect(tab.dialog()!.textContent).toContain('With no rate here, no state tax is counted.');
    await fill(tab.dialog()!, 'California income tax', '5');
    await save(tab);
    expect(tab.dialog()).toBeNull();
    const sent = lastSave();
    expect([sent.tax.state, sent.tax.stateRate, sent.household.filing]).toEqual(['CA', 0.05, 'joint']);
    expect(subOf(tab, 'Household')).toBe('40 and 38 now, stop at 55 · joint · California');
    await tab.unmount();
  }, 30_000);

  test('filing jointly needs a partner', async () => {
    const tab = await optedIn();
    await sheet(tab, 'Household');
    await fill(tab.dialog()!, 'Filing status', 'joint');
    await save(tab);
    expect(tab.dialog()?.textContent).toContain('Filing jointly needs your partner’s age, above.');
    await tab.unmount();
  }, 30_000);

  test('dependents come and go, and say what isn’t counted', async () => {
    const tab = await optedIn();
    await sheet(tab, 'Household');
    await press(button(tab.dialog(), 'Add a dependent'));
    expect(tab.dialog()!.textContent).toContain('The child tax credit and head of household aren’t counted.');
    await fill(tab.dialog()!, 'Dependent 1 leaves', '60');
    await save(tab);
    expect(lastSave().household.dependents.map((d: { untilAge: number }) => d.untilAge)).toEqual([60]);
    await sheet(tab, 'Household');
    await press(tab.dialog()!.findAll((e) => e.getAttribute('aria-label') === 'Remove dependent 1')[0]);
    await save(tab);
    expect(lastSave().household.dependents).toEqual([]);
    await tab.unmount();
  }, 30_000);

  test('a birth year only where a birthday decides the RMD age', async () => {
    const tab = await optedIn({}, { ...PLAN, age: 40, targetAge: 55 });
    await sheet(tab, 'Household');
    expect(field(tab.dialog()!, 'Your year of birth')).toBeNull();
    await fill(tab.dialog()!, 'Your age', String(new Date().getFullYear() - 1960));
    expect(field(tab.dialog()!, 'Your year of birth')).not.toBeNull();
    await tab.unmount();
  }, 30_000);

  test('in a copy the shared ones are locked and the state is its own', async () => {
    await seedPlan();
    await seedCopy('Move');
    await flagged();
    const tab = await render({ planTax: true });
    await pick(tab.container, 'Drawdown');
    await press(tab.row('Work it out from your accounts'));
    await press(button(tab.dialog(), 'Work it out'));
    await openCopy(tab, 'Move');
    await pick(tab.container, 'Your path');
    await sheet(tab, 'Household');
    expect(field(tab.dialog()!, 'Filing status')?.getAttribute('disabled')).not.toBeNull();
    expect(tab.dialog()!.textContent).toContain('Filing, dependents and years of birth are the same in every plan');
    expect(field(tab.dialog()!, 'State')?.getAttribute('disabled')).toBeNull();
    await fill(tab.dialog()!, 'State', 'NV');
    await save(tab);
    const put = calls().filter((c) => c.method === 'PUT' && c.path === '/api/plans').at(-1)!.body;
    expect(put.saves[0].tax.state).toBe('NV');
    expect((await read()).tax.state).toBeNull();
    expect((await stored()).byName['Move']).toBeDefined();
    await tab.unmount();
  }, 30_000);
});

describe('Assumptions', () => {
  test('its fields, its words, and the way back to a flat rate', async () => {
    const tab = await optedIn();
    const form = await sheet(tab, 'Assumptions');
    expect(form.textContent).toContain('Your FI number still uses this rate. Drawdown works tax out from your accounts.');
    expect(form.textContent).toContain('What the simulation withdraws comes from your spending, health coverage and their tax.');
    expect(form.textContent).toContain('health coverage, with their tax');
    await fill(form, 'Inflation', '2.5');
    await fill(form, 'Health costs rise', '1.5');
    await save(tab);
    const sent = lastSave();
    expect([sent.tax.inflation, sent.tax.health.growth]).toEqual([0.025, 0.015]);
    expect(subOf(tab, 'Assumptions')).toContain('2.5% inflation · health costs +1.5 points');
    await sheet(tab, 'Assumptions');
    await press(button(tab.dialog(), 'Use a flat rate instead'));
    expect(tab.dialog()).toBeNull();
    expect((await read()).tax_facts.model).toBe('flat');
    await pick(tab.container, 'Drawdown');
    expect(tab.text()).not.toContain('Year by year, at');
    expect(tab.row('Work it out from your accounts')).not.toBeNull();
    await tab.unmount();
  }, 30_000);

  test('flat, it reads as it always has, and the fourth start only with the flag', async () => {
    await seedPlan();
    const off = await render();
    const form = await sheet(off, 'Assumptions');
    expect(form.textContent).toContain('A flat share of every withdrawal');
    expect(form.textContent).not.toContain('What I’d have at my stop age');
    await off.unmount();
    await flagged();
    const on = await render({ planTax: true });
    expect((await sheet(on, 'Assumptions')).textContent).toContain('What I’d have at my stop age');
    await on.unmount();
  }, 30_000);
});
