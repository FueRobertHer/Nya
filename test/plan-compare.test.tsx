import { afterEach, describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PlanCompare from '@/components/PlanCompare';
import { compareRows, fiDateText, pointsText, startsLine, type CompareColumn } from '@/components/plan-compare';
import { CopyCard, PlanDetails, PlansSheet, REFUSED_TEXT, compareJobs, rememberResult, type PlanOutcome, type SheetPlan } from '@/components/PlansSheet';
import { TimelineCard } from '@/components/PlanTimeline';
import { FiCard, InputsCard, SimulationCard } from '@/components/PlanTab';
import { figureNotes, type FigureArgs } from '@/components/plan-figure-notes';
import { INITIAL_PLANS, createPlansClient, type PlanRow, type PlansState } from '@/components/plan-list';
import { copyDiffParts } from '@/components/plan-diff';
import { currencyText, startLineText, startsWithText, shortText } from '@/components/plan-scenario-text';
import { wholeMoney } from '@/components/plan-text';
import { DEFAULT_PLAN, enginePlan, fiView, type FirePlan, type Measured } from '@/lib/fire/plan';
import type { PlanFigures } from '@/lib/fire/plan-figures';
import { planOf } from '@/lib/fire/plan-v2';
import { withItem } from '@/lib/fire/items';
import type { LifeEvent } from '@/lib/fire/events';
import { runPlanJob } from '@/lib/fire/jobs';
import { usMarket } from '@/lib/fire/us-market';
import { HISTORY_COUNT, HISTORY_FIRST, historySpan } from '@/lib/fire/history-span';
import { simulate, type SimResult } from '@/lib/fire/simulate';
import { MASK, setAmountsHidden } from '@/lib/format';
import { NO_CONNECTIONS_WITHOUT } from '@/lib/no-transactions';
import { figuresOf, itemFromEvent, OFF, timelineProps } from './plan-gen';

// Compare mode (components/plan-compare.ts, PlanCompare.tsx), the open
// copy's card and the Plans sheet (components/PlansSheet.tsx), and the list
// of plans on the page (components/plan-list.ts): one seed and one dataset,
// what each cell says, what a plan that starts with money it wouldn't have
// says, and amounts hidden.

const us = usMarket();
const money = (n: number) => wholeMoney(n, 'USD');
const TODAY = '2026-10-23';
const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const measured: Measured = { spending: 40_000, savings: 30_000, assets: 300_000 };
const figs = (p: FirePlan, events: LifeEvent[] = []): PlanFigures => figuresOf(p, measured, events) as PlanFigures;
/** A plan as GET /api/plans lists it. */
const row = (id: string, name: string, over: Partial<PlanRow> = {}): PlanRow => ({
  id,
  name,
  plan: planOf(plan({ age: 40, targetAge: 55 })),
  currency: 'USD',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: `u-${id}`,
  ...over,
});
const noop = async () => true as const;
/** The open copy's card, as PlanTab draws it. */
const copyCard = (over: Partial<ComponentProps<typeof CopyCard>> = {}) =>
  renderToStaticMarkup(
    <CopyCard
      parts={['Stop age: 50 (your plan: 55)']}
      other={null}
      currencyLine={null}
      confirmWhyNot={null}
      planCurrency="USD"
      problem={null}
      repair={null}
      notice={null}
      editable
      onRelabel={noop}
      onMakeMain={noop}
      plansCount={2}
      onPlans={() => {}}
      {...over}
    />
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
const run = (f: PlanFigures): SimResult => {
  if (!('sim' in f.engine)) throw new Error('missing');
  return simulate('historical', f.engine.sim, us);
};

afterEach(() => setAmountsHidden(false));

describe('the history span', () => {
  test('is the data’s own, without loading it on the page', () => {
    expect(HISTORY_FIRST).toBe(us.firstMonth);
    expect(HISTORY_COUNT).toBe(us.months);
    expect(historySpan()).toEqual({ first: '1871-01', last: '2023-05' });
  });
});

describe('one seed and one dataset', () => {
  test('every job carries the Plan’s method and nothing else, and every answer the same seed, runs and blocks', () => {
    const base = plan({ age: 40, targetAge: 55, method: 'monte-carlo' });
    // Your plan, two copies, and one not worked out: each copy's figures are
    // worked out as the tab does (components/PlanTab.tsx views).
    const outcomes: PlanOutcome[] = [
      { kind: 'figures', figures: figs(base) },
      { kind: 'figures', figures: figs({ ...base, targetAge: 45 }) },
      { kind: 'figures', figures: figs({ ...base, spending: 50_000 }) },
      { kind: 'not-run', reason: currencyText('EUR', 'USD') },
    ];
    const jobs = compareJobs(outcomes, 'monte-carlo');
    expect(jobs.length).toBe(3);
    for (const { job } of jobs) expect(Object.keys(job).sort()).toEqual(['kind', 'method', 'plan']);
    expect(new Set(jobs.map((j) => j.job.method))).toEqual(new Set(['monte-carlo']));
    const answers = jobs.map(({ job }) => runPlanJob(job, us));
    const results = answers.map((a) => (a.ok && a.kind === 'simulate' ? a.result : null));
    expect(results.every((r) => r !== null)).toBe(true);
    expect(new Set(results.map((r) => `${r!.seed}/${r!.runs}/${r!.blockMonths}`))).toEqual(new Set(['1/5000/60']));
    // The Plan's job is the Plan tab's own: the same key, so its answer is reused.
    const view = fiView(base, measured);
    const own = enginePlan(base, view);
    expect(jobs[0].key).toBe(JSON.stringify(['monte-carlo', 'sim' in own ? own.sim : null]));
  });

  test('an answer worked out another way is never set beside the others', () => {
    const base = figs(plan({ age: 40, targetAge: 55 }));
    const r = run(base);
    const columns: CompareColumn[] = [
      { id: 'plan', name: 'Your plan', isPlan: true, outcome: { kind: 'figures', figures: base, result: r } },
      { id: 'x', name: 'Odd', isPlan: false, outcome: { kind: 'figures', figures: base, result: { ...r, seed: 7, method: 'monte-carlo' } } },
    ];
    const { rows } = compareRows(columns, money, TODAY);
    expect(rows.find((x) => x.key === 'lasted')!.cells[1].value).toBe('worked out another way, so not compared');
  });

  test('kept answers are the last few, the newest kept', () => {
    const cache = new Map<string, SimResult>();
    const r = {} as SimResult;
    for (let i = 0; i < 15; i++) rememberResult(cache, `k${i}`, r);
    expect([...cache.keys()]).toEqual(['k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10', 'k11', 'k12', 'k13', 'k14']);
  });
});

describe('what the cells say (review: retiring before the FI date)', () => {
  const base = plan({ age: 40, targetAge: 55 });
  const early = plan({ age: 40, targetAge: 45 });
  const fBase = figs(base);
  const fEarly = figs(early);
  const columns: CompareColumn[] = [
    { id: 'plan', name: 'Your plan', isPlan: true, outcome: { kind: 'figures', figures: fBase, result: run(fBase) } },
    { id: 's1', name: 'Retire at 45', isPlan: false, outcome: { kind: 'figures', figures: fEarly, result: run(fEarly) } },
    { id: 's2', name: 'In euros', isPlan: false, outcome: { kind: 'not-run', reason: 'Its amounts were typed in EUR.' } },
    { id: 's3', name: 'Waiting', isPlan: false, outcome: { kind: 'figures', figures: fBase, result: 'pending' } },
  ];
  const { rows, against } = compareRows(columns, money, TODAY);
  const row = (k: string) => rows.find((r) => r.key === k)!;

  test('the first row says what each starts with, and what it would have then', () => {
    expect(row('start').label).toBe('Starts with');
    expect(row('start').cells[0].value).toBe('$1,000,000, your FI number at 55: you’d have about $1,271,035 then.');
    expect(row('start').cells[1].value).toBe('$1,000,000, your FI number at 45: you’d have about $548,653 then, $451,347 less.');
  });

  test('a start the steady projection never gets to says why in its own cell, since no row below does (review of 8b)', () => {
    const f = figs(plan({ age: 40, targetAge: 55, assets: 100_000, savings: -10_000 }));
    expect(f.short).toBeNull();
    const { rows: own } = compareRows([{ id: 'plan', name: 'Your plan', isPlan: true, outcome: { kind: 'figures', figures: f, result: run(f) } }], money, TODAY);
    expect(own.find((r) => r.key === 'start')!.cells[0].value).toBe(
      '$1,000,000, your FI number at 55: it would never get that far. You’d have about $2,007 at 54, and that year takes $10,000 out, more than there is, so it never gets to 55.'
    );
  });

  test('a plan that starts with money it wouldn’t have says so in its own success cell', () => {
    const cell = row('lasted').cells[1];
    expect(cell.caveat).toBe('It starts with money it wouldn’t have then, so this is too high.');
    expect(row('lasted').cells[0].caveat).toBeNull();
    expect(cell.diff).toMatch(/^[\d.]+ points? (lower|higher)$/);
  });

  test('no amount difference where one starts with money it wouldn’t have', () => {
    expect(row('median').cells[1].diff).toBe('not compared: one starts with money it wouldn’t have');
    expect(row('worst').cells[1].diff).toBe('not compared: one starts with money it wouldn’t have');
    expect(row('spending').cells[1].diff).toBe('not compared: one starts with money it wouldn’t have');
    expect(row('median').label).toBe('Ending balance at 95, median');
    expect(row('spending').label).toBe('Spending in retirement, the first year, by the withdrawal rule (before one-offs and other items)');
  });

  test('ending balances at different ages are said with their age, and never set against each other', () => {
    const thirty = figs(plan({ age: 40, targetAge: 55, horizon: 30 }));
    const c: CompareColumn[] = [columns[0], { id: 'h', name: '30 years', isPlan: false, outcome: { kind: 'figures', figures: thirty, result: run(thirty) } }];
    const r = compareRows(c, money, TODAY).rows;
    const median = r.find((x) => x.key === 'median')!;
    expect(median.label).toBe('Ending balance, median, at each plan’s end');
    expect(median.cells[0].value).toMatch(/^\$[\d,]+ at 95$/);
    expect(median.cells[1].value).toMatch(/^\$[\d,]+ at 85$/);
    expect(median.cells[1].diff).toBe('ends at a different age, so not compared');
    expect(r.find((x) => x.key === 'worst')!.cells[1].diff).toBe('ends at a different age, so not compared');
    // The same start, so spending is still set against it.
    expect(r.find((x) => x.key === 'spending')!.cells[1].diff).toBe('the same');
  });

  test('with no age set, plans that run as long end together, and are set against each other; ones that don’t, aren’t', () => {
    const noAge = figs(plan({ age: null }));
    const fee = figs(plan({ age: null, fee: 0.003 }));
    const forty = figs(plan({ age: null, horizon: 40 }));
    const col = (id: string, f: PlanFigures): CompareColumn => ({ id, name: id, isPlan: id === 'plan', outcome: { kind: 'figures', figures: f, result: run(f) } });
    const same = compareRows([col('plan', noAge), col('fee', fee)], money, TODAY).rows;
    const median = same.find((x) => x.key === 'median')!;
    expect(median.label).toBe('Ending balance after 30 years, median');
    expect(same.find((x) => x.key === 'worst')!.label).toBe('Ending balance after 30 years, the 10% worst');
    expect(median.cells[0].value).toMatch(/^\$[\d,]+$/);
    expect(median.cells[1].diff).toMatch(/^\$[\d,]+ (less|more)$/);
    const apartRows = compareRows([col('plan', noAge), col('forty', forty)], money, TODAY).rows;
    const m = apartRows.find((x) => x.key === 'median')!;
    expect(m.label).toBe('Ending balance, median, at each plan’s end');
    expect(m.cells[0].value).toMatch(/^\$[\d,]+ after 30 years$/);
    expect(m.cells[1].value).toMatch(/^\$[\d,]+ after 40 years$/);
    expect(m.cells[1].diff).toBe('runs a different number of years, so not compared');
  });

  test('with no age set, a copy that sets a retirement age and runs as long is compared by length, not said to run another', () => {
    // The copy starts at 50 (its retirement age), your plan at no age: both 30 years.
    const noAge = figs(plan({ age: null, horizon: 30 }));
    const at50 = figs(plan({ age: null, targetAge: 50, horizon: 30 }));
    expect('sim' in at50.engine && at50.engine.startAge).toBe(50);
    const col = (id: string, f: PlanFigures): CompareColumn => ({ id, name: id, isPlan: id === 'plan', outcome: { kind: 'figures', figures: f, result: run(f) } });
    const r = compareRows([col('plan', noAge), col('Retire at 50', at50)], money, TODAY).rows;
    const median = r.find((x) => x.key === 'median')!;
    expect(median.label).toBe('Ending balance after 30 years, median');
    expect(median.cells[1].value).toMatch(/^\$[\d,]+$/);
    expect(median.cells[1].diff).not.toContain('different number of years');
    // Of another length, the reason is the true one.
    const at50long = figs(plan({ age: null, targetAge: 50, horizon: 35 }));
    const apart = compareRows([col('plan', noAge), col('Retire at 50', at50long)], money, TODAY).rows.find((x) => x.key === 'median')!;
    expect(apart.cells[1].diff).toBe('runs a different number of years, so not compared');
  });

  test('no FI date says which kind of shortfall: a cost it can’t pay, or a year that takes out more than there is', () => {
    const house = figs(plan({ age: 40, targetAge: 60 }), [{ id: 'h', kind: 'house', label: 'Our home', atAge: 42, cost: 800_000, yearly: 0, years: null }]);
    expect(house.short?.kind).toBe('cost');
    expect(fiDateText(house, TODAY)).toBe('none: a cost it can’t pay from its investments (below)');
    const off = figuresOf(plan({ age: 40, targetAge: 60 }), { ...measured, assets: 50_000 }, [{ id: 's', kind: 'sabbatical', label: 'Off', fromAge: 40, years: 1, savingsLost: 120_000 }]) as PlanFigures;
    expect(off.short?.kind).toBe('savings');
    expect(fiDateText(off, TODAY)).toBe('none: a year takes out more than there is (below)');
  });

  test('the FI date is the same for both, said in years, age and year', () => {
    expect(row('fi').cells[0].value).toBe('about 11.8 years, around age 52 (around 2038)');
    expect(row('fi').cells[1].diff).toBe('the same');
  });

  test('one not worked out, and one still working, say so; differences are against the first that ran', () => {
    expect(against?.id).toBe('plan');
    expect(row('lasted').cells[2]).toMatchObject({ value: 'not worked out (below)', diff: null });
    expect(row('lasted').cells[3]).toMatchObject({ pending: true, value: null });
    // The FI date needs no simulation.
    expect(row('fi').cells[3].pending).toBe(false);
  });

  test('one that needs a figure that isn’t measured says so, for invested assets and for spending, rather than that it needs one (review round 3)', () => {
    const noAssets = figuresOf(plan({ age: 40, targetAge: 55, start: 'assets' }), { ...measured, assets: null, unmeasured: ['assets'] }, []) as PlanFigures;
    const noSpending = figuresOf(base, { spending: null, savings: null, assets: 300_000, unmeasured: ['spending', 'savings'] }, []) as PlanFigures;
    const none = figuresOf(base, { spending: null, savings: null, assets: 300_000 }, []) as PlanFigures;
    const cells = compareRows(
      [
        { id: 'plan', name: 'Your plan', isPlan: true, outcome: { kind: 'figures', figures: fBase, result: run(fBase) } },
        ...[noAssets, noSpending, none].map((f, i): CompareColumn => ({ id: `m${i}`, name: `M${i}`, isPlan: false, outcome: { kind: 'figures', figures: f, result: 'sim' in f.engine ? run(f) : { missing: f.engine.missing } } })),
      ],
      money,
      TODAY
    ).rows.find((r) => r.key === 'lasted')!.cells;
    expect(cells.slice(1).map((c) => c.value)).toEqual([
      'needs your invested assets, which aren’t measured (Your path says why)',
      'needs your annual spending, which isn’t measured (Your path says why)',
      'needs your annual spending',
    ]);
  });

  test('plans that start with different balances show no amount difference; the same start shows one', () => {
    const typed = figs(plan({ age: 40, targetAge: 55, start: 'assets' }));
    const spendMore = figs(plan({ age: 40, targetAge: 55, withdrawalRate: 0.035 }));
    const c: CompareColumn[] = [
      columns[0],
      { id: 'a', name: 'From today', isPlan: false, outcome: { kind: 'figures', figures: typed, result: run(typed) } },
      { id: 'b', name: 'Fee', isPlan: false, outcome: { kind: 'figures', figures: figs(plan({ age: 40, targetAge: 55, fee: 0.003 })), result: run(figs(plan({ age: 40, targetAge: 55, fee: 0.003 }))) } },
      { id: 'c', name: 'At 3.5%', isPlan: false, outcome: { kind: 'figures', figures: spendMore, result: run(spendMore) } },
    ];
    const r = compareRows(c, money, TODAY).rows.find((x) => x.key === 'median')!;
    expect(r.cells[1].diff).toBe('starts with a different balance');
    expect(r.cells[2].diff).toMatch(/ less$/);
    expect(r.cells[3].diff).toBe('starts with a different balance');
  });

  test('points and lengths in words', () => {
    expect(pointsText(-0.0823)).toBe('8.2 points lower');
    expect(pointsText(0.01)).toBe('1 point higher');
    expect(pointsText(0.0001)).toBe('the same');
    const lengths = startsLine(columns);
    expect(lengths?.map((l) => [l.name, l.years, l.paths, l.lastStart])).toEqual([
      ['Your plan', 40, 1350, '1983-06'],
      ['Retire at 45', 50, 1230, '1973-06'],
    ]);
  });

  test('the view reads by metric, with the plan’s name as each row’s header, and says what every plan shares', () => {
    const html = renderToStaticMarkup(<PlanCompare columns={columns} method="historical" money={money} today={TODAY} details={{}} />);
    const t = text(html);
    expect(html).toContain('<caption>Starts with</caption>');
    expect(html).toContain('<th scope="row">Retire at 45</th>');
    expect(t).toContain('Differences are against Your plan.');
    expect(t).toContain('These plans run different lengths, so each has its own starts: Your plan, 40 years, 1,350 starts to Jun 1983; Retire at 45, 50 years, 1,230 starts to Jun 1973.');
    expect(t).toContain('The differences include the starts one plan has that another doesn’t.');
    expect(t).toContain('monthly returns from Jan 1871 to May 2023');
    expect(t).toContain('It starts with money it wouldn’t have then, so this is too high.');
  });

  test('with amounts hidden, no figure shows, and percentages, years and ages stay', () => {
    const g = globalThis as Record<string, unknown>;
    g.window = {};
    try {
      setAmountsHidden(true);
      const html = renderToStaticMarkup(<PlanCompare columns={columns} method="historical" money={money} today={TODAY} details={{}} />);
      const t = text(html);
      expect(t).not.toMatch(/\$\d/);
      expect(t).toContain(MASK);
      expect(t).toMatch(/\d+\.\d% of 1,350 historical starts/);
      expect(t).toContain('around age 52 (around 2038)');
      // A screen reader hears "hidden", never the mask.
      expect(html).toContain('class="visually-hidden"');
    } finally {
      setAmountsHidden(false);
      delete g.window;
    }
  });
});

describe('the words', () => {
  test('what a plan starts with', () => {
    const sw = figs(plan({ age: 40, targetAge: 45 })).startsWith!;
    expect(startsWithText(sw, money)).toBe('$1,000,000, your FI number at 45: you’d have about $548,653 then, $451,347 less.');
    expect(startsWithText({ ...sw, from: 'assets', balance: 300_000 }, money)).toBe('$300,000, your invested assets today.');
  });

  // Drawdown's start line (the tax plan's P): beside what a plan starts
  // with, what the steady path has where Whole path starts drawing.
  test('Drawdown’s start line, against where Whole path starts', () => {
    const at = { age: 40, stopAge: 45, atStop: 548_653 };
    const sw = figs(plan({ age: 40, targetAge: 45 })).startsWith!;
    // More: the caution's words instead (startsWithText).
    expect(startLineText(sw, money, at)).toBeNull();
    expect(startLineText({ ...sw, more: false, balance: 500_000 }, money, at)).toBe('Starting from your FI number, $500,000, not the $548,653 you’d have at 45.');
    expect(startLineText({ ...sw, more: false, from: 'custom', balance: 500_000 }, money, at)).toBe('Starting from the balance you typed, $500,000, not the $548,653 you’d have at 45.');
    // Within 50 cents, the same.
    expect(startLineText({ ...sw, more: false, balance: sw.projected! - 0.4 }, money, at)).toBeNull();
    // Once the stop has come, what you have today.
    expect(startLineText({ ...sw, more: false, balance: 500_000, atAge: 45 }, money, { ...at, age: 46 })).toBe('Starting from your FI number, $500,000, not the $548,653 you have today.');
    // From today's assets, before the stop, either way; once it has come, nothing.
    const assets = { ...sw, from: 'assets' as const, balance: 300_000, atAge: 40, projected: null };
    expect(startLineText(assets, money, at)).toBe('Starting today, at 40, from your invested assets, $300,000, not the $548,653 you’d have at 45.');
    expect(startLineText(assets, money, { ...at, atStop: 250_000 })).toBe('Starting today, at 40, from your invested assets, $300,000, not the $250,000 you’d have at 45.');
    expect(startLineText(assets, money, { ...at, age: 45 })).toBeNull();
    expect(startLineText(assets, money, { ...at, atStop: null })).toBeNull();
  });

  test('a start the walk never reaches says where the shortfall is: below it, in compare mode, by default', () => {
    const house = figs(plan({ age: 40, targetAge: 60 }), [{ id: 'h', kind: 'house', label: 'Our home', atAge: 42, cost: 800_000, yearly: 0, years: null }]);
    expect(house.startsWith?.short?.kind).toBe('cost');
    const start = compareRows([{ id: 'plan', name: 'Your plan', isPlan: true, outcome: { kind: 'figures', figures: house, result: 'pending' } }], money, TODAY).rows.find((r) => r.key === 'start')!;
    expect(start.cells[0].value).toMatch(/^\$[\d,]+, your FI number at 60: it would never get that far \(below\)\.$/);
    // The simulation's card names its place (PlanTab).
    expect(startsWithText(house.startsWith!, money, 'on Your path')).toEndWith(': it would never get that far (on Your path).');
  });

  test('typed in another currency while your plan’s isn’t known: it points at the question at the top of the Plan tab, on the card and in compare mode', () => {
    const said = 'Its amounts were typed in EUR, and which currency your plan’s figures are in isn’t known yet (at the top of the Plan tab). Nothing is converted, so it isn’t worked out until you have said.';
    expect(currencyText('EUR', 'USD', false)).toBe(said);
    // The tab hands the same words to the copy's card and to compare mode
    // (components/PlanTab.tsx sheetPlans).
    expect(text(copyCard({ other: 'EUR', currencyLine: said, planCurrency: null, confirmWhyNot: 'Say which currency your plan’s figures are in first.' }))).toContain(said);
    const copy: SheetPlan = { id: 'c1', name: 'In euros', isMain: false, updatedAt: 'u1', plan: planOf(plan({ age: 40, targetAge: 55, spending: 45_000 })), outcome: { kind: 'not-run', reason: said } };
    expect(text(renderToStaticMarkup(<PlanDetails plan={copy} parts={[]} outcome={{ kind: 'not-run', reason: said }} money={money} />))).toContain(said);
  });

  test('a cost the walk can’t pay', () => {
    expect(shortText({ year: 2, have: 653_750, need: 800_000, kind: 'cost' }, 40, money)).toBe(
      'You’d have about $653,750 at 42, less than the $800,000 it takes from your investments, so there is no FI date: change the cost, or when it comes.'
    );
  });
});

describe('the copy’s card and the Plans sheet', () => {
  const base = planOf(plan({ age: 40, targetAge: 55 }));

  test('the open copy’s card says how it differs and why it isn’t worked out; its name is the bar’s, and so is the way back', () => {
    const html = copyCard({ problem: REFUSED_TEXT });
    const t = text(html);
    // No heading of its own, and no Back: the Plan's bar has both (test/plan-bar-view.test.tsx).
    expect(html).not.toContain('<h2');
    expect(html).not.toContain('tabindex="-1"');
    expect(t).not.toContain('Copy: ');
    expect(t).not.toContain('Back to your plan');
    expect(html).toContain('class="card stack tight plan-copy-card" aria-label="This copy"');
    expect(t).toContain('Stop age: 50 (your plan: 55).');
    expect(t).toContain(REFUSED_TEXT);
    expect(t).toContain('Make this your plan');
    // None differs: said so.
    expect(text(copyCard({ parts: [] }))).toContain('The same as your plan.');
  });

  test('its Plans button opens the sheet, and counts the plans once there are two or more', () => {
    const plans = (html: string) => html.match(/<button[^>]*aria-haspopup="dialog"[^>]*>([^<]*)<\/button>/g) ?? [];
    expect(plans(copyCard())).toEqual(['<button type="button" class="btn ghost" aria-haspopup="dialog">Plans (2)</button>']);
    // Not loaded yet, or only one: no count.
    expect(plans(copyCard({ plansCount: null }))).toEqual(['<button type="button" class="btn ghost" aria-haspopup="dialog">Plans</button>']);
    expect(plans(copyCard({ plansCount: 1 }))).toEqual(['<button type="button" class="btn ghost" aria-haspopup="dialog">Plans</button>']);
  });

  test('“They’re in” is offered only once the accounts have loaded without a problem', () => {
    const props = { other: 'USD', planCurrency: 'EUR', currencyLine: currencyText('USD', 'EUR') };
    expect(text(copyCard({ ...props, confirmWhyNot: null }))).toContain('They’re in EUR');
    const waiting = text(copyCard({ ...props, confirmWhyNot: 'Your accounts haven’t all loaded.' }));
    expect(waiting).not.toContain('They’re in EUR');
    expect(waiting).toContain('Its amounts were typed in USD, and your plan is now in EUR.');
    expect(waiting).toContain('Your accounts haven’t all loaded.');
  });

  // In place of a scenario's rule broken, fixed field by field: a copy
  // holding values that don't fit your plan as it is now is repaired whole,
  // said on its card, and saved that way from there.
  test('values that don’t fit your plan now are said on the card, with Save it this way, off while nothing can be saved', () => {
    const repair = { text: 'Its stop age, 50, is before your age now: it is shown at 52.', onSave: noop };
    const t = text(copyCard({ repair }));
    expect(t).toContain('Its stop age, 50, is before your age now: it is shown at 52.');
    expect(t).toContain('Save it this way');
    expect(copyCard({ repair, editable: false })).toMatch(/<button type="button" class="btn secondary" disabled="">Save it this way<\/button>/);
    expect(text(copyCard())).not.toContain('Save it this way');
  });

  /** The Plans sheet, as PlanTab draws it, open at its list. */
  const sheet = (over: Partial<ComponentProps<typeof PlansSheet>> = {}) => {
    const state: PlansState = { ...INITIAL_PLANS, status: 'ready', list: [row('main', 'First plan'), row('c1', 'Retire at 45'), row('c2', 'Part time')], unrecognised: ['later'] };
    const at45 = planOf(plan({ age: 40, targetAge: 45 }));
    const plans: SheetPlan[] = [
      { id: 'main', name: 'First plan', isMain: true, updatedAt: 'u-main', plan: base, outcome: { kind: 'figures', figures: figs(plan({ age: 40, targetAge: 55 })) } },
      { id: 'c1', name: 'Retire at 45', isMain: false, updatedAt: 'u-c1', plan: at45, outcome: { kind: 'figures', figures: figs(plan({ age: 40, targetAge: 45 })) } },
      { id: 'c2', name: 'Part time', isMain: false, updatedAt: 'u-c2', plan: base, outcome: { kind: 'figures', figures: figs(plan({ age: 40, targetAge: 55 })) } },
    ];
    return renderToStaticMarkup(
      <PlansSheet
        open
        onClose={() => {}}
        state={state}
        plans={plans}
        measuring={false}
        planState="ready"
        whyNot={null}
        openId={null}
        onOpen={() => {}}
        onCreate={noop}
        onRename={noop}
        onDelete={noop}
        onMakeMain={noop}
        onRetry={() => {}}
        run={async () => ({ ok: false, error: 'cancelled' })}
        cache={new Map()}
        method="historical"
        money={money}
        today={TODAY}
        {...over}
      />
    );
  };

  test('the Plans sheet: titled Plans, your plan first with its badge, each copy with its FI age and how it differs, the newer-version note, and Compare and New copy', () => {
    const html = sheet();
    const t = text(html);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Plans"');
    expect(t).toContain('Each plan is whole: a copy starts as your plan, and changes you make in it stay in it.');
    expect(html).toContain('aria-label="Your plans"');
    expect(t.indexOf('First plan')).toBeLessThan(t.indexOf('Retire at 45'));
    expect(t.indexOf('Retire at 45')).toBeLessThan(t.indexOf('Part time'));
    expect(html.match(/class="badge accent">Your plan</g)?.length).toBe(1);
    expect(t).toMatch(/First plan FI around 52 Your plan/);
    // Stopping sooner moves no FI age: the FI number is reached when it is.
    expect(t).toContain('Retire at 45 FI around 52, as in your plan · Stop age: 45 (your plan: 55)');
    expect(t).toContain('Part time FI around 52, as in your plan · the same as your plan');
    expect(t).toContain('A plan was saved by a newer version of Nya: kept, and not shown here.');
    expect(html).toMatch(/<button[^>]*class="btn secondary"[^>]*>Compare<\/button>/);
    expect(html).toMatch(/<button[^>]*class="btn"[^>]*>New copy<\/button>/);
  });

  test('closed, the sheet draws nothing; while your plan loads, its list is only why and its rows as placeholders, with nothing over the defaults', () => {
    expect(sheet({ open: false })).toBe('');
    const html = sheet({ planState: 'loading', plans: [], whyNot: 'Your plan is still loading: plans open, and are compared, once it has.' });
    const t = text(html);
    expect(t).toContain('Your plan is still loading: plans open, and are compared, once it has.');
    expect(html).toContain('Loading your plans');
    expect(html).not.toContain('spinner');
    for (const absent of ['Each plan is whole', 'Retire at 45', 'FI around', 'Choose two to four plans.', 'newer version']) expect(t).not.toContain(absent);
    // Nothing to compare or copy yet.
    expect(html).toMatch(/<button[^>]*class="btn secondary"[^>]*disabled=""[^>]*>Compare<\/button>/);
    expect(html).toMatch(/<button[^>]*class="btn"[^>]*disabled=""[^>]*>New copy<\/button>/);
  });

  test('every card says it is the copy’s, and the method is your plan’s', () => {
    const p = plan({ age: 40, targetAge: 55 });
    const f = figs(p);
    const a: FigureArgs = {
      plan: p,
      view: f.view,
      flows: null,
      unread: [],
      withoutTransactions: NO_CONNECTIONS_WITHOUT,
      transactionCount: 0,
      txnsLoading: false,
      txnsFailed: false,
      assets: { total: 300_000, accounts: [], unknown: 0, caveats: [], currency: 'USD', leftOut: [] },
      balancesAsOf: null,
      workplace: null,
      workplaceCount: 0,
      cashOn: [],
      cashUnmarked: false,
      money,
      savingsRate: null,
      shareRates: null,
      taxOnHold: false,
    };
    const fi = renderToStaticMarkup(<FiCard copyName="Retire at 45" {...a} currencyNote={null} />);
    expect(text(fi)).toContain('Copy: Retire at 45');
    // The figures the FI card rests on, under it on Your path (rollout phase
    // 6c), what they say worked out in the render as PlanTab does.
    const Inputs = () => <InputsCard copyName="Retire at 45" figures={figureNotes(a)} view={f.view} plan={a.plan} money={money} onOpen={() => {}} />;
    const inputs = renderToStaticMarkup(<Inputs />);
    expect(text(inputs)).toContain('Copy: Retire at 45');
    const sim = renderToStaticMarkup(
      <SimulationCard copyName="Retire at 45" plan={f.plan} notes={f.itemNotes} view={f.view} engine={f.engine} outcome={null} pending={false} money={money} currency="USD" onRetry={() => {}} />
    );
    const st = text(sim);
    expect(st).toContain('Copy: Retire at 45');
    // The method is set in the Assumptions sheet, which says there that a
    // copy can't change it (rollout 6d, C2); the answer's line names it, so
    // Drawdown's hero has no meta (the tax plan's P).
    expect(st).toContain('Copy: Retire at 45 Will it last?');
    expect(sim).not.toContain('class="meta"');
    expect(sim).not.toContain('<button');
    const events = renderToStaticMarkup(
      <TimelineCard {...timelineProps(withItem(planOf(p), itemFromEvent({ id: 'c', kind: 'child', label: 'A child', fromAge: 38, yearly: 15_000, years: 18 })), measured, OFF)} copyName="Retire at 45" version="c1@u1" />
    );
    const et = text(events);
    expect(et).toContain('Copy: Retire at 45');
    expect(et).toContain('A child');
    expect(et).toContain('$15,000');
    expect(et).toContain('Some of it is before today');
  });

  test('a plan run from money it wouldn’t have says so on its simulation card', () => {
    const p = plan({ age: 40, targetAge: 45 });
    const f = figs(p);
    const t = text(renderToStaticMarkup(<SimulationCard startsWith={f.startsWith} plan={f.plan} notes={f.itemNotes} view={f.view} engine={f.engine} outcome={null} pending={false} money={money} currency="USD" onRetry={() => {}} />));
    expect(t).toContain('It starts with $1,000,000, your FI number at 45: you’d have about $548,653 then, $451,347 less: it starts with money it wouldn’t have then, so it reads safer than it is.');
  });
});

describe('loading and saving the list', () => {
  type Call = { url: string; method: string; body: unknown };
  function server(answers: ((c: Call) => [number, unknown])[]) {
    const calls: Call[] = [];
    let i = 0;
    const fetcher = async (url: string, init?: RequestInit) => {
      const c = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(c);
      const [status, body] = answers[i++](c);
      return new Response(JSON.stringify(body), { status });
    };
    return { calls, fetcher };
  }
  const mine = row('main', 'First plan');
  const c1 = row('c1', 'Retire at 45');
  const listing = (plans: PlanRow[], unreadable: string[] = []) => ({ main: 'main', missing: false, plans, unreadable_ids: unreadable, unrecognised_ids: [] });

  test('nothing is saved before a load has succeeded', async () => {
    const { calls, fetcher } = server([]);
    const client = createPlansClient(() => {}, fetcher);
    expect(await client.create({ from: 'main', name: 'x', plan: planOf(plan()), currency: null })).toEqual({ error: 'Your plans haven’t loaded yet. Try again in a moment.' });
    expect(calls).toEqual([]);
  });

  test('an edit names its version; one changed elsewhere is shown as it is now, and said', async () => {
    const now = { ...c1, name: 'On my phone', updated_at: 'u2' };
    const { calls, fetcher } = server([
      () => [200, listing([mine, c1])],
      () => [409, { error: 'Changed on another device: load it again', stale: true }],
      () => [200, listing([mine, now])],
    ]);
    let state = INITIAL_PLANS;
    const client = createPlansClient((s) => (state = s), fetcher);
    await client.load();
    const r = await client.rename('c1', 'On my laptop', 'u-c1');
    expect(r).toEqual({ error: 'Changed on another device: load it again', stale: true });
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: { id: 'c1', name: 'On my laptop', based_on: 'u-c1' } });
    expect(calls[2]).toMatchObject({ method: 'GET' });
    expect(state.list).toEqual([mine, now]);
    expect(state.saving).toBe(false);
  });

  test('one request at a time, in order; a failed save reloads what is stored', async () => {
    const order: string[] = [];
    const a = row('a', 'A');
    const { fetcher } = server([
      () => [200, listing([mine])],
      (c) => (order.push(`${c.method} ${(c.body as any).name}`), [200, { plan: a }]),
      (c) => (order.push(`${c.method} ${(c.body as any).name}`), [500, { error: 'Failed to make the plan' }]),
      (c) => (order.push(c.method), [200, listing([mine, a], ['bad'])]),
    ]);
    let state = INITIAL_PLANS;
    const client = createPlansClient((s) => (state = s), fetcher);
    void client.load();
    const made = (name: string) => client.create({ from: 'main', name, plan: planOf(plan()), currency: null });
    const [ok, failed] = await Promise.all([made('A'), made('B')]);
    expect('ok' in ok).toBe(true);
    expect(failed).toEqual({ error: 'Failed to make the plan', stale: false });
    expect(order).toEqual(['POST A', 'POST B', 'GET']);
    expect(state.list.map((r) => r.name)).toEqual(['First plan', 'A']);
    expect(state.unreadable).toEqual(['bad']);
  });
});
