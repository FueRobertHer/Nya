import { describe, expect, test } from 'bun:test';
import {
  HORIZON_MONTHS,
  MAX_APR,
  addMonths,
  blindSpots,
  byCurrency,
  comparePlans,
  coversInterest,
  debtAccounts,
  debtProblem,
  durationLabel,
  firstInterestCents,
  parseApr,
  parseCents,
  planRows,
  resolveApr,
  resolveMinimum,
  scheduledPaymentCents,
  simulate,
  splitByWeight,
  termMonths,
  toCents,
  type Debt,
  type DebtAccount,
  type DebtInstitutionInput,
  type PlanChoices,
  type Plan,
} from '@/lib/payoff';
import { normalizeLiabilities } from '@/lib/liabilities';
import { toInstitutions, type ManualAccount } from '@/lib/manual';

const START = '2026-10';
const debt = (id: string, balance: number, apr: number, minimum: number): Debt => ({
  id,
  balanceCents: toCents(balance),
  apr,
  minimumCents: toCents(minimum),
});
const run = (debts: Debt[], kind: Plan['kind'], extra = 0, horizon?: number) =>
  simulate(debts, kind, { startMonth: START, extraCents: toCents(extra), horizon });
const ids = (p: Plan) => p.debts.map((d) => d.id);
const outcome = (p: Plan, id: string) => p.debts.find((d) => d.id === id)!;

/**
 * The textbook schedule for repaying B at a monthly rate r with a payment P, in
 * exact (real-number) arithmetic: n = -ln(1 - rB/P) / ln(1 + r) payments, the
 * last a partial one, and the interest that costs.
 */
function closedForm(B: number, r: number, P: number) {
  const n = -Math.log(1 - (r * B) / P) / Math.log(1 + r);
  const full = Math.floor(n);
  const grown = Math.pow(1 + r, full);
  const owedAfterFull = B * grown - (P * (grown - 1)) / r;
  const finalPayment = owedAfterFull * (1 + r);
  return { n, months: full + 1, interest: full * P + finalPayment - B, finalPayment };
}

/**
 * How far the cents simulation can drift from the exact schedule over `months`
 * months, in cents. Each month's interest is rounded by at most half a cent, and
 * an error made in month i is carried, with interest, into every later month, so
 * the total can be off by at most 0.5 × (1 + r)^0 + ... + 0.5 × (1 + r)^(months-1).
 */
function driftBound(r: number, months: number): number {
  return (0.5 * (Math.pow(1 + r, months) - 1)) / r;
}

describe('a single loan against the closed-form amortization formula', () => {
  const cases = [
    { name: 'a $10,000 loan at 6% paying $200', B: 10_000, apr: 6, P: 200 },
    { name: 'a $200,000 mortgage at 6% paying $1,200', B: 200_000, apr: 6, P: 1_200 },
    { name: 'a $5,000 card at 19.99% paying $150', B: 5_000, apr: 19.99, P: 150 },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const r = c.apr / 100 / 12;
      const exact = closedForm(c.B, r, c.P);
      const plan = run([debt('loan', c.B, c.apr, c.P)], 'minimums');
      // n is never a whole number in these cases, and its last payment is far from
      // both 0 and P, so rounding cannot move the month count.
      expect(plan.months).toBe(Math.ceil(exact.n));
      expect(plan.months).toBe(exact.months);
      expect(Math.abs(plan.interestCents! - exact.interest * 100)).toBeLessThanOrEqual(driftBound(r, exact.months));
      // Every payment but the last is the full one; the last is what was left.
      expect(plan.paidByMonth.slice(0, -1).every((p) => p === toCents(c.P))).toBe(true);
      expect(Math.abs(plan.paidByMonth.at(-1)! - exact.finalPayment * 100)).toBeLessThanOrEqual(driftBound(r, exact.months));
    });
  }

  test('the $10,000 loan, to the cent: 58 payments, the last $136.16, $1,536.16 of interest', () => {
    // Pinned so a change to the rounding convention shows up as a diff, not a
    // drift. The exact schedule is $136.14 and $1,536.14: two cents of rounding
    // over 58 months, well inside driftBound.
    const plan = run([debt('loan', 10_000, 6, 200)], 'minimums');
    expect(plan.months).toBe(58);
    expect(plan.paidByMonth.at(-1)).toBe(13616);
    expect(plan.interestCents).toBe(153616);
    expect(plan.paidCents).toBe(1_000_000 + 153616);
    expect(plan.month).toBe('2031-08'); // 58 months after October 2026
  });

  test('the payment formula: a payment rounded up to the cent repays a 60-month loan in 60 months', () => {
    const B = 20_000;
    const r = 4.8 / 100 / 12;
    const payment = Math.ceil(((r * B) / (1 - Math.pow(1 + r, -60))) * 100) / 100;
    expect(payment).toBe(375.6);
    const plan = run([debt('car', B, 4.8, payment)], 'minimums');
    expect(plan.months).toBe(60);
    expect(plan.paidByMonth.at(-1)!).toBeLessThan(toCents(payment));
  });
});

