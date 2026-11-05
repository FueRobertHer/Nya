import { describe, expect, test } from 'bun:test';
import { TEST_CONTAINER } from './fake-redis';
import { DEFAULT_PLAN } from '@/lib/fire/plan';
import { planPage } from './plan-page';

// Year by year on the page, used on the real routes: the way in from a flat plan, then
// the card, a stage's sheet and a year's, and the way back.

const page = await planPage();
const { PLAN, answers, seedPlan, seedCopy, render, press, button, closeOf, pick, openCopy, classOf, calls, fake } = page;
type Tab = Awaited<ReturnType<typeof render>>;

async function flagged() {
  const { flagsStore } = await import('@/lib/flag-store');
  await flagsStore.update('plan-tax', async () => ({ on: 'nobody', containers: [TEST_CONTAINER], updatedAt: new Date().toISOString() }) as never, TEST_CONTAINER);
}
const drawdown = async (tab: Tab) => {
  await pick(tab.container, 'Drawdown');
};
const WAY_IN = 'Work it out from your accounts';

async function detailed(plan = PLAN, props: Parameters<typeof render>[0] = {}) {
  await flagged();
  await seedPlan(plan);
  const tab = await render({ planTax: true, ...props });
  await drawdown(tab);
  await press(tab.row(WAY_IN));
  await press(button(tab.dialog(), 'Work it out'));
  return tab;
}

describe('the before-59½ stage', () => {
  test('says what isn’t known of a Roth', async () => {
    const acct = (account_id: string, name: string, subtype: string, balance: number) => ({ account_id, name, type: 'investment', subtype, balance, currency: 'USD' });
    const institutions = [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [acct('k', '401(k)', '401k', 900_000), acct('r', 'Roth IRA', 'roth', 50_000)] }] as never;
    const tab = await detailed({ ...PLAN, age: 40, targetAge: 50 }, { institutions });
    const stage = tab.container.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && (e.textContent ?? '').includes('59½'))[0];
    await press(stage);
    expect(tab.dialog()!.textContent).toContain('What went into your Roth isn’t given, so none of it counts as reachable before 59½.');
    await tab.unmount();
  }, 30_000);
});

describe('Progress, on a plan a year’s tax moves', () => {
  test('says how far the saved plan’s line sits above Your path', async () => {
    const home = { id: 'home', label: 'Home', kind: 'one-off', from: { anchor: { at: 'age', age: 45 }, offset: 0 }, until: null, once: 200_000, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false };
    const plan = { ...PLAN, items: [home] } as typeof PLAN;
    const saved = { version: 1, plan: { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, savings: 30_000, assets: 300_000 }, savings: 30_000, currency: 'USD', inflation: 0.03, day: '2024-01-01', savedAt: '2024-01-01T12:00:00.000Z', rev: 'r1' };
    answers['GET /api/saved-plan'] = () => Response.json({ saved, problem: null });
    const k = { account_id: 'k', name: '401(k)', type: 'investment', subtype: '401k', balance: 300_000, currency: 'USD' };
    const institutions = [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [k] }];
    const tab = await detailed(plan, { institutions, planInWalk: true });
    await pick(tab.container, 'Your path');
    const progress = tab.container.findAll((e) => e.getAttribute('aria-labelledby') === 'plan-progress-title')[0];
    expect(progress.textContent).toMatch(/Your saved plan’s line takes no tax out before you stop, so from 45 it runs \$[\d,]+ above Your path\./);
    await tab.unmount();
  }, 30_000);
});

