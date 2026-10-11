import { describe, expect, test } from 'bun:test';
import { parseGoals, parsePlan, MAX_GOALS } from '@/lib/goal-model';

// What PUT /api/goals takes (#42): the four fields every release stored,
// checked as the release before checked them, and the plan, field by field.

const GOAL = { id: '3f0c9a7b-1d2e-4f5a-8b6c-7d8e9f0a1b2c', name: 'Emergency fund', target: 5000, account_id: 'acc_sav' };

describe('the four stored fields, as before', () => {
  test('a goal as the release before sent it is taken, with no plan to change', () => {
    expect(parseGoals([GOAL])).toEqual({ goals: [{ ...GOAL, plan: null }] });
  });

  test('names are trimmed and cut as before; ids and account ids cut as before', () => {
    const parsed = parseGoals([{ id: 'x'.repeat(50), name: `  ${'n'.repeat(70)} `, target: '12.5', account_id: 'a'.repeat(120) }]);
    expect(parsed).toEqual({ goals: [{ id: 'x'.repeat(40), name: 'n'.repeat(60), target: 12.5, account_id: 'a'.repeat(100), plan: null }] });
  });

  test('the same refusals as before, and more than twenty goals is too many', () => {
    for (const bad of [{ ...GOAL, name: '  ' }, { ...GOAL, target: 0 }, { ...GOAL, target: 'x' }, { ...GOAL, id: '' }, null, 'goal']) {
      expect(parseGoals([bad])).toEqual({ error: 'Invalid goal entry' });
    }
    expect(parseGoals('goals')).toEqual({ error: 'Invalid goals' });
    expect(parseGoals(Array.from({ length: MAX_GOALS + 1 }, (_, i) => ({ ...GOAL, id: `g${i}` })))).toEqual({ error: 'Invalid goals' });
    expect(parseGoals([GOAL, { ...GOAL, name: 'Again' }])).toEqual({ error: 'Two goals have the same id.' });
  });
});

describe('the plan', () => {
  test('every field, and null as not set', () => {
    expect(parsePlan({ allocation: 0, monthly_target: 250.5, target_date: '2027-06-01', archived: true })).toEqual({
      plan: { allocation: 0, monthly_target: 250.5, target_date: '2027-06-01', archived: true },
    });
    expect(parsePlan({ allocation: null, monthly_target: null, target_date: null, archived: false })).toEqual({ plan: {} });
    expect(parsePlan({})).toEqual({ plan: {} });
  });

  test('each field out of its range is refused, with why', () => {
    expect(parsePlan({ allocation: -1 })).toEqual({ error: 'An allocation is an amount from 0 up.' });
    expect(parsePlan({ allocation: '5' })).toEqual({ error: 'An allocation is an amount from 0 up.' });
    expect(parsePlan({ allocation: 2e12 })).toEqual({ error: 'An allocation is an amount from 0 up.' });
    expect(parsePlan({ monthly_target: 0 })).toEqual({ error: 'A monthly target is an amount above 0.' });
    expect(parsePlan({ monthly_target: Infinity })).toEqual({ error: 'A monthly target is an amount above 0.' });
    for (const d of ['2027-02-30', '1999-12-31', '2101-01-01', '2027-6-1', 20270601]) {
      expect(parsePlan({ target_date: d })).toEqual({ error: 'A target date is a day between 2000 and 2100, YYYY-MM-DD.' });
    }
    expect(parsePlan({ archived: 'yes' })).toEqual({ error: 'archived is true or false.' });
  });

  test('a field it doesn’t know is refused, never dropped', () => {
    expect(parsePlan({ allocation: 5, colour: 'red' })).toEqual({ error: 'A goal’s plan has no field colour.' });
    expect(parsePlan([1])).toEqual({ error: 'A goal’s plan is an object.' });
  });

  test('a goal with a plan: the plan checked, an allocation needing an account, an id the store can key', () => {
    expect(parseGoals([{ ...GOAL, plan: { allocation: 100 } }])).toEqual({ goals: [{ ...GOAL, plan: { allocation: 100 } }] });
    expect(parseGoals([{ ...GOAL, account_id: null, plan: { allocation: 100 } }])).toEqual({ error: 'An allocation needs an account to take it from.' });
    expect(parseGoals([{ ...GOAL, account_id: null, plan: { monthly_target: 100 } }])).toEqual({ goals: [{ ...GOAL, account_id: null, plan: { monthly_target: 100 } }] });
    expect(parseGoals([{ ...GOAL, id: 'my goal', plan: { monthly_target: 100 } }])).toMatchObject({ error: expect.stringContaining('can’t hold a plan') });
    // An odd id from an early release still saves, with no plan.
    expect(parseGoals([{ ...GOAL, id: 'my goal', plan: {} }])).toEqual({ goals: [{ ...GOAL, id: 'my goal', plan: {} }] });
    expect(parseGoals([{ ...GOAL, plan: { allocation: -5 } }])).toEqual({ error: 'An allocation is an amount from 0 up.' });
  });

  test('read-only fields a client echoes back are ignored', () => {
    const echoed = { ...GOAL, plan: { monthly_target: 10 }, plan_start: { date: '2026-01-01', amount: 99 }, archived_on: '2026-01-01', relinked: true, earlier_allocation: 5 };
    expect(parseGoals([echoed])).toEqual({ goals: [{ ...GOAL, plan: { monthly_target: 10 } }] });
  });
});
