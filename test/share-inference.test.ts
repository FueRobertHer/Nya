import { describe, expect, test } from 'bun:test';
import { inferences, RESIDUAL_NOTE, type FactAccount, type FactGoal, type InferenceFacts } from '@/lib/share-inference';
import type { ShareViews } from '@/lib/share-kinds';

// What someone could work out beyond what is shared with them
// (lib/share-inference.ts), always from everything shared on the connection
// together.

const checking: FactAccount = { id: 'chk', label: 'Chase Checking ••1111', level: null, investment: false };
const savings: FactAccount = { id: 'sav', label: 'Ally Savings', level: null, investment: false };
const ira: FactAccount = { id: 'ira', label: 'Fidelity IRA', level: null, investment: true };
const at = (a: FactAccount, level: FactAccount['level']): FactAccount => ({ ...a, level });
const holiday: FactGoal = { name: 'Holiday', projected: true, account_id: 'sav' };
const house: FactGoal = { name: 'House', projected: true, account_id: 'ira' };
const someday: FactGoal = { name: 'Someday', projected: false, account_id: null };

const facts = (views: ShareViews, accounts: FactAccount[] = [checking, savings, ira], goals?: FactGoal[]): InferenceFacts => ({ accounts, views, ...(goals ? { goals } : {}) });
const ids = (f: InferenceFacts) => inferences(f).map((i) => i.id);
const textOf = (f: InferenceFacts, id: string) => inferences(f).find((i) => i.id === id)?.text;

const NET_TOTAL = { net_worth: { detail: 'total', accounts: false } } as const;
const NET_HISTORY = { net_worth: { detail: 'history', accounts: false } } as const;
const NET_WITH_ACCOUNTS = { net_worth: { detail: 'history', accounts: true } } as const;

describe('nothing to warn about', () => {
  test('nothing shared, accounts alone, or one kind alone', () => {
    expect(ids(facts({}))).toEqual([]);
    expect(ids(facts({}, [at(checking, 'transactions'), at(savings, 'balance'), ira]))).toEqual([]);
    expect(ids(facts(NET_HISTORY))).toEqual([]);
    expect(ids(facts({ spending: { detail: 'amounts', by: 'category' } }))).toEqual([]);
    expect(ids(facts({ holdings: { detail: 'shares', positions: true } }))).toEqual([]);
    expect(ids(facts({ budgets: { detail: 'progress', by: 'category' } }))).toEqual([]);
  });

  test('an account that only shows it exists gives no amount away', () => {
    expect(ids(facts(NET_TOTAL, [at(checking, 'exists'), savings, ira]))).toEqual([]);
    expect(ids(facts({ holdings: { detail: 'shares', positions: false } }, [checking, savings, at(ira, 'exists')]))).toEqual([]);
  });

  test('a net worth with its accounts already shows every balance: nothing more to work out from it', () => {
    expect(ids(facts(NET_WITH_ACCOUNTS, [at(checking, 'balance'), savings, ira]))).toEqual([]);
  });

  test('a net worth beside every balance adds nothing: it is their sum', () => {
    expect(ids(facts(NET_TOTAL, [at(checking, 'balance'), at(savings, 'transactions'), at(ira, 'balance')]))).toEqual([]);
  });

  test('the note that goes beneath every list says no list is a promise', () => {
    expect(RESIDUAL_NOTE).toContain('not every way');
  });
});

describe('a net worth beside the balances of some accounts', () => {
  test('gives what the others add up to', () => {
    const f = facts(NET_HISTORY, [at(checking, 'balance'), savings, ira]);
    expect(ids(f)).toEqual(['net_worth_rest']);
    expect(textOf(f, 'net_worth_rest')).toBe('They see your net worth and the balance of Chase Checking ••1111, so they can work out what your other accounts add up to.');
  });

  test('with only one left over, gives its balance exactly, by name', () => {
    const f = facts(NET_TOTAL, [at(checking, 'balance'), at(savings, 'transactions'), at(ira, 'exists')]);
    expect(textOf(f, 'net_worth_rest')).toBe(
      'They see your net worth and the balances of Chase Checking ••1111 and Ally Savings, so they can work out the balance of Fidelity IRA, the one account whose balance you don’t share.'
    );
  });

  test('many balances are counted rather than listed', () => {
    const many = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: `Account ${id}`, level: 'balance' as const, investment: false }));
    const f = facts(NET_TOTAL, [...many, savings, ira]);
    expect(textOf(f, 'net_worth_rest')).toContain('the balances of 4 of your accounts');
  });
});

