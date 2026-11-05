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
async function optedIn(props: Parameters<typeof render>[0] = {}, plan = PLAN, seeded = false) {
  if (!seeded) await seedPlan(plan);
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

describe('Annual savings', () => {
  test('flat, its split is read-only; detailed, it takes your own by bucket, in one request', async () => {
    await seedPlan();
    const flat = await render();
    expect(field(await sheet(flat, 'Annual savings'), 'Taxable')).toBeFalsy();
    await flat.unmount();
    const tab = await optedIn({}, PLAN, true);
    const form = await sheet(tab, 'Annual savings');
    const mine = form.findAll((e) => e.getAttribute('role') === 'radio' && e.textContent === 'My own');
    await press(mine[mine.length - 1]);
    await fill(tab.dialog()!, 'Taxable', '30');
    await fill(tab.dialog()!, 'Roth', '30');
    await press(button(tab.dialog(), 'Save'));
    await settle(100);
    expect(tab.dialog()!.textContent).toContain('These add up to 60%, not 100%.');
    await fill(tab.dialog()!, 'Tax-deferred', '40');
    await save(tab);
    expect(lastSave().tax.savingsSplit).toEqual([
      { bucket: 'taxable', share: 0.3 },
      { bucket: 'tax-deferred', share: 0.4 },
      { bucket: 'roth', share: 0.3 },
    ]);
    expect((await read()).tax.savingsSplit).toHaveLength(3);
    await tab.unmount();
  }, 30_000);
});

describe('a split in thirds', () => {
  test('to two places it still comes to 100%, saves, and opens as it was saved', async () => {
    const tab = await optedIn();
    const form = await sheet(tab, 'Annual savings');
    const mine = form.findAll((e) => e.getAttribute('role') === 'radio' && e.textContent === 'My own');
    await press(mine[mine.length - 1]);
    for (const b of ['Taxable', 'Tax-deferred', 'Roth']) await fill(tab.dialog()!, b, '33.33');
    await save(tab);
    expect(tab.dialog()).toBeNull();
    const shares: { share: number }[] = lastSave().tax.savingsSplit;
    expect(shares.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 9);
    const before = planSaves().length;
    await sheet(tab, 'Annual savings');
    await save(tab);
    expect(tab.dialog()).toBeNull();
    expect(planSaves().length).toBe(before);
    await tab.unmount();
  }, 30_000);
});

describe('Invested assets', () => {
  const acct = (account_id: string, name: string, subtype: string, balance: number) => ({ account_id, name, type: 'investment', subtype, balance, currency: 'USD' });
  const institutions = [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [acct('k', '401(k)', '401k', 260_000), acct('r', 'Roth IRA', 'roth', 50_000), acct('h', 'HSA', 'hsa', 25_000)] }] as never;

  test('detailed, it says when required withdrawals start, what an HSA does, and what isn’t known of a Roth', async () => {
    await seedPlan();
    const flat = await render({ institutions });
    const flatText = (await sheet(flat, 'Invested assets')).textContent;
    expect(flatText).not.toContain('Required withdrawals start');
    expect(flatText).not.toContain('reachable before 59½');
    expect(flatText).toContain('With a flat tax rate these don’t change');
    await flat.unmount();
    const tab = await optedIn({ institutions }, PLAN, true);
    const text = (await sheet(tab, 'Invested assets')).textContent;
    expect(text).toContain('Required withdrawals start at');
    expect(text).toContain('From 65 it pays Medicare Part B and IRMAA premiums untaxed');
    expect(text).toContain('What went into your Roth isn’t given, so none of it counts as reachable before 59½. Say how much here.');
    expect(text).not.toContain('With a flat tax rate these don’t change');
    await tab.unmount();
  }, 30_000);
});

