import { describe, expect, test } from 'bun:test';
import { TEST_CONTAINER } from './fake-redis';
import { planPage } from './plan-page';

// Year by year on the page, used on the real routes: the way in from a flat plan, then
// the card, a stage's sheet and a year's, and the way back.

const page = await planPage();
const { PLAN, seedPlan, seedCopy, render, press, button, closeOf, pick, openCopy, classOf, calls, fake } = page;
type Tab = Awaited<ReturnType<typeof render>>;

async function flagged() {
  const { flagsStore } = await import('@/lib/flag-store');
  await flagsStore.update('plan-tax', async () => ({ on: 'nobody', containers: [TEST_CONTAINER], updatedAt: new Date().toISOString() }) as never, TEST_CONTAINER);
}
const drawdown = async (tab: Tab) => {
  await pick(tab.container, 'Drawdown');
};
const WAY_IN = 'Work it out from your accounts';

async function detailed(plan = PLAN) {
  await seedPlan(plan);
  await flagged();
  const tab = await render({ planTax: true });
  await drawdown(tab);
  await press(tab.row(WAY_IN));
  await press(button(tab.dialog(), 'Work it out'));
  return tab;
}

describe('the way in', () => {
  test('nothing with the flag off', async () => {
    await seedPlan();
    const tab = await render();
    await drawdown(tab);
    expect(tab.row(WAY_IN)).toBeNull();
    expect(tab.text()).not.toContain('Year by year');
    await tab.unmount();
  }, 20_000);

  test('the row opens what changes and what it reads; Not now changes nothing', async () => {
    await seedPlan();
    await flagged();
    const tab = await render({ planTax: true });
    await drawdown(tab);
    expect(tab.text()).not.toContain('Year by year');
    await press(tab.row(WAY_IN));
    const sheet = tab.dialog()!;
    expect(sheet.getAttribute('aria-label')).toBe(WAY_IN);
    expect(sheet.textContent).toContain('Your FI number changes when this reaches it, in a later version.');
    expect(sheet.textContent).toContain('Each account’s tax bucket, owner and cost basis');
    expect(sheet.textContent).toContain('2026 tax law. Not tax advice.');
    await press(button(sheet, 'Not now'));
    expect(tab.dialog()).toBeNull();
    expect(calls().filter((c) => c.path === '/api/plan-facts' && c.method === 'POST')).toEqual([]);
    expect(tab.row(WAY_IN)).not.toBeNull();
    await tab.unmount();
  }, 20_000);

  test('Work it out shows the years, the hero’s words and no way in', async () => {
    const tab = await detailed();
    expect(tab.dialog()).toBeNull();
    expect(tab.row(WAY_IN)).toBeNull();
    expect(tab.text()).toContain('Year by year, at a steady 5%');
    expect(tab.text()).toContain('from the years below.');
    expect(tab.text()).toContain('your spending and health coverage with their tax');
    expect(tab.text()).toContain('Hypothetical, 2026 tax law. Not tax advice.');
    expect(tab.text()).toContain('Go to Your path');
    await tab.unmount();
  }, 30_000);

  test('every plan was read again, so the next save isn’t refused', async () => {
    const tab = await detailed();
    const after = calls().filter((c) => c.method === 'GET' && (c.path === '/api/fire-plan' || c.path === '/api/plan-inputs' || c.path === '/api/plans'));
    expect(after.length).toBeGreaterThan(2);
    await pick(tab.container, 'Your path');
    await press(tab.row('Household'));
    await press(button(tab.dialog(), 'Save'));
    expect(tab.dialog()).toBeNull();
    await tab.unmount();
  }, 30_000);

  test('a refused opt-in says why, and the plan stays flat', async () => {
    await seedPlan();
    await flagged();
    const tab = await render({ planTax: true });
    await drawdown(tab);
    await press(tab.row(WAY_IN));
    page.answers['POST /api/plan-facts'] = () => Response.json({ error: 'Not now, says the server.' }, { status: 500 });
    await press(button(tab.dialog(), 'Work it out'));
    expect(tab.dialog()?.textContent).toContain('Not now, says the server.');
    expect(tab.text()).not.toContain('Year by year, at');
    await tab.unmount();
  }, 20_000);

  test('with no age it says so, and opens Household', async () => {
    await seedPlan({ ...PLAN, age: null, targetAge: null });
    await flagged();
    const tab = await render({ planTax: true });
    await drawdown(tab);
    const row = tab.row(WAY_IN)!;
    expect(row.textContent).toContain('It needs your age');
    await press(row);
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('Household');
    await tab.unmount();
  }, 20_000);

  test('in a copy it says where it is done', async () => {
    await seedPlan();
    await seedCopy('Try');
    await flagged();
    const tab = await render({ planTax: true });
    await openCopy(tab, 'Try');
    await drawdown(tab);
    expect(tab.row(WAY_IN)).toBeNull();
    expect(tab.text()).toContain(`${WAY_IN} is the same in every plan: change it on your plan.`);
    await tab.unmount();
  }, 20_000);

  test('a plan in another currency isn’t offered it', async () => {
    await seedPlan();
    await flagged();
    fake.reset();
    await (await import('./fake-redis')).registerTestContainer(fake);
    await flagged();
    const tab = await render({ planTax: true, currency: 'EUR' });
    await drawdown(tab);
    expect(tab.row(WAY_IN)).toBeNull();
    await tab.unmount();
  }, 20_000);
});

describe('the years', () => {
  const stageRows = (tab: Tab) => tab.container.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && / · /.test(e.findAll((t) => classOf(t).includes('list-row-title'))[0]?.textContent ?? ''));

  test('the card has its chart, legend and table, its stages and its foot', async () => {
    const tab = await detailed();
    const text = tab.text();
    expect(text).toContain('Show as a table');
    expect(text).toContain('Taxable');
    expect(text).toMatch(/Left at \d+: .* after tax · tax and health costs .* in all/);
    expect(stageRows(tab).length).toBeGreaterThan(0);
    expect(stageRows(tab)[0].textContent).toContain('tax a year');
    await tab.unmount();
  }, 30_000);

  test('a stage opens its years, a year its sections, and back again', async () => {
    const tab = await detailed();
    const first = stageRows(tab)[0];
    const stage = first.findAll((t) => classOf(t).includes('list-row-title'))[0].textContent;
    await press(first);
    const sheet = tab.dialog()!;
    expect(sheet.getAttribute('aria-label')).toBe(stage);
    const years = sheet.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row'));
    expect(years.length).toBeGreaterThan(0);
    await press(years[0]);
    const year = tab.dialog()!;
    expect(year.getAttribute('aria-label')).toMatch(/^Age \d+ · \d{4}$/);
    for (const title of ['Where the money comes from', 'What it pays for', 'Income the law counts', 'How the tax is worked out', 'Health coverage']) expect(year.textContent).toContain(title);
    expect(year.textContent).toContain('Hypothetical, not tax advice.');
    await press(year.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Back')[0]);
    expect(tab.dialog()!.getAttribute('aria-label')).toBe(stage);
    await press(closeOf(tab.dialog()!));
    expect(tab.dialog()).toBeNull();
    await tab.unmount();
  }, 30_000);

  test('Go to Your path goes there', async () => {
    const tab = await detailed();
    await press(button(tab.container, 'Go to Your path'));
    expect(tab.row('Household')).not.toBeNull();
    await tab.unmount();
  }, 30_000);

});
