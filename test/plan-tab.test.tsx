import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PlanTab, { EventsCard, FiCard, GridCard, SimulationCard, assetCaveatLines, unreadText, windowText, type Outcome } from '@/components/PlanTab';
import PlanFanChart from '@/components/PlanFanChart';
import { FigureForm } from '@/components/PlanForms';
import PlanGrid from '@/components/PlanGrid';
import { PlanUnavailable, loadPlanTab } from '@/components/PlanTabLoader';
import { dayName, monthName, pct, progressText, successText, wholeMoney } from '@/components/plan-text';
import { DEFAULT_PLAN, enginePlan, fiView, type FirePlan, type Measured } from '@/lib/fire/plan';
import { simulate, successGrid } from '@/lib/fire/simulate';
import { usMarket } from '@/lib/fire/us-market';
import type { InvestedAssets, TrailingFlows, WorkplaceSavings } from '@/lib/fire/inputs';

const noop = () => {};
const money = (n: number) => wholeMoney(n, 'USD');
const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const flows: TrailingFlows = {
  spending: 40_000,
  income: 70_000,
  savings: 30_000,
  loanPayments: 0,
  cash: 0,
  refunds: 0,
  unclearLoans: 0,
  largestRefund: null,
  from: '2025-10-07',
  to: '2026-10-06',
  days: 365,
  scaled: false,
  count: 400,
  currency: 'USD',
  mixedCurrency: false,
};
const measured: Measured = { spending: 40_000, savings: 30_000, assets: 250_000 };
const assets = (over: Partial<InvestedAssets> = {}): InvestedAssets => ({
  total: 250_000,
  accounts: [
    { account_id: 'a', name: 'Brokerage', type: 'investment', balance: 150_000, currency: 'USD', institution: 'Vanguard', item_id: 'i1' },
    { account_id: 'b', name: '401(k)', type: 'investment', subtype: '401k', balance: 100_000, currency: 'USD', institution: 'Fidelity', item_id: 'i2' },
  ],
  unknown: 0,
  caveats: [],
  currency: 'USD',
  mixedCurrency: false,
  ...over,
});
const noPlans: WorkplaceSavings = { total: 0, measured: [], added: [], matched: [], fromBank: [], partial: [], problems: [], unmeasured: [] };

