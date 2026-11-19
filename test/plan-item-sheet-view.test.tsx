import { describe, expect, test } from 'bun:test';
import { TEST_CONTAINER } from './fake-redis';
import { planPage } from './plan-page';

// The Timeline's item sheet (the tax plan's E2, components/PlanItemSheet.tsx),
// used as a person would on the real plan routes: each template's fields and
// helper, Starts and Ends, what is possible as it is typed, what it refuses,
// saving, Try it in a copy, Also change it in, and Remove.

const page = await planPage();
const { dom, PLAN, WITH_BALANCES, settle, rest, seedPlan, seedCopy, stored, writes, classOf, render, press, button, fill, field, pick, choice, addTemplate, openCopy } = page;
const { BREAK_HELP, ITEM_TEMPLATES, templateHelp } = await import('@/components/plan-items');
const { itemFromExpense, itemFromIncome } = await import('@/lib/fire/items');
type PlanItem = import('@/lib/fire/items').PlanItem;
type FirePlanV2 = import('@/lib/fire/plan-v2').FirePlanV2;

const mk = (id: string, kind: PlanItem['kind'], from: PlanItem['from'], set: Partial<PlanItem> = {}): PlanItem => ({
  id,
  label: id,
  kind,
  from,
  until: null,
  once: null,
  yearly: null,
  replaces: null,
  every: null,
  times: null,
  inflationAdjusted: true,
  owner: null,
  beforeTax: false,
  ...set,
});
const at = (age: number, offset = 0) => ({ anchor: { at: 'age' as const, age }, offset });
const ROOF = itemFromExpense({ id: 'roof', label: 'Roof', amount: 30_000, atAge: 45 });
const SOCIAL = itemFromIncome({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true });
const labelsIn = (sheet: ReturnType<ReturnType<typeof page.dom.document.createElement>['findAll']>[number]) =>
  sheet.findAll((e) => e.tagName === 'LABEL' && classOf(e).includes('field')).map((l) => l.textContent.trim());
const removeRow = (sheet: { findAll: (p: (e: { tagName: string; textContent: string }) => boolean) => any[] }, where = 'your plan') => sheet.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith(`Remove from ${where}`))[0];

