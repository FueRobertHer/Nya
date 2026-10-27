import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activityMonth, activityOpensOn, budgetsRange, budgetsShown, resetsMonth, writeMonth } from '@/components/view-month-state';
import { addMonths } from '@/lib/rollover';

// The month Activity and Budgets share (look and feel step 2b2,
// components/view-month-state.ts): what each tab shows for the month asked
// for, the months Budgets offers, and which of Home's links reset it.

const NOW = '2026-10';
const back = (n: number) => addMonths(NOW, -n);

describe('the shared month', () => {
  test('a tab writes null for its own default, else the month', () => {
    expect(writeMonth(NOW, NOW)).toBeNull();
    expect(writeMonth(back(1), NOW)).toBe(back(1));
    // Activity's default may be a past month, while this one has no transactions.
    expect(writeMonth(back(1), back(1))).toBeNull();
    expect(writeMonth(NOW, back(1))).toBe(NOW);
  });

  test('Activity opens on the latest month listed not after this one, else the newest', () => {
    expect(activityOpensOn([NOW, back(1)], NOW)).toBe(NOW);
    expect(activityOpensOn([back(1), back(2)], NOW)).toBe(back(1));
    // A row dated next month doesn't open the tab on it.
    expect(activityOpensOn([addMonths(NOW, 1), NOW], NOW)).toBe(NOW);
    expect(activityOpensOn([addMonths(NOW, 1)], NOW)).toBe(addMonths(NOW, 1));
    expect(activityOpensOn([], NOW)).toBeNull();
  });

  test('Activity shows the month asked for, else the latest listed before it, else its oldest', () => {
    const months = [NOW, back(1), back(3)];
    const cases: [string | null, string | null][] = [
      [null, NOW],
      [back(1), back(1)],
      // Not listed: the latest before it, never the later one (here its default).
      [back(2), back(3)],
      // Older than every month listed: the oldest.
      [back(5), back(3)],
      // A month to come that is no longer listed: the latest listed.
      [addMonths(NOW, 2), NOW],
    ];
    for (const [want, shown] of cases) expect([want, activityMonth(want, months, NOW)]).toEqual([want, shown]);
    expect(activityMonth(back(1), [], NOW)).toBeNull();
    expect(activityMonth(null, [], NOW)).toBeNull();
    // This month without transactions: the default is the latest with them.
    expect(activityMonth(null, [back(1), back(2)], NOW)).toBe(back(1));
    expect(activityMonth(NOW, [back(1), back(2)], NOW)).toBe(back(1));
  });

  test('Budgets shows this month for the default or a later one, else the month asked for, ten years back at most', () => {
    expect(budgetsShown(null, NOW)).toBe(NOW);
    expect(budgetsShown(NOW, NOW)).toBe(NOW);
    expect(budgetsShown(addMonths(NOW, 1), NOW)).toBe(NOW);
    expect(budgetsShown(back(2), NOW)).toBe(back(2));
    expect(budgetsShown(back(200), NOW)).toBe(back(120));
  });

  test('Budgets offers back to the first month with transactions, or to the month shown when that is earlier or the first isn’t known', () => {
    expect(budgetsRange(NOW, NOW, null)).toEqual([NOW]);
    expect(budgetsRange(NOW, NOW, back(2))).toEqual([NOW, back(1), back(2)]);
    // Not known yet, or failed: the month shown is still among them.
    expect(budgetsRange(back(2), NOW, null)).toEqual([NOW, back(1), back(2)]);
    // A first month later than the one Activity brought (a bank's stored rows
    // that couldn't be read): the month is kept, and offered.
    expect(budgetsRange(back(2), NOW, back(1))).toEqual([NOW, back(1), back(2)]);
    expect(budgetsRange(back(1), NOW, addMonths(NOW, 1))).toEqual([NOW, back(1)]);
    // Ten years at most.
    expect(budgetsRange(NOW, NOW, back(300))).toHaveLength(121);
  });

  test('Home’s budget alerts and its review count reset the month; its other links don’t', () => {
    expect(Object.entries(resetsMonth).filter(([, r]) => r).map(([k]) => k).sort()).toEqual(['budgets', 'review']);
  });

  test('the dashboard resets it for every link that does, before going', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    const goTo = src.slice(src.indexOf('const goTo = useCallback('));
    const reset = goTo.indexOf('if (resetsMonth[go.to]) resetViewMonth();');
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThan(goTo.indexOf('switch (go.to)'));
    expect(src).toContain('const resetViewMonth = viewMonth.reset;');
  });
});
