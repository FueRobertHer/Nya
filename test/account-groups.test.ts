import { describe, expect, test } from 'bun:test';
import { groupOf, summarize } from '@/components/account-groups';
import { AccountSubtype } from 'plaid';
import { accountKindParts, kindWords, signedBalance, subtypeWords, type Account, type Institution } from '@/components/accounts-format';
import type { PageFx } from '@/lib/fx/view';
import type { ConnectionHealth } from '@/lib/connection-state';
import type { ConnectorIssue } from '@/lib/connectors/types';

// The Accounts tab's line by type (rollout phase 3c): the accounts on the
// cards, by kind, and what it can't count, told from the accounts themselves.

const account = (over: Partial<Account> = {}): Account => ({
  account_id: 'acc',
  name: 'Account',
  official_name: null,
  mask: null,
  type: 'depository',
  subtype: 'checking',
  balance: 100,
  limit: null,
  currency: 'USD',
  ...over,
});

const institution = (over: Partial<Institution> = {}): Institution => ({
  institution_name: 'Chase',
  item_id: 'item_chase',
  accounts: [account()],
  holdings: [],
  error: null,
  needs_reauth: false,
  ...over,
});

/** A SimpleFIN connection's health with this issue (lib/connectors/health.ts). */
const connector = (issue: ConnectorIssue): ConnectionHealth => ({
  state: issue === 'waiting' ? 'partial' : 'needs_reauth',
  cause: 'connector',
  side: 'you',
  action: 'none',
  last_ok_at: null,
  detail: { connector: 'simplefin', label: 'SimpleFIN', host: null, connection_id: 'conn_1', issue, messages: [], accounts: [] },
});

const NOW = Date.parse('2026-10-23T12:00:00Z');
const FX: PageFx = { home: 'USD', latest: { date: '2026-10-22', rates: { USD: '1.1' } }, own: [] };

describe('the kinds', () => {
  test('each account type goes to its kind, the legacy brokerage with investments', () => {
    expect(['depository', 'credit', 'investment', 'brokerage', 'loan', 'other', 'mystery'].map(groupOf)).toEqual([
      'cash',
      'credit',
      'investments',
      'investments',
      'loans',
      'other',
      'other',
    ]);
  });

  test('in a fixed order, only those present, debts as debts', () => {
    const s = summarize(
      [
        institution({
          accounts: [
            account({ type: 'loan', balance: 9000 }),
            account({ type: 'depository', balance: 1200 }),
            account({ type: 'credit', balance: 300 }),
            account({ type: 'depository', balance: 800 }),
          ],
        }),
      ],
      null,
      'USD',
      NOW
    );
    expect(s.groups.map((g) => [g.label, g.total, g.currency, g.incomplete])).toEqual([
      ['Cash', 2000, 'USD', false],
      ['Credit', -300, 'USD', false],
      ['Loans', -9000, 'USD', false],
    ]);
    expect(s.short).toBeNull();
    expect(s.dated).toEqual([]);
    expect(s.currencyNote).toBeNull();
  });

  test('the kinds add up to the cards’ subtotals, so the line never disagrees with them', () => {
    const insts = [
      institution({ accounts: [account({ balance: 1200 }), account({ type: 'credit', balance: 450.5 })] }),
      institution({ institution_name: 'Fidelity', item_id: 'f', accounts: [account({ type: 'investment', balance: 50000 }), account({ type: 'loan', balance: 20000 })] }),
    ];
    const s = summarize(insts, null, 'USD', NOW);
    const cards = insts.reduce((sum, i) => sum + i.accounts.reduce((t, a) => t + signedBalance(a), 0), 0);
    expect(s.groups.reduce((sum, g) => sum + (g.total ?? 0), 0)).toBeCloseTo(cards, 9);
  });
});