describe('while what a plan’s years rest on is out', () => {
  const home = { id: 'home', label: 'Home', kind: 'one-off', from: { anchor: { at: 'age', age: 45 }, offset: 0 }, until: null, once: 200_000, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false };
  const moved = { ...PLAN, items: [home] } as typeof PLAN;
  const k = { account_id: 'k', name: '401(k)', type: 'investment', subtype: '401k', balance: 300_000, currency: 'USD' };
  const props = { institutions: [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [k] }], planInWalk: true } as never;
  /** Holds what `path` asks for, outside the page's own count, until it is let go. */
  const holding = async (path: string, run: (letGo: () => void) => Promise<void>) => {
    const real = globalThis.fetch;
    const waiting: (() => void)[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(path) ? new Promise<Response>((resolve) => waiting.push(() => resolve(real(input, init)))) : real(input, init)) as typeof fetch;
    try {
      await run(() => waiting.splice(0).forEach((go) => go()));
    } finally {
      globalThis.fetch = real;
    }
  };

  test('a plan the drawdown moves is dimmed, not a flat date that then jumps', async () => {
    await (await detailed(moved, props)).unmount();
    await holding('/api/allocation-settings', async (letGo) => {
      const tab = await render({ planTax: true, ...(props as object) });
      expect(tab.said()).toContain('Working it out');
      expect(tab.text()).not.toContain('Year by year, at');
      letGo();
      await page.settle(200);
      expect(tab.said()).not.toContain('Working it out');
      expect(tab.text()).toContain('Year by year, at');
      await tab.unmount();
    });
  }, 30_000);

  test('every detailed plan waits, its FI number, tax and health with it, since all three come from its years', async () => {
    await (await detailed(PLAN, props)).unmount();
    await holding('/api/allocation-settings', async (letGo) => {
      const tab = await render({ planTax: true, ...(props as object) });
      expect(tab.said()).toContain('Working it out');
      await pick(tab.container, 'Your path');
      const fi = () => tab.row('FI number')!.textContent ?? '';
      expect(fi()).toContain('--');
      expect(tab.row('Tax after you stop')!.textContent).toContain('--');
      // A sheet opened meanwhile has no flat number or rate to type.
      await press(tab.row('Assumptions'));
      expect(tab.dialog()!.textContent).not.toContain('Tax on withdrawals');
      expect(tab.dialog()!.textContent).toContain('FI number');
      expect(tab.dialog()!.textContent).not.toMatch(/FI number \(\$/);
      await press(closeOf(tab.dialog()!));
      letGo();
      await page.settle(200);
      expect(tab.said()).not.toContain('Working it out');
      expect(fi()).toMatch(/\$[\d,]+/);
      expect(tab.row('Tax after you stop')!.textContent).toMatch(/[\d.]+%/);
      await tab.unmount();
    });
  }, 30_000);

  test('with no balances in yet, a plan the drawdown moves waits for them', async () => {
    await (await detailed(moved, props)).unmount();
    const tab = await render({ planTax: true, planInWalk: true, institutions: [], balancesAsOf: null });
    expect(tab.said()).toContain('Working it out');
    expect(tab.text()).not.toContain('Year by year, at');
    await tab.unmount();
    // Balances that couldn't be had don't hold it for good.
    const failed = await render({ planTax: true, planInWalk: true, institutions: [], balancesAsOf: null, balancesFailed: true });
    expect(failed.said()).not.toContain('Working it out');
    expect(failed.text()).toContain('Year by year, at');
    await failed.unmount();
  }, 30_000);

  test('Compare runs nothing on a plan’s flat figures, even one the drawdown can’t move', async () => {
    await (await detailed(PLAN, props)).unmount();
    await seedCopy('Later', { targetAge: 58 });
    await holding('/api/allocation-settings', async (letGo) => {
      const tab = await render({ planTax: true, ...(props as object) });
      await press(tab.plans());
      await press(button(tab.dialog(), 'Compare'));
      await page.settle(1000);
      const lasted = /\d+(?:\.\d+)?% of [\d,]+ historical starts/;
      expect(tab.dialog()!.textContent).toContain('Working out the plans');
      expect(tab.dialog()!.textContent).not.toMatch(lasted);
      letGo();
      await page.settle(1000);
      await page.settle(1000);
      expect(tab.dialog()!.textContent).not.toContain('Working out the plans');
      expect(tab.dialog()!.textContent).toMatch(lasted);
      expect(tab.dialog()!.textContent).toContain('with health coverage');
      await tab.unmount();
    });
  }, 60_000);

  test('nothing flat that would then move: the setup line and what follows the stop', async () => {
    const atStop = { ...PLAN, spending: 60_000, start: 'at-stop' } as typeof PLAN;
    await (await detailed(atStop, props)).unmount();
    await holding('/api/allocation-settings', async (letGo) => {
      const tab = await render({ planTax: true, ...(props as object) });
      await page.settle(800);
      const flatSetup = /Stop working at \d+ with/;
      const whole = () => tab.container.findAll((e) => e.getAttribute('role') === 'radio' && e.textContent === 'Whole path');
      expect(tab.text()).not.toMatch(flatSetup);
      expect(whole().length).toBe(0);
      letGo();
      await page.settle(800);
      await page.settle(1500);
      expect(tab.text()).toContain('your spending and health coverage with their tax');
      expect(whole().length).toBe(1);
      await tab.unmount();
    });
  }, 60_000);

  test('nothing flat from the FI number: By withdrawal rate and length, and the start’s note', async () => {
    const taxed = { ...PLAN, taxRate: 0.15 } as typeof PLAN;
    await (await detailed(taxed, props)).unmount();
    await holding('/api/allocation-settings', async (letGo) => {
      const tab = await render({ planTax: true, ...(props as object) });
      await pick(tab.container, 'Drawdown');
      await page.settle(800);
      expect(tab.text()).not.toContain('each starting with');
      expect(tab.text()).not.toContain('Starting from your FI number');
      letGo();
      await page.settle(800);
      await page.settle(1500);
      expect(tab.text()).toContain('each starting with');
      await tab.unmount();
    });
  }, 60_000);

  test('Across history runs on the years it will show', async () => {
    const atStop = { ...PLAN, start: 'at-stop' } as typeof PLAN;
    await (await detailed(atStop, props)).unmount();
    await holding('/api/allocation-settings', async (letGo) => {
      const tab = await render({ planTax: true, ...(props as object) });
      const sheet = await page.addTemplate(tab, 'A change in spending');
      await page.fill(sheet, 'Change a year', '4000');
      await press(tab.sheetRow('Starts'));
      await pick(tab.dialog()!, 'When invested assets reach');
      await page.fill(tab.dialog()!, 'Invested assets', '5000000');
      await press(button(tab.dialog(), 'Done'));
      await page.rest();
      await page.settle(800);
      const said = /It starts in \d+% of runs/;
      expect(tab.dialog()!.textContent).toContain('Working it out');
      expect(tab.dialog()!.textContent).not.toMatch(said);
      letGo();
      // One figure from here on: no flat one first, for this to replace.
      const seen = new Set<string>();
      for (let i = 0; i < 60; i++) {
        await page.settle(10);
        const now = tab.dialog()!.textContent.match(said);
        if (now) seen.add(now[0]);
      }
      expect(tab.dialog()!.textContent).not.toContain('Working it out');
      expect(seen.size).toBe(1);
      await tab.unmount();
    });
  }, 90_000);

  test('an item sheet’s preview takes the answer as it comes, with nothing typed', async () => {
    await (await detailed(moved, props)).unmount();
    await holding('/api/allocation-settings', async (letGo) => {
      const tab = await render({ planTax: true, ...(props as object) });
      const sheet = await page.addTemplate(tab, 'A cost');
      await page.fill(sheet, 'The amount', '50000');
      await page.fill(sheet, 'Starts at age', '46');
      await page.rest();
      expect(tab.dialog()!.textContent).toContain('Working it out');
      letGo();
      await page.settle(200);
      await page.rest();
      expect(tab.dialog()!.textContent).not.toContain('Working it out');
      await tab.unmount();
    });
  }, 60_000);

  test('a failed row asked for again takes nothing back', async () => {
    const brk = { account_id: 'brk', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balance: 100_000, currency: 'USD' };
    const both = { ...(props as object), institutions: [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [k, brk] }] } as never;
    await (await detailed(moved, both)).unmount();
    // Its row can't be had, so the page goes on with the stand-ins and says so.
    const real = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (String(input).includes('sync=1') ? Promise.resolve(Response.json({ error: 'no' }, { status: 500 })) : real(input, init))) as typeof fetch;
    const tab = await render({ planTax: true, ...(both as object) });
    await page.settle(200);
    globalThis.fetch = real;
    expect(tab.text()).toContain('Year by year, at');
    await holding('/api/plan-inputs?sync=1', async (letGo) => {
      await press(tab.row('Invested assets'));
      await press(closeOf(tab.dialog()!));
      expect(calls().some((c) => c.path === '/api/plan-inputs')).toBe(true);
      expect(tab.said()).not.toContain('Working it out');
      expect(tab.text()).toContain('Year by year, at');
      letGo();
      await page.settle(200);
      await tab.unmount();
    });
  }, 30_000);
});

