import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PlanCompare from '@/components/PlanCompare';
import { compareRows, fiDateText, pointsText, startsLine, type CompareColumn } from '@/components/plan-compare';
import { ScenarioBar, ScenariosCard, compareJobs, formFor, rememberResult, scenarioOutcome } from '@/components/PlanScenarios';
import { LifeEventsCard } from '@/components/PlanEvents';
import { FiCard, SimulationCard } from '@/components/PlanTab';
import { INITIAL_SCENARIOS, createScenarioClient, type ScenarioEntry, type ScenariosState } from '@/components/plan-scenarios';
import { startsWithText, shortText, changeText } from '@/components/plan-scenario-text';
import { wholeMoney } from '@/components/plan-text';
import { DEFAULT_PLAN, enginePlan, fiView, type FirePlan, type Measured } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { NO_CHANGES, scenarioChanges, type ScenarioChanges } from '@/lib/fire/scenarios';
import { runPlanJob } from '@/lib/fire/jobs';
import { usMarket } from '@/lib/fire/us-market';
import { HISTORY_COUNT, HISTORY_FIRST, historySpan } from '@/lib/fire/history-span';
import { simulate, type SimResult } from '@/lib/fire/simulate';
import { MASK, setAmountsHidden } from '@/lib/format';

// Compare mode (components/plan-compare.ts, PlanCompare.tsx) and the
// scenario cards: one seed and one dataset, what each cell says, what a plan
// that starts with money it wouldn't have says, and amounts hidden.