describe('each template', () => {
  const FIELDS: Record<string, string[]> = {
    cost: ['Name', 'The amount'],
    spending: ['Name', 'By, a year'],
    home: ['Name', 'Paid from your investments', 'Change in yearly spending from then'],
    income: ['Name', 'A year'],
    windfall: ['Name', 'Amount, after tax'],
    pay: ['Name', 'By, a year'],
    'part-time': ['Name', 'A year', 'The take-home it replaces, a year'],
  };

  test('8 of them, each with its own helper, its fields, its name filled in and nothing else, and whether it has an end', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    expect(ITEM_TEMPLATES.length).toBe(8);
    for (const t of ITEM_TEMPLATES) {
      const sheet = await addTemplate(tab, t.label);
      expect([t.id, sheet.getAttribute('aria-label')]).toEqual([t.id, t.label]);
      expect(sheet.textContent).toContain((templateHelp(t.id) ?? templateHelp(t.kind))!);
      expect(sheet.textContent).toContain('Your own figures: Nya suggests none.');
      if (t.id === 'milestone') {
        // Reached when takes the place of Starts and Ends (its own tests below).
        expect([labelsIn(sheet), tab.sheetRow('Starts') === null, tab.sheetRow('Ends') === null, field(sheet, 'Name')?.value]).toEqual([['Name', 'Amount', 'Spending a year'], true, true, t.name]);
        await press(sheet.findAll((e) => e.getAttribute('aria-label') === 'Close')[0]);
        await settle(400);
        continue;
      }
      // The age field under Starts follows them.
      expect([t.id, labelsIn(sheet)]).toEqual([t.id, [...FIELDS[t.id], 'Starts at age']]);
      expect(field(sheet, 'Name')?.value).toBe(t.name);
      const inputs = sheet.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'number');
      expect([t.id, inputs.map((e) => e.value).join('')]).toEqual([t.id, '']);
      // Once-only kinds have no Ends, nor a home until it changes spending.
      const noEnd = ['cost', 'windfall', 'home'].includes(t.id);
      expect([t.id, tab.sheetRow('Ends') === null]).toEqual([t.id, noEnd]);
      await press(button(sheet, 'Add to your plan') && sheet.findAll((e) => e.getAttribute('aria-label') === 'Close')[0]);
      await settle(400);
    }
    await tab.unmount();
  }, 60_000);

  test('Income asks what it is: the helper and a name it gave follow the pick, a typed name stays, and it saves as that kind', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'Income');
    expect(choice(sheet, 'Social Security')?.findAll((e) => e.tagName === 'INPUT')[0].checked).toBe(true);
    expect(sheet.textContent).toContain('as your statement gives it');
    await pick(sheet, 'A pension');
    expect(field(tab.dialog()!, 'Name')?.value).toBe('A pension');
    expect(tab.dialog()!.textContent).toContain(templateHelp('pension')!);
    await fill(tab.dialog()!, 'Name', 'Rent from the flat');
    await pick(tab.dialog()!, 'Other income');
    expect(field(tab.dialog()!, 'Name')?.value).toBe('Rent from the flat');
    await pick(tab.dialog()!, 'A pension');
    await fill(tab.dialog()!, 'A year', '12000');
    await fill(tab.dialog()!, 'Starts at age', '65');
    await press(button(tab.dialog(), 'Add to your plan'));
    await settle(400);
    const added = (await stored()).byName['First plan'].plan.items.find((x: PlanItem) => x.label === 'Rent from the flat');
    expect([added?.kind, added?.yearly, added?.beforeTax]).toEqual(['pension', 12_000, true]);
    await tab.unmount();
  }, 30_000);

  test('A change in pay, less: a line on what a break is, and it saves as pay down for its years', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'A change in pay');
    expect(sheet.textContent).not.toContain(BREAK_HELP);
    await pick(sheet, 'Less');
    expect(tab.dialog()!.textContent).toContain(BREAK_HELP);
    await fill(tab.dialog()!, 'Name', 'A career break');
    await fill(tab.dialog()!, 'By, a year', '30000');
    await fill(tab.dialog()!, 'Starts at age', '45');
    await press(tab.sheetRow('Ends'));
    await pick(tab.dialog()!, 'After some years');
    await fill(tab.dialog()!, 'For how many years', '2');
    await press(button(tab.dialog(), 'Done'));
    await press(button(tab.dialog(), 'Add to your plan'));
    await settle(400);
    const added = (await stored()).byName['First plan'].plan.items.find((x: PlanItem) => x.label === 'A career break');
    expect([added?.kind, added?.yearly, added?.until]).toEqual(['pay', -30_000, { years: 2 }]);
    await tab.unmount();
  }, 30_000);

  test('no Whose without a partner; income is before or after tax, before first', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'Income');
    expect(sheet.textContent).not.toContain('Whose');
    expect(choice(sheet, 'Before tax')?.getAttribute('aria-checked')).toBe('true');
    await tab.unmount();
  }, 20_000);

  test('Whose with a partner set, and its age follows', async () => {
    await seedPlan({ ...PLAN, partnerAge: 38, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'Income');
    expect(sheet.textContent).toContain('Whose');
    await pick(sheet, 'Your partner');
    expect(field(sheet, 'Starts at your partner’s age')).not.toBeNull();
    await tab.unmount();
  }, 30_000);
});

describe('kinds with no row of their own', () => {
  const CAR = mk('car', 'car', at(44), { label: 'New car', once: 30_000, times: 1 });
  const CHILD = mk('kid', 'child', at(43), { label: 'Maya', yearly: 9_000, until: { years: 18 } });
  const LOAN = mk('loan', 'loan-end', at(45), { label: 'Car loan paid off', yearly: 6_000 });
  const BREAK = mk('brk', 'pay', at(44), { label: 'Sabbatical', yearly: -40_000, until: { years: 2 } });
  const PENSION = mk('pen', 'pension', at(65), { label: 'Teacher pension', yearly: 12_000, inflationAdjusted: false, beforeTax: true });
  const cases: [PlanItem, string, string[]][] = [
    [CAR, 'cost', ['Name', 'Paid from your investments, each']],
    [CHILD, 'spending', ['Name', 'More spending a year']],
    [LOAN, 'spending', ['Name', 'Spending less a year']],
    [BREAK, 'pay', ['Name', 'By, a year']],
    [PENSION, 'income', ['Name', 'A year']],
  ];

  test('each opens in the row that took its place, with its own fields, and saves back as it was', async () => {
    await seedPlan({ ...PLAN, items: [ROOF, ...cases.map(([x]) => x)] });
    const tab = await render();
    for (const [x, template, labels] of cases) {
      await press(tab.row(x.label));
      const sheet = tab.dialog()!;
      expect([x.id, sheet.textContent.includes((templateHelp(template) ?? templateHelp(x.kind))!)]).toEqual([x.id, true]);
      expect([x.id, labelsIn(sheet)]).toEqual([x.id, [...labels, 'Starts at age']]);
      // Income says which kind it is.
      if (template === 'income') expect(choice(sheet, 'A pension')?.findAll((e) => e.tagName === 'INPUT')[0].checked).toBe(true);
      await fill(sheet, 'Name', `${x.label}, renamed`);
      await press(button(tab.dialog(), 'Save'));
      await settle(400);
      const saved = (await stored()).byName['First plan'].plan.items.find((y: PlanItem) => y.id === x.id);
      expect(saved).toEqual({ ...x, label: `${x.label}, renamed` });
    }
    await tab.unmount();
  }, 60_000);

  test('a break opens on Less, with its line; a child keeps an end and a loan paid off has none', async () => {
    await seedPlan({ ...PLAN, items: [ROOF, CHILD, LOAN, BREAK] });
    const tab = await render();
    await press(tab.row('Sabbatical'));
    expect(choice(tab.dialog()!, 'Less')?.getAttribute('aria-checked')).toBe('true');
    expect(tab.dialog()!.textContent).toContain(BREAK_HELP);
    await press(button(tab.dialog(), 'Cancel'));
    await press(tab.row('Maya'));
    await press(tab.sheetRow('Ends'));
    expect(tab.dialog()!.textContent).not.toContain('For good');
    await press(button(tab.dialog(), 'Done'));
    await press(button(tab.dialog(), 'Cancel'));
    await press(tab.row('Car loan paid off'));
    expect(tab.sheetRow('Ends')).toBeNull();
    await tab.unmount();
  }, 40_000);
});

