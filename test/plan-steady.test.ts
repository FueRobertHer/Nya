import { describe, expect, test } from 'bun:test';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planPath } from '@/lib/fire/path';
import { walkToFi } from '@/lib/fire/events';
import { projectBalance } from '@/lib/fire/fi';
import { itemFromExpense, type Anchor, type PlanItem } from '@/lib/fire/items';
import { DEFAULT_PLAN_V2, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { OFF } from './plan-gen';

// Where each item falls on the steady path (lib/fire/steady.ts), through the
// figures that build the path it reads (lib/fire/plan-figures.ts): fixed
// edges, balance milestones latched, and the two searches.

const m = { spending: null, savings: null, assets: null };
// FI number $1,000,000 (4%, no tax); $500,000 now and $50,000 a year at 5%.
const base: FirePlanV2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: 60, spending: 40_000, savings: 50_000, assets: 500_000, realReturn: 0.05, taxRate: 0 };
const A = 500_000;
const C = 50_000;
const G = 0.05;
const TARGET = 1_000_000;

const when = (anchor: Anchor, offset = 0) => ({ anchor, offset });
/** A cost paid once, a home's, which counts in the walk whatever D15's switch. */
const cost = (id: string, from: ReturnType<typeof when>, amount: number): PlanItem => ({ ...itemFromExpense({ id, label: id, amount: 0, atAge: 50 }), kind: 'home', from, once: amount, yearly: 0 });
/** More spent a year, from `from` until `until`. */
const spend = (id: string, from: ReturnType<typeof when>, yearly: number, until: PlanItem['until'] = null): PlanItem => ({ ...itemFromExpense({ id, label: id, amount: 0, atAge: 50 }), kind: 'spending', from, until, once: null, yearly });

const figures = (over: Partial<FirePlanV2>): PlanFigures => {
  const f = planFigures({ ...base, ...over }, m, { count: OFF });
  if ('refused' in f) throw new Error('refused');
  return f;
};

describe('fixed edges', () => {
  test('an age, an edge on another item’s end, the stop', () => {
    const a = spend('a', when({ at: 'age', age: 45 }), 1_000, { years: 5 });
    const b = cost('b', when({ at: 'item', id: 'a', edge: 'end' }, 2), 10_000);
    const c = cost('c', when({ at: 'stop' }, -1), 10_000);
    const f = figures({ items: [a, b, c] });
    expect(f.resolution.ages).toEqual([{ start: 45, end: 50 }, { start: 52, end: null }, { start: 59, end: null }]);
    expect(f.resolution.searched).toBe('none');
    expect(f.events?.walk.costs).toEqual([{ year: 12, amount: 10_000 }, { year: 19, amount: 10_000 }]);
  });

  test('a partner’s age is turned into yours; without the partner’s age it isn’t placed', () => {
    const x = { ...cost('x', when({ at: 'age', age: 60 }), 1), owner: 'partner' as const };
    expect(figures({ items: [x], partnerAge: 37 }).resolution.ages).toEqual([{ start: 63, end: null }]);
    const f = figures({ items: [x] });
    expect([f.resolution.ages, f.resolution.why]).toEqual([[null], ['no-age']]);
  });
});

describe('balance milestones', () => {
  test('fire at the start of the first year the balance reaches them, and stay fired', () => {
    const k = Array.from({ length: 30 }, (_, i) => i).find((i) => projectBalance(A, C, G, i) >= 800_000) as number;
    // A cost it starts takes the balance back under: still placed.
    const x = spend('x', when({ at: 'balance', amount: 800_000 }), 60_000);
    const f = figures({ items: [x] });
    expect(f.resolution.ages).toEqual([{ start: 40 + k, end: null }]);
    const p = planPath(f);
    expect(p?.points[k + 2].balance).toBeLessThan(800_000 + 2 * C * 2);
  });

  test('one never reached waits, and an end before its start runs no years', () => {
    const never = cost('n', when({ at: 'balance', amount: 1e12 }), 1);
    const early = spend('e', when({ at: 'age', age: 50 }), 1_000, when({ at: 'balance', amount: 100 }));
    const f = figures({ items: [never, early] });
    expect(f.resolution.ages).toEqual([null, { start: 50, end: 50 }]);
    expect(f.resolution.why).toEqual(['not-reached', 'no-years']);
  });

  test('an edge after a balance follows it', () => {
    const x = spend('x', when({ at: 'balance', amount: 700_000 }), 1_000, { years: 3 });
    const y = cost('y', when({ at: 'item', id: 'x', edge: 'end' }), 5_000);
    const f = figures({ items: [x, y] });
    const start = (f.resolution.ages[0] as { start: number }).start;
    expect(f.resolution.ages).toEqual([{ start, end: start + 3 }, { start: start + 3, end: null }]);
  });
});

