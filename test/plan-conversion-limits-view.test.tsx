import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { planPage } from './plan-page';

// What Compare conversions and the Roth conversions sheet's preview say they hold, on the
// page, on the real routes: Tune to a goal's two limits. On a withdrawal rule that spends
// with the balance, the rules spend differently, so what's left doesn't compare like with
// like. On a plan that moves when a rule is used, a row is the plan held where it is, so
// a rule's sheet and the preview say what using it comes to.

const page = await planPage();
const { PLAN, WITH_BALANCES, seedPlan, render, press, button, closeOf, fill, pick, settle, classOf } = page;
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

const compareTable = (tab: Tab) => tab.container.findAll((e) => e.tagName === 'TABLE' && classOf(e).includes('plan-rules-table'))[0];
const compareCard = (tab: Tab) => tab.container.findAll((e) => e.getAttribute('aria-labelledby') === 'plan-compare-rules')[0];
const bodyRows = (table: Node) => table.findAll((e) => e.tagName === 'TR').filter((r) => r.findAll((c) => c.getAttribute('scope') === 'row').length > 0);
const ruleOf = (row: Node) => row.findAll((c) => c.getAttribute('scope') === 'row')[0].findAll((e) => e.tagName === 'BUTTON')[0];
const named = (table: Node, name: string) => bodyRows(table).find((r) => ruleOf(r).textContent === name)!;
const cell = (row: Node, n: number) => row.findAll((c) => c.tagName === 'TD')[n].textContent ?? '';
const mineOf = (tab: Tab) => bodyRows(compareTable(tab)).find((r) => /Your plan|This copy/.test(r.textContent ?? ''))!;
const disabled = (el: Node | null) => el?.getAttribute('disabled') !== undefined && el?.getAttribute('disabled') !== null;
/** The preview's figure, by its row's label: This rule's, then None's. */
const preview = (sheet: Node, label: string) => {
  const row = sheet.findAll((e) => e.tagName === 'TR' && (e.findAll((c) => c.getAttribute('scope') === 'row')[0]?.textContent ?? '').startsWith(label))[0];
  return [cell(row, 0), cell(row, 1)];
};

const HOLDS = 'Each rule here keeps your stop, your start and what’s timed on them where they are now, so the rules compare like with like. A rule’s own sheet shows what it comes to once used.';
const SPENDS = 'your withdrawal rule spends differently under each, so what’s left doesn’t compare like with like';
const PREVIEW_SPENDS = 'Your withdrawal rule spends differently under this rule and None, so what’s left doesn’t compare like with like.';

const { RuleLevel } = await import('@/components/PlanHowYouDraw');
const { wholeMoney } = await import('@/components/plan-text');
const { planSearch } = await import('@/components/plan-search');