describe('the strategies', () => {
  // Zero rates, so every figure can be checked by hand.
  const small = debt('small', 100, 0, 50);
  const big = debt('big', 1_000, 0, 50);

  test('paying only the minimums: each debt gets its own payment, and a cleared one stops', () => {
    const p = run([small, big], 'minimums');
    expect(outcome(p, 'small').months).toBe(2);
    expect(outcome(p, 'big').months).toBe(20);
    expect(p.months).toBe(20);
    expect(p.monthlyCents).toBe(10000);
    expect(p.paidByMonth.slice(0, 2)).toEqual([10000, 10000]);
    expect(p.paidByMonth.slice(2).every((x) => x === 5000)).toBe(true);
  });

  test("a cleared debt's payment rolls into the next one", () => {
    const p = run([small, big], 'snowball');
    expect(outcome(p, 'small').months).toBe(2);
    // From month 3 the big debt gets both payments: 1,000 - 2 × 50 = 900 left
    // at $100 a month is 9 more months.
    expect(outcome(p, 'big').months).toBe(11);
    expect(p.paidByMonth.every((x) => x === 10000)).toBe(true);
    expect(p.months).toBe(11);
  });

  test("a final partial payment's leftover goes to the next debt the same month", () => {
    const p = run([debt('small', 75, 0, 50), big], 'snowball');
    // Month 2: small takes its last $25, and the other $25 of its payment joins
    // big's own $50.
    expect(p.owedByMonth.slice(0, 3)).toEqual([107500, 97500, 87500]);
    expect(p.paidByMonth.every((x, i, all) => x === 10000 || i === all.length - 1)).toBe(true);
  });

  test('the extra goes to the target, on top of every payment', () => {
    const p = run([small, big], 'snowball', 100);
    expect(p.monthlyCents).toBe(20000);
    // Month 1: small gets $50 + $100 (it only needs $100), the rest to big.
    expect(outcome(p, 'small').months).toBe(1);
    expect(p.owedByMonth[1]).toBe(110000 - 20000);
  });

  test('the savings against minimums only, in months and interest', () => {
    const c = comparePlans([small, big], { startMonth: START });
    expect(c.minimums.months).toBe(20);
    expect(c.snowball.months).toBe(11);
    expect(c.snowball.saved).toEqual({ interestCents: 0, months: 9 });
    expect(c.snowball.month).toBe(addMonths(START, 11));
  });

  // A known example worked by hand for the first months.
  const card = debt('card', 2_000, 24.99, 60);
  const store = debt('store', 500, 15, 25);
  const car = debt('car', 8_000, 6, 250);

  test('avalanche pays the highest rate first, snowball the smallest balance', () => {
    const c = comparePlans([car, store, card], { startMonth: START, extraCents: toCents(200) });
    expect(ids(c.avalanche)).toEqual(['card', 'store', 'car']);
    expect(ids(c.snowball)).toEqual(['store', 'card', 'car']);
    expect(c.avalanche.monthlyCents).toBe(toCents(60 + 25 + 250 + 200));
    expect(c.snowball.monthlyCents).toBe(c.avalanche.monthlyCents);
    // The point of the avalanche.
    expect(c.avalanche.interestCents!).toBeLessThan(c.snowball.interestCents!);
    expect(c.avalanche.months!).toBeLessThanOrEqual(c.snowball.months!);
  });

  test('the first months, by hand', () => {
    // Month 1 interest: card 200,000 × 24.99% / 12 = 4,165¢, store 625¢, car 4,000¢.
    // Both strategies pay $535 in total, so the total owed after month 1 matches.
    const a = run([card, store, car], 'avalanche', 200);
    const s = run([card, store, car], 'snowball', 200);
    expect(a.owedByMonth[1]).toBe(1_050_000 + 4165 + 625 + 4000 - 53500);
    expect(s.owedByMonth[1]).toBe(a.owedByMonth[1]);
    // Snowball: the store card gets $225 a month. After month 1 it owes 28,125¢;
    // month 2 adds 352¢ (351.5625 rounded) and leaves 5,977¢; month 3 adds 75¢
    // (74.7125) and clears it with 6,052¢, the rest of that month's $535 going
    // to the card.
    const st = outcome(s, 'store');
    expect(st.months).toBe(3);
    expect(st.interestCents).toBe(625 + 352 + 75);
    expect(st.paidCents).toBe(50000 + 625 + 352 + 75);
  });

  test('ties: the avalanche takes the smaller balance, the snowball the higher rate', () => {
    const a = run([debt('x', 900, 20, 30), debt('y', 300, 20, 30)], 'avalanche', 100);
    expect(ids(a)[0]).toBe('y');
    const s = run([debt('x', 300, 10, 30), debt('y', 300, 20, 30)], 'snowball', 100);
    expect(ids(s)[0]).toBe('y');
  });
});

describe('payments that never clear a debt', () => {
  test('a minimum below the interest never pays off, and says so instead of looping', () => {
    const d = debt('card', 10_000, 24, 150); // $200 interest a month
    expect(coversInterest(d)).toBe(false);
    expect(firstInterestCents(d)).toBe(20000);
    const p = run([d], 'minimums');
    expect(p.months).toBeNull();
    expect(p.month).toBeNull();
    expect(p.interestCents).toBeNull();
    expect(p.paidCents).toBeNull();
    expect(outcome(p, 'card')).toMatchObject({ months: null, month: null, interestCents: null });
    expect(outcome(p, 'card').remainingCents).toBeGreaterThan(d.balanceCents);
    // Followed to the horizon and no further.
    expect(p.paidByMonth).toHaveLength(HORIZON_MONTHS);
    expect(p.owedByMonth).toHaveLength(HORIZON_MONTHS + 1);
  });

  test('a minimum exactly equal to the interest holds the balance where it is, forever', () => {
    const d = debt('card', 10_000, 24, 200);
    expect(coversInterest(d)).toBe(false);
    const p = run([d], 'minimums');
    expect(p.months).toBeNull();
    expect(p.owedByMonth.every((x) => x === 1_000_000)).toBe(true);
  });

  test('a cent over the interest covers it', () => {
    expect(coversInterest(debt('card', 10_000, 24, 200.01))).toBe(true);
  });

  test('with an extra on top it does pay off, as the closed form says, but there is nothing finite to save against', () => {
    const c = comparePlans([debt('card', 10_000, 24, 150)], { startMonth: START, extraCents: toCents(100) });
    const exact = closedForm(10_000, 0.02, 250);
    expect(c.avalanche.months).toBe(Math.ceil(exact.n));
    expect(c.minimums.months).toBeNull();
    expect(c.avalanche.saved).toEqual({ interestCents: null, months: null });
  });

  test('a debt whose payment does not cover its interest grows until the strategy reaches it', () => {
    const c = comparePlans([debt('low', 5_000, 30, 50), debt('high', 1_000, 35, 100)], {
      startMonth: START,
      extraCents: toCents(150),
    });
    expect(ids(c.avalanche)).toEqual(['high', 'low']);
    expect(c.avalanche.months).not.toBeNull();
    expect(outcome(c.minimums, 'low').months).toBeNull();
    expect(outcome(c.minimums, 'high').months).not.toBeNull();
  });

  test('a strategy whose whole monthly total falls short is reported as never paying off', () => {
    const p = run([debt('a', 50_000, 25, 500), debt('b', 50_000, 25, 500)], 'avalanche', 0);
    expect(p.months).toBeNull();
    expect(p.interestCents).toBeNull();
  });

  test('the horizon is inclusive: a plan finishing in its last month is paid off', () => {
    const d = debt('loan', 1_000, 0, 100); // 10 months
    expect(run([d], 'minimums', 0, 10).months).toBe(10);
    expect(run([d], 'minimums', 0, 9).months).toBeNull();
  });

  test('a zero payment on a debt with interest never clears it', () => {
    expect(coversInterest(debt('deferred', 20_000, 5.5, 0))).toBe(false);
    expect(run([debt('deferred', 20_000, 5.5, 0)], 'minimums').months).toBeNull();
  });
});