const us = usMarket();
const money = (n: number) => wholeMoney(n, 'USD');
const TODAY = '2026-10-23';
const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const measured: Measured = { spending: 40_000, savings: 30_000, assets: 300_000 };
const figs = (p: FirePlan, events: ScenarioChanges['events'] = []): PlanFigures => planFigures(p, measured, events) as PlanFigures;
const entry = (over: Partial<ScenarioEntry> = {}): ScenarioEntry => ({
  id: 's1',
  version: 1,
  name: 'Retire at 45',
  currency: 'USD',
  createdAt: '2026-10-01T00:00:00.000Z',
  savedAt: '2026-10-01T00:00:00.000Z',
  rev: 'r1',
  ...NO_CHANGES,
  set: { targetAge: 45 },
  ...over,
});
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
    const outcomes = [
      { kind: 'figures' as const, figures: figs(base) },
      scenarioOutcome(base, entry(), measured, 'USD'),
      scenarioOutcome(base, entry({ id: 's2', name: 'Spend more', set: { spending: 50_000 } }), measured, 'USD'),
      { kind: 'not-run' as const },
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
    expect(row('spending').label).toBe('Spending in retirement, the first year, by the withdrawal rule (before one-offs and life events)');
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

  test('no FI date says which kind of shortfall: a cost it can’t pay, or a year that takes out more than there is', () => {
    const house = figs(plan({ age: 40, targetAge: 60 }), [{ id: 'h', kind: 'house', label: 'Our home', atAge: 42, cost: 800_000, yearly: 0, years: null }]);
    expect(house.short?.kind).toBe('cost');
    expect(fiDateText(house, TODAY)).toBe('none: a cost it can’t pay from its investments (below)');
    const off = planFigures(plan({ age: 40, targetAge: 60 }), { ...measured, assets: 50_000 }, [{ id: 's', kind: 'sabbatical', label: 'Off', fromAge: 40, years: 1, savingsLost: 120_000 }]) as PlanFigures;
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

  test('a cost the walk can’t pay', () => {
    expect(shortText({ year: 2, have: 653_750, need: 800_000, kind: 'cost' }, 40, money)).toBe(
      'You’d have about $653,750 at 42, less than the $800,000 it takes from your investments, so there is no FI date: change the cost, or when it comes.'
    );
  });

  test('each change, with the Plan’s value beside it', () => {
    const base = plan({ age: 40, targetAge: 55, income: [{ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true }] });
    const s = entry({ set: { targetAge: 45, spending: null }, income: { leaveOut: ['ss'], add: [{ id: 'ss', label: 'Social Security', amount: 18_000, fromAge: 62, inflationAdjusted: true }] } });
    expect(scenarioChanges(base, s).map((c) => changeText(c, base, s, money))).toEqual([
      'Retirement age: 45 (your plan: 55)',
      'Annual spending: Nya’s measured figure (the same as your plan now)',
      '“Social Security”: $18,000 a year from age 62, rising with inflation, instead of $24,000 a year from age 67, rising with inflation',
    ]);
  });

  test('which form fixes a rule a scenario breaks', () => {
    expect(formFor('targetAge')).toBe('about');
    expect(formFor('withdrawalRate')).toBe('assumptions');
    expect(formFor('spending')).toBe('spending');
    expect(formFor('fee')).toBe('simulation');
    expect(formFor('income[5]')).toBeNull();
  });
});

describe('the scenario cards', () => {
  const base = plan({ age: 52, targetAge: 55 });
  const noop = async () => true as const;

  test('the top card says whose it is and that saves go to it, lists its changes, and says why it isn’t worked out', () => {
    const s = entry({ set: { targetAge: 50 } });
    const html = renderToStaticMarkup(
      <ScenarioBar
        entry={s}
        base={base}
        problem={{ text: 'It retires at 50, before your age now (52). Change its retirement age, or use your plan’s.', field: 'targetAge' }}
        other={null}
        planCurrency="USD"
        confirmWhyNot={null}
        editable
        money={money}
        eventsCount={2}
        headingRef={{ current: null }}
        onSave={noop}
        onConfirmCurrency={noop}
        onFix={() => {}}
        onBack={() => {}}
      />
    );
    const t = text(html);
    expect(html).toContain('tabindex="-1"');
    expect(t).toContain('Scenario: Retire at 45');
    expect(t).toContain('changes you make here are saved to it, never to your plan');
    expect(t).toContain('It retires at 50, before your age now (52).');
    expect(t).toContain('Change it');
    expect(t).toContain('Retirement age: 50 (your plan: 55)');
    expect(t).toContain('Use your plan’s');
    expect(t).toContain('2 life events, below.');
    expect(t).toContain('Back to your plan');
  });

  test('“They’re in” is offered only once the accounts have loaded without a problem', () => {
    const props = {
      entry: entry({ currency: 'USD', set: { spending: 45_000 } }),
      base,
      problem: null,
      other: 'USD',
      planCurrency: 'EUR',
      editable: true,
      money,
      eventsCount: 0,
      headingRef: { current: null },
      onSave: noop,
      onConfirmCurrency: noop,
      onFix: () => {},
      onBack: () => {},
    };
    expect(text(renderToStaticMarkup(<ScenarioBar {...props} confirmWhyNot={null} />))).toContain('They’re in EUR');
    const waiting = text(renderToStaticMarkup(<ScenarioBar {...props} confirmWhyNot="Your accounts haven’t all loaded." />));
    expect(waiting).not.toContain('They’re in EUR');
    expect(waiting).toContain('Its amounts were typed in USD, and your plan is now in EUR.');
  });

  test('the list card: each scenario with what it changes, and the limit', () => {
    const state: ScenariosState = { ...INITIAL_SCENARIOS, status: 'ready', list: [entry(), entry({ id: 's2', name: 'Part time', set: {} })], unrecognised: ['later'] };
    const html = renderToStaticMarkup(
      <ScenariosCard
        state={state}
        client={createScenarioClient(() => {})}
        base={base}
        baseFigures={figs(base)}
        measured={measured}
        planCurrency="USD"
        canOpen
        planState="ready"
        whyNot={null}
        openId={null}
        onOpen={() => {}}
        run={async () => ({ ok: false, error: 'cancelled' })}
        cache={new Map()}
        method="historical"
        money={money}
        today={TODAY}
      />
    );
    const t = text(html);
    expect(t).toContain('Retire at 45');
    expect(t).toContain('Retirement age: 45 (your plan: 55)');
    expect(t).toContain('No changes yet');
    expect(t).toContain('A scenario was saved by a newer version of Nya: kept, and not shown here.');
    expect(t).toContain('Choose two to four plans.');
    expect(html).toContain('aria-pressed="true"');
  });

  test('every card says it is the scenario’s, and the method is the Plan’s', () => {
    const p = plan({ age: 40, targetAge: 55 });
    const f = figs(p);
    const fi = renderToStaticMarkup(
      <FiCard
        scenarioName="Retire at 45"
        plan={p}
        view={f.view}
        flows={null}
        unread={[]}
        txnsLoading={false}
        txnsFailed={false}
        assets={{ total: 300_000, accounts: [], unknown: 0, caveats: [], currency: 'USD', leftOut: [] }}
        balancesAsOf={null}
        workplace={null}
        workplaceCount={0}
        currencyNote={null}
        money={money}
        editable
        open={() => {}}
      />
    );
    expect(text(fi)).toContain('Scenario: Retire at 45');
    const sim = renderToStaticMarkup(
      <SimulationCard scenarioName="Retire at 45" plan={p} view={f.view} engine={f.engine} outcome={null} pending={false} money={money} currency="USD" editable onMethod={null} onRetry={() => {}} open={() => {}} />
    );
    const st = text(sim);
    expect(st).toContain('Scenario: Retire at 45');
    expect(st).toContain('The method is your plan’s: every scenario uses it, so they compare.');
    expect(sim).toMatch(/<button[^>]*aria-pressed="true"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-pressed="true"/);
    const events = renderToStaticMarkup(<LifeEventsCard scenarioName="Retire at 45" version="s1@r1" events={[{ id: 'c', kind: 'child', label: 'A child', fromAge: 42, yearly: 15_000, years: 18 }]} notes={[{ id: 'c', part: 'past' }]} money={money} editable onSave={noop} />);
    const et = text(events);
    expect(et).toContain('Scenario: Retire at 45');
    expect(et).toContain('From 42: spending $15,000 a year more, for 18 years.');
    expect(et).toContain('Some of it is before today');
  });

  test('a plan run from money it wouldn’t have says so on its simulation card', () => {
    const p = plan({ age: 40, targetAge: 45 });
    const f = figs(p);
    const t = text(renderToStaticMarkup(<SimulationCard startsWith={f.startsWith} plan={p} view={f.view} engine={f.engine} outcome={null} pending={false} money={money} currency="USD" editable onMethod={() => {}} onRetry={() => {}} open={() => {}} />));
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
  const s1 = entry();

  test('nothing is saved before a load has succeeded', async () => {
    const { calls, fetcher } = server([]);
    const client = createScenarioClient(() => {}, fetcher);
    expect(await client.create({ name: 'x', currency: null, ...NO_CHANGES })).toEqual({ error: 'Your saved scenarios haven’t loaded yet.' });
    expect(calls).toEqual([]);
  });

  test('an edit names its version; one changed elsewhere is shown as it is now, and said', async () => {
    const now = { ...s1, name: 'On my phone', rev: 'r2' };
    const { calls, fetcher } = server([
      () => [200, { scenarios: [s1], unreadable_ids: [], unrecognised_ids: [] }],
      () => [409, { error: 'This scenario was changed on another device: here it is as it is now.', stale: true, scenario: now }],
    ]);
    let state = INITIAL_SCENARIOS;
    const client = createScenarioClient((s) => (state = s), fetcher);
    await client.load();
    const r = await client.save('s1', { name: 'On my laptop', currency: 'USD', ...NO_CHANGES }, 'r1');
    expect(r).toEqual({ error: 'This scenario was changed on another device: here it is as it is now.', stale: true });
    expect(calls[1]).toMatchObject({ method: 'PUT', body: { id: 's1', based_on: 'r1' } });
    expect(state.list).toEqual([now]);
  });

  test('one request at a time, in order; a failed save reloads what is stored', async () => {
    const order: string[] = [];
    const { fetcher } = server([
      () => [200, { scenarios: [], unreadable_ids: [], unrecognised_ids: [] }],
      (c) => (order.push(`${c.method} ${(c.body as any).scenario.name}`), [200, { scenario: { ...s1, id: 'a', name: 'A' } }]),
      (c) => (order.push(`${c.method} ${(c.body as any).scenario.name}`), [500, { error: 'Failed to save the scenario' }]),
      (c) => (order.push(c.method), [200, { scenarios: [{ ...s1, id: 'a', name: 'A' }], unreadable_ids: ['bad'], unrecognised_ids: [] }]),
    ]);
    let state = INITIAL_SCENARIOS;
    const client = createScenarioClient((s) => (state = s), fetcher);
    void client.load();
    const [a, b] = await Promise.all([client.create({ name: 'A', currency: null, ...NO_CHANGES }), client.create({ name: 'B', currency: null, ...NO_CHANGES })]);
    expect('ok' in a).toBe(true);
    expect(b).toEqual({ error: 'Failed to save the scenario' });
    expect(order).toEqual(['POST A', 'POST B', 'GET']);
    expect(state.list.map((s) => s.name)).toEqual(['A']);
    expect(state.unreadable).toEqual(['bad']);
  });
});