describe('net worth with spending gives income', () => {
  test('spending in amounts beside a net worth over time', () => {
    const f = facts({ ...NET_HISTORY, spending: { detail: 'amounts', by: 'group' } });
    expect(ids(f)).toEqual(['income']);
    expect(textOf(f, 'income')).toBe(
      'With your net worth over time and your spending each month, they can estimate your income: about what your net worth gained in a month plus what you spent in it.'
    );
  });

  test('beside the total alone, as long as they note it from month to month', () => {
    const f = facts({ ...NET_TOTAL, spending: { detail: 'amounts', by: 'category' } });
    expect(textOf(f, 'income')).toContain('if they note your net worth from month to month');
  });

  test('what is spent against budgets, in amounts, does the same', () => {
    const f = facts({ ...NET_HISTORY, budgets: { detail: 'amounts', by: 'group' } });
    expect(textOf(f, 'income')).toContain('what you spend against your budgets');
  });

  test('spending as percentages alone gives no amount to add', () => {
    expect(ids(facts({ ...NET_HISTORY, spending: { detail: 'shares', by: 'category' } }))).toEqual([]);
    expect(ids(facts({ ...NET_HISTORY, budgets: { detail: 'progress', by: 'category' } }))).toEqual([]);
  });
});

describe('a goal’s projection gives its monthly contribution', () => {
  test('in amounts, how much goes in; as progress, what share of its target', () => {
    const amounts = facts({ goals: { detail: 'amounts', goals: ['g1'] } }, [checking], [holiday]);
    expect(textOf(amounts, 'goal_contribution')).toBe('From the progress of Holiday and when it is projected to be reached, they can work out about how much goes into it a month.');
    const progress = facts({ goals: { detail: 'progress', goals: ['g1'] } }, [checking], [holiday]);
    expect(textOf(progress, 'goal_contribution')).toBe(
      'From the progress of Holiday and when it is projected to be reached, they can work out about what share of its target goes in a month.'
    );
  });

  test('several goals are named together, once', () => {
    const f = facts({ goals: { detail: 'amounts', goals: ['g1', 'g2', 'g3'] } }, [checking], [holiday, house, someday]);
    expect(inferences(f).filter((i) => i.id === 'goal_contribution')).toHaveLength(1);
    expect(textOf(f, 'goal_contribution')).toBe('From the progress of Holiday and House and when each is projected to be reached, they can work out about how much goes into each a month.');
  });

  test('a goal that isn’t projected (no account) gives nothing away', () => {
    expect(ids(facts({ goals: { detail: 'amounts', goals: ['g3'] } }, [checking], [someday]))).toEqual([]);
  });

  test('as progress, beside its account’s balance, may give its target', () => {
    const f = facts({ goals: { detail: 'progress', goals: ['g1'] } }, [checking, at(savings, 'balance')], [holiday]);
    expect(ids(f)).toEqual(['goal_contribution', 'goal_target']);
    expect(textOf(f, 'goal_target')).toBe('From the progress of Holiday and the balance of Ally Savings, they may be able to work out its target.');
    // In amounts, the target is shown already.
    expect(ids(facts({ goals: { detail: 'amounts', goals: ['g1'] } }, [checking, at(savings, 'balance')], [holiday]))).toEqual(['goal_contribution']);
    // Its account shared only as existing shows no balance.
    expect(ids(facts({ goals: { detail: 'progress', goals: ['g1'] } }, [checking, at(savings, 'exists')], [holiday]))).toEqual(['goal_contribution']);
  });
});