describe('zero rates, zero balances and other edges', () => {
  test('a zero APR charges nothing and pays off in ceil(balance / payment) months, the last one partial', () => {
    const p = run([debt('loan', 1_000, 0, 300)], 'minimums');
    expect(p.months).toBe(4);
    expect(p.interestCents).toBe(0);
    expect(p.paidByMonth).toEqual([30000, 30000, 30000, 10000]);
    expect(p.owedByMonth).toEqual([100000, 70000, 40000, 10000, 0]);
  });

  test('a zero APR with no payment never clears', () => {
    expect(coversInterest(debt('family', 500, 0, 0))).toBe(false);
    expect(run([debt('family', 500, 0, 0)], 'minimums').months).toBeNull();
  });

  test('a debt with nothing owed is cleared at month 0 and its payment is no part of the total', () => {
    const paid = debt('paid', 0, 24, 35);
    expect(coversInterest(paid)).toBe(true);
    const loan = debt('loan', 1_000, 0, 300);
    const p = run([paid, loan], 'avalanche', 50);
    expect(p.monthlyCents).toBe(35000);
    expect(outcome(p, 'paid')).toMatchObject({ months: 0, month: START, interestCents: 0, paidCents: 0 });
    expect(p.debts[0].id).toBe('paid');
    // Exactly as without it.
    const alone = run([loan], 'avalanche', 50);
    expect(p.months).toBe(alone.months);
    expect(p.paidByMonth).toEqual(alone.paidByMonth);
  });

  test('nothing owed at all is debt-free now', () => {
    const p = run([], 'snowball', 100);
    expect(p.months).toBe(0);
    expect(p.month).toBe(START);
    expect(p.interestCents).toBe(0);
    expect(p.owedByMonth).toEqual([0]);
  });

  test('a payment bigger than the balance clears it in one month and pays only what is owed', () => {
    const p = run([debt('card', 20, 24, 35)], 'minimums');
    expect(p.months).toBe(1);
    expect(p.paidByMonth).toEqual([2040]); // $20 plus 40¢ of interest
  });

  test('the extra plays no part in the minimums-only baseline', () => {
    const d = [debt('loan', 1_000, 10, 100)];
    expect(simulate(d, 'minimums', { startMonth: START, extraCents: 50000 })).toEqual(run(d, 'minimums'));
  });

  test('a half cent of interest rounds up', () => {
    // 6,250¢ at 0.096% APR: 6250 × 96 / 1,200,000 = 0.5¢ exactly.
    expect(firstInterestCents({ id: 'x', balanceCents: 6250, apr: 0.096, minimumCents: 0 })).toBe(1);
    // A hair under a half rounds down.
    expect(firstInterestCents({ id: 'x', balanceCents: 6249, apr: 0.096, minimumCents: 0 })).toBe(0);
  });

  test('interest stays exact on the largest balance accepted', () => {
    // $1 trillion at 18%: 1.5% a month, exactly $15 billion.
    expect(firstInterestCents({ id: 'x', balanceCents: 1e14, apr: 18, minimumCents: 0 })).toBe(1.5e12);
    expect(firstInterestCents({ id: 'x', balanceCents: 1e14 - 1, apr: 18, minimumCents: 0 })).toBe(1.5e12);
  });

  test('refuses out-of-range input rather than planning it', () => {
    expect(debtProblem(debt('x', -1, 10, 10))).toBe('balance');
    expect(debtProblem({ id: 'x', balanceCents: 10.5, apr: 10, minimumCents: 10 })).toBe('balance');
    expect(debtProblem(debt('x', 10, MAX_APR + 0.01, 10))).toBe('apr');
    expect(debtProblem(debt('x', 10, Number.NaN, 10))).toBe('apr');
    expect(debtProblem(debt('x', 10, 10, -5))).toBe('minimum');
    expect(debtProblem(debt('x', 10, 10, 10))).toBeNull();
    expect(() => run([debt('x', 10, 150, 10)], 'minimums')).toThrow(RangeError);
    expect(() => run([debt('x', 10, 10, 10)], 'avalanche', -1)).toThrow(RangeError);
    expect(() => simulate([], 'minimums', { startMonth: '2026-13' })).toThrow(RangeError);
  });
});

describe('the totals reconcile to the cent', () => {
  // A small seeded generator, so a failure reproduces.
  function random(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test('over many random sets of debts: paid = owed + interest, debt by debt and in total', () => {
    const rand = random(20261006);
    const cents = (max: number) => Math.floor(rand() * max);
    let finished = 0;
    let never = 0;
    for (let i = 0; i < 250; i++) {
      const debts: Debt[] = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, j) => {
        const balanceCents = rand() < 0.05 ? 0 : 1 + cents(5_000_000);
        const apr = rand() < 0.1 ? 0 : Math.round(rand() * 3600) / 100;
        // From well below to well above the first month's interest.
        const minimumCents = cents(Math.max(2_500, balanceCents * 0.05));
        return { id: `d${j}`, balanceCents, apr, minimumCents };
      });
      const extraCents = rand() < 0.3 ? 0 : cents(100_000);
      const c = comparePlans(debts, { startMonth: START, extraCents });
      const owed = debts.reduce((s, d) => s + d.balanceCents, 0);

      for (const plan of [c.minimums, c.avalanche, c.snowball]) {
        expect(plan.owedByMonth[0]).toBe(owed);
        expect(plan.paidByMonth).toHaveLength(plan.owedByMonth.length - 1);
        if (plan.months === null) {
          never++;
          continue;
        }
        finished++;
        expect(plan.paidCents).toBe(owed + plan.interestCents!);
        expect(plan.paidByMonth.reduce((s, x) => s + x, 0)).toBe(plan.paidCents!);
        expect(plan.owedByMonth.at(-1)).toBe(0);
        for (const d of plan.debts) {
          const start = debts.find((x) => x.id === d.id)!;
          expect(d.paidCents).toBe(start.balanceCents + d.interestCents!);
          expect(d.remainingCents).toBe(0);
        }
        expect(plan.debts.reduce((s, d) => s + d.interestCents!, 0)).toBe(plan.interestCents!);
        // A strategy pays its whole monthly total every month but the last.
        if (plan.kind !== 'minimums') {
          expect(plan.paidByMonth.slice(0, -1).every((x) => x === plan.monthlyCents)).toBe(true);
          expect(plan.paidByMonth.at(-1)!).toBeLessThanOrEqual(plan.monthlyCents);
        }
      }

      // Never worse than the baseline: each debt gets at least its own payment
      // every month, so the strategies finish whenever the baseline does, no
      // later and for no more interest.
      for (const s of [c.avalanche, c.snowball]) {
        if (c.minimums.months === null) {
          expect(s.saved).toEqual({ interestCents: null, months: null });
          continue;
        }
        expect(s.months).not.toBeNull();
        expect(s.saved.months!).toBeGreaterThanOrEqual(0);
        expect(s.saved.interestCents!).toBeGreaterThanOrEqual(0);
      }
    }
    // The generator exercised both kinds of plan.
    expect(finished).toBeGreaterThan(100);
    expect(never).toBeGreaterThan(10);
  });
});