describe('a rule that takes a share of what is there', () => {
  test('doesn’t say it can’t run out', async () => {
    const k = { account_id: 'k', name: '401(k)', type: 'investment', subtype: '401k', balance: 300_000, currency: 'USD' };
    const props = { institutions: [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [k] }], planInWalk: true } as never;
    const tab = await detailed({ ...PLAN, spending: 40_000, rule: 'percent', start: 'at-stop' } as typeof PLAN, props);
    await pick(tab.container, 'Drawdown');
    await page.settle(800);
    await page.settle(1500);
    expect(tab.text()).not.toContain('it cannot run out');
    expect(tab.text()).toContain('with health coverage on top, and it lasted every start');
    await tab.unmount();
  }, 60_000);
});

describe('the start link', () => {
  test('on a copy, a save that fails says so where it was pressed', async () => {
    await seedPlan();
    await flagged();
    await seedCopy('Later', { targetAge: 58 });
    const tab = await render({ planTax: true });
    await openCopy(tab, 'Later');
    const link = () => tab.container.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim().startsWith('Start from what you'))[0] ?? null;
    answers['PUT /api/plans'] = () => Response.json({ error: 'Not now, says the server.' }, { status: 500 });
    await press(link());
    await page.settle(300);
    expect(tab.container.findAll((e) => e.getAttribute('role') === 'alert').some((e) => e.textContent.length > 0)).toBe(true);
    expect(link()).not.toBeNull();
    await tab.unmount();
  }, 30_000);
});