describe('About these numbers', () => {
  const about = async (tab: Tab) => {
    await pick(tab.container, 'Drawdown');
    return (await sheet(tab, 'About these numbers')).textContent;
  };

  test('flat, one flat rate; detailed, how tax is worked out and what isn’t modeled', async () => {
    await seedPlan();
    const flat = await render();
    expect(await about(flat)).toContain('taxes beyond one flat rate');
    await flat.unmount();
    const tab = await optedIn({}, PLAN, true);
    const text = await about(tab);
    expect(text).not.toContain('taxes beyond one flat rate');
    expect(text).toContain('How tax is worked out');
    expect(text).toContain('75% counts as qualified');
    expect(text).toContain('Only premiums count as health costs');
    expect(text).toContain('An education account you count stands in as tax-deferred');
    expect(text).toContain('Not modeled: the child tax credit');
    await tab.unmount();
  }, 30_000);
});

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
    expect(subOf(tab, 'Health coverage')).toBe('ACA before 65, then Medicare · in your FI number');
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

  test('how fast it rises is in points, to 10', async () => {
    const tab = await optedIn();
    await sheet(tab, 'Health coverage');
    await fill(tab.dialog()!, 'Health costs rise faster', '11');
    await save(tab);
    expect(tab.dialog()?.textContent).toContain('How fast it rises');
    await fill(tab.dialog()!, 'Health costs rise faster', '2.5');
    await save(tab);
    expect(tab.dialog()).toBeNull();
    expect(lastSave().tax.health.growth).toBeCloseTo(0.025, 9);
    await tab.unmount();
  }, 30_000);

  test('something else at no cost opens as it was saved', async () => {
    const tab = await optedIn();
    await pick(await sheet(tab, 'Health coverage'), 'Something else');
    await fill(tab.dialog()!, 'What it costs', '0');
    await save(tab);
    expect(lastSave().tax.health.beforeMedicare).toEqual({ kind: 'other', yearly: 0 });
    expect(field(await sheet(tab, 'Health coverage'), 'What it costs')?.value).toBe('0');
    await tab.unmount();
  }, 30_000);

  test('coverage already paid, with spending typed: nothing is taken out of it', async () => {
    const tab = await optedIn();
    await pick(await sheet(tab, 'Health coverage'), 'You already pay for coverage');
    expect(tab.dialog()!.textContent).toContain('Your FI number still counts it, for now.');
    expect(tab.dialog()!.textContent).toContain('Your spending is typed, so nothing is taken out of it: leave coverage out of what you type.');
    await tab.unmount();
  }, 30_000);

  describe('Medicaid, by the state’s own line', () => {
    const wordsIn = async (state: string | null) => {
      const tab = await optedIn();
      if (state) {
        await sheet(tab, 'Household');
        await fill(tab.dialog()!, 'State', state);
        await save(tab);
      }
      await pick(await sheet(tab, 'Health coverage'), 'ACA marketplace');
      const text = tab.dialog()!.textContent;
      await tab.unmount();
      return text;
    };
    test('the usual line, with the work rule from 2027', async () => {
      const text = await wordsIn('CA');
      expect(text).toContain('Under 138% of the poverty line California covers adults through Medicaid. From 2027 that needs 80 hours a month');
    }, 30_000);
    test('a state’s higher line', async () => {
      expect(await wordsIn('DC')).toContain('Under 215% of the poverty line');
    }, 30_000);
    test('a state that doesn’t expand, up to the poverty line', async () => {
      expect(await wordsIn('WI')).toContain('Under 100% of the poverty line Wisconsin covers adults');
    }, 30_000);
    test('a state with its own work rule says so, and for how long', async () => {
      expect(await wordsIn('GA')).toContain('Under 100% of the poverty line Georgia covers adults through Medicaid if they meet its own work rule, through 2026.');
    }, 30_000);
    test('a state with no line says nothing of it', async () => {
      expect(await wordsIn('TX')).not.toContain('poverty line Texas covers');
    }, 30_000);
  });

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
    expect(field(form, 'Tax on withdrawals')).toBeFalsy();
    expect(form.textContent).not.toContain('Use a flat rate instead');
    expect(form.textContent).toContain('What the simulation withdraws comes from your spending, health coverage and their tax.');
    expect(form.textContent).toContain('health coverage, with their tax');
    await fill(form, 'Inflation', '2.5');
    await fill(form, 'Health costs rise', '1.5');
    await save(tab);
    const sent = lastSave();
    expect([sent.tax.inflation, sent.tax.health.growth]).toEqual([0.025, 0.015]);
    expect(subOf(tab, 'Assumptions')).toContain('2.5% inflation · health costs +1.5 points');
    await sheet(tab, 'Tax after you stop');
    await press(tab.sheetRow('Use a flat rate instead'));
    expect(tab.dialog()).toBeNull();
    expect((await read()).tax_facts.model).toBe('flat');
    await pick(tab.container, 'Drawdown');
    expect(tab.text()).not.toContain('Year by year, at');
    expect(tab.row('Work it out from your accounts')).not.toBeNull();
    await tab.unmount();
  }, 30_000);

  test('the start line takes you to what you would have at the stop, only with the flag', async () => {
    const typed = { ...PLAN, start: 'custom' as const, startBalance: 500_000, targetAge: 60 };
    await seedPlan(typed);
    const off = await render();
    await pick(off.container, 'Drawdown');
    expect(off.text()).toContain('Starting from the balance you typed');
    expect(off.text()).not.toContain('Start from what you');
    await off.unmount();
    await flagged();
    const on = await render({ planTax: true });
    await pick(on.container, 'Drawdown');
    const link = button(on.container, 'Start from what you\'d have at 60');
    expect(link!.parentElement?.parentElement?.textContent).toContain('Starting from the balance you typed');
    await press(link);
    await settle(200);
    expect(lastSave().plan.start).toBe('at-stop');
    expect((await read()).plan.start).toBe('at-stop');
    expect(on.text()).not.toContain('Start from what you');
    await on.unmount();
  }, 30_000);

  test('a plan never saved starts from what it would have at the stop, only with the flag', async () => {
    const off = await render();
    await pick(off.container, 'Your path');
    const WITH_THEN = 'with what you’d have then';
    expect((await sheet(off, 'Assumptions')).textContent).not.toContain(WITH_THEN);
    await off.unmount();
    await flagged();
    const on = await render({ planTax: true });
    await pick(on.container, 'Your path');
    expect((await sheet(on, 'Assumptions')).textContent).toContain(WITH_THEN);
    await on.unmount();
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
