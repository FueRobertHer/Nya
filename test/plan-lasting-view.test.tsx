import { describe, expect, test } from 'bun:test';
import { planPage } from './plan-page';

// D9 on the Plan tab: a plan stored with `lastsIn` answers with the earliest stop that
// lasts (lib/fire/earliest.ts), found in the simulator's worker, in place of the age the
// walk reaches the FI number (decision 25). Nothing in this release writes the field
// (a release before its writer, docs/operations.md), so these plans are stored as a
// later release would store them.
//
// The page's plan: 40, stopping at 55, $40,000 a year, $30,000 saved on $300,000.
// Decision 25: around 52. The earliest stop that lasts in 95% of historical starts is
// 53, in 80% it is 51.

const page = await planPage();
const { PLAN, WITH_BALANCES, settle, rest, seedPlan, seedCopy, render, pick, press, button, closeOf, openCopy, addTemplate, fill } = page;

const { act, dom } = page;
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const React = await import('react');
const { default: FiProgressCard } = await import('@/components/FiProgressCard');
const { createPlanInputsStore } = await import('@/lib/plan-inputs-store');

/** Home's FI line for the plan stored: its title. */
async function home(institutions: unknown[] = []) {
  const container = dom.document.createElement('ul');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(React.createElement(FiProgressCard, { txns: [], txnsLoading: false, txnNotes: [], institutions: institutions as never, currency: 'USD', onOpenPlan: () => {}, planInputs: createPlanInputsStore() })));
  await settle(400);
  const title = container.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes('list-row-title'))[0]?.textContent ?? '';
  await act(async () => root.unmount());
  return title;
}

const answerOf = (tab: Awaited<ReturnType<typeof render>>) => {
  const hero = tab.container.findAll((e) => e.getAttribute('aria-labelledby') === 'plan-fi-title')[0] ?? null;
  return hero?.textContent ?? '';
};

