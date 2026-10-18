import { describe, expect, test } from 'bun:test';
import {
  dayViewsOf,
  isViewsRead,
  MAX_RECORDED_GOALS,
  MAX_SHARED_GOALS,
  mergeViewsRead,
  parseViews,
  pctOf,
  sharedKinds,
  viewProblem,
  viewsChangeProblem,
  viewsOfChange,
  viewsReadOf,
  widerDetail,
  VIEW_KINDS,
  type ShareViews,
} from '@/lib/share-kinds';

// The other kinds of share's settings (lib/share-kinds.ts): read closed, so
// what this release can't read is shared as nothing, never as more.

const ALL = {
  net_worth: { detail: 'history', accounts: true },
  spending: { detail: 'shares', by: 'category' },
  holdings: { detail: 'amounts', positions: false },
  budgets: { detail: 'progress', by: 'group' },
  goals: { detail: 'amounts', goals: ['3f0c9a7b-1d2e-4f5a-8b6c-7d8e9f0a1b2c'] },
};

describe('a kind’s setting', () => {
  test('every kind at every level of its ladder is one', () => {
    for (const detail of ['total', 'history']) for (const accounts of [true, false]) expect(viewProblem('net_worth', { detail, accounts })).toBeNull();
    for (const detail of ['shares', 'amounts']) for (const by of ['group', 'category']) expect(viewProblem('spending', { detail, by })).toBeNull();
    for (const detail of ['shares', 'amounts']) for (const positions of [true, false]) expect(viewProblem('holdings', { detail, positions })).toBeNull();
    for (const detail of ['progress', 'amounts']) for (const by of ['group', 'category']) expect(viewProblem('budgets', { detail, by })).toBeNull();
    for (const detail of ['progress', 'amounts']) expect(viewProblem('goals', { detail, goals: ['g1', 'g2'] })).toBeNull();
  });

  test('is closed: a field more or fewer, a level of another kind, or a value of another type is refused', () => {
    expect(viewProblem('net_worth', { detail: 'history' })).not.toBeNull();
    expect(viewProblem('net_worth', { detail: 'history', accounts: false, daily: true })).not.toBeNull();
    expect(viewProblem('net_worth', { detail: 'amounts', accounts: false })).not.toBeNull();
    expect(viewProblem('net_worth', { detail: 'total', accounts: 'yes' })).not.toBeNull();
    expect(viewProblem('spending', { detail: 'progress', by: 'group' })).not.toBeNull();
    expect(viewProblem('spending', { detail: 'amounts', by: 'merchant' })).not.toBeNull();
    expect(viewProblem('holdings', { detail: 'shares', positions: 1 })).not.toBeNull();
    expect(viewProblem('budgets', { detail: 'shares', by: 'group' })).not.toBeNull();
    for (const junk of [null, 'history', ['history'], 3]) expect(viewProblem('net_worth', junk)).not.toBeNull();
  });

  test('goals name at least one goal and at most as many as anyone has, each once, each by an id that can be one', () => {
    expect(viewProblem('goals', { detail: 'amounts', goals: [] })).not.toBeNull();
    expect(viewProblem('goals', { detail: 'amounts', goals: Array.from({ length: MAX_SHARED_GOALS }, (_, i) => `g${i}`) })).toBeNull();
    expect(viewProblem('goals', { detail: 'amounts', goals: Array.from({ length: MAX_SHARED_GOALS + 1 }, (_, i) => `g${i}`) })).not.toBeNull();
    expect(viewProblem('goals', { detail: 'amounts', goals: ['g1', 'g1'] })).toBe('names a goal twice');
    expect(viewProblem('goals', { detail: 'amounts', goals: ['has space'] })).not.toBeNull();
    expect(viewProblem('goals', { detail: 'amounts', goals: ['x'.repeat(41)] })).not.toBeNull();
    expect(viewProblem('goals', { detail: 'amounts', goals: [7] })).not.toBeNull();
  });
});

describe('a change', () => {
  test('names known kinds, each a setting or null for not shared', () => {
    expect(viewsChangeProblem(ALL)).toBeNull();
    expect(viewsChangeProblem({ net_worth: null, goals: null })).toBeNull();
    expect(viewsChangeProblem({})).toBeNull();
    expect(viewsChangeProblem({ bills: { detail: 'upcoming' } })).toBe('bills isn’t a kind of share');
    expect(viewsChangeProblem({ spending: { detail: 'amounts' } })).toBe('Spending takes detail and by');
    for (const junk of [null, [], 'net_worth', 1]) expect(viewsChangeProblem(junk)).not.toBeNull();
  });

  test('as settings: what it names, a null as not shared, copied', () => {
    const goals = ['g1'];
    const change = { net_worth: null, spending: { detail: 'amounts', by: 'group' }, goals: { detail: 'progress', goals } };
    const views = viewsOfChange(change);
    expect(views).toEqual({ spending: { detail: 'amounts', by: 'group' }, goals: { detail: 'progress', goals: ['g1'] } });
    goals.push('g2');
    expect(views.goals!.goals).toEqual(['g1']);
  });
});

describe('a stored share’s kinds, read closed', () => {
  test('every kind it can read, as stored', () => {
    expect(parseViews(ALL)).toEqual(ALL as any);
    expect(sharedKinds(parseViews(ALL))).toEqual([...VIEW_KINDS]);
  });

  test('a kind this release doesn’t know, or can’t read, is shared as nothing; the rest as they are', () => {
    const later = {
      ...ALL,
      // A later release's kind, and a later release's narrowing of one this
      // release knows: neither is read as more than it says.
      bills: { detail: 'upcoming' },
      spending: { detail: 'shares', by: 'category', except: ['g-medical'] },
      holdings: { detail: 'percentiles', positions: false },
      budgets: 'all',
    };
    expect(parseViews(later)).toEqual({ net_worth: ALL.net_worth, goals: ALL.goals } as any);
  });

  test('anything else is no kinds at all, never an error', () => {
    for (const junk of [undefined, null, 'views', 3, [], [ALL]]) expect(parseViews(junk)).toEqual({});
  });
});

