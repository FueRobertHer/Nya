import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { NOTE_KINDS, figureNotes, inputFlags, stressNotice, windowText, type FigureArgs, type FigureNote, type FigureText } from '@/components/plan-figure-notes';
import { FiCard } from '@/components/PlanTab';
import { PAYROLL_NOTE, wholeMoney } from '@/components/plan-text';
import { DEFAULT_PLAN, type FirePlan } from '@/lib/fire/plan';
import { planFigures } from '@/lib/fire/plan-figures';
import { fiFigures, gapText, measuredInputs, spendingGap, assetsGap } from '@/lib/fire/progress';
import { NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import type { InvestedAssets, TrailingFlows, WorkplaceSavings } from '@/lib/fire/inputs';
import type { LifeEvent } from '@/lib/fire/events';

// What each figure the Plan rests on says (components/plan-figure-notes.ts,
// rollout phase 6c): every state of the plan's table (the sub, the value's
// second line, `why`, and each note's words, level, kind and order), the
// kind words, the keys, the Stress test's notice and the FI card's flags.
// The rows themselves are rendered by test/plan-inputs-view.test.tsx.

const money = (n: number) => wholeMoney(n, 'USD');
const flows: TrailingFlows = {
  spending: 40_000,
  income: 70_000,
  savings: 30_000,
  loanPayments: 0,
  cash: 0,
  refunds: 0,
  cashWithdrawn: 0,
  cashEntered: 0,
  cashEnteredOn: [],
  cashIous: 0,
  unclearLoans: 0,
  largestRefund: null,
  from: '2025-10-07',
  to: '2026-10-06',
  days: 365,
  scaled: false,
  count: 400,
  excludedCount: 0,
  currency: 'USD',
  leftOut: [],
};
const assets = (over: Partial<InvestedAssets> = {}): InvestedAssets => ({
  total: 250_000,
  accounts: [
    { account_id: 'a', name: 'Brokerage', type: 'investment', balance: 150_000, currency: 'USD', institution: 'Vanguard', item_id: 'i1' },
    { account_id: 'b', name: '401(k)', type: 'investment', subtype: '401k', balance: 100_000, currency: 'USD', institution: 'Fidelity', item_id: 'i2' },
  ],
  unknown: 0,
  caveats: [],
  currency: 'USD',
  leftOut: [],
  ...over,
});
const noPlans: WorkplaceSavings = { total: 0, plans: [], fromBank: [], partial: [], shortHistory: [], problems: [], unmeasured: [] };
const investmentsOnly: NoTransactionsView = {
  without: [
    { institution_name: 'Empower', reason: 'investment_accounts' },
    { institution_name: 'Vanguard', reason: 'investment_accounts' },
  ],
  connections: 2,
};
const refusedBeside: NoTransactionsView = { without: [{ institution_name: 'Acme CU', reason: 'refused' }], connections: 2 };
const bothBeside: NoTransactionsView = {
  without: [
    { institution_name: 'Acme CU', reason: 'refused' },
    { institution_name: 'Fidelity', reason: 'no_consent' },
  ],
  connections: 3,
};
const AS_OF = '2026-10-06T15:12:00Z';
const WINDOW = 'your last 12 months of transactions (Oct 7, 2025 to Oct 6, 2026)';

type Over = Omit<Partial<FigureArgs>, 'plan'> & { plan?: Partial<FirePlan> };

/** What the figures are worked out from, with the view and the savings rate
 *  worked out as the Plan tab does (lib/fire/progress.ts fiFigures). */
function at(over: Over = {}): FigureArgs {
  const { plan: planOver, ...rest } = over;
  const plan: FirePlan = { ...DEFAULT_PLAN, age: 40, targetAge: 55, ...planOver };
  const f = rest.flows === undefined ? flows : rest.flows;
  const a = rest.assets ?? assets();
  const w = rest.workplace === undefined ? noPlans : rest.workplace;
  const figures = fiFigures(plan, { flows: f, workplace: w, assets: a, rates: rest.shareRates ?? null }, 'USD');
  return {
    plan,
    view: figures.view,
    flows: f,
    unread: [],
    withoutTransactions: NO_CONNECTIONS_WITHOUT,
    transactionCount: f?.count ?? 0,
    txnsLoading: false,
    txnsFailed: false,
    assets: a,
    balancesAsOf: AS_OF,
    workplace: w,
    workplaceCount: 0,
    cashOn: [],
    cashUnmarked: false,
    money,
    savingsRate: figures.savingsRate,
    shareRates: null,
    ...rest,
  };
}

/** A figure's notes as [level, kind, text]. */
const notesOf = (t: FigureText) => t.notes.map((n) => [n.level, n.kind, n.text]);

describe('annual spending', () => {
  test('typed: says so, with no note, and Why? still explains the measured figure', () => {
    const t = figureNotes(at({ plan: { spending: 50_000 }, flows: { ...flows, refunds: 200 } })).spending;
    expect(t).toEqual({ sub: 'Typed by you', line: null, why: 'Less $200 of refunds.', notes: [] });
  });

  test('not measured: the gap in full, as a caution, and nothing to explain', () => {
    const f = { ...flows, leftOut: [{ currency: 'EUR', count: 150 }] };
    const t = figureNotes(at({ flows: f })).spending;
    expect(t.sub).toBe('Not measured');
    expect(t.why).toBeNull();
    expect(notesOf(t)).toEqual([['caution', 'spending not measured', gapText(spendingGap(f)!)]]);
  });

  test('loading, failed, and no spending to measure', () => {
    expect(figureNotes(at({ flows: null, txnsLoading: true })).spending).toEqual({ sub: 'Loading your transactions…', line: null, why: null, notes: [] });
    const failed = figureNotes(at({ flows: null, txnsFailed: true })).spending;
    expect(failed.sub).toBe("Couldn't be loaded");
    expect(notesOf(failed)).toEqual([['info', 'transactions not loaded', "Your transactions couldn't be loaded; type your spending, or try again later."]]);
    const none = figureNotes(at({ flows: null, withoutTransactions: investmentsOnly, transactionCount: 0 })).spending;
    expect(none.sub).toBe('No transactions to measure from');
    expect(notesOf(none)).toEqual([
      ['info', 'no transactions to measure from', 'Your connected accounts are investment accounts, so there are no bank or card transactions to measure spending from. Type your own.'],
    ]);
  });

  test('not enough transactions yet: what is left uncounted as a caution, the connections named as information', () => {
    const refused = figureNotes(at({ flows: null, withoutTransactions: refusedBeside, transactionCount: 30 })).spending;
    expect(refused.sub).toBe('Not enough transactions yet');
    expect(notesOf(refused)).toEqual([['caution', 'accounts Plaid doesn’t cover', "Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so they aren't counted."]]);
    const named = figureNotes(at({ flows: null, withoutTransactions: investmentsOnly, transactionCount: 12 })).spending;
    expect(notesOf(named)).toEqual([['info', 'connections with no transactions', 'Empower and Vanguard hold no bank account or card, so no transactions come from them.']]);
  });

  test('measured: where from, every warning in the FI card’s order as a caution, then what is left out as information', () => {
    const f: TrailingFlows = {
      ...flows,
      excludedCount: 3,
      uncategorized: 5,
      iousBefore: { count: 2, amount: 300 },
      cashWithdrawn: 500,
      cash: 500,
      unclearLoans: 1_000,
      unclearLoansElsewhere: 400,
      leftOut: [{ currency: 'EUR', count: 4 }],
    };
    const t = figureNotes(at({ flows: f, cashUnmarked: true, unread: [{ institution: 'Chase', reason: 'x' }], withoutTransactions: bothBeside })).spending;
    expect(t.sub).toBe('A year, from transactions');
    expect(t.line).toBeNull();
    expect(notesOf(t)).toEqual([
      ['caution', 'other currencies left out', "4 transactions in EUR aren't in your spending or savings, which are in USD."],
      [
        'caution',
        'uncategorized transactions',
        '5 transactions from SimpleFIN or Lunch Flow have no category, so they count as spending or income. A move between two of your SimpleFIN or Lunch Flow accounts is left out on its own; categorize any other card payment or move between your accounts as a transfer to leave it out too.',
      ],
      ['caution', 'IOUs from before your transactions', "2 IOUs you owe from before Oct 7, 2025 ($300) aren't counted here: your spending is measured from your transactions, which begin then."],
      [
        'caution',
        'cash that may count twice',
        "Cash withdrawals count as spent, and so does what you entered by hand. If what you entered is the cash you withdrew, mark its account as cash on hand (Update the account), so it isn't counted twice.",
      ],
      [
        'caution',
        'loan payments not counted',
        "$600 of loan payments isn't counted: Plaid doesn't say it is a mortgage, car, student or personal loan, so it may be paying off a card, which settles spending already counted.",
      ],
      [
        'caution',
        'loan payments not counted',
        "$400 of loan payments you entered, imported or categorized isn't counted: nothing says it pays a mortgage, car, student or personal loan rather than a card, whose payment settles spending already counted.",
      ],
      ['caution', 'transactions that couldn’t be read', "Transactions from Chase couldn't all be read (the Activity tab says why), so this figure may be low."],
      ['caution', 'accounts Plaid doesn’t cover', "Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so this figure may be low."],
      [
        'caution',
        'transactions not allowed',
        "You didn't allow Nya to see transactions from the bank or card accounts at Fidelity, so this figure may be low. To bring them in, choose Allow transactions on the Accounts tab.",
      ],
      ['info', 'excluded transactions', 'Leaves out 3 transactions you excluded from budgets and reports.'],
    ]);
    // Transactions that couldn't be loaded at all are a kind of their own.
    expect(notesOf(figureNotes(at({ unread: [{ institution: null, reason: 'x' }] })).spending)).toEqual([
      ['caution', 'transactions not loaded', "Your latest transactions couldn't be loaded, so this figure may be low or out of date."],
    ]);
    // Entered by hand beside connections that bring in none: named, as information.
    expect(notesOf(figureNotes(at({ withoutTransactions: investmentsOnly, transactionCount: 12 })).spending)).toEqual([
      ['info', 'connections with no transactions', 'Empower and Vanguard hold no bank account or card, so no transactions come from them.'],
    ]);
  });

  test('a window shorter than a year says so in its sub', () => {
    expect(figureNotes(at({ flows: { ...flows, scaled: true, days: 152, from: '2026-05-08' } })).spending.sub).toBe('5 months, scaled up to a year');
    expect(figureNotes(at({ flows: { ...flows, scaled: true, days: 340, from: '2025-11-01' } })).spending.sub).toBe('340 days, scaled up to a year');
  });

  test('Why? says what is in it past the window, never the window itself, and nothing when there is nothing more', () => {
    expect(figureNotes(at()).spending.why).toBeNull();
    const rich = figureNotes(
      at({
        flows: { ...flows, loanPayments: 6_000, cash: 1_200, cashEntered: 800, cashWithdrawn: 2_000, cashIous: 150, refunds: 900, largestRefund: { amount: 600, date: '2026-05-02', name: 'REI' } },
        cashOn: ['Wallet'],
      })
    ).spending.why;
    expect(rich).toBe(
      'Includes $6,000 of loan payments (principal counts as spending until the loan ends) and $1,200 of cash withdrawals beyond the $800 of cash spending you entered on Wallet and for what you owed others and settled in cash, taken to be the same money, less $900 of refunds (the largest, $600 from REI on May 2, 2026).'
    );
    expect(rich).not.toContain(WINDOW);
    expect(rich).not.toContain('from your last');
    expect(figureNotes(at({ flows: { ...flows, cashWithdrawn: 500, cashEntered: 700, refunds: 200 } })).spending.why).toBe(
      "Less $200 of refunds. Cash withdrawals ($500) aren't counted: the $700 of cash spending you entered is taken to be the same money."
    );
    expect(figureNotes(at({ flows: { ...flows, cash: 1_200, cashWithdrawn: 1_200 } })).spending.why).toBe('Includes $1,200 of cash withdrawals.');
  });
});

describe('annual savings', () => {
  test('typed: the measured rate in full as its one note, and Why? the measured estimate', () => {
    const t = figureNotes(at({ plan: { savings: 20_000 } })).savings;
    expect(t.sub).toBe('Typed by you');
    expect(t.line).toBeNull();
    expect(t.why).toBe('An estimate: income minus spending over the same 12 months. That is a savings rate of 43% of income.');
    expect(notesOf(t)).toEqual([['info', 'your savings rate', `Measured from ${WINDOW} instead, your savings rate is 43% of income.`]]);
  });

  test('typed with the year not measured: why the rate isn’t, as a caution', () => {
    const f = { ...flows, leftOut: [{ currency: 'EUR', count: 150 }] };
    const t = figureNotes(at({ plan: { savings: 20_000 }, flows: f })).savings;
    expect(t.why).toBeNull();
    expect(notesOf(t)).toEqual([['caution', 'savings rate not measured', gapText(spendingGap(f)!, 'rate')]]);
    // Nothing measured, nothing to say.
    expect(figureNotes(at({ plan: { savings: 20_000 }, flows: null })).savings).toEqual({ sub: 'Typed by you', line: null, why: null, notes: [] });
  });

  test('not measured, loading, no spending to measure, and a year needed', () => {
    const f = { ...flows, leftOut: [{ currency: 'EUR', count: 150 }] };
    const gap = figureNotes(at({ flows: f })).savings;
    expect([gap.sub, gap.why]).toEqual(['Not measured', null]);
    expect(notesOf(gap)).toEqual([['caution', 'savings not measured', gapText(spendingGap(f)!, 'year')]]);
    expect(figureNotes(at({ flows: null, txnsLoading: true })).savings).toEqual({ sub: 'Loading your transactions…', line: null, why: null, notes: [] });
    const none = figureNotes(at({ flows: null, withoutTransactions: investmentsOnly, transactionCount: 0 })).savings;
    expect(none.sub).toBe('No transactions to measure from');
    expect(notesOf(none)).toEqual([
      ['info', 'no transactions to measure from', 'Your connected accounts are investment accounts, so there are no bank or card transactions to measure income and spending from. Type your own.'],
    ]);
    expect(figureNotes(at({ flows: null })).savings).toEqual({ sub: 'Needs a year of transactions', line: null, why: null, notes: [] });
    expect(notesOf(figureNotes(at({ flows: null, withoutTransactions: investmentsOnly, transactionCount: 12 })).savings)).toEqual([
      ['info', 'connections with no transactions', 'Empower and Vanguard hold no bank account or card, so no transactions come from them.'],
    ]);
  });

  test('measured: the savings rate as the value’s second line, Why? the estimate whole, and pay before a bank as a caution', () => {
    const t = figureNotes(at()).savings;
    expect(t.sub).toBe('Estimated from a year');
    expect(t.line).toBe('43% savings rate');
    expect(t.why).toBe('An estimate: income minus spending over the same 12 months. That is a savings rate of 43% of income.');
    expect(notesOf(t)).toEqual([['caution', 'pay before it reaches a bank', PAYROLL_NOTE]]);
    const scaled = figureNotes(at({ flows: { ...flows, scaled: true, days: 152, from: '2026-05-08' } })).savings;
    expect(scaled.sub).toBe('Estimated from 5 months, scaled up');
    expect(scaled.why).toBe('An estimate: income minus spending over the same span. That is a savings rate of 43% of income.');
    // No income, no rate: no second line.
    expect(figureNotes(at({ flows: { ...flows, income: 0, savings: -40_000 } })).savings.line).toBeNull();
    // Still being checked.
    expect(notesOf(figureNotes(at({ workplace: null, workplaceCount: null })).savings)).toEqual([['caution', 'workplace plans still being checked', 'Checking contributions to workplace plans…']]);
  });

  test('measured with workplace plans: what was added, matched and not set, each a caution in order, with the place word "in Annual savings"', () => {
    const workplace: WorkplaceSavings = {
      total: 14_000,
      plans: [
        { name: 'Fidelity 401(k)', paidFrom: 'payroll', added: 12_000, count: 24, largest: { amount: 900, date: '2026-03-15' }, matched: 0 },
        { name: 'Empower 403(b)', paidFrom: null, added: 2_000, count: 0, largest: null, matched: 1_500 },
      ],
      fromBank: ['Vanguard Solo 401(k)'],
      partial: [{ name: 'Fidelity 401(k)', from: '2026-01-10' }],
      shortHistory: [{ name: 'Empower 403(b)', from: '2026-04-02' }],
      problems: [{ name: 'Empower 403(b)', note: 'x' }],
      unmeasured: ['TIAA 457(b)'],
    } as WorkplaceSavings;
    const t = figureNotes(at({ workplace, workplaceCount: 4, unread: [{ institution: 'Chase', reason: 'x' }], withoutTransactions: refusedBeside })).savings;
    expect(t.line).toBe('52% savings rate');
    expect(t.why).toBe(
      'An estimate: income minus spending over the same 12 months, plus $14,000 paid into Fidelity 401(k) and Empower 403(b). That is a savings rate of 52% of income, what went into those plans counted as income too.'
    );
    expect(notesOf(t)).toEqual([
      ['caution', 'contributions added', 'Fidelity 401(k): 24 contributions added, $12,000, the largest $900 on Mar 15, 2026, all of them, as it is set as paid through payroll.'],
      ['caution', 'contributions added', 'Empower 403(b): $2,000 added.'],
      [
        'caution',
        'contributions not added twice',
        "$1,500 more paid into Empower 403(b) matched transfers from your bank to investment and retirement funds, which already count as saved, so it isn't added again.",
      ],
      ['caution', 'payroll not set', "How Empower 403(b) is paid into isn't set: if you pay into it from your bank account, say so in Annual savings, or it may count twice."],
      ['caution', 'plans paid from your bank', 'Vanguard Solo 401(k) is set as paid from your bank, so nothing paid into it is added again.'],
      ['caution', 'a plan counted from later', "Fidelity 401(k) is counted from Jan 10, 2026, when Nya's record of it starts."],
      ['caution', 'a plan’s history starting later', 'Nya has activity for Empower 403(b) from Apr 2, 2026.'],
      ['caution', 'contributions not measured', "Contributions to TIAA 457(b) couldn't be measured, so this figure may be low."],
      ['caution', 'plan activity not read', "Empower 403(b)'s activity couldn't all be read, so this figure may be low."],
      ['caution', 'transactions that couldn’t be read', "Transactions from Chase couldn't all be read (the Activity tab says why), so this figure may be off."],
      ['caution', 'accounts Plaid doesn’t cover', "Plaid doesn't provide transactions for the bank or card accounts at Acme CU, so this figure may be off."],
    ]);
    expect(t.notes.some((n) => n.text.includes('under Edit'))).toBe(false);
  });
});

describe('invested assets', () => {
  test('typed: says so, with nothing under it and nothing behind Why?', () => {
    expect(figureNotes(at({ plan: { assets: 400_000 } })).assets).toEqual({ sub: 'Typed by you', line: null, why: null, notes: [] });
  });

  test('measured: how many accounts and as of when, never a Why?, cash said when it counts', () => {
    const t = figureNotes(at()).assets;
    expect(t.sub).toMatch(/^2 accounts, as of Oct [67], \d{1,2}:12\s[AP]M$/);
    expect(t.why).toBeNull();
    expect(t.notes).toEqual([]);
    expect(figureNotes(at({ plan: { includeCash: true } })).assets.sub).toMatch(/^2 accounts, cash included, as of Oct [67], \d{1,2}:12\s[AP]M$/);
    expect(figureNotes(at({ plan: { includeCash: true }, balancesAsOf: null })).assets.sub).toBe('2 accounts, cash included');
    expect(figureNotes(at({ balancesAsOf: null })).assets.sub).toBe('2 accounts');
    expect(figureNotes(at({ assets: assets({ accounts: assets().accounts.slice(0, 1), total: 150_000 }), balancesAsOf: null })).assets.sub).toBe('1 account');
  });

  test('measured with balances missing: each named as a caution in the FI card’s order', () => {
    const a = assets({
      unknown: 2,
      caveats: [
        { kind: 'unreachable', institution: 'Schwab' },
        { kind: 'stale', institution: 'Vanguard', asOf: '2026-10-01', at: null },
        { kind: 'missing', institution: 'Fidelity', count: 2 },
      ],
      leftOut: [{ currency: 'GBP', count: 1 }],
      accounts: Array.from({ length: 12 }, (_, i) => ({ ...assets().accounts[0], account_id: `x${i}`, balance: 20_000 })),
      total: 240_000,
    });
    expect(notesOf(figureNotes(at({ assets: a })).assets)).toEqual([
      ['caution', 'an institution not reached', "Schwab couldn't be reached and isn't counted, so this figure may be low."],
      ['caution', 'balances from earlier', "Vanguard's balances are from Oct 1, 2026: it couldn't be reached since."],
      ['caution', 'accounts not shown', "2 accounts at Fidelity couldn't be shown, so this figure may be low."],
      ['caution', 'balances not known', '2 more had no balance to count, so this figure may be low.'],
      ['caution', 'other currencies left out', "1 account in GBP isn't in this figure, which is in USD."],
    ]);
  });

  test('not measured, and none to measure from: why, then what couldn’t be counted', () => {
    const caveats: InvestedAssets['caveats'] = [{ kind: 'unreachable', institution: 'Schwab' }];
    const gapped = assets({ leftOut: [{ currency: 'GBP', count: 3 }], caveats });
    const t = figureNotes(at({ assets: gapped })).assets;
    expect([t.sub, t.why]).toEqual(['Not measured', null]);
    expect(notesOf(t)).toEqual([
      ['caution', 'invested assets not measured', gapText(assetsGap(gapped)!)],
      ['caution', 'an institution not reached', "Schwab couldn't be reached and isn't counted, so this figure may be low."],
    ]);
    const none = figureNotes(at({ assets: assets({ total: null, accounts: [], caveats }) })).assets;
    expect(none.sub).toBe('No investment accounts to measure from');
    expect(notesOf(none)).toEqual([['caution', 'an institution not reached', "Schwab couldn't be reached and isn't counted, so this figure may be low."]]);
  });
});

describe('ages and assumptions', () => {
  test('the ages are their sub; not set, what they are for', () => {
    expect(figureNotes(at()).ages).toEqual({ sub: '40 now, 55 target', line: null, why: null, notes: [] });
    expect(figureNotes(at({ plan: { age: null } })).ages.sub).toBe('? now, 55 target');
    expect(figureNotes(at({ plan: { age: null, targetAge: null } })).ages.sub).toBe('Add them for Coast FI and to place income by age');
  });

  test('the assumptions are their sub, with the part-time income when there is one', () => {
    expect(figureNotes(at()).assumptions).toEqual({ sub: '4% withdrawal · 5% real return until FI · 0% tax', line: null, why: null, notes: [] });
    expect(figureNotes(at({ plan: { withdrawalRate: 0.0425, realReturn: 0.055, taxRate: 0.15, partTimeIncome: 28_000 } })).assumptions.sub).toBe(
      '4.25% withdrawal · 5.5% real return until FI · 15% tax · $28,000 part-time'
    );
  });
});

describe('the notes’ kinds and keys', () => {
  test('two notes that say the same have keys of their own, from the row, the kind and the place, never the text', () => {
    const workplace = { ...noPlans, partial: [{ name: 'Fidelity 401(k)', from: '2026-01-10' }, { name: 'Fidelity 401(k)', from: '2026-01-10' }] } as WorkplaceSavings;
    const notes = figureNotes(at({ workplace, workplaceCount: 1 })).savings.notes;
    expect(notes.map((n) => n.text)).toEqual(["Fidelity 401(k) is counted from Jan 10, 2026, when Nya's record of it starts.", "Fidelity 401(k) is counted from Jan 10, 2026, when Nya's record of it starts."]);
    expect(notes.map((n) => n.key)).toEqual(['savings:a plan counted from later:0', 'savings:a plan counted from later:1']);
    const all = Object.values(figureNotes(at({ unread: [{ institution: 'Chase', reason: 'x' }] }))).flatMap((t) => t.notes.map((n) => n.key));
    expect(new Set(all).size).toBe(all.length);
  });

  test('every kind is a few words, never an amount, with curly apostrophes, and each is one a note can have', () => {
    for (const kind of Object.values(NOTE_KINDS)) {
      expect([kind, /\d|\$/.test(kind)]).toEqual([kind, false]);
      expect([kind, kind.includes("'")]).toEqual([kind, false]);
      expect(kind.split(' ').length).toBeLessThanOrEqual(6);
    }
    // Between them, these say every kind but the notice's two (below).
    const gapped = { ...flows, leftOut: [{ currency: 'EUR', count: 150 }] };
    const workplace = {
      total: 2_000,
      plans: [{ name: 'Empower 403(b)', paidFrom: null, added: 2_000, count: 0, largest: null, matched: 1_500 }],
      fromBank: ['Vanguard Solo 401(k)'],
      partial: [{ name: 'Empower 403(b)', from: '2026-01-10' }],
      shortHistory: [{ name: 'Empower 403(b)', from: '2026-04-02' }],
      problems: [{ name: 'Empower 403(b)', note: 'x' }],
      unmeasured: ['TIAA 457(b)'],
    } as WorkplaceSavings;
    const kinds = new Set(
      [
        at({ flows: gapped }),
        at({ flows: gapped, plan: { savings: 1 } }),
        at({ plan: { savings: 1 } }),
        at({ assets: assets({ leftOut: [{ currency: 'GBP', count: 3 }] }) }),
        at({
          flows: { ...flows, excludedCount: 1, uncategorized: 1, iousBefore: { count: 1, amount: 1 }, cashWithdrawn: 1, cash: 1, unclearLoans: 1, leftOut: [{ currency: 'EUR', count: 1 }] },
          cashUnmarked: true,
          unread: [{ institution: 'Chase', reason: 'x' }],
          withoutTransactions: bothBeside,
          workplace,
          workplaceCount: 1,
        }),
        at({ unread: [{ institution: null, reason: 'x' }], workplace: null, workplaceCount: null }),
        at({ withoutTransactions: investmentsOnly, transactionCount: 12 }),
        at({ flows: null, txnsFailed: true }),
        at({ flows: null, withoutTransactions: investmentsOnly, transactionCount: 0 }),
        at({
          assets: assets({
            unknown: 1,
            caveats: [
              { kind: 'unreachable', institution: 'Schwab' },
              { kind: 'stale', institution: 'Vanguard', asOf: '2026-10-01', at: null },
              { kind: 'missing', institution: 'Fidelity', count: 1 },
            ],
          }),
        }),
      ].flatMap((a) => Object.values(figureNotes(a)).flatMap((t) => t.notes.map((n) => n.kind)))
    );
    const notice: string[] = [NOTE_KINDS.spendingLow, NOTE_KINDS.assetsLow];
    expect(Object.values(NOTE_KINDS).filter((k) => !notice.includes(k) && !kinds.has(k))).toEqual([]);
  });
});

/** The simulation's engine and start for a plan, with its life events, as
 *  the Plan tab works them out. */
function sim(a: FigureArgs, events: LifeEvent[] = []) {
  const f = planFigures(a.plan, measuredInputs({ flows: a.flows, workplace: a.workplace, assets: a.assets }), events);
  if ('refused' in f) throw new Error('refused');
  return { engine: f.engine, startsWith: f.startsWith, view: f.view };
}
const notice = (over: Over, events: LifeEvent[] = []) => {
  const a = at(over);
  const s = sim(a, events);
  return stressNotice({ ...a, view: s.view }, s.engine, s.startsWith).map((n: FigureNote) => [n.level, n.kind, n.text]);
};
/** What the simulation's card is told it starts with, for the same plan:
 *  whether it says it starts with more (`more`), what the walk projects, and
 *  whether the walk stopped short. */
const start = (over: Over, events: LifeEvent[] = []) => {
  const s = sim(at(over), events).startsWith;
  return s ? { more: s.more, projected: s.projected === null ? null : Math.round(s.projected), short: s.short !== null } : null;
};
const SPENDING_LOW = (missing: string) => ['caution', 'spending may be low', `Your annual spending may be low: it is missing ${missing}, and the simulation withdraws it (Your path says which).`];
const SPENDING_FI = (missing: string) => [
  'caution',
  'spending may be low',
  `Your annual spending may be low: it is missing ${missing}, and the simulation starts from the FI number worked out from it (Your path says which).`,
];
const SPENDING_VPW = (missing: string) => [
  'caution',
  'spending may be low',
  `Your annual spending may be low: it is missing ${missing}, and the simulation compares its first year's spending with it (Your path says which).`,
];
const ASSETS_LOW = ['caution', 'invested assets may be low', "Your invested assets may be low: some couldn't be counted (Your path says which)."];
const unreachable = assets({ caveats: [{ kind: 'unreachable', institution: 'Schwab' }] });
/** A home at 41 costing more than there will be by then: the walk from
 *  today's assets can't pay it. */
const HOME: LifeEvent[] = [{ id: 'h', kind: 'house', label: 'Our home', atAge: 41, cost: 800_000, yearly: 0, years: null }];

describe('the Stress test’s notice', () => {
  test('spending that may be low: withdrawn by every rule but VPW; under VPW, said of the FI number it starts from, or of the first year’s spending its card compares with it', () => {
    const unread = [{ institution: 'Chase', reason: 'x' }];
    expect(notice({ unread })).toEqual([SPENDING_LOW("transactions that couldn't be read")]);
    expect(notice({ unread, plan: { rule: 'guardrails', start: 'assets' } })).toEqual([SPENDING_LOW("transactions that couldn't be read")]);
    expect(notice({ withoutTransactions: refusedBeside, plan: { rule: 'vpw', start: 'fi-number' } })).toEqual([SPENDING_FI("transactions Plaid doesn't provide")]);
    // VPW from today's assets, or from a balance typed: its card compares its
    // first year's spending with the annual spending.
    expect(notice({ unread, plan: { rule: 'vpw', start: 'assets' } })).toEqual([SPENDING_VPW("transactions that couldn't be read")]);
    expect(notice({ withoutTransactions: refusedBeside, plan: { rule: 'vpw', start: 'custom', startBalance: 900_000 } })).toEqual([SPENDING_VPW("transactions Plaid doesn't provide")]);
    // Typed, it is what was typed.
    expect(notice({ unread, plan: { spending: 40_000 } })).toEqual([]);
    expect(notice({ unread, plan: { spending: 40_000, rule: 'vpw', start: 'assets' } })).toEqual([]);
  });

  test('invested assets that may be low: when the simulation starts from them, or its card says it starts with more than they would grow to', () => {
    expect(notice({ assets: unreachable, plan: { start: 'assets' } })).toEqual([ASSETS_LOW]);
    // From the FI number at 42, two years from now: the walk from today's
    // assets comes to less, and the card says so, from them.
    expect(start({ assets: unreachable, plan: { targetAge: 42 } })).toMatchObject({ more: true, short: false });
    expect(notice({ assets: unreachable, plan: { targetAge: 42 } })).toEqual([ASSETS_LOW]);
    // A cost the walk from them can't pay: nothing projected, and the card
    // says it starts with more all the same.
    expect(start({ assets: unreachable }, HOME)).toEqual({ more: true, projected: null, short: true });
    expect(notice({ assets: unreachable }, HOME)).toEqual([ASSETS_LOW]);
    // At 55 they would grow past the FI number: projected, but the card says
    // nothing of them, so neither does the notice.
    const at55 = start({ assets: unreachable });
    expect(at55?.more).toBe(false);
    expect(at55?.projected).toBeGreaterThan(1_000_000);
    expect(notice({ assets: unreachable })).toEqual([]);
    // With no age nothing is projected, so nothing reads them.
    expect(start({ assets: unreachable, plan: { age: null } })).toEqual({ more: false, projected: null, short: false });
    expect(notice({ assets: unreachable, plan: { start: 'fi-number', age: null } })).toEqual([]);
    // A balance typed above what they would grow to is said from them too;
    // one below it isn't.
    expect(notice({ assets: unreachable, plan: { start: 'custom', startBalance: 2_000_000 } })).toEqual([ASSETS_LOW]);
    expect(notice({ assets: unreachable, plan: { start: 'custom', startBalance: 900_000 } })).toEqual([]);
    // A stale balance alone is still counted.
    expect(notice({ assets: assets({ caveats: [{ kind: 'stale', institution: 'Vanguard', asOf: '2026-10-01', at: null }] }), plan: { start: 'assets' } })).toEqual([]);
    // Typed, they are what was typed, whatever couldn't be reached.
    expect(notice({ assets: unreachable, plan: { assets: 300_000, start: 'assets' } })).toEqual([]);
    expect(notice({ assets: unreachable, plan: { assets: 300_000, targetAge: 42 } })).toEqual([]);
    // Both, the spending first.
    expect(notice({ assets: unreachable, unread: [{ institution: null, reason: 'x' }], plan: { start: 'assets' } })).toEqual([SPENDING_LOW("transactions that couldn't be read"), ASSETS_LOW]);
  });

  test('none while the simulation can’t run: its card says what it needs', () => {
    const a = at({ assets: unreachable, unread: [{ institution: 'Chase', reason: 'x' }], plan: { start: 'assets' } });
    expect(stressNotice(a, { missing: 'assets' })).toEqual([]);
    expect(stressNotice(a, { missing: 'spending' }, null)).toEqual([]);
  });
});

describe('inputFlags', () => {
  test('what measured spending is missing, and whether measured invested assets may be low; nothing of a typed figure', () => {
    expect(inputFlags(at())).toEqual({ spendingMissing: null, assetsShort: false });
    expect(inputFlags(at({ unread: [{ institution: 'Chase', reason: 'x' }] })).spendingMissing).toBe("transactions that couldn't be read");
    expect(inputFlags(at({ withoutTransactions: bothBeside })).spendingMissing).toBe("transactions Plaid doesn't provide or you didn't allow");
    expect(inputFlags(at({ unread: [{ institution: 'Chase', reason: 'x' }], plan: { spending: 40_000 } })).spendingMissing).toBeNull();
    expect(inputFlags(at({ assets: unreachable })).assetsShort).toBe(true);
    expect(inputFlags(at({ assets: assets({ caveats: [{ kind: 'missing', institution: 'Fidelity', count: 1 }] }) })).assetsShort).toBe(true);
    // A stale balance is still counted.
    expect(inputFlags(at({ assets: assets({ caveats: [{ kind: 'stale', institution: 'Vanguard', asOf: '2026-10-01', at: null }] }) })).assetsShort).toBe(false);
    // Typed assets beside a bank that couldn't be reached: what was typed counts.
    expect(inputFlags(at({ assets: unreachable, plan: { assets: 300_000 } })).assetsShort).toBe(false);
  });

  /** The FI card's two lines on its number, for the same inputs. */
  const lines = (a: FigureArgs) => {
    const html = renderToStaticMarkup(
      createElement(FiCard, {
        plan: a.plan,
        view: a.view,
        unread: a.unread,
        withoutTransactions: a.withoutTransactions,
        transactionCount: a.transactionCount,
        assets: a.assets,
        currencyNote: null,
        money,
      })
    ).replace(/&#x27;/g, "'");
    return { spending: html.match(/May be low: spending is missing ([^<]*) \(below\)\./)?.[1] ?? null, assets: html.includes('Invested assets may be low (below).') };
  };

  test('the FI card draws on its number what inputFlags says, for each input', () => {
    for (const over of [
      {},
      { unread: [{ institution: 'Chase', reason: 'x' }] },
      { unread: [{ institution: null, reason: 'x' }], plan: { spending: 40_000 } },
      { withoutTransactions: bothBeside },
      { assets: unreachable },
      { assets: unreachable, plan: { assets: 300_000 } },
      { assets: assets({ caveats: [{ kind: 'missing', institution: 'Fidelity', count: 1 }] }) },
      { assets: assets({ caveats: [{ kind: 'stale', institution: 'Vanguard', asOf: '2026-10-01', at: null }] }) },
    ] satisfies Over[]) {
      const a = at(over);
      const f = inputFlags(a);
      expect([over, { spending: f.spendingMissing, assets: f.assetsShort }]).toEqual([over, lines(a)]);
    }
  });
});

test('windowText is still said from PlanTab, where tests and the sheet read it', async () => {
  const tab = await import('@/components/PlanTab');
  expect(tab.windowText(flows)).toBe(windowText(flows));
  expect(windowText(flows)).toBe(WINDOW);
});