/** Markup as text, tags dropped and entities decoded, for reading sentences. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

describe('figures', () => {
  test('a success rate never rounds up to 100% or down to 0%', () => {
    expect(successText(1)).toBe('100%');
    expect(successText(0)).toBe('0%');
    expect(successText(0.996)).toBe('>99%');
    expect(successText(0.996, 1)).toBe('99.6%');
    expect(successText(0.9996, 1)).toBe('>99.9%');
    expect(successText(0.004)).toBe('<1%');
    expect(successText(0.973, 1)).toBe('97.3%');
  });

  test('progress never reads 100% short of the target, and says how far past it', () => {
    expect(progressText(0.996)).toBe('>99%');
    expect(progressText(0.61)).toBe('61%');
    expect(progressText(1)).toBe('100%');
    expect(progressText(1.5)).toBe('150%');
  });

  test('percents, whole money, days and months', () => {
    expect(pct(0.04)).toBe('4%');
    expect(pct(0.035)).toBe('3.5%');
    expect(pct(0.0425)).toBe('4.25%');
    expect(wholeMoney(1234.56, 'USD')).toBe('$1,235');
    expect(wholeMoney(-0.4, null)).toBe('$0');
    expect(wholeMoney(1500, 'not a code')).toBe('$1,500'); // a code Intl refuses falls back
    expect(monthName('1965-11')).toBe('Nov 1965');
    expect(dayName('2025-10-07')).toBe('Oct 7, 2025');
  });

  test('the measured window, and a shorter one scaled up', () => {
    expect(windowText(flows)).toBe('your last 12 months of transactions (Oct 7, 2025 to Oct 6, 2026)');
    expect(windowText({ ...flows, scaled: true, days: 152, from: '2026-05-08' })).toBe(
      '5 months of transactions (May 8, 2026 to Oct 6, 2026), scaled up to a year'
    );
    expect(windowText({ ...flows, scaled: true, days: 360, from: '2025-10-12' })).toContain('360 days of transactions');
  });
});

describe('the FI card', () => {
  const card = (
    p: FirePlan,
    opts: {
      m?: Measured;
      f?: TrailingFlows | null;
      unread?: { institution: string | null; reason: string }[];
      txnsFailed?: boolean;
      a?: InvestedAssets;
      workplace?: WorkplaceSavings | null;
      workplaceCount?: number | null;
      currencyNote?: string | null;
    } = {}
  ) =>
    text(
      renderToStaticMarkup(
        <FiCard
          plan={p}
          view={fiView(p, opts.m ?? measured)}
          flows={opts.f === undefined ? flows : opts.f}
          unread={opts.unread ?? []}
          txnsLoading={false}
          txnsFailed={opts.txnsFailed ?? false}
          assets={opts.a ?? assets()}
          balancesAsOf="2026-10-06T15:12:00Z"
          workplace={opts.workplace === undefined ? noPlans : opts.workplace}
          workplaceCount={opts.workplaceCount === undefined ? 0 : opts.workplaceCount}
          currencyNote={opts.currencyNote ?? null}
          money={money}
          editable
          open={noop}
        />
      )
    );

  test('shows the FI number with the inputs it came from, and where each came from', () => {
    const t = card(plan());
    expect(t).toContain('$1,000,000');
    expect(t).toContain('$40,000 a year ÷ 4% withdrawal rate');
    expect(t).toContain('from your last 12 months of transactions (Oct 7, 2025 to Oct 6, 2026).');
    expect(t).toContain('from 2 investment accounts, balances as of');
    expect(t).toContain('an estimate: income minus spending over the same 12 months.');
    expect(t).toContain("Contributions taken from pay before it reaches a bank (a 401(k) Nya can't see, an employer's match) aren't in bank data.");
    expect(t).toContain('25% of the way');
  });

  test('says what the spending includes beyond the Activity tab: loan payments, cash, refunds taken off with the largest', () => {
    const t = card(plan(), {
      f: { ...flows, loanPayments: 18_000, cash: 1_200, refunds: 1_800, largestRefund: { amount: 1_500, date: '2026-02-01', name: 'Acme Rentals' }, unclearLoans: 400 },
    });
    expect(t).toContain(
      'Includes $18,000 of loan payments (principal counts as spending until the loan ends) and $1,200 of cash withdrawals, less $1,800 of refunds (the largest, $1,500 from Acme Rentals on Feb 1, 2026).'
    );
    expect(t).toContain("$400 of loan payments isn't counted: Plaid doesn't say it is a mortgage, car, student or personal loan");
  });

  test('a figure that may be short says so, beside it and on the FI number, naming the institution', () => {
    const t = card(plan(), { unread: [{ institution: 'Chase', reason: 'needs to be reconnected' }] });
    expect(t).toContain("Transactions from Chase couldn't all be read (the Activity tab says why), so this figure may be low.");
    expect(t).toContain("May be low: spending is missing transactions that couldn't be read");
    // Savings could be off either way: the missing rows could be income too.
    expect(t).toContain('so this figure may be off.');
    // A typed figure is not affected.
    expect(card(plan({ spending: 50_000, savings: 10_000 }), { unread: [{ institution: 'Chase', reason: 'x' }] })).not.toContain('May be low');
  });

  test('transactions that failed to load are said so, not "not enough"', () => {
    const t = card(plan(), { m: { spending: null, savings: null, assets: 250_000 }, f: null, txnsFailed: true });
    expect(t).toContain("your transactions couldn't be loaded");
    expect(t).not.toContain('not enough transactions');
  });

  test('balances that are old, missing or unreachable are named with their date', () => {
    const t = card(plan(), {
      a: assets({
        caveats: [
          { kind: 'unreachable', institution: 'Schwab' },
          { kind: 'stale', institution: 'Vanguard', asOf: '2026-10-03', at: null },
          { kind: 'missing', institution: 'Fidelity', count: 1 },
        ],
      }),
    });
    expect(t).toContain("Schwab couldn't be reached and isn't counted, so this figure may be low.");
    expect(t).toContain("Vanguard's balances are from Oct 3, 2026");
    expect(t).toContain("1 account at Fidelity couldn't be shown, so this figure may be low.");
    expect(t).toContain('Invested assets may be low');
  });

  test('savings say what was added for workplace plans, what was not and why, and what could not be measured', () => {
    const t = card(plan(), {
      workplaceCount: 4,
      workplace: {
        ...noPlans,
        total: 12_000,
        measured: ['Fidelity 401(k)'],
        added: [{ name: 'Fidelity 401(k)', amount: 12_000 }],
        matched: [{ name: 'Vanguard Solo 401(k)', amount: 10_000 }],
        fromBank: ['Schwab SEP'],
        partial: [{ name: 'Fidelity 401(k)', from: '2026-04-01' }],
        unmeasured: ['TSP TSP'],
      },
    });
    expect(t).toContain('over the same 12 months, plus $12,000 paid into Fidelity 401(k) through payroll.');
    expect(t).toContain('$10,000 paid into Vanguard Solo 401(k) matched transfers out of your accounts, which already count as saved, so it isn\'t added again.');
    expect(t).toContain('Schwab SEP is set as paid from your bank, so nothing paid into it is added again.');
    expect(t).toContain('If you pay into it from your bank account, turn off "Paid through payroll" for it under Edit, or it counts twice.');
    expect(t).toContain('Fidelity 401(k) is counted from Apr 1, 2026');
    expect(t).toContain("Contributions to TSP TSP couldn't be measured, so this figure may be low.");
    expect(card(plan(), { workplace: null, workplaceCount: null })).toContain('Checking contributions to workplace plans');
  });

  test('a currency mismatch is said beside the figures', () => {
    expect(card(plan(), { currencyNote: 'Your investments are in EUR and your spending in USD.' })).toContain('Your investments are in EUR and your spending in USD.');
  });

  test('progress just short of the target does not read 100%', () => {
    expect(card(plan(), { m: { ...measured, assets: 996_000 } })).toContain('>99% of the way');
  });

  test('a typed figure says so', () => {
    expect(card(plan({ spending: 60_000 }))).toContain('typed by you');
  });

  test('says what is missing instead of showing a zero', () => {
    const t = card(plan(), { m: { spending: null, savings: null, assets: null }, f: null, a: assets({ total: null, accounts: [] }) });
    expect(t).toContain('Needs your annual spending');
    expect(t).toContain('not enough transactions to measure from yet');
    expect(t).toContain('Needs your age and target age.');
    expect(t).not.toContain('$0');
  });

  test('Coast FI and the years to FI, with ages', () => {
    const t = card(plan({ age: 35, targetAge: 50 }));
    expect(t).toContain('grows to your FI number by age 50');
    expect(t).toMatch(/about \d+(\.\d)? years/);
    expect(t).toContain('Around age');
  });
});

describe('the caveat sentences', () => {
  test('name every institution once', () => {
    expect(
      unreadText(
        [
          { institution: 'Chase', reason: 'a' },
          { institution: 'Chase', reason: 'b' },
          { institution: 'Amex', reason: 'c' },
        ],
        'low'
      )
    ).toBe("Transactions from Chase and Amex couldn't all be read (the Activity tab says why), so this figure may be low.");
    expect(unreadText([{ institution: null, reason: 'Could not load transactions.' }], 'low')).toContain("Your latest transactions couldn't be loaded");
    expect(unreadText([], 'low')).toBeNull();
    expect(
      assetCaveatLines([
        { kind: 'unreachable', institution: 'A' },
        { kind: 'unreachable', institution: 'B' },
      ])
    ).toEqual(["A and B couldn't be reached and aren't counted, so this figure may be low."]);
  });
});

describe('the simulation card', () => {
  const us = usMarket();
  const render = (p: FirePlan, m = measured, opts: { pending?: boolean; noOutcome?: boolean; outcome?: Outcome } = {}) => {
    const view = fiView(p, m);
    const engine = enginePlan(p, view);
    const outcome = opts.outcome ?? ('sim' in engine && !opts.noOutcome ? { result: simulate(p.method, engine.sim, us) } : null);
    return renderToStaticMarkup(
      <SimulationCard
        plan={p}
        view={view}
        engine={engine}
        outcome={outcome}
        pending={opts.pending ?? false}
        money={money}
        currency="USD"
        editable
        onMethod={noop}
        onRetry={noop}
        open={noop}
      />
    );
  };
  const read = (p: FirePlan, m = measured, opts: { pending?: boolean; noOutcome?: boolean; outcome?: Outcome } = {}) => text(render(p, m, opts));

  test('the success rate with its definition, the hypothetical framing, the worst years and the assumptions', () => {
    const t = read(plan({ targetAge: 65, horizon: 30 }));
    expect(t).toContain('Retire at 65 with $1,000,000 (your FI number), withdrawing 4% of it, $40,000 a year after tax, your spending now, for 30 years (to age 95)');
    expect(t).toMatch(/9\d\.\d% of 1,470 historical starts \(Jan 1871 to Jun 1993\) lasted 30 years/);
    expect(t).toContain("Success: the portfolio never ran out. Every year's withdrawal was paid in full for all 30 years.");
    expect(t).toContain('Hypothetical, from US history: not a prediction, and not advice.');
    expect(t).toContain('Worst starting years');
    expect(t).toMatch(/(Nov|Oct|Dec|Jan) 196\d ran out in year \d+ \(age \d+\)/);
    expect(t).toContain('Withdrawals once a year, at the start of the year.');
    expect(t).toContain('Mix: 75% stocks, 25% bonds, 0% cash');
    expect(t).toContain('the S&P Composite (the S&P 500 since 1957)');
    expect(t).toContain('long-term US government bonds (10-year Treasuries since 1953)');
  });

  // Starting from what you have, the headline answers "could I stop now?".
  test('starting from your invested assets withdraws your spending, and says the rate that implies', () => {
    const t = read(plan({ age: 45, start: 'assets', horizon: 30 }), { spending: 60_000, savings: 10_000, assets: 600_000 });
    expect(t).toContain('Retire today, at 45, with $600,000 (your invested assets), spending what you spend now, $60,000 a year after tax');
    expect(t).toContain('That is a 10% withdrawal rate, above the 4% your FI number assumes.');
    // And the success rate is for that spending: a 10% rate rarely lasts 30 years.
    expect(t).toMatch(/\b\d{1,2}(\.\d)?% of 1,470 historical starts/);
    expect(t).not.toMatch(/\b9\d(\.\d)?% of 1,470/);
  });

  test('Monte Carlo says how it was made', () => {
    const t = read(plan({ method: 'monte-carlo', horizon: 30 }));
    expect(t).toContain('of 5,000 Monte Carlo runs lasted 30 years');
    expect(t).toContain('5,000 runs, each built from 5-year blocks');
    expect(t).toContain('seed 1');
    expect(t).not.toContain('Worst starting years');
  });

  test('a flexible rule shows how far spending fell beside the success rate', () => {
    const t = read(plan({ rule: 'guardrails', horizon: 30 }));
    expect(t).toMatch(/\d+% of the first year's spending in the lowest year, in the worst start that lasted \(\w{3} \d{4}\): \$[\d,]+ against \$40,000/);
    expect(t).toContain('This rule lasts by cutting spending when markets fall; the second figure is how far.');
    expect(read(plan({ rule: 'percent', horizon: 30 }))).toContain('it cannot run out');
    expect(read(plan({ horizon: 30 }))).not.toContain("of the first year's spending in the lowest year");
  });

  test('VPW sets its own spending, and says how it compares with yours', () => {
    const t = read(plan({ rule: 'vpw', horizon: 30 }));
    expect(t).toContain("VPW sets each year's spending from the balance and the years left.");
    expect(t).toMatch(/Its first year spends \$[\d,]+ after tax, against the \$40,000 you spend now/);
  });

  test('a new answer being worked out keeps the last one, dimmed; the first shows a placeholder', () => {
    expect(render(plan({ horizon: 30 }), measured, { pending: true })).toContain('plan-result-pending');
    expect(render(plan({ horizon: 30 }))).not.toContain('plan-result-pending');
    expect(read(plan({ horizon: 30 }), measured, { noOutcome: true })).toContain('Working it out');
  });

  test('a simulation that could not be run says so and offers to try again; a refused plan says why', () => {
    const t = read(plan({ horizon: 30 }), measured, { outcome: { error: 'Failed to load chunk', unavailable: true } });
    expect(t).toContain("The simulation couldn't be loaded. It needs a connection the first time it runs after an update.");
    expect(t).toContain('Try again');
    expect(t).not.toContain("This plan can't be simulated");
    const refused = read(plan({ horizon: 30 }), measured, { outcome: { error: 'a plan runs 1 to 60 years' } });
    expect(refused).toContain("This plan can't be simulated: a plan runs 1 to 60 years.");
    expect(refused).not.toContain('Try again');
  });

  test('explains what is missing instead of simulating nothing', () => {
    expect(read(plan(), { spending: null, savings: null, assets: null })).toContain('withdraws your annual spending, so it needs it');
    expect(read(plan({ start: 'assets' }), { spending: 40_000, savings: null, assets: null })).toContain('none to count yet');
  });
});

describe('the grid', () => {
  const cell = (rate: number, years: number, successRate: number, low = 1) => ({
    rate,
    years,
    successRate,
    lowestSpendingShare: low,
    paths: 1470,
    firstStart: '1871-01',
    lastStart: '1993-06',
  });

  test('never shows a rate that rounds to 100% as 100%, outlines the plan, and says where its starts end', () => {
    const html = renderToStaticMarkup(
      <PlanGrid
        cells={[cell(0.04, 30, 0.999), cell(0.05, 30, 0.8)]}
        rates={[0.04, 0.05]}
        horizons={[30, 40]}
        current={{ rate: 0.04, years: 30 }}
        flexible={false}
        pathsNoun="starts"
      />
    );
    expect(text(html)).toContain('>99%');
    expect(html).toContain('80%');
    expect(html).toContain('plan-grid-cell own');
    expect(html).toContain('4% for 30 years: 99.9% of 1,470 starts lasted');
    expect(html).toContain('to 1993');
    expect(html).toContain('1,470 starts, 1871-01 to 1993-06');
    // A cell still being worked out says so rather than showing a number.
    expect(html).toContain('4% for 40 years: working it out');
    expect(html).not.toContain('plan-grid-low');
  });

  test('a cell that could not be worked out says so, rather than waiting forever', () => {
    const html = renderToStaticMarkup(
      <PlanGrid
        cells={[cell(0.04, 30, 0.97)]}
        failed={[{ rate: 0.05, years: 30 }]}
        rates={[0.04, 0.05]}
        horizons={[30]}
        current={{ rate: 0.04, years: 30 }}
        flexible={false}
        pathsNoun="starts"
      />
    );
    expect(html).toContain("5% for 30 years: couldn&#x27;t be worked out");
    expect(html).not.toContain('working it out');
    const p = plan({ horizon: 30 });
    const t = text(
      renderToStaticMarkup(
        <GridCard
          plan={p}
          cells={[cell(0.04, 30, 0.97)]}
          failed={[{ rate: 0.05, years: 30 }]}
          unavailable
          onRetry={noop}
          rates={[0.04, 0.05]}
          years={[30]}
          current={{ rate: 0.04, years: 30 }}
          startBalance={1_000_000}
          money={money}
        />
      )
    );
    expect(t).toContain("One cell couldn't be worked out: the simulation couldn't be loaded, which needs a connection the first time after an update.");
    expect(t).toContain('Try again');
  });

  test("a flexible rule's cells carry how far spending fell", () => {
    const html = renderToStaticMarkup(
      <PlanGrid cells={[cell(0.04, 30, 1, 0.42)]} rates={[0.04]} horizons={[30]} current={{ rate: 0.04, years: 30 }} flexible pathsNoun="starts" />
    );
    expect(html).toContain('low 42%');
    expect(html).toContain("the lowest year&#x27;s spending was 42% of the first year&#x27;s");
  });

  test('the card works the grid out for the plan, with each column’s starts named', () => {
    const p = plan({ horizon: 30 });
    const e = enginePlan(p, fiView(p, measured)) as { sim: any };
    const cells = successGrid('historical', e.sim, usMarket(), [0.03, 0.04], [30, 50]);
    const t = text(
      renderToStaticMarkup(
        <GridCard plan={p} cells={cells} rates={[0.03, 0.04]} years={[30, 50]} current={{ rate: 0.04, years: 30 }} startBalance={e.sim.startBalance} money={money} />
      )
    );
    expect(t).toContain('The share of starts that lasted, each starting with $1,000,000');
    expect(t).toContain('30 years, 1,470 starts over 123 years (to Jun 1993); 50 years, 1,230 starts over 103 years (to Jun 1973)');
    expect(t).toContain('which is why it can read safer than a shorter one');
  });

  test('VPW gets one row, by length', () => {
    const p = plan({ rule: 'vpw', horizon: 30 });
    const e = enginePlan(p, fiView(p, measured)) as { sim: any };
    const cells = successGrid('historical', e.sim, usMarket(), [], [30]);
    expect(cells).toHaveLength(1);
    expect(cells[0].rate).toBeNull();
    const t = text(
      renderToStaticMarkup(<GridCard plan={p} cells={cells} rates={[null]} years={[30]} current={{ rate: null, years: 30 }} startBalance={1} money={money} />)
    );
    expect(t).toContain('VPW has no withdrawal rate to vary');
    expect(t).toMatch(/VPW 100% low \d+%/);
  });
});

describe('the fan chart', () => {
  test('draws the bands and the median, with a table of the same figures', () => {
    const bands = { p10: [100, 80, 0], p25: [100, 90, 50], p50: [100, 105, 110], p75: [100, 120, 150], p90: [100, 140, 200] };
    const html = renderToStaticMarkup(<PlanFanChart bands={bands} startAge={60} currency="USD" />);
    expect(html.match(/<path /g)).toHaveLength(3);
    expect(text(html)).toContain('Median $110');
    expect(text(html)).toContain('at the end (age 62) · middle 80%: $0 to $200');
    expect(text(html)).toContain('Show as a table');
    expect(html).toContain('<td>62</td>');
  });
});

describe('income and one-offs', () => {
  test('lists them, and says when one is left out of the simulation or comes after it', () => {
    const p = plan({
      income: [{ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true }],
      expenses: [{ id: 'roof', label: 'Roof', amount: 30_000, atAge: 60 }],
    });
    const t = text(renderToStaticMarkup(<EventsCard plan={p} engine={enginePlan(p, fiView(p, measured))} money={money} editable open={noop} />));
    expect(t).toContain('Social Security $24,000 a year from age 67, after tax, rises with inflation. Not in the simulation: add your age.');
    expect(t).toContain('Roof $30,000 at age 60. Not in the simulation');
    const aged = plan({ ...p, targetAge: 50, horizon: 5 });
    const late = text(renderToStaticMarkup(<EventsCard plan={aged} engine={enginePlan(aged, fiView(aged, measured))} money={money} editable open={noop} />));
    expect(late).toContain("Roof $30,000 at age 60. After the plan ends at 55: only the grid's longer columns reach it.");
  });
});

describe('the savings sheet', () => {
  test('gives each workplace plan a "Paid through payroll" switch, on unless the plan says otherwise, and says when to turn it off', () => {
    const html = renderToStaticMarkup(
      <FigureForm
        plan={plan({ bankFunded: ['solo'] })}
        onSave={async () => true}
        onDone={noop}
        editable
        kind="savings"
        measured={30_000}
        measuredText="from your last 12 months"
        currency="USD"
        workplacePlans={[
          { account_id: 'k', label: 'Fidelity 401(k)' },
          { account_id: 'solo', label: 'Vanguard Solo 401(k)' },
        ]}
      />
    );
    const t = text(html);
    expect(t).toContain('Turn "Paid through payroll" off for a plan you pay into from your bank account');
    expect(t).toContain('Fidelity 401(k): paid through payroll');
    expect(t).toContain('Vanguard Solo 401(k): paid through payroll');
    // Checked for the 401(k), not for the plan set as paid from the bank.
    expect(html.match(/<input type="checkbox"[^>]*>/g)!.map((i) => i.includes('checked'))).toEqual([true, false]);
  });
});

describe('the tab', () => {
  test('shows a spinner until the saved plan has loaded, never the defaults as if they were saved', () => {
    const html = renderToStaticMarkup(<PlanTab txns={[]} txnsLoading={false} txnNotes={[]} institutions={[]} balancesAsOf={null} currency="USD" />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('FI number');
  });
});

describe('loading the tab', () => {
  test('a failed import is forgotten, so trying again imports again', async () => {
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('chunk failed'));
    };
    await expect(loadPlanTab(failing)).rejects.toThrow('chunk failed');
    await expect(loadPlanTab(failing)).rejects.toThrow('chunk failed');
    expect(calls).toBe(2);
    const mod = await loadPlanTab(() => import('@/components/PlanTab'));
    expect(typeof mod.default).toBe('function');
    // Once loaded, it is kept.
    expect(await loadPlanTab(failing)).toBe(mod);
    expect(calls).toBe(2);
  });

  test('says what happened, keeps the other tabs, and offers to try again', () => {
    const load = text(renderToStaticMarkup(<PlanUnavailable reason="load" onRetry={noop} />));
    expect(load).toContain(
      "The Plan tab couldn't be loaded. It needs a connection the first time it opens after an update. The other tabs work as before."
    );
    expect(load).toContain('Try again');
    expect(load).toContain('Reload the page');
    expect(text(renderToStaticMarkup(<PlanUnavailable reason="crash" onRetry={noop} />))).toContain('ran into a problem and stopped');
  });
});