describe('Starts and Ends', () => {
  test('a level with back named, its choices by kind, the picked one’s fields under it, and back keeps what was typed', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'A change in spending');
    await fill(sheet, 'By, a year', '4000');
    await press(tab.sheetRow('Starts'));
    const level = tab.dialog()!;
    expect(level.getAttribute('aria-label')).toBe('Starts');
    expect(level.findAll((e) => e.getAttribute('aria-label') === 'Back to A change in spending').length).toBe(1);
    expect(level.textContent).toContain('At an age');
    expect(level.textContent).toContain('When you stopAt 55');
    expect(level.textContent).toMatch(/When you reach FIAround \d+/);
    expect(level.textContent).not.toContain('For good');
    // The picked one's fields beside its label, not inside it.
    await pick(level, 'When invested assets reach');
    const detail = level.findAll((e) => classOf(e).includes('radio-row-detail'))[0];
    expect(detail.textContent).toContain('Invested assets');
    expect(detail.parentNode).not.toBe(choice(level, 'When invested assets reach'));
    await fill(level, 'Invested assets', '700000');
    await press(button(level, 'Done'));
    // Focus back on the row that opened it.
    expect(dom.document.activeElement).toBe(tab.sheetRow('Starts')!);
    expect(tab.sheetRow('Starts')!.textContent).toContain('When invested assets reach $700,000');
    expect(field(tab.dialog()!, 'By, a year')?.value).toBe('4000');
    // Ends: the same, with For good and after some years.
    await press(tab.sheetRow('Ends'));
    expect(tab.dialog()!.textContent).toContain('For good');
    expect(tab.dialog()!.textContent).toContain('After some years');
    await pick(tab.dialog()!, 'After some years');
    await fill(tab.dialog()!, 'For how many years', '3');
    await press(button(tab.dialog(), 'Done'));
    expect(dom.document.activeElement).toBe(tab.sheetRow('Ends')!);
    await press(button(tab.dialog(), 'Add to your plan'));
    await settle(400);
    const saved = (await stored()).byName['First plan'].plan.items.find((x: PlanItem) => x.label === 'A change in spending')!;
    expect([saved.from, saved.until, saved.yearly]).toEqual([{ anchor: { at: 'balance', amount: 700_000 }, offset: 0 }, { years: 3 }, 4_000]);
    await tab.unmount();
  }, 30_000);

  test('part-time work always ends; When you stop is off with no stop, and the legend says why', async () => {
    await seedPlan({ ...PLAN, targetAge: null, items: [ROOF] });
    const tab = await render();
    await addTemplate(tab, 'Part-time work');
    await press(tab.sheetRow('Ends'));
    const level = tab.dialog()!;
    expect(level.textContent).not.toContain('For good');
    expect(level.textContent).toContain('Set when you stop in Household first.');
    const off = choice(level, 'When you stop')!.findAll((e) => e.tagName === 'INPUT')[0];
    expect(off.disabled).toBe(true);
    const fieldset = level.findAll((e) => e.tagName === 'FIELDSET')[0];
    const describedBy = fieldset.getAttribute('aria-describedby');
    expect(level.findAll((e) => e.getAttribute('id') === describedBy)[0]?.textContent).toContain('Set when you stop in Household first.');
    await press(button(level, 'Done'));
    await tab.unmount();
  }, 30_000);

  test('under stop when I reach FI, When you stop and When you reach FI are both listed, and say they are the same year', async () => {
    await seedPlan({ ...PLAN, stopAtFi: true, targetAge: null, items: [ROOF] });
    const tab = await render();
    await addTemplate(tab, 'A cost');
    await press(tab.sheetRow('Starts'));
    const level = tab.dialog()!;
    expect(level.textContent).toContain('When you stopThe same year while you stop at FI');
    expect(level.textContent).toContain('When you reach FIThe same year while you stop at FI');
    await tab.unmount();
  }, 20_000);
});

