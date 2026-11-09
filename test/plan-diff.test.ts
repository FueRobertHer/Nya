import { describe, expect, test } from 'bun:test';
import { copyDiffParts, diffText, figureChoices, itemChoices, rowText, sameChange } from '@/components/plan-diff';
import { asEvent, itemFromExpense, itemFromIncome, type PlanItem } from '@/lib/fire/items';
import type { LifeEvent } from '@/lib/fire/events';
import { DEFAULT_PLAN_V2, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { genEvents, itemFromEvent, rand } from './plan-gen';

// A copy against your plan, without the page: life events read back from a
// plan's items (lib/fire/items.ts asEvent), how a copy differs from your plan
// in words, and Also change it in's change made in another plan and its
// choices (components/plan-diff.ts).

const money = (n: number) => `$${n.toLocaleString('en-US')}`;

describe('a rate where tax is worked out', () => {
  const base: FirePlanV2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: 55, spending: 40_000, savings: 20_000, assets: 300_000, taxRate: 0 };
  test('isn’t a difference, as nothing reads it there', () => {
    expect(copyDiffParts(base, { ...base, taxRate: 0.15 }, money, { taxWorked: true })).toEqual([]);
  });
  test('is one where it is what the plan runs at', () => {
    expect(copyDiffParts(base, { ...base, taxRate: 0.15 }, money)).toHaveLength(1);
    expect(copyDiffParts(base, { ...base, taxRate: 0.15 }, money, { taxWorked: false })).toHaveLength(1);
  });
});
const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...DEFAULT_PLAN_V2, age: 40, targetAge: 55, spending: 40_000, savings: 20_000, assets: 300_000, ...over });

const CHILD: LifeEvent = { id: 'e1', kind: 'child', label: 'A child', fromAge: 42, yearly: 15_000, years: 18 };
const WINDFALL: LifeEvent = { id: 'e2', kind: 'windfall', label: 'Inheritance', atAge: 60, amount: 100_000 };
const RENT = itemFromIncome({ id: 'i1', label: 'Rent', amount: 12_000, fromAge: 45, inflationAdjusted: true });
const ROOF = itemFromExpense({ id: 'x1', label: 'New roof', amount: 20_000, atAge: 50 });

describe('life events as items, and back', () => {
  test('every life event read back from its item is the same event', () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const e of genEvents(rand(seed))) {
        expect([seed, asEvent(itemFromEvent(e))]).toEqual([seed, e]);
      }
    }
  });

  test('an item no life event makes is none: income, a one-off, or one before tax or a partner’s', () => {
    const child = itemFromEvent(CHILD);
    expect(asEvent(RENT)).toBeNull();
    expect(asEvent(ROOF)).toBeNull();
    expect(asEvent({ ...child, beforeTax: true })).toBeNull();
    expect(asEvent({ ...child, owner: 'partner' } as PlanItem)).toBeNull();
    expect(asEvent({ ...child, inflationAdjusted: false })).toBeNull();
  });
});

