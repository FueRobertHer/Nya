import { describe, expect, test } from 'bun:test';
import { planPage } from './plan-page';

// The Household sheet (the tax plan's E2; T3 adds filing and state), used on
// the real plan routes: the stop as an age or when you reach FI, your
// partner's age, and what each save keeps; and the repair card's words for a
// copy that lost an item when your partner's age was cleared.

const page = await planPage();
const { PLAN, settle, seedPlan, seedCopy, stored, writes, render, press, button, field, fill, pick, openCopy, classOf } = page;
type PlanItem = import('@/lib/fire/items').PlanItem;
type Tab = Awaited<ReturnType<typeof render>>;

const household = async (tab: Tab) => {
  await press(tab.row('Household'));
  const form = tab.dialog()!;
  expect(form.getAttribute('aria-label')).toBe('Household');
  return form;
};
const save = async (tab: Tab) => {
  await press(button(tab.dialog(), 'Save'));
  await settle(400);
};
const mine = async () => (await stored()).byName['First plan'].plan;
const subOf = (tab: Tab, title: string) => tab.row(title)?.findAll((e) => classOf(e).includes('list-row-sub'))[0]?.textContent;
const partners: PlanItem = {
  id: 'pss',
  label: 'Partner’s Social Security',
  kind: 'social-security',
  from: { anchor: { at: 'age', age: 67 }, offset: 0 },
  until: null,
  once: null,
  yearly: 20_000,
  replaces: null,
  every: null,
  times: null,
  inflationAdjusted: true,
  owner: 'partner',
  beforeTax: false,
};

describe('the stop', () => {
  test('Stop when I reach FI writes it, the age field goes, and the stop age is kept', async () => {
    await seedPlan();
    const tab = await render();
    expect(subOf(tab, 'Household')).toBe('40 now, stop at 55');
    const form = await household(tab);
    await pick(form, 'When I reach FI');
    expect(field(form, 'Stop age')).toBeNull();
    expect(form.textContent).toContain('When I reach FI: the first age your invested assets cover the life you');
    await save(tab);
    const saved = await mine();
    expect([saved.stopAtFi, saved.targetAge]).toEqual([true, 55]);
    expect(subOf(tab, 'Household')).toBe('40 now, stop when you reach FI');
    expect(tab.text()).toMatch(/FI and your stop: around \d+/);
    await tab.unmount();
  }, 20_000);

  test('going back finds the age kept, while it is still ahead', async () => {
    await seedPlan({ ...PLAN, stopAtFi: true });
    const tab = await render();
    const form = await household(tab);
    await pick(form, 'At an age');
    expect(field(form, 'Stop age')?.value).toBe('55');
    await save(tab);
    expect((await mine()).stopAtFi).toBe(false);
    await tab.unmount();
  }, 20_000);

  test('once it has passed, the field comes back empty and says why', async () => {
    await seedPlan({ ...PLAN, age: 60, targetAge: 55, stopAtFi: true });
    const tab = await render();
    const form = await household(tab);
    await pick(form, 'At an age');
    expect(field(form, 'Stop age')?.value).toBe('');
    expect(form.textContent).toContain('The age you had here has passed: type when you');
    await tab.unmount();
  }, 20_000);

  test('under stop when I reach FI your age isn’t held to the stop age it keeps hidden', async () => {
    await seedPlan({ ...PLAN, stopAtFi: true });
    const tab = await render();
    const form = await household(tab);
    await fill(form, 'Your age', '60');
    await save(tab);
    const saved = await mine();
    expect([saved.age, saved.targetAge, saved.stopAtFi]).toEqual([60, 55, true]);
    await tab.unmount();
  }, 20_000);

  test('at an age, a stop before your age is refused, in words', async () => {
    await seedPlan();
    const tab = await render();
    const form = await household(tab);
    await fill(form, 'Stop age', '30');
    await press(button(form, 'Save'));
    expect(tab.dialog()!.textContent).toContain("Your stop age can't be before your age.");
    expect(writes()).toEqual([]);
    await tab.unmount();
  }, 20_000);

  test('in a copy the stop saves to the copy, and both ages are off', async () => {
    await seedPlan();
    await seedCopy('Stop at 52', { targetAge: 52 });
    const tab = await render();
    await openCopy(tab, 'Stop at 52');
    const form = await household(tab);
    expect(field(form, 'Your age')?.disabled).toBe(true);
    expect(field(form, 'Your partner')?.disabled).toBe(true);
    expect(form.textContent).toContain('Both ages are the same in every plan: change it on your plan.');
    await pick(form, 'When I reach FI');
    await save(tab);
    const { byName } = await stored();
    expect(byName['Stop at 52'].plan.stopAtFi).toBe(true);
    expect(byName['First plan'].plan.stopAtFi).toBe(false);
    await tab.unmount();
  }, 20_000);
});

describe('your partner’s age', () => {
  test('a fact: saved on your plan, in its sub, and in every plan', async () => {
    await seedPlan();
    await seedCopy('Stop at 52', { targetAge: 52 });
    const tab = await render();
    const form = await household(tab);
    await fill(form, 'Your partner', '38');
    await save(tab);
    expect(subOf(tab, 'Household')).toBe('40 and 38 now, stop at 55');
    const { byName } = await stored();
    expect(byName['First plan'].plan.partnerAge).toBe(38);
    expect(byName['Stop at 52'].plan.partnerAge).toBe(38);
    await tab.unmount();
  }, 20_000);

  test('clearing it while your plan has an item timed by it is refused, naming the item', async () => {
    await seedPlan({ ...PLAN, partnerAge: 38, items: [partners] });
    const tab = await render();
    const form = await household(tab);
    await fill(form, 'Your partner', '');
    await press(button(form, 'Save'));
    expect(tab.dialog()!.textContent).toContain('“Partner’s Social Security”');
    expect(writes()).toEqual([]);
    expect((await mine()).partnerAge).toBe(38);
    await tab.unmount();
  }, 20_000);

  test('cleared with a copy that has one: your plan saves; the copy’s card names the item, not a one-off, and nothing is saved to it until asked', async () => {
    await seedPlan({ ...PLAN, partnerAge: 38 });
    await seedCopy('With her', { items: [partners] }, { ...PLAN, partnerAge: 38 });
    const tab = await render();
    const form = await household(tab);
    await fill(form, 'Your partner', '');
    await save(tab);
    expect(writes()).toEqual(['PUT /api/fire-plan']);
    expect((await mine()).partnerAge).toBeNull();
    await openCopy(tab, 'With her');
    const said = tab.card()!.textContent;
    expect(said).toContain('the item "Partner’s Social Security"');
    expect(said).not.toContain('one-off');
    expect(said).toContain('nothing is saved to it until you choose Save it this way.');
    await tab.unmount();
  }, 30_000);
});
