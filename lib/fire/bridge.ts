// lib/fire/bridge.ts
//
// The stress test in the detailed tax model, until T5 puts the tax year inside the
// engine: the flat engine, at the tax share `t` and the yearly health cost `h` the
// steady drawdown worked out (lib/fire/drawdown.ts).
//
//   - The rule covers spending and health: `rate = (S + h) / (1 - t) / start`.
//   - Each year's health differs from `h` by a one-off (more) or a lower cost
//     (less), so health counts once. Past the drawdown's last year, its last
//     difference holds, as the grid's longer columns run on.
//   - All income goes in at `gross * (1 - t)`, before tax, after tax and windfalls
//     alike. The engine divides what a year needs by `1 - t`, so a dollar of income
//     takes a whole dollar off what is withdrawn, as it does in the drawdown, where
//     `t` is a share of everything paid. An after-tax amount left as it is would
//     end high.
//   - A year with money to spare invests it divided by `1 - t` too (SimPlan's
//     `bridged`), or `t` of every surplus would be lost.
//
// On a steady market at the drawdown's own inflation this ends where the drawdown
// ends, to the dollar (test/drawdown-bridge.test.ts). `spend < h` inside a run
// waits for T5, and About these numbers says so.
//
// Arithmetic only: the Plan tab runs this in the browser.

import type { CompiledItems } from './compile';
import type { Drawdown } from './drawdown';
import { ruleSpec, type EnginePlan, type PlanCore } from './plan';
import { MAX_YEARS, type ConditionalFlows, type LowerSpending, type OneOffExpense } from './simulate';

/** Differences in a year's health under this aren't worth a flow. */
const CENT = 0.005;

/**
 * The plan's engine at `start`'s tax share and health cost. A start of nothing
 * runs the flat plan: there is no rate to divide out. `fixed` holds the parts the
 * engine runs as fixed, compiled at the engine's start age; `conditional`, what
 * waits on a run's own balance, compiled at `t` (compile.ts conditionalFlows).
 */
export function bridgedEngine(plan: PlanCore, engine: EnginePlan, start: Drawdown, fixed: Pick<CompiledItems, 'incomeBy'>, conditional: ConditionalFlows | undefined): EnginePlan {
  const { sim, startAge } = engine;
  if (!(sim.startBalance > 0) || start.years.length === 0 || startAge === null) return engine;
  const keep = 1 - start.t;
  const income = fixed.incomeBy.map((r) => ({ amount: r.gross * keep, fromYear: r.fromYear, inflationAdjusted: r.inflationAdjusted, ...(r.toYear !== undefined ? { toYear: r.toYear } : {}) }));
  const oneOffs: OneOffExpense[] = [...sim.oneOffs];
  const lowerSpending: LowerSpending[] = [...(sim.lowerSpending ?? [])];
  const first = start.years[0].age;
  for (let y = 0; y < MAX_YEARS; y++) {
    // A run may start before today, once the stop has passed: those years have
    // no drawdown of their own, so nothing differs from `h`.
    const i = startAge + y - first;
    if (i < 0) continue;
    const difference = start.years[Math.min(i, start.years.length - 1)].health - start.h;
    if (difference > CENT) oneOffs.push({ amount: difference, year: y });
    else if (difference < -CENT) lowerSpending.push({ amount: -difference, fromYear: y, toYear: y + 1 });
  }
  const { conditional: _flat, ...rest } = sim;
  return {
    ...engine,
    rate: start.rate,
    rateFrom: 'spending',
    sim: { ...rest, taxRate: start.t, rule: ruleSpec(plan, start.rate), income, oneOffs, lowerSpending, bridged: true, ...(conditional ? { conditional } : {}) },
  };
}
