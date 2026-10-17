// lib/fire/fi.ts
//
// The deterministic FI view: what you need, when you get there, and the Coast
// and Barista variants. Plain arithmetic on spending, savings and ONE assumed
// real return, with no market history; the simulator (lib/fire/simulate.ts)
// is where the history comes in.
//
// Everything is in today's dollars ("real"): the return is after inflation,
// so spending never needs raising for it. Savings are added at the end of
// each year.
//
// Imports nothing: the Plan tab runs this in the browser.

function checkRate(name: string, v: number, min: number, max: number): void {
  if (!(v >= min && v <= max)) throw new RangeError(`${name} must be between ${min} and ${max}, got ${v}`);
}

/**
 * The portfolio that supports a year's spending at a withdrawal rate:
 * spending / rate. With a flat tax on withdrawals, each dollar withdrawn
 * leaves (1 - tax) to spend, so the withdrawals, and the portfolio behind
 * them, are larger by 1 / (1 - tax).
 */
export function fiNumber(annualSpending: number, withdrawalRate: number, taxRate = 0): number {
  checkRate('withdrawal rate', withdrawalRate, 1e-6, 1);
  checkRate('tax rate', taxRate, 0, 0.99);
  return Math.max(0, annualSpending) / (1 - taxRate) / withdrawalRate;
}

/**
 * Barista FI: the portfolio needed when part-time income covers part of the
 * spending, so the portfolio only has to cover the rest. The income is after
 * tax, like the spending it covers.
 */
export function baristaFiNumber(annualSpending: number, partTimeIncome: number, withdrawalRate: number, taxRate = 0): number {
  return fiNumber(Math.max(0, annualSpending - Math.max(0, partTimeIncome)), withdrawalRate, taxRate);
}

/**
 * Invested assets after `years`, saving `savings` at the end of each year
 * and earning `realReturn` on everything: B(n) = A(1+g)^n + C((1+g)^n - 1)/g.
 */
export function projectBalance(assets: number, savings: number, realReturn: number, years: number): number {
  checkRate('real return', realReturn, -0.99, 1);
  const g = realReturn;
  if (Math.abs(g) < 1e-12) return assets + savings * years;
  const growth = (1 + g) ** years;
  return assets * growth + (savings * (growth - 1)) / g;
}

/**
 * Years until invested assets reach a target, saving a fixed amount at the
 * end of each year at a fixed real return. 0 when already there, Infinity
 * when the balance never gets there (no savings and no growth, savings that
 * run it down, or a negative return that holds it below the target).
 *
 * Solves projectBalance(...) = target for the number of years, which can
 * fall between whole years: (1+g)^n = (T + C/g) / (A + C/g). Exact at whole
 * years; between them it is a smooth estimate (savings really arrive once a
 * year), close enough for "about 12 years".
 */
export function yearsToTarget(assets: number, savings: number, realReturn: number, target: number): number {
  checkRate('real return', realReturn, -0.99, 1);
  if (assets >= target) return 0;
  const g = realReturn;
  if (Math.abs(g) < 1e-12) return savings > 0 ? (target - assets) / savings : Infinity;
  // Shifting by C/g turns the balance into plain compounding: B(n) + C/g =
  // (A + C/g)(1+g)^n. The target is reached only if that grows the right way,
  // which the ratio's sign and the log's sign below decide together (see
  // test/fire-engine.test.ts for each case).
  const k = savings / g;
  const ratio = (target + k) / (assets + k);
  if (!(ratio > 0) || !Number.isFinite(ratio)) return Infinity;
  const n = Math.log(ratio) / Math.log(1 + g);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

/**
 * Coast FI: what invested today grows, with nothing more added, to `target`
 * in `years` at a real return. Having it means the rest of your savings are
 * optional, as long as the return holds.
 */
export function coastFiNumber(target: number, realReturn: number, years: number): number {
  checkRate('real return', realReturn, -0.99, 1);
  return Math.max(0, target) / (1 + realReturn) ** Math.max(0, years);
}