describe('what is possible', () => {
  test('on a balance: where the steady path has it, the FI date, and that it is checked each year', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'A change in spending');
    await fill(sheet, 'By, a year', '4000');
    await press(tab.sheetRow('Starts'));
    await pick(tab.dialog()!, 'When invested assets reach');
    await fill(tab.dialog()!, 'Invested assets', '700000');
    await press(button(tab.dialog(), 'Done'));
    await rest();
    const t = tab.dialog()!.textContent;
    expect(t).toContain('What’s possible');
    expect(t).toMatch(/On your steady pathFrom \d+, when invested assets reach \$700,000/);
    expect(t).toMatch(/Your FI date(From around \d+ to around \d+|Stays around \d+)/);
    expect(t).toContain('Checked on the balance at the start of each year');
    await tab.unmount();
  }, 20_000);

  test('with a start from what you would have then, a later balance says where it falls across the runs', async () => {
    await seedPlan({ ...PLAN, start: 'at-stop', items: [ROOF] });
    const tab = await render(WITH_BALANCES);
    const sheet = await addTemplate(tab, 'A change in spending');
    await fill(sheet, 'By, a year', '4000');
    await press(tab.sheetRow('Starts'));
    await pick(tab.dialog()!, 'When invested assets reach');
    await fill(tab.dialog()!, 'Invested assets', '5000000');
    await press(button(tab.dialog(), 'Done'));
    await rest();
    await settle(800);
    expect(tab.dialog()!.textContent).toMatch(/Across historyIt (starts in (every run|\d+% of runs), by \d+ in half of (them|those)|never starts, in any run)/);
    await tab.unmount();
  }, 30_000);

  test('a balance never reached says the nearest', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'A cost');
    await fill(sheet, 'The amount', '1000');
    await press(tab.sheetRow('Starts'));
    await pick(tab.dialog()!, 'When invested assets reach');
    await fill(tab.dialog()!, 'Invested assets', '900000000');
    await press(button(tab.dialog(), 'Done'));
    await rest();
    const t = tab.dialog()!.textContent;
    expect(t).toContain('It never starts');
    expect(t).toMatch(/at most \$[\d,]+, at \d+, so it never starts\./);
    await tab.unmount();
  }, 20_000);

  test('a change in pay says what you’d save, measured against your savings', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'A change in pay');
    await fill(sheet, 'By, a year', '20000');
    await fill(sheet, 'Starts at age', '45');
    await rest();
    expect(tab.dialog()!.textContent).toContain('You’d save$50,000 a year, not $30,000');
    await pick(sheet, 'Less');
    await rest();
    expect(tab.dialog()!.textContent).toContain('You’d save$10,000 a year, not $30,000');
    await tab.unmount();
  }, 20_000);

  test('on FI: it moves when FI does, and what FI would be without it', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'A cost');
    await fill(sheet, 'The amount', '100000');
    await press(tab.sheetRow('Starts'));
    await pick(tab.dialog()!, 'When you reach FI');
    await press(button(tab.dialog(), 'Done'));
    await rest();
    expect(tab.dialog()!.textContent).toMatch(/the year you reach FI; without it, FI would be around \d+\. It moves when FI does\./);
    expect(tab.dialog()!.textContent).toMatch(/Starts at \d+ in every run/);
    await tab.unmount();
  }, 20_000);

  test('part-time before the stop: what you’d save, and the caution while what it replaces isn’t said', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'Part-time work');
    await fill(sheet, 'A year', '20000');
    await fill(sheet, 'Starts at age', '50');
    await press(tab.sheetRow('Ends'));
    await fill(tab.dialog()!, 'Age', '60');
    await press(button(tab.dialog(), 'Done'));
    await rest();
    const caution = () => tab.dialog()!.findAll((e) => classOf(e).includes('notice') && classOf(e).includes('caution')).map((e) => e.textContent).join(' ');
    expect(caution()).toContain('Say what take-home it replaces, so it counts in your FI date');
    await fill(sheet, 'The take-home it replaces', '25000');
    await rest();
    expect(caution()).not.toContain('Say what take-home it replaces');
    expect(tab.dialog()!.textContent).toContain('You’d save$25,000 a year, not $30,000');
    // Begun before today, it is in the $30,000 already.
    await fill(sheet, 'Starts at age', '38');
    await rest();
    expect(tab.dialog()!.textContent).not.toContain('You’d save');
    await tab.unmount();
  }, 20_000);

  test('two part-time jobs for one person that meet on the steady path are said to', async () => {
    await seedPlan({ ...PLAN, items: [mk('job', 'part-time', { anchor: { at: 'stop' }, offset: 0 }, { label: 'Consulting', until: at(62), yearly: 10_000 })] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'Part-time work');
    await fill(sheet, 'A year', '20000');
    await press(tab.sheetRow('Starts'));
    await pick(tab.dialog()!, 'When you reach FI');
    await press(button(tab.dialog(), 'Done'));
    await press(tab.sheetRow('Ends'));
    await fill(tab.dialog()!, 'Age', '60');
    await press(button(tab.dialog(), 'Done'));
    await rest();
    const warned = tab.dialog()!.findAll((e) => classOf(e).includes('plan-warning')).map((e) => e.textContent);
    expect(warned).toContain('It overlaps “Consulting” on your steady path. Both count in those years. If one takes over from the other, start it when the other ends.');
    await tab.unmount();
  }, 20_000);

  test('waiting on figures, and a line that says what is missing', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    await addTemplate(tab, 'A cost');
    expect(tab.dialog()!.textContent).toContain('Fill in the figures to see how it moves your FI age.');
    await tab.unmount();
  }, 20_000);
});