describe('on a withdrawal rule that spends with the balance', () => {
  test('Compare says its rules spend differently, so what’s left doesn’t compare like with like', async () => {
    const tab = await detailed({ ...PLAN, rule: 'vpw' });
    const card = compareCard(tab).textContent ?? '';
    expect(card).toContain(SPENDS);
    expect(card).toContain('Each rule here keeps your stop, your start and what’s timed on them where they are now, but ');
    expect(card).toContain('A rule’s own sheet shows what it comes to once used.');
    // Never beside its opposite.
    expect(card).not.toContain('so the rules compare like with like');
    // Why Tune isn't offered keeps its words.
    expect(card).toContain('Tune to a goal needs the Constant withdrawal rule. Other rules spend differently under each setting, so what’s left wouldn’t compare like with like.');
    await tab.unmount();
  }, 30_000);

  for (const rule of ['percent', 'guardrails', 'floor-ceiling'] as const) {
    test(`and on ${rule}`, async () => {
      const tab = await detailed({ ...PLAN, rule });
      expect(compareCard(tab).textContent).toContain(SPENDS);
      await tab.unmount();
    }, 30_000);
  }

  test('the preview says this rule and None spend differently', async () => {
    const tab = await detailed({ ...PLAN, rule: 'vpw' });
    await press(tab.row('Roth conversions'));
    await pick(tab.dialog()!, 'Fill a bracket');
    const sheet = tab.dialog()!;
    expect(sheet.textContent).toContain('What it comes to');
    expect(sheet.textContent).toContain(PREVIEW_SPENDS);
    // On the figures it is about: in the preview's section, under its table.
    const section = sheet.findAll((e) => e.getAttribute('aria-labelledby') === 'plan-conversion-preview')[0];
    expect(section.textContent).toContain(PREVIEW_SPENDS);
    await tab.unmount();
  }, 30_000);

  test('on the Constant rule neither says so, and Compare says its rules compare like with like', async () => {
    const tab = await detailed();
    const card = compareCard(tab).textContent ?? '';
    expect(card).toContain(HOLDS);
    expect(card).not.toContain('spends differently');
    await press(tab.row('Roth conversions'));
    await pick(tab.dialog()!, 'Fill a bracket');
    expect(tab.dialog()!.textContent).toContain('What it comes to');
    expect(tab.dialog()!.textContent).not.toContain('spends differently');
    await tab.unmount();
  }, 30_000);

  test('with nothing to convert, its rules live on the same and aren’t said to differ', async () => {
    const tab = await detailed({ ...PLAN, rule: 'vpw' }, account('roth', 600_000));
    const card = compareCard(tab).textContent ?? '';
    // Every rule comes to the same: there is no tax-deferred money to move.
    const lefts = bodyRows(compareTable(tab)).map((r) => cell(r, 0));
    expect(new Set(lefts).size).toBe(1);
    // What they hold, and nothing said of how they compare beside the line on other rules.
    expect(card).toContain('Each rule here keeps your stop, your start and what’s timed on them where they are now. A rule’s own sheet shows what it comes to once used.');
    expect(card).not.toContain('so the rules compare like with like');
    expect(card).not.toContain('spends differently under each');
    await tab.unmount();
  }, 30_000);
});