describe('how a copy differs from your plan', () => {
  test('the same plan differs in nothing', () => {
    expect(copyDiffParts(plan(), plan(), money)).toEqual([]);
    expect(diffText([])).toBe('The same as your plan.');
  });

  test('the stop first, then each setting, your own FI number, the items, and anything else; each with your plan’s', () => {
    const main = plan({ items: [RENT, ROOF] });
    const copy = plan({
      targetAge: 52,
      spending: 45_000,
      fiNumber: 1_000_000,
      fee: main.fee + 0.001,
      items: [{ ...RENT, yearly: 15_000 }, itemFromEvent(CHILD)],
      partTimeIncome: 10_000,
    });
    const parts = copyDiffParts(main, copy, money);
    expect(parts[0]).toBe('Stop age: 52 (your plan: 55)');
    expect(parts[1]).toStartWith('Annual spending: $45,000');
    expect(parts[1]).toEndWith('(your plan: $40,000 a year)');
    expect(parts.some((p) => p.startsWith('Fund fees: '))).toBe(true);
    expect(parts).toContain('Your own FI number: $1,000,000 (your plan: worked out from spending)');
    expect(parts.find((p) => p.startsWith('“Rent”: '))).toContain(', instead of ');
    expect(parts.find((p) => p.startsWith('Adds “A child”: '))).toBeDefined();
    expect(parts.find((p) => p.startsWith('Leaves out “New roof” ('))).toBeDefined();
    expect(parts.at(-1)).toBe('Other settings differ');
    // In that order: the stop, the settings, the FI number, the items.
    const at = (start: string) => parts.findIndex((p) => p.startsWith(start));
    expect([at('Stop age'), at('Annual spending'), at('Fund fees'), at('Your own FI number'), at('“Rent”'), at('Adds'), at('Leaves out'), at('Other')]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test('stopping at FI is said as the stop', () => {
    expect(copyDiffParts(plan(), plan({ stopAtFi: true }), money)).toEqual(['Stop age: when it reaches FI (your plan: 55)']);
  });

  test('D9’s FI date is said, in words, never as other settings', () => {
    expect(copyDiffParts(plan(), plan({ lastsIn: 0.9 }), money)).toEqual(['Your FI date: the earliest stop that lasts in 90% of starts (your plan: when it reaches the FI number)']);
    expect(copyDiffParts(plan({ lastsIn: 0.8 }), plan(), money)).toEqual(['Your FI date: when it reaches the FI number (your plan: the earliest stop that lasts in 80% of starts)']);
  });

  test('the facts every plan shares are never a difference', () => {
    const copy = plan({ age: 41, partnerAge: 39, includeCash: !DEFAULT_PLAN_V2.includeCash, method: 'monte-carlo' });
    expect(copyDiffParts(plan(), copy, money)).toEqual([]);
  });

  test('every amount goes through the money given, so hidden amounts stay hidden', () => {
    const hidden = () => '$•••';
    const parts = copyDiffParts(plan({ items: [ROOF] }), plan({ spending: 45_000, fiNumber: 900_000, items: [itemFromEvent(WINDFALL)] }), hidden);
    expect(parts.join(' ')).not.toMatch(/\d{2},\d{3}/);
  });

  test('as one line, the first two and how many more; as a row, the FI age against your plan’s and the first', () => {
    expect(diffText(['A', 'B'])).toBe('A; B.');
    expect(diffText(['A', 'B', 'C', 'D'])).toBe('A; B; and 2 more.');
    expect(diffText(['A', 'B', 'C'], 3)).toBe('A; B; C.');
    expect(rowText({ kind: 'age', age: 54 }, null, [])).toBe('FI around 54');
    expect(rowText({ kind: 'age', age: 54 }, { kind: 'age', age: 53 }, ['Stop age: 52 (your plan: 55)', 'B', 'C'])).toBe('FI around 54, 1 year later · Stop age: 52 (your plan: 55), and 2 more');
    expect(rowText({ kind: 'age', age: 53 }, { kind: 'age', age: 53 }, [])).toStartWith('FI around 53');
    expect(rowText({ kind: 'age', age: 53 }, { kind: 'age', age: 53 }, [])).toEndWith(' · the same as your plan');
  });
});

describe('Also change it in', () => {
  test('a setting changed is changed there too; the facts and the rest of that plan stay its own', () => {
    const before = plan({ items: [RENT] });
    const after = { ...before, spending: 50_000, age: 41 };
    const there = plan({ targetAge: 50, savings: 30_000, items: [ROOF] });
    expect(sameChange(before, after, there)).toEqual({ ...there, spending: 50_000 });
  });

  test('an item changed is changed where that plan holds it (by id), in its place; one added or removed is not passed on', () => {
    const before = plan({ items: [RENT, ROOF] });
    const after = { ...before, items: [{ ...RENT, yearly: 15_000 }, itemFromEvent(CHILD)] };
    const there = plan({ items: [itemFromEvent(WINDFALL), RENT, ROOF] });
    expect(sameChange(before, after, there).items).toEqual([itemFromEvent(WINDFALL), { ...RENT, yearly: 15_000 }, ROOF]);
    // A plan without it is left as it was.
    const without = plan({ items: [ROOF] });
    expect(sameChange(before, after, without)).toEqual(without);
  });

  test('the choices: every plan offered with the figure there, or each holding the item with it as it is there', () => {
    const targets = [
      { id: 'main', name: 'First plan (your plan)', plan: plan({ spending: null, items: [RENT] }) },
      { id: 'c1', name: 'Stop at 52', plan: plan({ assets: 250_000, items: [{ ...RENT, yearly: 9_000 }] }) },
      { id: 'c2', name: 'No rent', plan: plan() },
    ];
    expect(figureChoices(targets, 'spending', money)).toEqual([
      { id: 'main', name: 'First plan (your plan)', value: 'Nya’s figure' },
      { id: 'c1', name: 'Stop at 52', value: '$40,000 a year' },
      { id: 'c2', name: 'No rent', value: '$40,000 a year' },
    ]);
    expect(figureChoices(targets, 'assets', money).map((c) => c.value)).toEqual(['$300,000', '$250,000', '$300,000']);
    const rent = itemChoices(targets, 'i1', money);
    expect(rent.map((c) => c.id)).toEqual(['main', 'c1']);
    expect(rent[1].value).toContain('$9,000');
    expect(itemChoices(targets, 'nowhere', money)).toEqual([]);
  });
});