describe('what it refuses', () => {
  test('an empty field is named, and nothing is saved', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'A cost');
    await press(button(sheet, 'Add to your plan'));
    expect(tab.dialog()!.textContent).toContain('Fill in the amount.');
    expect(writes()).toEqual([]);
    await tab.unmount();
  }, 20_000);

  test('two items timed by each other, by name', async () => {
    const other = mk('b', 'spending', { anchor: { at: 'item', id: 'c', edge: 'start' }, offset: 0 }, { label: 'Boat', yearly: 100 });
    const third = mk('c', 'spending', at(50), { label: 'Cabin', yearly: 100 });
    await seedPlan({ ...PLAN, items: [other, third] });
    const tab = await render();
    await press(tab.row('Cabin'));
    await press(tab.sheetRow('Starts'));
    const level = tab.dialog()!;
    await pick(level, 'When another item starts or ends');
    const select = level.findAll((e) => e.tagName === 'SELECT')[0];
    await page.act(async () => page.type(select, 'b'));
    await settle();
    await press(button(level, 'Done'));
    await press(button(tab.dialog(), 'Save'));
    expect(tab.dialog()!.textContent).toContain('“Boat” and “Cabin” wait on each other');
    expect(writes()).toEqual([]);
    await tab.unmount();
  }, 20_000);

  test('an end before its start', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'Part-time work');
    await fill(sheet, 'A year', '20000');
    await fill(sheet, 'Starts at age', '50');
    await press(tab.sheetRow('Ends'));
    await fill(tab.dialog()!, 'Age', '45');
    await press(button(tab.dialog(), 'Done'));
    await press(button(tab.dialog(), 'Add to your plan'));
    expect(tab.dialog()!.textContent).toContain('stops before it starts');
    expect(writes()).toEqual([]);
    await tab.unmount();
  }, 20_000);

  test('an Add that takes your plan’s spending in retirement below zero: refused in the plan’s words, and nothing saved', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'A change in spending');
    await fill(sheet, 'By, a year', '50000');
    await pick(sheet, 'Less');
    await fill(sheet, 'Starts at age', '45');
    await press(button(sheet, 'Add to your plan'));
    expect(tab.dialog()!.textContent).toContain('below zero');
    expect(tab.dialog()!.textContent).toContain('Nothing was saved.');
    expect(writes()).toEqual([]);
    await tab.unmount();
  }, 20_000);
});