describe('on a plan that moves when a rule is used', () => {
  /** It stops at FI, so a rule that moves its FI number moves its stop. */
  const MOVES = { ...PLAN, stopAtFi: true, targetAge: null, spending: 60_000, savings: 40_000 } as typeof PLAN;
  /** It starts from what it would have at its stop age, which no rule moves. */
  const STAYS = { ...PLAN, start: 'at-stop' } as typeof PLAN;
  const MOVED = /Once used, (your plan (stops at \d+, not \d+|starts from \$[\d,]+, not \$[\d,]+)|more of your plan moves with this rule)/;
  const SAVED = /Once saved, (your plan (stops at \d+, not \d+|starts from \$[\d,]+, not \$[\d,]+)|more of your plan moves with this rule)[^.]*, so it differs from the table: it (leaves \$[\d,]+ at \d+|runs short at \d+) and costs \$[\d,]+ in tax and health\./;

  test('what the gap is: a row isn’t what a copy with that rule comes to', async () => {
    const tab = await detailed(MOVES);
    await settle(400);
    const said = cell(named(compareTable(tab), 'Fill the 22% bracket'), 0);
    await press(ruleOf(named(compareTable(tab), 'Fill the 22% bracket')));
    for (let i = 0; i < 400 && disabled(button(tab.dialog(), 'Try it in a copy')); i++) await settle(50);
    await press(button(tab.dialog(), 'Try it in a copy'));
    await settle(400);
    for (let i = 0; i < 400 && (compareCard(tab)?.getAttribute('aria-busy') ?? null) === 'true'; i++) await settle(50);
    // The copy is open, and its own row is that rule, as the copy comes to it.
    expect(ruleOf(mineOf(tab)).textContent).toBe('Fill the 22% bracket');
    expect(cell(mineOf(tab), 0)).not.toBe(said);
    await tab.unmount();
  }, 60_000);

  test('what the gap is: the preview isn’t what Save gives', async () => {
    const tab = await detailed(MOVES);
    await settle(400);
    await press(tab.row('Roth conversions'));
    await pick(tab.dialog()!, 'Fill a bracket');
    await fill(tab.dialog()!, 'Up to the top of', '0.22');
    const [held] = preview(tab.dialog()!, 'Left at');
    await press(button(tab.dialog(), 'Save'));
    await settle(400);
    for (let i = 0; i < 400 && (compareCard(tab)?.getAttribute('aria-busy') ?? null) === 'true'; i++) await settle(50);
    expect(tab.dialog()).toBeNull();
    expect(ruleOf(mineOf(tab)).textContent).toBe('Fill the 22% bracket');
    expect(cell(mineOf(tab), 0)).not.toBe(held);
    await tab.unmount();
  }, 60_000);

  test('Compare says what its rows hold', async () => {
    const tab = await detailed(MOVES);
    expect(compareCard(tab).textContent).toContain(HOLDS);
    await tab.unmount();
  }, 30_000);

  test('a rule’s sheet works out what it comes to once used, with Try off until then, and says what moved', async () => {
    const search = planSearch();
    const real = search.answer;
    const tab = await detailed(MOVES);
    await settle(400);
    const row = named(compareTable(tab), 'Fill the 22% bracket');
    const said = cell(row, 0);
    try {
      search.answer = () => null;
      await press(ruleOf(row));
      const sheet = tab.dialog()!;
      expect(sheet.textContent).toContain('Working it out');
      expect(sheet.findAll((e) => e.getAttribute('aria-busy') === 'true').length).toBe(1);
      expect(disabled(button(sheet, 'Try it in a copy'))).toBe(true);
      expect(sheet.textContent).not.toContain('differs from the table');
    } finally {
      search.answer = real;
      search.retry();
    }
    for (let i = 0; i < 400 && (tab.dialog()!.textContent ?? '').includes('Working it out'); i++) await settle(50);
    const sheet = tab.dialog()!;
    expect(sheet.textContent).toMatch(MOVED);
    expect(sheet.textContent).toContain('so this differs from the table.');
    // Its figures are the plan's as used, not the row's.
    expect(sheet.textContent).not.toContain(said);
    expect(disabled(button(sheet, 'Try it in a copy'))).toBe(false);
    await tab.unmount();
  }, 60_000);

  test('the preview says what Save comes to, and Save gives it', async () => {
    const tab = await detailed(MOVES);
    await settle(400);
    await press(tab.row('Roth conversions'));
    await pick(tab.dialog()!, 'Fill a bracket');
    await fill(tab.dialog()!, 'Up to the top of', '0.22');
    for (let i = 0; i < 400 && !SAVED.test(tab.dialog()!.textContent ?? ''); i++) await settle(50);
    const sheet = tab.dialog()!;
    const text = sheet.textContent ?? '';
    expect(text).toMatch(SAVED);
    // What the table says isn't what the line says.
    const [held] = preview(sheet, 'Left at');
    const once = /so it differs from the table: it (?:leaves (\$[\d,]+) at \d+|runs short at (\d+))/.exec(text)!;
    expect(once[1] ?? `Runs short at ${once[2]}`).not.toBe(held);
    await press(button(sheet, 'Save'));
    await settle(400);
    for (let i = 0; i < 400 && (compareCard(tab)?.getAttribute('aria-busy') ?? null) === 'true'; i++) await settle(50);
    expect(tab.dialog()).toBeNull();
    // What your plan comes to now is what the line said.
    expect(ruleOf(mineOf(tab)).textContent).toBe('Fill the 22% bracket');
    expect(cell(mineOf(tab), 0)).toBe(once[1] ?? `Runs short at ${once[2]}`);
    await tab.unmount();
  }, 60_000);

  test('a plan that doesn’t move says nothing of the kind, and its rows are what using them gives', async () => {
    const tab = await detailed(STAYS);
    expect(compareCard(tab).textContent).toContain(HOLDS);
    const row = named(compareTable(tab), 'Fill the 12% bracket');
    const said = cell(row, 0);
    await press(ruleOf(row));
    await settle(300);
    expect(tab.dialog()!.textContent).toContain(said);
    expect(tab.dialog()!.textContent).not.toContain('differs from the table');
    await press(closeOf(tab.dialog()!));
    await press(tab.row('Roth conversions'));
    await pick(tab.dialog()!, 'Fill a bracket');
    await settle(300);
    expect(tab.dialog()!.textContent).toContain('What it comes to');
    expect(tab.dialog()!.textContent).not.toContain('Once saved');
    await tab.unmount();
  }, 60_000);

  test('a search nobody asks for any more is let go: a rule’s sheet on Close, the preview once its draft is your plan’s again', async () => {
    const search = planSearch();
    const real = search.drop;
    const tab = await detailed(MOVES);
    await settle(400);
    const dropped: string[] = [];
    search.drop = (slot) => {
      dropped.push(slot);
      real(slot);
    };
    try {
      await press(ruleOf(named(compareTable(tab), 'Fill the 22% bracket')));
      await settle(300);
      await press(closeOf(tab.dialog()!));
      await settle(300);
      expect(dropped).toContain('rule-level');
      await press(tab.row('Roth conversions'));
      await pick(tab.dialog()!, 'Fill a bracket');
      for (let i = 0; i < 400 && !(tab.dialog()!.textContent ?? '').includes('Once saved'); i++) await settle(50);
      dropped.length = 0;
      await pick(tab.dialog()!, 'None');
      await settle(300);
      expect(tab.dialog()).not.toBeNull();
      expect(dropped).toContain('conversions');
    } finally {
      search.drop = real;
    }
    await tab.unmount();
  }, 60_000);

  test('the plan’s own rule asks nothing of the search, and says nothing moved', async () => {
    const tab = await detailed(MOVES);
    await settle(400);
    const asked: string[] = [];
    const search = planSearch();
    const real = search.answer;
    search.answer = (slot, job) => {
      asked.push(slot);
      return real(slot, job);
    };
    try {
      await press(ruleOf(mineOf(tab)));
      await settle(200);
      expect(tab.dialog()!.textContent).toContain('Your plan has this rule.');
      expect(tab.dialog()!.textContent).not.toContain('Working it out');
      expect(tab.dialog()!.textContent).not.toContain('differs from the table');
    } finally {
      search.answer = real;
    }
    expect(asked).not.toContain('rule-level');
    await tab.unmount();
  }, 60_000);
});