describe('what a record of showings keeps', () => {
  const NW = { detail: 'history', accounts: true } as const;
  test('each kind as it was shown, closed as a setting is, and of goals which, by id', () => {
    expect(isViewsRead({})).toBe(true);
    expect(isViewsRead({ net_worth: NW, spending: { detail: 'shares', by: 'category' }, goals: { detail: 'progress', goals: ['g1', 'g2'] } })).toBe(true);
    // Another release's kind, level or field is unrecognised, never read as less.
    expect(isViewsRead({ bills: { detail: 'upcoming' } })).toBe(false);
    expect(isViewsRead({ net_worth: { detail: 'amounts', accounts: false } })).toBe(false);
    expect(isViewsRead({ net_worth: { detail: 'total' } })).toBe(false);
    expect(isViewsRead({ spending: { detail: 'shares', by: 'group', except: [] } })).toBe(false);
    // The shape before kinds kept their options is not this one.
    expect(isViewsRead({ net_worth: 'history' })).toBe(false);
    expect(isViewsRead(['net_worth'])).toBe(false);
    // Goals: by ids that can be ones, each once, as many as a merge keeps.
    expect(isViewsRead({ goals: { detail: 'amounts', goals: [] } })).toBe(false);
    expect(isViewsRead({ goals: { detail: 'amounts', goals: ['g1', 'g1'] } })).toBe(false);
    expect(isViewsRead({ goals: { detail: 'amounts', goals: ['not one'] } })).toBe(false);
    expect(isViewsRead({ goals: { detail: 'amounts', goals: Array.from({ length: MAX_RECORDED_GOALS }, (_, i) => `g${i}`) } })).toBe(true);
    expect(isViewsRead({ goals: { detail: 'amounts', goals: Array.from({ length: MAX_RECORDED_GOALS + 1 }, (_, i) => `g${i}`) } })).toBe(false);
  });

  test('merged, each kind as widely as either: the wider detail, an option on if either had it, the goals of both', () => {
    expect(widerDetail('net_worth', 'total', 'history')).toBe('history');
    expect(widerDetail('net_worth', 'history', 'total')).toBe('history');
    expect(widerDetail('spending', 'shares', 'shares')).toBe('shares');
    expect(widerDetail('budgets', 'amounts', 'progress')).toBe('amounts');
    const merged = mergeViewsRead(
      { net_worth: { detail: 'total', accounts: true }, spending: { detail: 'amounts', by: 'group' }, goals: { detail: 'progress', goals: ['g2'] } },
      { net_worth: { detail: 'history', accounts: false }, spending: { detail: 'shares', by: 'category' }, holdings: { detail: 'shares', positions: true }, goals: { detail: 'amounts', goals: ['g1', 'g2'] } }
    );
    expect(merged).toEqual({
      net_worth: { detail: 'history', accounts: true },
      spending: { detail: 'amounts', by: 'category' },
      holdings: { detail: 'shares', positions: true },
      goals: { detail: 'amounts', goals: ['g1', 'g2'] },
    });
    expect(isViewsRead(merged)).toBe(true);
    expect(mergeViewsRead(undefined, undefined)).toEqual({});
    // Never more goals than a record reads.
    const many = (from: number) => ({ goals: { detail: 'progress' as const, goals: Array.from({ length: MAX_RECORDED_GOALS }, (_, i) => `g${from + i}`) } });
    expect(isViewsRead(mergeViewsRead(many(0), many(MAX_RECORDED_GOALS)))).toBe(true);
  });

  test('a day says how many goals, never which', () => {
    expect(dayViewsOf({ budgets: { detail: 'progress', by: 'group' }, goals: { detail: 'amounts', goals: ['g1', 'g2'] } })).toEqual({
      budgets: { detail: 'progress', by: 'group' },
      goals: { detail: 'amounts', count: 2 },
    });
  });

  test('a showing keeps each kind as its setting chose it, and the goals shown; a kind that couldn’t be read showed nothing, so isn’t in it', () => {
    const settings: ShareViews = {
      net_worth: { detail: 'total', accounts: true },
      spending: { detail: 'amounts', by: 'category' },
      holdings: { detail: 'shares', positions: true },
      goals: { detail: 'progress', goals: ['g1', 'g2', 'g3'] },
    };
    expect(
      viewsReadOf(
        {
          net_worth: { unreadable: true },
          spending: { detail: 'amounts', by: 'category', currency: 'USD', months: [] },
          holdings: { detail: 'shares', currency: 'USD', as_of: null, from: null, classes: [], buckets: [], positions: [], notes: [] },
          goals: { detail: 'progress', goals: [] },
        },
        settings,
        ['g2', 'g1']
      )
    ).toEqual({ spending: { detail: 'amounts', by: 'category' }, holdings: { detail: 'shares', positions: true }, goals: { detail: 'progress', goals: ['g1', 'g2'] } });
    expect(viewsReadOf(undefined, settings)).toEqual({});
  });
});

test('a whole percent of a whole, or none of nothing', () => {
  expect(pctOf(25, 100)).toBe(25);
  expect(pctOf(1, 3)).toBe(33);
  expect(pctOf(2, 3)).toBe(67);
  expect(pctOf(150, 100)).toBe(150);
  expect(pctOf(5, 0)).toBeNull();
  expect(pctOf(5, -10)).toBeNull();
  expect(pctOf(Number.NaN, 10)).toBeNull();
});