describe('a refused plan', () => {
  const BELOW = mk('x', 'spending', at(41), { label: 'Mortgage paid off', yearly: -45_000 });

  test('yours: it loads with why and its Timeline to fix it, and doesn’t throw', async () => {
    await seedPlan({ ...PLAN, items: [BELOW] });
    const tab = await render();
    expect(tab.text()).toContain('below zero');
    expect(tab.row('Mortgage paid off')).not.toBeNull();
    // Fixed a step at a time, from there.
    await press(tab.row('Mortgage paid off'));
    await fill(tab.dialog()!, 'By, a year', '10000');
    await press(button(tab.dialog(), 'Save'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/fire-plan']);
    expect(tab.text()).not.toContain('below zero');
    await tab.unmount();
  }, 30_000);

  test('a save to a copy already refused is taken, so it can be fixed a step at a time', async () => {
    await seedPlan();
    await seedCopy('Mortgage gone', { items: [BELOW, mk('y', 'spending', at(42), { label: 'Less too', yearly: -30_000 })] });
    const tab = await render();
    await openCopy(tab, 'Mortgage gone');
    await press(tab.row('Less too'));
    await fill(tab.dialog()!, 'By, a year', '20000');
    await press(button(tab.dialog(), 'Save'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/plans']);
    expect((await stored()).byName['Mortgage gone'].plan.items[1].yearly).toBe(-20_000);
    await tab.unmount();
  }, 30_000);
});

describe('an item there', () => {
  test('its sheet opens as it was saved; Save changes it, Cancel doesn’t', async () => {
    await seedPlan({ ...PLAN, items: [SOCIAL] });
    const tab = await render();
    await press(tab.row('Social Security'));
    const sheet = tab.dialog()!;
    expect(field(sheet, 'A year')?.value).toBe('24000');
    expect(field(sheet, 'Starts at age')?.value).toBe('67');
    expect(button(sheet, 'Add to your plan')).toBeNull();
    await fill(sheet, 'A year', '30000');
    await press(button(sheet, 'Cancel'));
    await settle(400);
    expect(writes()).toEqual([]);
    await press(tab.row('Social Security'));
    expect(field(tab.dialog()!, 'A year')?.value).toBe('24000');
    await fill(tab.dialog()!, 'A year', '30000');
    await press(button(tab.dialog(), 'Save'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/fire-plan']);
    expect((await stored()).byName['First plan'].plan.items[0].yearly).toBe(30_000);
    await tab.unmount();
  }, 30_000);

  test('Try this change in a copy: only once it differs, and your plan stays', async () => {
    await seedPlan({ ...PLAN, items: [SOCIAL] });
    const tab = await render();
    await press(tab.row('Social Security'));
    const sheet = tab.dialog()!;
    expect(tab.sheetRow('Try this change in a copy')).toBeNull();
    await fill(sheet, 'A year', '30000');
    await press(tab.sheetRow('Try this change in a copy'));
    await settle(400);
    expect(writes()).toEqual(['POST /api/plans']);
    expect(tab.title()).toBe('Copy: Social Security at 67');
    const { byName } = await stored();
    expect(byName['First plan'].plan.items[0].yearly).toBe(24_000);
    await tab.unmount();
  }, 30_000);

  test('Also change it in: both take it; a ticked plan the change would break is refused by name, and nothing is saved', async () => {
    const mine: FirePlanV2 = { ...PLAN, items: [mk('less', 'spending', at(45), { label: 'Downshift', yearly: -10_000 })] };
    await seedPlan(mine);
    // In this copy a further cut is what takes retirement spending below zero.
    await seedCopy('Lean', { spending: 12_000 }, mine);
    await seedCopy('Same', {}, mine);
    const tab = await render();
    await press(tab.row('Downshift'));
    const sheet = tab.dialog()!;
    const rows = sheet.findAll((e) => e.tagName === 'LABEL' && classOf(e).includes('check-row'));
    expect(rows.map((r) => r.findAll((e) => classOf(e).includes('check-row-title'))[0]?.textContent)).toEqual(['Lean', 'Same']);
    await fill(sheet, 'By, a year', '20000');
    const box = rows[0].findAll((e) => e.tagName === 'INPUT')[0];
    await page.act(async () => {
      box.checked = true;
      page.click(box);
    });
    await settle();
    await press(button(sheet, 'Save'));
    expect(tab.dialog()!.textContent).toContain('Lean can’t take this change, so nothing was saved: its spending in retirement would go below zero. Untick it to save the rest.');
    expect(writes()).toEqual([]);
    await tab.unmount();
  }, 40_000);

  test('Remove: a level that asks, naming what is timed by it, with only Back then', async () => {
    const roof = ROOF;
    const after = mk('after', 'spending', { anchor: { at: 'item', id: 'roof', edge: 'start' }, offset: 0 }, { label: 'Upkeep', yearly: 500 });
    await seedPlan({ ...PLAN, items: [roof, after] });
    const tab = await render();
    await press(tab.row('Roof'));
    const row = removeRow(tab.dialog()!);
    expect(classOf(row)).toContain('neg');
    await press(row);
    const level = tab.dialog()!;
    expect(level.getAttribute('aria-label')).toBe('Remove Roof');
    expect(level.textContent).toContain('“Upkeep” is timed by it. Change when that starts or ends first.');
    expect(button(level, 'Remove')).toBeNull();
    await press(button(level, 'Back'));
    expect(tab.dialog()!.getAttribute('aria-label')).toBe('Roof');
    expect(page.dom.document.activeElement).toBe(removeRow(tab.dialog()!));
    expect(writes()).toEqual([]);
    await tab.unmount();
  }, 20_000);

  test('a row’s warning is in its sheet too', async () => {
    await seedPlan({ ...PLAN, items: [mk('old', 'one-off', at(30), { label: 'Old roof', once: 9_000 })] });
    const tab = await render();
    await press(tab.row('Old roof'));
    await rest();
    const warned = tab.dialog()!.findAll((e) => classOf(e).includes('plan-warning')).map((e) => e.textContent);
    expect(warned).toEqual(['Before today, so it isn’t counted: your measured figures may already count it.']);
    await tab.unmount();
  }, 20_000);
});

describe('a save that fails', () => {
  test('keeps the sheet, what was typed and why; the plan on screen goes back, and it can be tried again', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'A cost');
    await fill(sheet, 'Name', 'New roof');
    await fill(sheet, 'The amount', '5000');
    await fill(sheet, 'Starts at age', '45');
    page.answers['PUT /api/fire-plan'] = () => Response.json({ error: 'Nope' }, { status: 500 });
    await press(button(sheet, 'Add to your plan'));
    await settle(400);
    const open = tab.dialog();
    expect(open?.getAttribute('aria-label')).toBe('A cost');
    expect(field(open!, 'The amount')?.value).toBe('5000');
    expect(open!.textContent).toContain('It was not saved. Try again in a moment.');
    expect(tab.row('New roof')).toBeNull();
    delete page.answers['PUT /api/fire-plan'];
    await press(button(tab.dialog(), 'Add to your plan'));
    await settle(400);
    expect(tab.dialog()).toBeNull();
    expect(tab.row('New roof')).not.toBeNull();
    expect((await stored()).byName['First plan'].plan.items.map((x: PlanItem) => x.label)).toEqual(['Roof', 'New roof']);
    await tab.unmount();
  }, 30_000);
});

describe('the Honesty cautions', () => {
  test('before tax, income before FI says the rate it counts at, in the sheet at caution level', async () => {
    await seedPlan({ ...PLAN, items: [mk('rent', 'other-income', at(45), { label: 'Rent', yearly: 12_000, beforeTax: true })] });
    const tab = await render();
    expect(tab.timeline()!.textContent).toContain('In your FI date after 0% tax');
    await press(tab.row('Rent'));
    await rest();
    const caution = tab.dialog()!.findAll((e) => classOf(e).includes('notice') && classOf(e).includes('caution')).map((e) => e.textContent).join(' ');
    expect(caution).toContain('In your FI date after 0% tax, your plan’s rate on withdrawals. It may keep less: give its take-home for a closer date');
    await tab.unmount();
  }, 20_000);
});

describe('a milestone', () => {
  const LEAN = mk('lean', 'milestone', at(50), { label: 'Lean FI' });
  const radioOn = (within: Parameters<typeof choice>[0], words: string) => choice(within, words)?.findAll((e) => e.tagName === 'INPUT')[0].checked;

  test('an amount: worked out from a spending with Use it, saved with no money, and no Starts row or Try it in a copy', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'A milestone');
    expect(radioOn(sheet, 'Invested assets reach an amount')).toBe(true);
    expect([tab.sheetRow('Starts'), button(sheet, 'Try it in a copy')]).toEqual([null, null]);
    expect(sheet.textContent).toContain('Worked out once: the amount stays as it is if your plan changes.');
    expect(button(sheet, 'Use it')).toBeNull();
    expect(sheet.textContent).toContain('Fill in the figures to see where it falls.');
    await fill(sheet, 'Spending a year', '30000');
    await rest();
    expect(tab.dialog()!.textContent).toMatch(/At your [\d.]+% withdrawal rate: about \$[\d,]+,000\./);
    await press(button(tab.dialog(), 'Use it'));
    const amount = Number(field(tab.dialog()!, 'Amount')?.value);
    expect(amount % 1000).toBe(0);
    expect(amount).toBeGreaterThan(30_000 * 20);
    await fill(tab.dialog()!, 'Name', 'Lean FI');
    await rest();
    expect(tab.dialog()!.textContent).toContain('To time an item on it, pick Lean FI under that item’s Starts or Ends.');
    await press(button(tab.dialog(), 'Add to your plan'));
    await settle(400);
    const added = (await stored()).byName['First plan'].plan.items.find((x: PlanItem) => x.label === 'Lean FI');
    expect(added).toMatchObject({ kind: 'milestone', from: { anchor: { at: 'balance', amount }, offset: 0 }, until: null, once: null, yearly: null, owner: null });
    await tab.unmount();
  }, 30_000);

  test('an age, with whose when there is a partner', async () => {
    await seedPlan({ ...PLAN, partnerAge: 38, items: [ROOF] });
    const tab = await render();
    await addTemplate(tab, 'A milestone');
    await pick(tab.dialog()!, 'An age');
    await pick(tab.dialog()!, 'Your partner');
    await fill(tab.dialog()!, 'Your partner’s age', '60');
    await fill(tab.dialog()!, 'Name', 'Partner at 60');
    await rest();
    expect(tab.dialog()!.textContent).toContain('Items timed on it move together when you change the age.');
    await press(button(tab.dialog(), 'Add to your plan'));
    await settle(400);
    const added = (await stored()).byName['First plan'].plan.items.find((x: PlanItem) => x.label === 'Partner at 60');
    expect(added).toMatchObject({ kind: 'milestone', from: { anchor: { at: 'age', age: 60 }, offset: 0 }, owner: 'partner' });
    await tab.unmount();
  }, 30_000);

  test('a saved one offers Save and Remove, never Try it in a copy', async () => {
    await seedPlan({ ...PLAN, items: [ROOF, LEAN] });
    const tab = await render();
    await press(tab.row('Milestone: Lean FI'));
    const sheet = tab.dialog()!;
    expect(radioOn(sheet, 'An age')).toBe(true);
    await fill(sheet, 'Age', '51');
    await rest();
    expect([button(tab.dialog(), 'Save') !== null, button(tab.dialog(), 'Try it in a copy'), tab.dialog()!.textContent.includes('Try this change in a copy')]).toEqual([true, null, false]);
    expect(removeRow(tab.dialog()!)).toBeDefined();
    await tab.unmount();
  }, 20_000);

  test('a milestone at your partner’s age says whose age in Starts', async () => {
    await seedPlan({ ...PLAN, partnerAge: 37, items: [ROOF, mk('theirs', 'milestone', at(55), { label: 'Partner at 55', owner: 'partner' })] });
    const tab = await render();
    await addTemplate(tab, 'A cost');
    await press(tab.sheetRow('Starts'));
    const level = tab.dialog()!;
    await pick(level, 'At a milestone');
    const select = level.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith('Milestone'))[0].findAll((e) => e.tagName === 'SELECT')[0];
    expect(select.findAll((e) => e.tagName === 'OPTION').map((e) => e.textContent)).toEqual(['Pick one', 'Partner at 55 · at your partner’s 55']);
    await tab.unmount();
  }, 20_000);

  test('At a milestone in Starts and Ends, with where each falls; a follower reopens on it; and milestones are not another item', async () => {
    await seedPlan({ ...PLAN, items: [ROOF, LEAN] });
    const tab = await render();
    const sheet = await addTemplate(tab, 'A change in spending');
    await fill(sheet, 'By, a year', '4000');
    await fill(sheet, 'Name', 'Travel more');
    await press(tab.sheetRow('Starts'));
    let level = tab.dialog()!;
    await pick(level, 'When another item starts or ends');
    expect(level.findAll((e) => e.tagName === 'OPTION').map((e) => e.getAttribute('value'))).not.toContain('lean');
    await pick(level, 'At a milestone');
    const select = level.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith('Milestone'))[0].findAll((e) => e.tagName === 'SELECT')[0];
    expect(select.findAll((e) => e.tagName === 'OPTION').map((e) => e.textContent)).toEqual(['Pick one', 'Lean FI · at 50']);
    await page.act(async () => page.type(select, 'lean'));
    await settle();
    await fill(level, 'Years after', '1');
    await press(button(level, 'Done'));
    expect(tab.dialog()!.textContent).toContain('1 year after Lean FI');
    await press(tab.sheetRow('Ends'));
    expect(choice(tab.dialog()!, 'At a milestone')).not.toBeNull();
    await press(button(tab.dialog(), 'Done'));
    await press(button(tab.dialog(), 'Add to your plan'));
    await settle(400);
    const added = (await stored()).byName['First plan'].plan.items.find((x: PlanItem) => x.label === 'Travel more');
    expect(added?.from).toEqual({ anchor: { at: 'item', id: 'lean', edge: 'start' }, offset: 1 });
    await press(tab.row('Travel more'));
    await press(tab.sheetRow('Starts'));
    level = tab.dialog()!;
    expect(radioOn(level, 'At a milestone')).toBe(true);
    await tab.unmount();
  }, 30_000);
});

describe('Try it in a copy', () => {
  test('from a chip, with the copy’s name from its anchor and never an amount', async () => {
    await seedPlan();
    const tab = await render();
    await press(tab.chip('Part-time work'));
    const sheet = tab.dialog()!;
    await fill(sheet, 'A year', '20000');
    await press(tab.sheetRow('Starts'));
    await pick(tab.dialog()!, 'When you stop');
    await press(button(tab.dialog(), 'Done'));
    await press(tab.sheetRow('Ends'));
    await fill(tab.dialog()!, 'Age', '60');
    await press(button(tab.dialog(), 'Done'));
    await press(button(tab.dialog(), 'Try it in a copy'));
    await settle(400);
    expect(tab.title()).toBe('Copy: Part-time work when you stop');
    const { byName } = await stored();
    expect(byName['First plan'].plan.items).toEqual([]);
    expect(byName['Part-time work when you stop'].plan.items[0].from).toEqual({ anchor: { at: 'stop' }, offset: 0 });
    await tab.unmount();
  }, 30_000);
});