describe('what it can’t count', () => {
  test('a held account with no balance marks its own kind, and names its institution', () => {
    const s = summarize(
      [institution({ accounts: [account(), account({ type: 'credit', balance: null, held: { as_of: null } })] })],
      null,
      'USD',
      NOW
    );
    expect(s.groups.map((g) => [g.key, g.incomplete])).toEqual([
      ['cash', false],
      ['credit', true],
    ]);
    expect(s.short).toEqual({ institutions: ['Chase'], untyped: false });
  });

  test('a held account Nya never knew the kind of marks no kind: any may be short', () => {
    const s = summarize([institution({ accounts: [account(), account({ type: 'other', balance: null, held: { as_of: null } })] })], null, 'USD', NOW);
    expect(s.groups.every((g) => !g.incomplete)).toBe(true);
    expect(s.short).toEqual({ institutions: ['Chase'], untyped: true });
  });

  test('an account a broken card can’t show marks its kind, even with none of it on screen', () => {
    const s = summarize(
      [
        institution({
          error: 'Needs reconnecting',
          stale_as_of: '2026-10-21',
          stale_missing: 1,
          accounts: [account({ stale: true })],
          unshown_accounts: [{ account_id: 'x', name: 'Mortgage', mask: null, type: 'loan' }],
        }),
      ],
      null,
      'USD',
      NOW
    );
    // No loan is on screen to add: the kind has no figure, only its mark.
    expect(s.groups.map((g) => [g.key, g.total, g.incomplete])).toEqual([
      ['cash', 100, false],
      ['loans', null, true],
    ]);
    expect(s.short).toEqual({ institutions: ['Chase'], untyped: false });
    expect(s.dated).toEqual(['Chase']);
  });

  test('missing accounts with no names: no kind is marked, the institution is named', () => {
    const s = summarize(
      [institution({ error: 'Needs reconnecting', stale_as_of: '2026-10-21', stale_missing: 2, accounts: [account({ stale: true }), account({ type: 'credit', stale: true })] })],
      null,
      'USD',
      NOW
    );
    expect(s.groups.every((g) => !g.incomplete)).toBe(true);
    expect(s.short).toEqual({ institutions: ['Chase'], untyped: true });
  });

  test('nothing fetched or recovered at all is short too', () => {
    const s = summarize([institution({ error: 'Something went wrong', accounts: [] }), institution({ institution_name: 'Ally', item_id: 'a' })], null, 'USD', NOW);
    expect(s.short).toEqual({ institutions: ['Chase'], untyped: true });
  });

  test('a connector’s account with no balance (waiting for its sign) marks its kind, as its red card does', () => {
    const s = summarize(
      [institution({ manual: true, connector: 'simplefin', health: connector('sign'), accounts: [account(), account({ type: 'credit', balance: null })] })],
      null,
      'USD',
      NOW
    );
    expect(s.groups.find((g) => g.key === 'credit')).toMatchObject({ total: null, incomplete: true });
    expect(s.short?.institutions).toEqual(['Chase']);
  });

  test('a new connection waiting for its first answer was never in the total: amber, as its card, not red', () => {
    const s = summarize(
      [
        institution({
          manual: true,
          connector: 'simplefin',
          error: 'Waiting for SimpleFIN’s answer',
          health: connector('waiting'),
          accounts: [account({ balance: null }), account({ type: 'credit', balance: null })],
        }),
        institution({ institution_name: 'Ally', item_id: 'a', accounts: [account(), account({ type: 'credit', balance: 5 })] }),
      ],
      null,
      'USD',
      NOW
    );
    expect(s.groups.every((g) => !g.incomplete)).toBe(true);
    expect(s.short).toBeNull();
    expect(s.dated).toEqual(['Chase']);
  });

  test('a count with no names is said even when a held account names one kind', () => {
    const s = summarize(
      [institution({ error: 'Down', stale_as_of: '2026-10-21', stale_missing: 2, accounts: [account({ stale: true }), account({ type: 'credit', balance: null, held: { as_of: null } })] })],
      null,
      'USD',
      NOW
    );
    expect(s.groups.find((g) => g.key === 'credit')?.incomplete).toBe(true);
    expect(s.short).toEqual({ institutions: ['Chase'], untyped: true });
  });

  test('a healthy account with no balance is counted as nothing, as its card shows it', () => {
    const s = summarize([institution({ accounts: [account(), account({ type: 'credit', balance: null })] })], null, 'USD', NOW);
    expect(s.short).toBeNull();
  });

  test('balances recovered during an outage, held at a last known one, or an account the bank stopped sending: dated', () => {
    const s = summarize(
      [
        institution({ error: 'Down', stale_as_of: '2026-10-21', accounts: [account({ stale: true })] }),
        institution({ institution_name: 'Ally', item_id: 'a', accounts: [account({ balance: 50, held: { as_of: '2026-10-01' } })] }),
        institution({ institution_name: 'Citi', item_id: 'c', unconfirmed_missing: 1 }),
        institution({ institution_name: 'Discover', item_id: 'd' }),
      ],
      null,
      'USD',
      NOW
    );
    expect(s.dated).toEqual(['Chase', 'Ally', 'Citi']);
    expect(s.short).toBeNull();
  });
});