describe('months and labels', () => {
  test('addMonths crosses years', () => {
    expect(addMonths('2026-10', 0)).toBe('2026-10');
    expect(addMonths('2026-10', 3)).toBe('2027-01');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', 600)).toBe('2076-01');
    expect(() => addMonths('2026-1', 1)).toThrow(RangeError);
  });

  test('durationLabel', () => {
    expect(durationLabel(1)).toBe('1 month');
    expect(durationLabel(11)).toBe('11 months');
    expect(durationLabel(12)).toBe('1 year');
    expect(durationLabel(29)).toBe('2 years 5 months');
    expect(durationLabel(25)).toBe('2 years 1 month');
  });
});

describe('what the extra alone saves', () => {
  const debts = [debt('card', 4_000, 22, 120), debt('loan', 9_000, 7, 210)];

  test('the same order with and without the extra, apart from what rolling payments over saves', () => {
    const c = comparePlans(debts, { startMonth: START, extraCents: toCents(200) });
    const without = run(debts, 'avalanche', 0);
    expect(c.avalanche.extraSaved).toEqual({
      interestCents: without.interestCents! - c.avalanche.interestCents!,
      months: without.months! - c.avalanche.months!,
    });
    expect(c.avalanche.extraSaved!.interestCents!).toBeGreaterThan(0);
    // Against minimums only it saves more: the extra and the rollover together.
    expect(c.avalanche.saved.interestCents!).toBeGreaterThan(c.avalanche.extraSaved!.interestCents!);
  });

  test('no extra, nothing to measure', () => {
    const c = comparePlans(debts, { startMonth: START });
    expect(c.avalanche.extraSaved).toBeNull();
    expect(c.snowball.extraSaved).toBeNull();
  });

  test('when only the extra makes it finish, there is no finite saving to state', () => {
    const c = comparePlans([debt('card', 10_000, 24, 150)], { startMonth: START, extraCents: toCents(100) });
    expect(c.avalanche.months).not.toBeNull();
    expect(c.avalanche.extraSaved).toEqual({ interestCents: null, months: null });
  });
});

describe('typed terms', () => {
  test('parseApr takes 0 to 100 and nothing else', () => {
    expect(parseApr('')).toBeNull();
    expect(parseApr('  ')).toBeNull();
    expect(parseApr('21.24')).toBe(21.24);
    expect(parseApr('0')).toBe(0);
    expect(parseApr('100')).toBe(100);
    expect(parseApr('2124')).toBe('invalid');
    expect(parseApr('-1')).toBe('invalid');
    expect(parseApr('abc')).toBe('invalid');
    expect(parseApr('Infinity')).toBe('invalid');
  });

  test('parseCents takes an amount of 0 or more, to the cent', () => {
    expect(parseCents('')).toBeNull();
    expect(parseCents('35')).toBe(3500);
    expect(parseCents('35.5')).toBe(3550);
    expect(parseCents('0')).toBe(0);
    expect(parseCents('-1')).toBe('invalid');
    expect(parseCents('1e15')).toBe('invalid');
    expect(parseCents('x')).toBe('invalid');
  });

  // The fields resolveMinimum reads, for an account with an ordinary minimum.
  const minimumOf = (defaultMinimumCents: number | null, more: Partial<DebtAccount> = {}) => ({
    defaultMinimumCents,
    plaidMinimumCents: defaultMinimumCents,
    minimumHold: null,
    workedOut: null,
    ...more,
  });

  test("Plaid's value stands until something is typed", () => {
    expect(resolveApr(21.24, undefined)).toEqual({ value: 21.24, source: 'plaid', error: null });
    expect(resolveMinimum(minimumOf(3500), undefined)).toEqual({ value: 3500, source: 'plaid', error: null });
    expect(resolveApr(null, undefined)).toEqual({ value: null, source: null, error: null });
  });

  test("what is typed wins, and retyping the same figure is still Plaid's", () => {
    expect(resolveApr(21.24, '19.99')).toEqual({ value: 19.99, source: 'typed', error: null });
    expect(resolveApr(21.24, '21.240')).toEqual({ value: 21.24, source: 'plaid', error: null });
    expect(resolveMinimum(minimumOf(3500), '50')).toEqual({ value: 5000, source: 'typed', error: null });
    expect(resolveMinimum(minimumOf(null), '50')).toEqual({ value: 5000, source: 'typed', error: null });
  });

  test("a cleared field is needed again rather than quietly falling back to Plaid's", () => {
    expect(resolveApr(21.24, '')).toEqual({ value: null, source: null, error: null });
    expect(resolveMinimum(minimumOf(3500), '')).toEqual({ value: null, source: null, error: null });
  });

  test('a typed value out of range is refused with a reason', () => {
    expect(resolveApr(21.24, '2124')).toMatchObject({ value: null, source: 'typed', error: 'Enter a rate from 0 to 100%.' });
    expect(resolveMinimum(minimumOf(3500), '-3')).toMatchObject({ value: null, error: 'Enter an amount of 0 or more.' });
  });

  test("a Plaid figure out of range is not planned on: it's needed instead", () => {
    expect(resolveApr(2124, undefined)).toEqual({ value: null, source: null, error: null });
    expect(resolveMinimum(minimumOf(-500), undefined)).toEqual({ value: null, source: null, error: null });
  });

  test('a held mortgage payment: typed figures are named for where they came from', () => {
    const workedOut = { cents: 202657, principal: 425000, months: 360, apr: 3.99 };
    const escrow = minimumOf(null, { plaidMinimumCents: 314154, minimumHold: 'escrow', workedOut });
    expect(resolveMinimum(escrow, undefined)).toEqual({ value: null, source: null, error: null });
    expect(resolveMinimum(escrow, '2026.57')).toEqual({ value: 202657, source: 'worked-out', error: null });
    // Plaid's escrow-inclusive figure typed back in is the person's choice, not Plaid's.
    expect(resolveMinimum(escrow, '3141.54')).toEqual({ value: 314154, source: 'typed', error: null });
    // With no escrow reported, saying it has none makes Plaid's figure the payment.
    const unknown = minimumOf(null, { plaidMinimumCents: 210050, minimumHold: 'escrow-unknown', workedOut: null });
    expect(resolveMinimum(unknown, '2100.50')).toEqual({ value: 210050, source: 'plaid', error: null });
    // A typed 0 stays a typed 0, even where Plaid's 0 was held.
    expect(resolveMinimum(minimumOf(null, { plaidMinimumCents: 0, minimumHold: 'zero' }), '0')).toEqual({
      value: 0,
      source: 'typed',
      error: null,
    });
  });
});

