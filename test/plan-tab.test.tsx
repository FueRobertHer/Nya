import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PlanTab, { EventsCard, FiCard, GridCard, SimulationCard } from '@/components/PlanTab';
import PlanFanChart from '@/components/PlanFanChart';
import PlanGrid from '@/components/PlanGrid';
import { monthName, pct, successText, wholeMoney } from '@/components/plan-text';
import { DEFAULT_PLAN, enginePlan, fiView, type FirePlan, type Measured } from '@/lib/fire/plan';
import { simulate, successGrid } from '@/lib/fire/simulate';
import { usMarket } from '@/lib/fire/us-market';
import type { TrailingFlows } from '@/lib/fire/inputs';

const noop = () => {};
const money = (n: number) => wholeMoney(n, 'USD');
const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const flows: TrailingFlows = {
  spending: 40_000,
  income: 70_000,
  savings: 30_000,
  from: '2025-10-07',
  to: '2026-10-06',
  days: 365,
  scaled: false,
  count: 400,
  currency: 'USD',
  mixedCurrency: false,
};
const measured: Measured = { spending: 40_000, savings: 30_000, assets: 250_000 };

/** Markup as text, tags dropped and entities decoded, for reading sentences. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
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

  test('percents, whole money and months', () => {
    expect(pct(0.04)).toBe('4%');
    expect(pct(0.035)).toBe('3.5%');
    expect(pct(0.0425)).toBe('4.25%');
    expect(wholeMoney(1234.56, 'USD')).toBe('$1,235');
    expect(wholeMoney(-0.4, null)).toBe('$0');
    expect(wholeMoney(1500, 'not a code')).toBe('$1,500'); // a code Intl refuses falls back
    expect(monthName('1965-11')).toBe('Nov 1965');
  });
});

describe('the FI card', () => {
  const card = (p: FirePlan, m = measured, f: TrailingFlows | null = flows) =>
    text(
      renderToStaticMarkup(
        <FiCard plan={p} view={fiView(p, m)} flows={f} assetsCount={2} unknownAssets={0} txnsLoading={false} mixedCurrency={false} money={money} editable open={noop} />
      )
    );

  test('shows the FI number with the inputs it came from, and where each came from', () => {
    const t = card(plan());
    expect(t).toContain('$1,000,000');
    expect(t).toContain('$40,000 a year ÷ 4% withdrawal rate');
    expect(t).toContain('from your last 12 months of transactions');
    expect(t).toContain('from 2 investment accounts');
    expect(t).toContain("an estimate: income minus spending over your last 12 months of transactions. Pre-tax 401(k) contributions and an employer match aren't in bank data");
    expect(t).toContain('25% of the way');
  });

  test('a typed figure says so, and a shorter history says it was scaled', () => {
    expect(card(plan({ spending: 60_000 }))).toContain('typed by you');
    expect(card(plan(), measured, { ...flows, scaled: true, days: 152 })).toContain('from 5 months of transactions, scaled to a year');
  });

  test('says what is missing instead of showing a zero', () => {
    const t = card(plan(), { spending: null, savings: null, assets: null }, null);
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

describe('the simulation card', () => {
  const us = usMarket();
  const render = (p: FirePlan, m = measured) => {
    const view = fiView(p, m);
    const engine = enginePlan(p, view);
    const outcome = 'sim' in engine ? { result: simulate(p.method, engine.sim, us) } : null;
    return text(renderToStaticMarkup(<SimulationCard plan={p} engine={engine} outcome={outcome} money={money} currency="USD" editable onMethod={noop} open={noop} />));
  };

  test('the success rate with its definition, the hypothetical framing, the worst years and the assumptions', () => {
    const t = render(plan({ targetAge: 65, horizon: 30 }));
    expect(t).toContain('Retire at 65 with $1,000,000 (your FI number), spending $40,000 after tax in the first year, for 30 years (to age 95)');
    expect(t).toMatch(/9\d\.\d% of 1,470 historical starts \(Jan 1871 to Jun 1993\) lasted 30 years/);
    expect(t).toContain("Success: the portfolio never ran out. Every year's withdrawal was paid in full for all 30 years.");
    expect(t).toContain('Hypothetical, from US history: not a prediction, and not advice.');
    expect(t).toContain('Worst starting years');
    expect(t).toMatch(/(Nov|Oct|Dec|Jan) 196\d ran out in year \d+ \(age \d+\)/);
    expect(t).toContain('Withdrawals once a year, at the start of the year.');
    expect(t).toContain('Mix: 75% stocks, 25% bonds, 0% cash');
  });

  test('Monte Carlo says how it was made', () => {
    const t = render(plan({ method: 'monte-carlo', horizon: 30 }));
    expect(t).toContain('of 5,000 Monte Carlo runs lasted 30 years');
    expect(t).toContain('5,000 runs, each built from 5-year blocks');
    expect(t).toContain('seed 1');
    expect(t).not.toContain('Worst starting years');
  });

  test('a flexible rule reports how far spending fell', () => {
    const t = render(plan({ rule: 'percent', horizon: 30 }));
    expect(t).toContain('it cannot run out');
    expect(t).toMatch(/the lowest year was \$[\d,]+, \d+% of the first year's/);
  });

  test('explains what is missing instead of simulating nothing', () => {
    expect(render(plan(), { spending: null, savings: null, assets: null })).toContain('needs your annual spending');
  });
});

describe('the grid', () => {
  test('never shows a rate that rounds to 100% as 100%, and outlines the plan', () => {
    const html = renderToStaticMarkup(
      <PlanGrid
        cells={[
          { rate: 0.04, years: 30, successRate: 0.999, lowestSpendingShare: 1, paths: 1470 },
          { rate: 0.05, years: 30, successRate: 0.8, lowestSpendingShare: 1, paths: 1470 },
        ]}
        rates={[0.04, 0.05]}
        horizons={[30, 40]}
        current={{ rate: 0.04, years: 30 }}
        metric="success"
        pathsNoun="starts"
      />
    );
    expect(html).toContain('&gt;99%');
    expect(html).toContain('80%');
    expect(html).toContain('plan-grid-cell own');
    expect(html).toContain('4% for 30 years: 99.9% of 1,470 starts lasted');
    // A cell still being worked out says so rather than showing a number.
    expect(html).toContain('4% for 40 years: working it out');
  });

  test('the card works the grid out for the plan, and has nothing to vary for VPW', () => {
    const p = plan({ horizon: 30 });
    const sim = (enginePlan(p, fiView(p, measured)) as { sim: any }).sim;
    const cells = successGrid('historical', sim, usMarket(), [0.03, 0.04], [30]);
    const t = text(renderToStaticMarkup(<GridCard plan={p} cells={cells} rates={[0.03, 0.04]} years={[30]} ownYears={30} startBalance={sim.startBalance} money={money} />));
    expect(t).toContain('The share of starts that lasted, each starting with $1,000,000');
    expect(t).toContain('100%');
    const vpw = text(renderToStaticMarkup(<GridCard plan={plan({ rule: 'vpw' })} cells={null} rates={[]} years={[]} ownYears={30} startBalance={1} money={money} />));
    expect(vpw).toContain('VPW has no withdrawal rate to vary');
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
  test('lists them, and says when one is left out of the simulation', () => {
    const p = plan({
      income: [{ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true }],
      expenses: [{ id: 'roof', label: 'Roof', amount: 30_000, atAge: 60 }],
    });
    const t = text(renderToStaticMarkup(<EventsCard plan={p} engine={enginePlan(p, fiView(p, measured))} money={money} editable open={noop} />));
    expect(t).toContain('Social Security $24,000 a year from age 67, after tax, rises with inflation. Not in the simulation: add your age.');
    expect(t).toContain('Roof $30,000 at age 60. Not in the simulation');
  });
});

describe('the tab', () => {
  test('shows a spinner until the saved plan has loaded, never the defaults as if they were saved', () => {
    const html = renderToStaticMarkup(<PlanTab txns={[]} txnsLoading={false} accounts={[]} currency="USD" />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('FI number');
  });
});