describe('currencies', () => {
  test('mixed with a home currency: converted at the newest rates, with the cards’ note', () => {
    const s = summarize([institution({ accounts: [account({ balance: 100 }), account({ balance: 100, currency: 'EUR' })] })], FX, 'USD', NOW);
    expect(s.groups[0]).toMatchObject({ key: 'cash', currency: 'USD', incomplete: false });
    expect(s.groups[0].total).toBeCloseTo(210, 6);
    expect(s.currencyNote).toBe('Mixed currencies, converted into USD at the ECB’s newest rates.');
  });

  test('a currency with no rate marks the kinds it is in', () => {
    const s = summarize(
      [institution({ accounts: [account({ balance: 100 }), account({ type: 'credit', balance: 5, currency: 'XYZ' })] })],
      FX,
      'USD',
      NOW
    );
    expect(s.groups.map((g) => [g.key, g.incomplete])).toEqual([
      ['cash', false],
      ['credit', true],
    ]);
    expect(s.currencyNote).toContain('XYZ isn’t in it');
  });

  test('mixed with nothing to convert: a kind in one currency keeps its sum, a mixed one says so', () => {
    const s = summarize(
      [institution({ accounts: [account({ balance: 100 }), account({ balance: 100, currency: 'EUR' }), account({ type: 'credit', balance: 40, currency: 'EUR' })] })],
      null,
      'USD',
      NOW
    );
    expect(s.groups.map((g) => [g.key, g.total, g.mixed, g.currency])).toEqual([
      ['cash', null, true, null],
      ['credit', -40, false, 'EUR'],
    ]);
    expect(s.currencyNote).toBe('Mixed currencies; totals aren’t converted.');
  });

  test('an account with no currency is counted in the main one, and doesn’t make them mixed', () => {
    const s = summarize([institution({ accounts: [account({ currency: null }), account({ type: 'credit', currency: null, balance: 5 })] })], FX, 'EUR', NOW);
    expect(s.groups.map((g) => [g.total, g.currency])).toEqual([
      [100, 'EUR'],
      [-5, 'EUR'],
    ]);
    expect(s.currencyNote).toBeNull();
  });
});

describe('what kind of account it is', () => {
  const inst = { manual: false } as Institution;
  const acct = (over: Partial<Account>) => ({ name: 'Everyday', official_name: null, type: 'depository', subtype: 'checking', currency: null, ...over }) as Account;
  const kind = (over: Partial<Account>, i: Institution = inst) => accountKindParts(acct(over), i, 'USD');

  test("the bank's own name, without the kind it already says", () => {
    expect(kind({ official_name: 'Plaid Gold Standard 0% Interest Checking' })).toEqual(['Plaid Gold Standard 0% Interest Checking']);
    expect(kind({ official_name: 'Everyday Money Market Account', subtype: 'money market' })).toEqual(['Everyday Money Market Account']);
    // The screen review's "... Interest Saving · savings": one word, plural or not.
    expect(kind({ official_name: 'Plaid Silver Standard 0.1% Interest Saving', subtype: 'savings' })).toEqual(['Plaid Silver Standard 0.1% Interest Saving']);
  });

  test('nothing when its own name says it, as the title over it already does', () => {
    expect(kind({ name: 'Plaid Checking' })).toEqual([]);
    expect(kind({ name: 'Northwind 401(k)', type: 'investment', subtype: '401k' })).toEqual([]);
    expect(kind({ name: 'Plaid IRA', type: 'investment', subtype: 'ira' })).toEqual([]);
    expect(kind({ name: 'Plaid Student Loan', type: 'loan', subtype: 'student' })).toEqual([]);
  });

  test('the kind in words when no name says it, or a word only contains it', () => {
    expect(kind({ official_name: 'Checkingplus Rewards' })).toEqual(['Checkingplus Rewards', 'Checking']);
    expect(kind({})).toEqual(['Checking']);
    expect(kind({ subtype: null })).toEqual(['Bank account']);
    expect(kind({ name: 'Car', type: 'loan', subtype: 'auto' })).toEqual(['Auto loan']);
    expect(kind({ name: 'House', type: 'loan', subtype: 'other' })).toEqual(['Loan']);
  });

  test('a typed balance in another currency says so, as a part of its own', () => {
    const typed = { manual: true } as Institution;
    expect(kind({ name: 'Cash', currency: 'EUR' }, typed)).toEqual(['Checking', 'in EUR']);
    // Its name says the kind: the currency alone, never a "·" with nothing before it.
    expect(kind({ name: 'Plaid Checking', currency: 'EUR' }, typed)).toEqual(['in EUR']);
  });

  test('the payoff plan and Hidden accounts name the kind the same way', () => {
    expect(kindWords({ name: 'Plaid Auto', official_name: null, type: 'loan', subtype: 'auto' })).toBeNull();
    expect(kindWords({ name: 'Car', type: 'loan', subtype: 'auto' })).toBe('Auto loan');
  });
});