describe('a plan whose years can’t be worked out', () => {
  test('a job that can’t run: says so, offers it again, and draws no years', async () => {
    const { planSearch } = await import('@/components/plan-search');
    const search = planSearch();
    const real = search.answer;
    search.answer = () => ({ ok: false, error: 'nope' });
    try {
      const home = { id: 'home', label: 'Home', kind: 'one-off', from: { anchor: { at: 'age', age: 45 }, offset: 0 }, until: null, once: 200_000, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false };
      const k = { account_id: 'k', name: '401(k)', type: 'investment', subtype: '401k', balance: 300_000, currency: 'USD' };
      const tab = await detailed({ ...PLAN, stopAtFi: true, items: [home] } as typeof PLAN, { institutions: [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [k] }], planInWalk: true } as never);
      expect(tab.text()).not.toContain('Year by year, at');
      expect(button(tab.container, 'Try again')).not.toBeNull();
      await tab.unmount();
    } finally {
      search.answer = real;
    }
  }, 30_000);

  test('a year the tax can’t read: Drawdown says it uses the flat rate', async () => {
    await (await detailed()).unmount();
    // A reader checks only a value's shape, so a later version can write what this one wouldn't.
    const { GET } = await import('@/app/api/plan-inputs/route');
    answers['GET /api/plan-inputs'] = async () => {
      const body = await (await GET(new Request('http://nya.test/api/plan-inputs'))).json();
      return Response.json({ ...body, tax: { ...body.tax, taxableYield: 5 } });
    };
    const tab = await render({ planTax: true });
    expect(tab.text()).toContain('Tax couldn’t be worked out for this plan, so it uses the flat rate.');
    expect(tab.text()).not.toContain('Year by year, at');
    await tab.unmount();
  }, 30_000);
});