describe('the answer, with lastsIn and without', () => {
  test('without it: decision 25’s age, how the walk gets there, and what the FI number leaves out', async () => {
    await seedPlan();
    const tab = await render();
    await settle(400);
    const answer = answerOf(tab);
    expect(answer).toContain('Around age 52');
    expect(answer).toContain('3 years before you stop at 55');
    expect(answer).toContain('Saving $30,000 a year, growing a steady 5% a year after inflation.');
    expect(answer).not.toContain('lasts');
    await tab.unmount();
  }, 30_000);

  test('with 95%: the earliest stop that lasts, against the stop typed, and how it was found', async () => {
    await seedPlan({ ...PLAN, lastsIn: 0.95 });
    const tab = await render();
    await settle(400);
    const answer = answerOf(tab);
    expect(answer).toContain('Around age 53');
    expect(answer).toContain('2 years before you stop at 55');
    expect(answer).toContain('The earliest stop that lasts to 95 in at least 95% of historical starts, from what you’d have then.');
    expect(answer).not.toContain('Saving $30,000 a year, growing a steady');
    expect(answer).not.toContain('Working it out');
    await tab.unmount();
  }, 30_000);

  test('under the stop at FI, the stop is the age found, and Will it last? runs from it', async () => {
    await seedPlan({ ...PLAN, stopAtFi: true, start: 'at-stop', lastsIn: 0.8 });
    const tab = await render();
    await settle(400);
    expect(answerOf(tab)).toContain('FI and your stop: around 51');
    expect(answerOf(tab)).toContain('The earliest stop that lasts to 95 in at least 80% of historical starts');
    // Will it last? from 51: 82% of historical starts, the run the search found to last.
    await pick(tab.container, 'Drawdown');
    await settle(400);
    expect(tab.text()).toMatch(/82\.5%\s*of 1,302 historical starts \(Jan 1871 to Jun 1979\) lasted 44 years, from 51/);
    await tab.unmount();
  }, 40_000);

  test('Home’s FI line says the same age as the Plan: without it, decision 25’s', async () => {
    await seedPlan();
    expect(await home()).toBe('FI around age 52, 3 years before you stop at 55');
  }, 40_000);

  test('Home’s FI line with 95%: the earliest stop that lasts', async () => {
    await seedPlan({ ...PLAN, lastsIn: 0.95 });
    expect(await home()).toBe('FI around age 53, 2 years before you stop at 55');
  }, 40_000);

  test('Home’s FI line under the stop at FI with 80%', async () => {
    await seedPlan({ ...PLAN, stopAtFi: true, start: 'at-stop', lastsIn: 0.8 });
    expect(await home()).toBe('FI and your stop around 51');
  }, 40_000);

  test('a copy with it says its own answer while your plan keeps decision 25’s', async () => {
    await seedPlan();
    await seedCopy('Lasting', { lastsIn: 0.8 });
    const tab = await render();
    await settle(400);
    expect(answerOf(tab)).toContain('Around age 52');
    await openCopy(tab, 'Lasting');
    await settle(400);
    expect(answerOf(tab)).toContain('Around age 51');
    expect(answerOf(tab)).toContain('in at least 80% of historical starts');
    await tab.unmount();
  }, 40_000);

  test('the Timeline’s preview of an item waits for, then says, the earliest stop that lasts', async () => {
    await seedPlan({ ...PLAN, lastsIn: 0.95 });
    const tab = await render();
    await settle(400);
    const sheet = await addTemplate(tab, 'A cost');
    await fill(sheet, 'The amount', '1000');
    await fill(sheet, 'Starts at age', '60');
    await rest();
    await settle(400);
    const t = tab.dialog()!.textContent;
    expect(t).not.toContain('Working it out');
    expect(t).toMatch(/Your FI date(Stays around 53|From around 53 to around \d+)/);
    await tab.unmount();
  }, 40_000);

  const k = { account_id: 'k', name: '401(k)', type: 'investment', subtype: '401k', balance: 300_000, currency: 'USD' };
  const institutions = [{ name: 'Fidelity', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts: [k] }];
  /** The page's plan with 95%, made detailed by its way in, on Drawdown. */
  async function detailed() {
    await seedPlan({ ...PLAN, lastsIn: 0.95 });
    const tab = await render({ ...WITH_BALANCES, institutions } as never);
    await settle(400);
    await pick(tab.container, 'Drawdown');
    await press(tab.row('Work out tax from your accounts'));
    await press(button(tab.dialog(), 'Work it out'));
    await settle(400);
    return tab;
  }

  // The page runs a detailed plan's jobs on fewer starts (test/plan-page.tsx), and its
  // tax isn't the flat plan's: at 95% it lasts from 52, where the flat plan's is 53.
  test('a detailed plan: the earliest stop that lasts with its tax in every run, on the Plan and on Home', async () => {
    const tab = await detailed();
    await pick(tab.container, 'Your path');
    await settle(400);
    const answer = answerOf(tab);
    expect(answer).toContain('Around age 52');
    expect(answer).toContain('3 years before you stop at 55');
    expect(answer).toContain('The earliest stop that lasts to 95 in at least 95% of historical starts');
    expect(answer).not.toContain('Working it out');
    await tab.unmount();
    expect(await home(institutions)).toBe('FI around age 52, 3 years before you stop at 55');
  }, 60_000);

  test('a sheet’s earliest stop job is let go as the sheet closes', async () => {
    const { planLasting } = await import('@/components/plan-search');
    const store = planLasting();
    const tab = await detailed();
    await press(tab.row('Roth conversions'));
    await pick(tab.dialog()!, 'Fill a bracket');
    await settle(400);
    const dropped: string[] = [];
    const drop = store.drop;
    store.drop = (slot) => {
      dropped.push(slot);
      drop(slot);
    };
    try {
      await press(closeOf(tab.dialog()!));
      await settle(100);
    } finally {
      store.drop = drop;
    }
    expect(dropped).toContain('conversions');
    await tab.unmount();
  }, 60_000);
});