describe('a rule’s sheet, drawn alone', () => {
  const money = (n: number) => wholeMoney(n, 'USD');
  const drawn = (over: object) => ({ leftAtEnd: 1_000_000, taxAndHealth: 200_000, runsOutAt: null, years: [], stages: [], aca: { on: 0, withCredit: 0 }, ...over }) as never;
  const ROW = { key: 'fill-12', mine: false, strategy: { order: 'standard' as const, conversions: { kind: 'bracket' as const, top: 0.12 as const }, convertUntil: null }, drawn: drawn({}) };
  const NOW = { drawn: drawn({ leftAtEnd: 900_000, taxAndHealth: 300_000 }), stop: 55, start: 1_500_000 };
  const NO_ANSWER = { drawn: null, stop: null, start: null, working: false, failed: false, retry: null };
  const level = (used: object, over: object = {}) =>
    renderToStaticMarkup(<RuleLevel row={ROW} money={money} lawYear={2026} copyOpen={false} whyNot={null} onTry={async () => true as const} now={NOW} used={() => used as never} {...over} />);

  test('one that can’t be worked out once used shows the row’s figures, says so, and offers no copy', () => {
    const html = level({ ...NO_ANSWER, failed: true });
    expect(html).toContain('This couldn’t be worked out once used, so Try it in a copy is off.');
    expect(html).toContain('$1,000,000');
    expect(html).not.toContain('>Try it in a copy<');
  });

  test('worked out as used, the same as its row, it says nothing moved', () => {
    const html = level({ ...NO_ANSWER, drawn: drawn({}), stop: 55, start: 1_500_000 });
    expect(html).not.toContain('differs from the table');
    expect(html).toMatch(/<button[^>]*>Try it in a copy</);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Try it in a copy</);
  });

  test('worked out as used with another stop and start, it names both', () => {
    const html = level({ ...NO_ANSWER, drawn: drawn({ leftAtEnd: 1_400_000 }), stop: 57, start: 1_600_000 });
    expect(html).toContain('Once used, your plan stops at 57, not 55, and starts from $1,600,000, not $1,500,000, so this differs from the table.');
    expect(html).toContain('$1,400,000');
  });

  test('in a copy, the copy is what moves', () => {
    const html = level({ ...NO_ANSWER, drawn: drawn({ leftAtEnd: 1_400_000 }), stop: 57, start: 1_500_000 }, { copyOpen: true });
    expect(html).toContain('Once used, this copy stops at 57, not 55, so this differs from the table.');
  });

  test('still being worked out: the row’s run dimmed, said, and no copy yet', () => {
    // What the page has meanwhile is a stand-in at another stop: not drawn.
    const html = level({ ...NO_ANSWER, working: true, drawn: drawn({ leftAtEnd: 777_000 }) });
    expect(html).toContain('$1,000,000');
    expect(html).not.toContain('$777,000');
    expect(html).toContain('Working it out');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Try it in a copy</);
  });
});