describe('a copy’s card', () => {
  test('its choices are said once they differ from your plan’s', async () => {
    const tab = await detailed();
    await tab.unmount();
    await seedCopy('Other', { spending: 50_000 });
    const open = await render({ planTax: true });
    await openCopy(open, 'Other');
    expect(open.text()).not.toContain('Other settings differ');
    await pick(open.container, 'Your path');
    await press(open.row('Assumptions'));
    await page.fill(open.dialog()!, 'Inflation', '4');
    await press(button(open.dialog(), 'Save'));
    await page.settle(300);
    expect(open.text()).toContain('Other settings differ');
    await open.unmount();
  }, 30_000);
});

describe('marks on Whole path', () => {
  const summary = (tab: Tab) => tab.container.findAll((e) => e.getAttribute('role') === 'img' && (e.getAttribute('aria-label') ?? '').includes('Invested assets'))[0]?.getAttribute('aria-label') ?? '';
  const ticks = (tab: Tab) => tab.container.findAll((e) => e.tagName === 'text' || e.tagName === 'TEXT').map((e) => e.textContent);

  test('a detailed plan marks the ages its rules change at, and none on To the stop', async () => {
    const tab = await detailed({ ...PLAN, age: 40, targetAge: 50 });
    await pick(tab.container, 'Your path');
    await pick(tab.container, 'To 50');
    expect(summary(tab)).not.toContain('Marks at');
    await pick(tab.container, 'Whole path');
    expect(summary(tab)).toContain('Marks at 59½, 65 and RMD age');
    expect(ticks(tab)).toContain('59½');
    await tab.unmount();
  }, 30_000);

  test('a flat plan has none', async () => {
    await seedPlan({ ...PLAN, age: 40, targetAge: 50 });
    const tab = await render();
    await pick(tab.container, 'Your path');
    await pick(tab.container, 'Whole path');
    expect(summary(tab)).not.toContain('Marks at');
    expect(ticks(tab)).not.toContain('59½');
    await tab.unmount();
  }, 30_000);
});

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
    expect(sheet.textContent).toContain('your FI number, Home and every copy use them.');
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
    const rows = () => tab.dialog()!.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row'));
    expect(rows().length).toBeGreaterThan(0);
    // Years that read the same are one row, which opens to them in place.
    const run = rows().find((e) => e.getAttribute('aria-expanded') === 'false');
    if (run) {
      const before = rows().length;
      await press(run);
      expect(rows().length).toBeGreaterThan(before);
      expect(rows().find((e) => e.getAttribute('aria-expanded') === 'true')).toBeTruthy();
    }
    await press(rows().find((e) => e.getAttribute('aria-expanded') === null)!);
    const year = tab.dialog()!;
    expect(year.getAttribute('aria-label')).toMatch(/^Age \d+ · \d{4}$/);
    for (const title of ['Where the money comes from', 'What it pays for', 'Income the law counts', 'How the tax is worked out', 'Health coverage']) expect(year.textContent).toContain(title);
    expect(year.textContent).toContain('Hypothetical, not tax advice.');
    await press(year.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Back')[0]);
    expect(tab.dialog()!.getAttribute('aria-label')).toBe(stage);
    // Back to the stage with its run still open, and a stage opened again starts closed.
    if (run) {
      expect(rows().find((e) => e.getAttribute('aria-expanded') === 'true')).toBeTruthy();
      await press(closeOf(tab.dialog()!));
      await press(first);
      expect(rows().find((e) => e.getAttribute('aria-expanded') === 'true')).toBeFalsy();
    }
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