describe('payments from Plaid that are not what the plan needs', () => {
  test('termMonths and the scheduled payment of a fixed-rate loan', () => {
    expect(termMonths('30 year')).toBe(360);
    expect(termMonths('10 years')).toBe(120);
    expect(termMonths('360 month')).toBe(360);
    expect(termMonths('15 yr')).toBe(180);
    expect(termMonths('thirty')).toBeNull();
    expect(termMonths('700 months')).toBeNull(); // past the horizon
    expect(termMonths(null)).toBeNull();
    // Plaid's example mortgage: $425,000 at 3.99% over 30 years.
    expect(scheduledPaymentCents(425_000, 3.99, 360)).toBe(202657);
    expect(scheduledPaymentCents(12_000, 0, 48)).toBe(25000);
    expect(scheduledPaymentCents(10_000, 0, 3)).toBe(333334);
  });

  // Plaid's own example mortgage (LiabilitiesGetResponse in its API spec): the
  // payment includes escrow, and the escrow account holds money.
  const exampleMortgage = normalizeLiabilities({
    mortgage: [
      {
        account_id: 'mortgage',
        escrow_balance: 3141.54,
        interest_rate: { percentage: 3.99, type: 'fixed' },
        loan_term: '30 year',
        next_monthly_payment: 3141.54,
        origination_principal_amount: 425000,
      },
    ],
  } as unknown as Parameters<typeof normalizeLiabilities>[0]).mortgage;
  const mortgageAt = (liability: object, balance = 56_302.06) =>
    debtAccounts([
      {
        institution_name: 'Chase',
        accounts: [{ account_id: 'm', name: 'Mortgage', type: 'loan', subtype: 'mortgage', balance, currency: 'USD', liability: liability as never }],
      },
    ])[0];

  test("a mortgage reporting escrow is never planned on Plaid's payment, and is offered its principal and interest", () => {
    const m = mortgageAt(exampleMortgage);
    expect(m).toMatchObject({
      minimumHold: 'escrow',
      plaidMinimumCents: 314154,
      defaultMinimumCents: null,
      escrowCents: 314154,
      workedOut: { cents: 202657, principal: 425000, months: 360, apr: 3.99 },
    });
    const { rows, debts, waiting } = planRows([m], { typed: {}, leftOut: {}, withoutAccrued: {} });
    expect(rows[0].status).toBe('needs-terms');
    expect(waiting).toBe(1);
    expect(debts).toEqual([]);
    // Taking the worked-out figure plans on principal and interest only.
    const taken = planRows([m], { typed: { m: { minimum: '2026.57' } }, leftOut: {}, withoutAccrued: {} });
    expect(taken.debts[0].minimumCents).toBe(202657);
    expect(taken.rows[0].minimum.source).toBe('worked-out');
  });

  test("escrow never rolls into the next debt: the strategy's monthly total holds principal and interest only", () => {
    const m = mortgageAt(exampleMortgage);
    const card = debtAccounts([
      {
        institution_name: 'Chase',
        accounts: [
          { account_id: 'c', name: 'Card', type: 'credit', balance: 2000, currency: 'USD', liability: { kind: 'credit', apr: 20, apr_label: 'Purchase APR', minimum_payment: 60 } },
        ],
      },
    ])[0];
    const { debts } = planRows([m, card], { typed: { m: { minimum: '2026.57' } }, leftOut: {}, withoutAccrued: {} });
    const c = comparePlans(debts, { startMonth: START });
    expect(c.avalanche.monthlyCents).toBe(202657 + 6000);
  });

  test('a mortgage reporting no escrow balance is held too, since Plaid gives no split', () => {
    for (const escrow of [null, 0]) {
      const m = mortgageAt({ ...exampleMortgage, escrow_balance: escrow });
      expect(m.minimumHold).toBe('escrow-unknown');
      expect(m.defaultMinimumCents).toBeNull();
    }
    // A variable rate, or no term: nothing is worked out.
    expect(mortgageAt({ ...exampleMortgage, interest_rate_type: 'variable' }).workedOut).toBeNull();
    expect(mortgageAt({ ...exampleMortgage, loan_term: null }).workedOut).toBeNull();
  });

  // Plaid's example student loan: $65,262 of principal and $6,227.36 accrued.
  const studentAt = (institution_id: string | null, outstanding_interest: number | null) =>
    debtAccounts([
      {
        institution_name: 'Servicer',
        institution_id,
        accounts: [
          {
            account_id: 's',
            name: 'Student Loan',
            type: 'loan',
            subtype: 'student',
            balance: 65_262,
            currency: 'USD',
            liability: { kind: 'student', apr: 5.25, apr_label: 'Interest rate', minimum_payment: 25, outstanding_interest },
          },
        ],
      },
    ])[0];

  test("a student loan's accrued interest is owed on top of its balance, unless left out", () => {
    const s = studentAt('ins_1', 6227.36);
    expect(s.balanceCents).toBe(6526200);
    expect(s.accruedInterestCents).toBe(622736);
    const planned = planRows([s], { typed: {}, leftOut: {}, withoutAccrued: {} });
    expect(planned.rows[0]).toMatchObject({ owedCents: 7148936, accruedIncluded: true });
    expect(planned.debts[0].balanceCents).toBe(7148936);
    const without = planRows([s], { typed: {}, leftOut: {}, withoutAccrued: { s: true } });
    expect(without.rows[0]).toMatchObject({ owedCents: 6526200, accruedIncluded: false });
    expect(without.debts[0].balanceCents).toBe(6526200);
  });

  test("Sallie Mae's balance already includes it, as Plaid documents, so nothing is added twice", () => {
    expect(studentAt('ins_116944', 6227.36).accruedInterestCents).toBeNull();
    expect(studentAt('ins_1', null).accruedInterestCents).toBeNull();
    expect(studentAt('ins_1', 0).accruedInterestCents).toBeNull();
  });

  const zeroMinimum = (type: 'credit' | 'loan', kind: 'credit' | 'student') =>
    debtAccounts([
      {
        institution_name: 'Navient',
        accounts: [
          { account_id: 'z', name: 'Loan', type, balance: 20_000, currency: 'USD', liability: { kind, apr: 8.5, apr_label: 'Interest rate', minimum_payment: 0 } },
        ],
      },
    ])[0];

  test('a Plaid minimum of $0 on a debt that owes something is needed, never planned as a payment', () => {
    for (const z of [zeroMinimum('loan', 'student'), zeroMinimum('credit', 'credit')]) {
      expect(z).toMatchObject({ minimumHold: 'zero', plaidMinimumCents: 0, defaultMinimumCents: null });
      const { rows, waiting } = planRows([z], { typed: {}, leftOut: {}, withoutAccrued: {} });
      expect(rows[0].status).toBe('needs-terms');
      expect(waiting).toBe(1);
    }
    // A typed 0 is the person's own figure, planned as it is (and never clears on its own).
    const typedZero = planRows([zeroMinimum('loan', 'student')], { typed: { z: { minimum: '0' } }, leftOut: {}, withoutAccrued: {} });
    expect(typedZero.debts[0].minimumCents).toBe(0);
    expect(coversInterest(typedZero.debts[0])).toBe(false);
  });

  test('splitByWeight: whole cents, in proportion, adding up exactly', () => {
    expect(splitByWeight(40000, [800000, 700000, 900000, 600000])).toEqual([10667, 9333, 12000, 8000]);
    expect(splitByWeight(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitByWeight(7, [0, 5])).toEqual([0, 7]);
    // Past 2^53 in the products, still exact.
    const big = splitByWeight(1e14, [1e14 - 1, 3]);
    expect(big[0] + big[1]).toBe(1e14);
  });

  const loan = (id: string, balance: number, minimum: number) => ({
    account_id: id,
    name: id,
    type: 'loan',
    subtype: 'student',
    balance,
    currency: 'USD',
    liability: { kind: 'student' as const, apr: 4.9, apr_label: 'Interest rate', minimum_payment: minimum },
  });

  test('student loans at one institution showing the same minimum share one payment, split by balance', () => {
    const accounts = debtAccounts([
      { institution_name: 'Great Lakes', accounts: [loan('a', 8000, 400), loan('b', 7000, 400), loan('c', 9000, 400), loan('d', 6000, 400), loan('e', 3000, 95)] },
      { institution_name: 'Nelnet', accounts: [loan('f', 5000, 400)] },
    ]);
    const by = Object.fromEntries(accounts.map((a) => [a.id, a]));
    expect(['a', 'b', 'c', 'd'].map((id) => by[id].defaultMinimumCents)).toEqual([10667, 9333, 12000, 8000]);
    for (const id of ['a', 'b', 'c', 'd']) expect(by[id].sharedMinimum).toEqual({ totalCents: 40000, loans: 4 });
    // A different minimum, or the same one at another institution, is its own.
    expect(by.e).toMatchObject({ defaultMinimumCents: 9500, sharedMinimum: null });
    expect(by.f).toMatchObject({ defaultMinimumCents: 40000, sharedMinimum: null });
    // The plan's monthly total counts the shared payment once.
    const { debts } = planRows(accounts.filter((a) => a.institution === 'Great Lakes'), { typed: {}, leftOut: {}, withoutAccrued: {} });
    expect(comparePlans(debts, { startMonth: START }).avalanche.monthlyCents).toBe(40000 + 9500);
  });

  test("each loan's own payment can be typed over its share", () => {
    const accounts = debtAccounts([{ institution_name: 'Great Lakes', accounts: [loan('a', 8000, 400), loan('b', 7000, 400)] }]);
    const { rows } = planRows(accounts, { typed: { a: { minimum: '400' } }, leftOut: {}, withoutAccrued: {} });
    expect(rows.find((r) => r.account.id === 'a')!.minimum).toEqual({ value: 40000, source: 'typed', error: null });
    expect(rows.find((r) => r.account.id === 'b')!.minimum.source).toBe('plaid');
  });

  test('loans owing nothing, or with no minimum, share nothing', () => {
    const accounts = debtAccounts([{ institution_name: 'Great Lakes', accounts: [loan('a', 8000, 400), loan('paid', 0, 400)] }]);
    expect(accounts.every((a) => a.sharedMinimum === null)).toBe(true);
  });

  const card = (last_payment_amount: number | null, last_statement_balance: number | null) =>
    debtAccounts([
      {
        institution_name: 'Chase',
        accounts: [
          {
            account_id: 'c',
            name: 'Card',
            type: 'credit',
            balance: 1240,
            currency: 'USD',
            liability: { kind: 'credit', apr: 21.24, apr_label: 'Purchase APR', minimum_payment: 35, last_payment_amount, last_statement_balance },
          },
        ],
      },
    ])[0];

  test('a card paid in full at its last statement starts out of the plan, and can be put in', () => {
    const paid = card(980.5, 980.5);
    expect(paid.paidInFull).toBe(true);
    const out = planRows([paid], { typed: {}, leftOut: {}, withoutAccrued: {} });
    expect(out.rows[0].status).toBe('paid-in-full');
    expect(out.debts).toEqual([]);
    expect(out.waiting).toBe(0);
    const included = planRows([paid], { typed: {}, leftOut: { c: false }, withoutAccrued: {} });
    expect(included.rows[0].status).toBe('ready');
    const leftOut = planRows([paid], { typed: {}, leftOut: { c: true }, withoutAccrued: {} });
    expect(leftOut.rows[0].status).toBe('left-out');
  });

  test('a card carrying a balance, or one whose payments Plaid does not report, is planned', () => {
    expect(card(168.25, 1708.77).paidInFull).toBe(false);
    expect(card(null, 980.5).paidInFull).toBe(false);
    expect(card(980.5, null).paidInFull).toBe(false);
    // Nothing on the statement and nothing paid: no balance was carried.
    expect(card(0, 0).paidInFull).toBe(true);
  });

  // Plaid's example card: four rates, one a 0% special rate on $1,000.
  const exampleCard = normalizeLiabilities({
    credit: [
      {
        account_id: 'card',
        aprs: [
          { apr_percentage: 15.24, apr_type: 'balance_transfer_apr', balance_subject_to_apr: 1562.32, interest_charge_amount: 130.22 },
          { apr_percentage: 27.95, apr_type: 'cash_apr', balance_subject_to_apr: 56.22, interest_charge_amount: 14.81 },
          { apr_percentage: 12.5, apr_type: 'purchase_apr', balance_subject_to_apr: 157.01, interest_charge_amount: 25.66 },
          { apr_percentage: 0, apr_type: 'special', balance_subject_to_apr: 1000, interest_charge_amount: 0 },
        ],
        last_payment_amount: 168.25,
        last_statement_balance: 1708.77,
        minimum_payment_amount: 20,
      },
    ],
  } as unknown as Parameters<typeof normalizeLiabilities>[0]).card;

  test("a card's rates are blended by what each applied to, so a 0% promotional balance isn't charged the purchase APR", () => {
    const [c] = debtAccounts([
      { institution_name: 'Chase', accounts: [{ account_id: 'c', name: 'Card', type: 'credit', balance: 2775.55, currency: 'USD', liability: exampleCard }] },
    ]);
    // (15.24 × 1,562.32 + 27.95 × 56.22 + 12.5 × 157.01 + 0 × 1,000) / 2,775.55
    expect(c.plaidApr).toBe(9.852);
    expect(c.plaidAprLabel).toBe('Blended APR');
    expect(c.aprParts).toHaveLength(4);
    expect(c.paidInFull).toBe(false);
    // One rate with a balance says nothing about the rest: the usual pick stands.
    const [single] = debtAccounts([
      {
        institution_name: 'Chase',
        accounts: [
          {
            account_id: 'c',
            name: 'Card',
            type: 'credit',
            balance: 500,
            currency: 'USD',
            liability: { ...exampleCard, apr: 21.24, apr_label: 'Purchase APR', apr_balances: [{ type: 'cash_apr', rate: 27.95, balance: 56.22 }] },
          },
        ],
      },
    ]);
    expect(single).toMatchObject({ plaidApr: 21.24, plaidAprLabel: 'Purchase APR', aprParts: null });
  });
});

describe('what the plan cannot see', () => {
  const owed = { account_id: 'x', name: 'Card', type: 'credit', balance: 10, currency: 'USD' };

  test('an institution that failed with nothing recovered, or too old to use, may hold debts', () => {
    expect(blindSpots([{ institution_name: 'Citi', error: 'Could not fetch balances', accounts: [] }])).toEqual([
      { kind: 'unloaded', institution: 'Citi' },
    ]);
    expect(
      blindSpots([
        { institution_name: 'Citi', error: 'Could not fetch balances', stale_too_old: '2026-06-01', stale_too_old_at: '2026-06-01T13:00:00Z', accounts: [] },
      ])
    ).toEqual([{ kind: 'too-old', institution: 'Citi', date: '2026-06-01', at: '2026-06-01T13:00:00Z' }]);
  });

  test('recovered balances are dated, and accounts that could not be recovered are counted', () => {
    expect(
      blindSpots([
        { institution_name: 'Chase', error: 'Could not fetch balances', stale_as_of: '2026-08-07', stale_missing: 1, accounts: [owed] },
      ])
    ).toEqual([
      { kind: 'dated', institution: 'Chase', date: '2026-08-07', at: null },
      { kind: 'missing', institution: 'Chase', count: 1 },
    ]);
  });

  test('accounts missing from an answer are counted; a date on a bank holding no debts is not given', () => {
    expect(blindSpots([{ institution_name: 'Chase', unconfirmed_missing: 2, accounts: [owed] }])).toEqual([
      { kind: 'vanished', institution: 'Chase', count: 2 },
    ]);
    const checking = { ...owed, type: 'depository' };
    expect(blindSpots([{ institution_name: 'Ally', error: 'x', stale_as_of: '2026-08-07', accounts: [checking] }])).toEqual([]);
  });

  test('a healthy institution has nothing to say', () => {
    expect(blindSpots([{ institution_name: 'Chase', error: null, accounts: [owed] }])).toEqual([]);
  });
});

describe('from accounts to debts', () => {
  // Plaid's LiabilitiesObject is a big nominal type; the fixtures are partial on
  // purpose, as in test/liabilities.test.ts.
  const terms = normalizeLiabilities({
    credit: [
      { account_id: 'card', aprs: [{ apr_type: 'cash_apr', apr_percentage: 29.99 }, { apr_type: 'purchase_apr', apr_percentage: 21.24 }], minimum_payment_amount: 35 },
      { account_id: 'card-no-apr', aprs: [], minimum_payment_amount: 25 },
    ],
    student: [{ account_id: 'student', interest_rate_percentage: 6.8, minimum_payment_amount: 420 }],
    mortgage: [{ account_id: 'home', interest_rate: { percentage: 5.25 }, next_monthly_payment: 2100.5 }],
  } as unknown as Parameters<typeof normalizeLiabilities>[0]);

  const account = (account_id: string, type: string, balance: number | null, extra: object = {}) => ({
    account_id,
    name: account_id,
    mask: '1234',
    type,
    subtype: null,
    balance,
    currency: 'USD',
    liability: terms[account_id],
    ...extra,
  });

  const plaidBank: DebtInstitutionInput = {
    institution_name: 'Chase',
    liabilities: 'on',
    accounts: [
      account('card', 'credit', 4210.55),
      account('card-no-apr', 'credit', 800),
      account('student', 'loan', 25_000),
      account('home', 'loan', 310_000),
      account('auto', 'loan', 12_000), // Plaid's liabilities product doesn't cover auto loans
      account('checking', 'depository', 1_500),
      account('hidden-card', 'credit', 900, { hidden: true }),
      account('paid-off', 'credit', 0),
      account('refund', 'credit', -12.5),
      account('no-balance', 'credit', null),
    ],
  };
  const none: PlanChoices = { typed: {}, leftOut: {}, withoutAccrued: {} };

  test('takes the terms Plaid supplies: purchase APR for a card, interest rate and payment for loans', () => {
    const byId = Object.fromEntries(debtAccounts([plaidBank]).map((d) => [d.id, d]));
    expect(byId.card).toMatchObject({
      type: 'credit',
      kind: 'credit',
      balanceCents: 421055,
      plaidApr: 21.24,
      plaidAprLabel: 'Purchase APR',
      plaidMinimumCents: 3500,
      defaultMinimumCents: 3500,
      noTerms: null,
      manual: false,
      institution: 'Chase',
      mask: '1234',
    });
    expect(byId.student).toMatchObject({ kind: 'student', plaidApr: 6.8, plaidAprLabel: 'Interest rate', defaultMinimumCents: 42000 });
    // A mortgage reports its whole payment in the minimum's place
    // (lib/liabilities.ts), which is held: it can include escrow.
    expect(byId.home).toMatchObject({ kind: 'mortgage', plaidApr: 5.25, plaidMinimumCents: 210050, defaultMinimumCents: null, minimumHold: 'escrow-unknown' });
    // A record with no usable rate: the rate is needed, the minimum stands.
    expect(byId['card-no-apr']).toMatchObject({ plaidApr: null, plaidAprLabel: null, defaultMinimumCents: 2500, noTerms: null });
    expect(byId.auto).toMatchObject({ kind: null, plaidApr: null, plaidMinimumCents: null, noTerms: 'not-reported' });
  });

  test('every card and loan that is not hidden, and nothing else', () => {
    const list = debtAccounts([plaidBank]).map((d) => d.id);
    expect(list).not.toContain('checking');
    expect(list).not.toContain('hidden-card');
    expect(list).toContain('paid-off');
    expect(list).toContain('no-balance');
  });

  test('says why Plaid has no terms: not enabled, still importing, or a manual account', () => {
    const at = (liabilities: string | undefined) =>
      debtAccounts([{ institution_name: 'Bank', liabilities, accounts: [account('x', 'credit', 10, { liability: undefined })] }])[0].noTerms;
    expect(at('off')).toBe('not-enabled');
    expect(at('loading')).toBe('loading');
    expect(at('unavailable')).toBe('not-reported');
    expect(at(undefined)).toBe('not-reported'); // a payload cached before the field existed
  });

  test("an unreachable institution's recovered accounts have no terms because it couldn't be asked", () => {
    // lib/last-known.ts recovers balances only, and the failed fetch leaves
    // liabilities 'unavailable': that is not Plaid lacking the terms.
    const [d] = debtAccounts([
      { institution_name: 'Bank', liabilities: 'unavailable', stale_as_of: '2026-08-07', accounts: [account('x', 'credit', 10, { liability: undefined })] },
    ]);
    expect(d.noTerms).toBe('unreachable');
  });

  test('manual credit and loan accounts have no terms and are planned in USD', () => {
    const manual: ManualAccount[] = [
      { account_id: 'manual_1', name: 'Auto Loan', institution_name: 'Alliant', type: 'loan', subtype: 'auto', balance: 8420, updated_at: '2026-08-02T17:02:00.000Z' },
      { account_id: 'manual_2', name: 'Visa', institution_name: 'Alliant', type: 'credit', subtype: null, balance: 310, updated_at: '2026-09-01T12:00:00.000Z' },
      { account_id: 'manual_3', name: 'HSA', institution_name: 'Alliant', type: 'investment', subtype: 'hsa', balance: 6009, updated_at: '2026-09-01T12:00:00.000Z' },
    ];
    const list = debtAccounts(toInstitutions(manual));
    expect(list.map((d) => d.id)).toEqual(['manual_1', 'manual_2']);
    expect(list[0]).toMatchObject({
      manual: true,
      noTerms: 'manual',
      plaidApr: null,
      plaidMinimumCents: null,
      currency: 'USD',
      subtype: 'auto',
      balanceCents: 842000,
      updatedAt: '2026-08-02T17:02:00.000Z',
    });
  });

  test("a recovered balance carries the day it's from", () => {
    const [d] = debtAccounts([
      { ...plaidBank, stale_as_of: '2026-08-07', stale_as_of_at: '2026-08-07T13:00:00Z', accounts: [account('card', 'credit', 4210.55)] },
    ]);
    expect(d.staleAsOf).toBe('2026-08-07');
    expect(d.staleAsOfAt).toBe('2026-08-07T13:00:00Z');
    expect(debtAccounts([plaidBank])[0].staleAsOf).toBeNull();
  });

  test("in the Accounts tab's order: institution, then name", () => {
    const list = debtAccounts([
      { institution_name: 'Wells', accounts: [account('b', 'credit', 1), account('a', 'credit', 1)] },
      { institution_name: 'Amex', accounts: [account('z', 'credit', 1)] },
    ]);
    expect(list.map((d) => d.id)).toEqual(['z', 'a', 'b']);
  });

  test('plans what is ready, waits on a missing term, and leaves out what owes nothing', () => {
    const accounts = debtAccounts([plaidBank]);
    const { rows, debts, waiting } = planRows(accounts, none);
    const status = Object.fromEntries(rows.map((r) => [r.account.id, r.status]));
    expect(status).toEqual({
      auto: 'needs-terms',
      card: 'ready',
      'card-no-apr': 'needs-terms',
      home: 'needs-terms', // its payment is held: it may include escrow
      'no-balance': 'no-balance',
      'paid-off': 'nothing-owed',
      refund: 'nothing-owed',
      student: 'ready',
    });
    expect(waiting).toBe(3);
    expect(debts.map((d) => d.id).sort()).toEqual(['card', 'student']);
    expect(debts.find((d) => d.id === 'card')).toEqual({ id: 'card', balanceCents: 421055, apr: 21.24, minimumCents: 3500 });
  });

  test('typed terms fill the gaps and are labelled as typed; a left-out debt waits on nothing', () => {
    const accounts = debtAccounts([plaidBank]);
    const { rows, debts, waiting } = planRows(accounts, {
      ...none,
      typed: { 'card-no-apr': { apr: '27.49' }, auto: { apr: '7.9', minimum: '310' }, home: { minimum: '1711.83' } },
    });
    expect(waiting).toBe(0);
    const row = (id: string) => rows.find((r) => r.account.id === id)!;
    expect(row('card-no-apr').apr).toEqual({ value: 27.49, source: 'typed', error: null });
    expect(row('card-no-apr').minimum).toEqual({ value: 2500, source: 'plaid', error: null });
    expect(debts.find((d) => d.id === 'auto')).toEqual({ id: 'auto', balanceCents: 1_200_000, apr: 7.9, minimumCents: 31000 });

    const out = planRows(accounts, { ...none, leftOut: { auto: true, 'card-no-apr': true, home: true } });
    expect(out.waiting).toBe(0);
    expect(out.rows.find((r) => r.account.id === 'auto')!.status).toBe('left-out');
    expect(out.debts.map((d) => d.id)).not.toContain('auto');
  });

  test('a term typed wrong holds the plan, like a missing one', () => {
    const accounts = debtAccounts([plaidBank]);
    const { rows, waiting } = planRows(accounts, {
      ...none,
      typed: { card: { apr: '2124' } },
      leftOut: { auto: true, 'card-no-apr': true, home: true },
    });
    expect(waiting).toBe(1);
    expect(rows.find((r) => r.account.id === 'card')!.apr.error).toBe('Enter a rate from 0 to 100%.');
  });
});

describe('currencies', () => {
  const acct = (id: string, currency: string | null) => ({
    account_id: id,
    name: id,
    type: 'credit',
    balance: 100,
    currency,
  });

  test('each currency is its own plan, the most common first, never mixed', () => {
    const groups = byCurrency(
      debtAccounts([{ institution_name: 'Bank', accounts: [acct('a', 'EUR'), acct('b', 'USD'), acct('c', 'USD'), acct('d', null)] }])
    );
    expect(groups.map((g) => g.currency)).toEqual(['USD', 'EUR', null]);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(['b', 'c']);
  });

  test('on a tie, by code, with no code last', () => {
    const groups = byCurrency(
      debtAccounts([{ institution_name: 'Bank', accounts: [acct('d', null), acct('b', 'USD'), acct('a', 'EUR')] }])
    );
    expect(groups.map((g) => g.currency)).toEqual(['EUR', 'USD', null]);
  });

  test('one currency is one group', () => {
    expect(byCurrency(debtAccounts([{ institution_name: 'Bank', accounts: [acct('a', 'USD')] }]))).toHaveLength(1);
    expect(byCurrency([])).toEqual([]);
  });
});