describe('finding FI', () => {
  const plain = figures({}).view.fiAge as number;
  /** The first whole age k at which, with the cost at k, the walk is at FI by k. */
  const firstWith = (amount: number) => {
    for (let k = 40; k <= 95; k++) {
      const r = walkToFi(A, C, G, TARGET, { moneyIn: [], costs: [{ year: k - 40, amount }], spans: [] });
      if ('years' in r && Math.round(40 + r.years) <= k) return k;
    }
    return null;
  };

  test('$350,000 at FI: the first age at which, after it, you’re still at your FI number', () => {
    const f = figures({ items: [cost('house', when({ at: 'fi' }), 350_000)] });
    const k = firstWith(350_000) as number;
    expect(k).toBeGreaterThan(Math.round(plain));
    expect(f.resolution).toMatchObject({ searched: 'fi', fi: k, stop: 60 });
    expect(f.resolution.ages).toEqual([{ start: k, end: null }]);
    expect([f.view.fiAge, f.view.yearsToFi]).toEqual([k, k - 40]);
  });

  test('a cost after FI leaves FI where it was; one that would fall before today starts today', () => {
    const later = figures({ items: [cost('trip', when({ at: 'fi' }, 5), 300_000)] });
    expect(later.resolution.fi).toBe(Math.round(plain));
    expect(later.resolution.ages).toEqual([{ start: Math.round(plain) + 5, end: null }]);
    const before = figures({ items: [cost('gift', when({ at: 'fi' }, -40), 1)] });
    expect(before.resolution.ages).toEqual([{ start: 40, end: null }]);
  });

  test('none by 95: what waits on FI isn’t placed, and FI is never', () => {
    const f = figures({ items: [cost('x', when({ at: 'fi' }), 1)], savings: 0, assets: 1_000 });
    expect(f.resolution).toMatchObject({ searched: 'fi', fi: null });
    expect(f.resolution.why).toEqual(['waits-on-fi']);
    expect([f.view.fiAge, f.view.yearsToFi]).toEqual([null, Infinity]);
  });
});

describe('stop when I reach FI', () => {
  test('the stop is FI’s age, as it rounds', () => {
    const f = figures({ stopAtFi: true, targetAge: null });
    expect(f.resolution).toMatchObject({ searched: 'stop', stop: Math.round(figures({}).view.fiAge as number) });
    expect(f.view.stopAge).toBe(f.resolution.stop);
    expect(f.view.fiAge).toBe(f.resolution.stop);
    expect(planPath(f)?.stopAge).toBe(f.resolution.stop as number);
  });

  test('a cost when you stop moves the stop: the walk counts it in the year it stops', () => {
    const plain = figures({ stopAtFi: true, targetAge: null }).resolution.stop as number;
    const f = figures({ stopAtFi: true, targetAge: null, items: [cost('party', when({ at: 'stop' }), 350_000)] });
    expect(f.resolution.stop).toBeGreaterThan(plain);
    expect(f.resolution.ages).toEqual([{ start: f.resolution.stop as number, end: null }]);
  });

  test('none by 95: no stop, nothing on it placed, nothing drawn', () => {
    const f = figures({ stopAtFi: true, targetAge: null, savings: 0, assets: 1_000, items: [cost('x', when({ at: 'stop' }), 1)] });
    expect(f.resolution).toMatchObject({ searched: 'stop', stop: null });
    expect(f.resolution.why).toEqual(['waits-on-stop']);
    expect(f.view.fiAge).toBeNull();
    expect(planPath(f)).toBeNull();
  });
});

test('the longest search, 25 items with balance milestones, under 50 ms', () => {
  const items: PlanItem[] = Array.from({ length: 25 }, (_, i) =>
    i % 3 === 0 ? spend(`s${i}`, when({ at: 'balance', amount: 600_000 + i * 50_000 }), 500) : i % 3 === 1 ? cost(`c${i}`, when({ at: 'fi' }, i % 5), 1_000) : cost(`a${i}`, when({ at: 'stop' }, -(i % 4)), 1_000)
  );
  // A stop no walk reaches: every candidate to 95 is tried.
  const slow = { stopAtFi: true, targetAge: null, items, savings: 1_000, assets: 10_000 };
  figures(slow);
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    figures(slow);
    best = Math.min(best, performance.now() - t);
  }
  expect(figures(slow).resolution.stop).toBeNull();
  expect(best).toBeLessThan(50);
});