describe('holdings as percentages, beside an amount of the same money, give the whole', () => {
  test('an investment account’s balance', () => {
    const f = facts({ holdings: { detail: 'shares', positions: false } }, [checking, savings, at(ira, 'balance')]);
    expect(ids(f)).toEqual(['holdings_total']);
    expect(textOf(f, 'holdings_total')).toBe('With your holdings as percentages and the balance of Fidelity IRA, they can estimate how much is in each part of your holdings, and in all.');
  });

  test('a net worth listing its accounts, an investment one among them', () => {
    const f = facts({ ...NET_WITH_ACCOUNTS, holdings: { detail: 'shares', positions: true } });
    expect(textOf(f, 'holdings_total')).toContain('the balances of your investment accounts in your net worth');
    // With no investment account to list, nothing.
    expect(ids(facts({ ...NET_WITH_ACCOUNTS, holdings: { detail: 'shares', positions: true } }, [checking, savings]))).toEqual([]);
  });

  test('a bank account’s balance is no part of them, and amounts show the whole already', () => {
    expect(ids(facts({ holdings: { detail: 'shares', positions: false } }, [at(checking, 'balance'), savings, ira]))).toEqual([]);
    expect(ids(facts({ holdings: { detail: 'amounts', positions: false } }, [checking, savings, at(ira, 'balance')]))).toEqual([]);
  });
});

describe('budgets and spending, one in amounts and the other in percentages', () => {
  test('budgets as progress beside spending in amounts give the budgets', () => {
    const f = facts({ budgets: { detail: 'progress', by: 'category' }, spending: { detail: 'amounts', by: 'category' } });
    expect(ids(f)).toEqual(['budget_amounts']);
  });

  test('spending as percentages beside budgets in amounts give the spending', () => {
    const f = facts({ budgets: { detail: 'amounts', by: 'group' }, spending: { detail: 'shares', by: 'group' } });
    expect(ids(f)).toEqual(['spending_amounts']);
  });

  test('both in amounts, or both as percentages, add nothing', () => {
    expect(ids(facts({ budgets: { detail: 'amounts', by: 'group' }, spending: { detail: 'amounts', by: 'group' } }))).toEqual([]);
    expect(ids(facts({ budgets: { detail: 'progress', by: 'group' }, spending: { detail: 'shares', by: 'group' } }))).toEqual([]);
  });
});

describe('from the combination, never one share alone', () => {
  test('a share added beside others is judged with them: spending is harmless alone, and gives income beside a net worth already shared', () => {
    const before: ShareViews = { ...NET_HISTORY };
    expect(ids(facts(before))).toEqual([]);
    expect(ids(facts({ spending: { detail: 'amounts', by: 'group' } }))).toEqual([]);
    expect(ids(facts({ ...before, spending: { detail: 'amounts', by: 'group' } }))).toEqual(['income']);
  });

  test('everything at once: each rule once, in order', () => {
    const f = facts(
      {
        net_worth: { detail: 'history', accounts: false },
        spending: { detail: 'shares', by: 'category' },
        holdings: { detail: 'shares', positions: true },
        budgets: { detail: 'amounts', by: 'category' },
        goals: { detail: 'progress', goals: ['g1', 'g2'] },
      },
      [at(checking, 'transactions'), at(savings, 'balance'), at(ira, 'balance')],
      [holiday, house]
    );
    // Every balance is shown, so the net worth gives nothing more.
    expect(ids(f)).toEqual(['income', 'goal_contribution', 'goal_target', 'holdings_total', 'spending_amounts']);
    // The goals' accounts are named once each.
    expect(textOf(f, 'goal_target')).toBe('From the progress of Holiday and House and the balances of Ally Savings and Fidelity IRA, they may be able to work out their targets.');
  });

  test('the words never use a dash', () => {
    const f = facts(
      { ...NET_TOTAL, spending: { detail: 'amounts', by: 'group' }, holdings: { detail: 'shares', positions: false }, budgets: { detail: 'progress', by: 'group' }, goals: { detail: 'progress', goals: ['g1'] } },
      [at(checking, 'balance'), at(savings, 'balance'), ira],
      [holiday]
    );
    for (const i of inferences(f)) expect(i.text).not.toMatch(/[–—]/);
    expect(RESIDUAL_NOTE).not.toMatch(/[–—]/);
  });
});