describe("Plaid's account subtypes in words", () => {
  // Every subtype Plaid lists (plaid v27, AccountSubtype), as a label.
  const EXPECTED: Record<string, string> = {
    '401a': '401(a)',
    '401k': '401(k)',
    '403B': '403(b)',
    '457b': '457(b)',
    '529': '529 plan',
    auto: 'Auto loan',
    brokerage: 'Brokerage',
    business: 'Business loan',
    'cash isa': 'Cash ISA',
    'cash management': 'Cash management',
    cd: 'CD',
    checking: 'Checking',
    commercial: 'Commercial loan',
    construction: 'Construction loan',
    consumer: 'Consumer loan',
    'credit card': 'Credit card',
    'crypto exchange': 'Crypto exchange',
    ebt: 'EBT',
    'education savings account': 'Education savings account',
    'fixed annuity': 'Fixed annuity',
    gic: 'GIC',
    'health reimbursement arrangement': 'Health reimbursement arrangement',
    'home equity': 'Home equity loan',
    hsa: 'HSA',
    isa: 'ISA',
    ira: 'IRA',
    keogh: 'Keogh plan',
    lif: 'LIF',
    'life insurance': 'Life insurance',
    'line of credit': 'Line of credit',
    lira: 'LIRA',
    loan: 'Loan',
    lrif: 'LRIF',
    lrsp: 'LRSP',
    'money market': 'Money market',
    mortgage: 'Mortgage',
    'mutual fund': 'Mutual fund',
    'non-custodial wallet': 'Non-custodial wallet',
    'non-taxable brokerage account': 'Non-taxable brokerage account',
    other: 'Other',
    'other insurance': 'Other insurance',
    'other annuity': 'Other annuity',
    overdraft: 'Overdraft',
    paypal: 'PayPal',
    payroll: 'Payroll',
    pension: 'Pension',
    prepaid: 'Prepaid',
    prif: 'PRIF',
    'profit sharing plan': 'Profit sharing plan',
    rdsp: 'RDSP',
    resp: 'RESP',
    retirement: 'Retirement',
    rlif: 'RLIF',
    roth: 'Roth IRA',
    'roth 401k': 'Roth 401(k)',
    rrif: 'RRIF',
    rrsp: 'RRSP',
    sarsep: 'SARSEP',
    savings: 'Savings',
    'sep ira': 'SEP IRA',
    'simple ira': 'SIMPLE IRA',
    sipp: 'SIPP',
    'stock plan': 'Stock plan',
    student: 'Student loan',
    'thrift savings plan': 'Thrift Savings Plan',
    tfsa: 'TFSA',
    trust: 'Trust',
    ugma: 'UGMA',
    utma: 'UTMA',
    'variable annuity': 'Variable annuity',
  };

  test('every subtype Plaid lists is listed here', () => {
    const plaid: string[] = Object.values(AccountSubtype);
    expect([...plaid].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [subtype, words] of Object.entries(EXPECTED)) {
    test(`"${subtype}" reads "${words}"`, () => {
      expect(subtypeWords(subtype, 'other')).toBe(words);
    });
  }

  test('none, or "other", says the type, and in a sentence only names and letters keep their capitals', () => {
    expect(subtypeWords(null, 'loan')).toBe('Loan');
    expect(subtypeWords('other', 'investment')).toBe('Investment');
    expect(subtypeWords(null, 'depository')).toBe('Bank account');
    expect(subtypeWords('brokerage', 'investment', true)).toBe('brokerage');
    expect(subtypeWords('auto', 'loan', true)).toBe('auto loan');
    expect(subtypeWords('401k', 'investment', true)).toBe('401(k)');
    expect(subtypeWords('roth', 'investment', true)).toBe('Roth IRA');
    expect(subtypeWords('sep ira', 'investment', true)).toBe('SEP IRA');
  });
});
