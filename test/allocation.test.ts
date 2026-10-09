import { describe, expect, test } from 'bun:test';
import { InvestmentAccountSubtype } from 'plaid';
import { accountBucket, DECIDED_SUBTYPES, subtypeBucket, type BucketSlot } from '@/lib/allocation/buckets';
import { classify, isCompleteSplit, securityKey, splitProblem, splitText, spread, type FundSplits, type Split } from '@/lib/allocation/classes';
import { FUNDS, fundSplit } from '@/lib/allocation/funds';
import { EMPTY_SETTINGS, SETTINGS_LIMITS, TICKER, isAllocationSettings, overridesOf, parseSettings, withAccountSplit, withBucket, withFund, type AllocationSettings } from '@/lib/allocation/settings';

// Tax buckets, by Plaid's account subtype. Every investment subtype Plaid
// lists is decided on purpose, and a Plaid release listing one more fails
// the first test here until it is decided too.
describe('tax buckets', () => {
  // Plaid's list (plaid v27, InvestmentAccountSubtype), with its bucket here.
  // "all" is a Link filter, not a subtype.
  const EXPECTED: Record<string, BucketSlot> = {
    '529': 'education',
    '401a': 'tax-deferred',
    '401k': 'tax-deferred',
    '403B': 'tax-deferred',
    '457b': 'tax-deferred',
    brokerage: 'taxable',
    'cash isa': 'roth',
    'crypto exchange': 'taxable',
    'education savings account': 'education',
    'fixed annuity': 'tax-deferred',
    gic: 'unclassified',
    'health reimbursement arrangement': 'unclassified',
    hsa: 'hsa',
    ira: 'tax-deferred',
    isa: 'roth',
    keogh: 'tax-deferred',
    lif: 'tax-deferred',
    'life insurance': 'unclassified',
    lira: 'tax-deferred',
    lrif: 'tax-deferred',
    lrsp: 'tax-deferred',
    'mutual fund': 'unclassified',
    'non-custodial wallet': 'taxable',
    'non-taxable brokerage account': 'unclassified',
    other: 'unclassified',
    'other annuity': 'tax-deferred',
    'other insurance': 'unclassified',
    pension: 'tax-deferred',
    prif: 'tax-deferred',
    'profit sharing plan': 'tax-deferred',
    qshr: 'unclassified',
    rdsp: 'tax-deferred',
    resp: 'education',
    retirement: 'unclassified',
    rlif: 'tax-deferred',
    roth: 'roth',
    'roth 401k': 'roth',
    rrif: 'tax-deferred',
    rrsp: 'tax-deferred',
    sarsep: 'tax-deferred',
    'sep ira': 'tax-deferred',
    'simple ira': 'tax-deferred',
    sipp: 'tax-deferred',
    'stock plan': 'taxable',
    tfsa: 'roth',
    trust: 'taxable',
    ugma: 'taxable',
    utma: 'taxable',
    'variable annuity': 'tax-deferred',
  };

  test('every investment subtype Plaid lists is decided here, and this test lists each', () => {
    const plaid: string[] = Object.values(InvestmentAccountSubtype).filter((s) => s !== 'all');
    expect([...plaid].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const s of plaid) expect(DECIDED_SUBTYPES).toContain(s.toLowerCase());
  });

  for (const [subtype, bucket] of Object.entries(EXPECTED)) {
    test(`a "${subtype}" account is ${bucket}`, () => {
      const r = subtypeBucket(subtype);
      expect(r.bucket ?? 'unclassified').toBe(bucket);
      // An unclassified one always says why, for the line beside it.
      if (r.bucket === null) expect(r.why.length).toBeGreaterThan(10);
    });
  }

  test('the subtypes outside Plaid’s investment list that reach investment accounts', () => {
    expect(subtypeBucket('thrift savings plan').bucket).toBe('tax-deferred');
    expect(subtypeBucket('tsp').bucket).toBe('tax-deferred');
    expect(subtypeBucket('cash management').bucket).toBe('taxable');
    expect(subtypeBucket('money market').bucket).toBe('taxable');
  });

  test('case does not matter: Plaid writes "403B"', () => {
    expect(subtypeBucket('403B').bucket).toBe('tax-deferred');
    expect(subtypeBucket('403b').bucket).toBe('tax-deferred');
    expect(subtypeBucket('Roth 401K').bucket).toBe('roth');
  });

  test('an unknown or missing subtype is unclassified, never a guess', () => {
    for (const s of ['savings plan of the future', 'constructor', '__proto__', 'all', '', null, undefined]) {
      const r = subtypeBucket(s);
      expect(r.bucket).toBeNull();
    }
    expect(subtypeBucket(null)).toMatchObject({ why: expect.stringContaining("didn't say") });
  });

  test('the person’s bucket wins, and what the subtype says is kept beside it', () => {
    // A 401(k) holding Roth money: the subtype can't say so.
    expect(accountBucket('401k', 'roth')).toEqual({ bucket: 'roth', from: 'you', subtype: 'tax-deferred', why: null });
    expect(accountBucket('401k', undefined)).toEqual({ bucket: 'tax-deferred', from: 'subtype', subtype: 'tax-deferred', why: null });
    const none = accountBucket('retirement', undefined);
    expect(none.bucket).toBe('unclassified');
    expect(none.from).toBe('none');
    expect(none.why).toContain('which kind');
    expect(accountBucket('retirement', 'tax-deferred')).toMatchObject({ bucket: 'tax-deferred', from: 'you', subtype: 'unclassified' });
  });
});

const NONE: FundSplits = { byTicker: new Map(), byName: new Map() };
const splits = (byTicker: Record<string, Split> = {}, byName: Record<string, Split> = {}): FundSplits => ({
  byTicker: new Map(Object.entries(byTicker)),
  byName: new Map(Object.entries(byName)),
});

describe('splits', () => {
  test('add up to exactly 100, counted in tenths', () => {
    expect(splitProblem({ 'us-stocks': 100 })).toBeNull();
    expect(splitProblem({ 'us-stocks': 33.3, 'intl-stocks': 33.3, bonds: 33.4 })).toBeNull();
    expect(splitProblem({ 'us-stocks': 0.1, bonds: 99.9 })).toBeNull();
    expect(splitProblem({ 'us-stocks': 50, bonds: 49.9 })).toContain('99.9%');
    expect(splitProblem({ 'us-stocks': 60, bonds: 60 })).toContain('120%');
  });

  test('every share above 0 and at most 100, with at most one decimal, of a known class', () => {
    expect(splitProblem({})).toContain('at least one');
    expect(splitProblem({ 'us-stocks': 100, bonds: 0 })).toContain('above 0');
    expect(splitProblem({ 'us-stocks': 110, cash: -10 })).toContain('above 0');
    expect(splitProblem({ 'us-stocks': 50.05, bonds: 49.95 })).toContain('one decimal');
    expect(splitProblem({ gold: 100 })).toContain('unknown class');
    expect(splitProblem({ unclassified: 100 })).toContain('unknown class');
    expect(splitProblem({ 'us-stocks': NaN })).not.toBeNull();
    expect(splitProblem({ 'us-stocks': '100' })).not.toBeNull();
    expect(splitProblem(null)).not.toBeNull();
    expect(splitProblem([100])).not.toBeNull();
  });

  test('a value spread over a split always adds back up to the value, exactly', () => {
    const parts = spread(1000.01, { 'us-stocks': 33.3, 'intl-stocks': 33.3, bonds: 33.4 });
    expect(parts.map(([c]) => c)).toEqual(['us-stocks', 'intl-stocks', 'bonds']);
    expect(parts.reduce((s, [, v]) => s + v, 0)).toBe(1000.01);
    // A negative value (a short position) spreads with its sign.
    expect(spread(-500, { 'us-stocks': 60, bonds: 40 })).toEqual([['us-stocks', -300], ['bonds', -200]]);
  });

  test('read as a sentence', () => {
    expect(splitText({ bonds: 40, 'us-stocks': 60 })).toBe('60% US stocks, 40% bonds');
    expect(splitText({ stocks: 80, bonds: 20 })).toBe('80% stocks (region unknown), 20% bonds');
  });
});

describe('the classifier', () => {
  const fund = (ticker: string | null, over: Record<string, unknown> = {}) => ({ ticker, name: ticker ? `${ticker} fund` : null, security_type: 'etf', is_cash_equivalent: false, ...over });

  test('cash equivalents are cash, by lib/cash.ts’s rule', () => {
    expect(classify({ ticker: 'XYZ', security_type: 'mutual fund', is_cash_equivalent: true })).toEqual({ split: { cash: 100 }, by: 'cash' });
    expect(classify({ ticker: 'CUR:USD', security_type: null, is_cash_equivalent: null })).toEqual({ split: { cash: 100 }, by: 'cash' });
    expect(classify({ ticker: 'VMFXX', security_type: 'mutual fund', is_cash_equivalent: false })).toEqual({ split: { cash: 100 }, by: 'cash' });
    expect(classify({ ticker: null, name: 'Acme Government Money Market Fund', security_type: null })).toEqual({ split: { cash: 100 }, by: 'cash' });
    expect(classify({ ticker: 'ZZZ', security_type: 'cash' })).toEqual({ split: { cash: 100 }, by: 'cash' });
  });

  test('funds on Nya’s list take its split', () => {
    expect(classify(fund('VTI'))).toEqual({ split: { 'us-stocks': 100 }, by: 'list' });
    expect(classify(fund('BND'))).toEqual({ split: { bonds: 100 }, by: 'list' });
    expect(classify(fund('VXUS'))).toEqual({ split: { 'intl-stocks': 100 }, by: 'list' });
    expect(classify(fund('vtsax', { security_type: 'mutual fund' }))).toEqual({ split: { 'us-stocks': 100 }, by: 'list' });
    expect(classify(fund('VBIAX', { security_type: 'mutual fund' }))).toEqual({ split: { 'us-stocks': 60, bonds: 40 }, by: 'list' });
    // A world fund: surely stocks, but its region split moves.
    expect(classify(fund('VT'))).toEqual({ split: { stocks: 100 }, by: 'list' });
  });

  test('the person’s split wins over the list, the cash rule and the type', () => {
    const mine = splits({ VTI: { 'us-stocks': 90, cash: 10 }, VMFXX: { bonds: 100 }, AAPL: { 'us-stocks': 100 } });
    expect(classify(fund('VTI'), mine)).toEqual({ split: { 'us-stocks': 90, cash: 10 }, by: 'yours' });
    expect(classify({ ticker: 'VMFXX', is_cash_equivalent: true }, mine)).toEqual({ split: { bonds: 100 }, by: 'yours' });
    expect(classify({ ticker: 'aapl', security_type: 'equity' }, mine)).toEqual({ split: { 'us-stocks': 100 }, by: 'yours' });
  });

  test('a security with no ticker is classified by its name, never by the placeholder', () => {
    const mine = splits({}, { 'target retirement 2050 trust ii': { 'us-stocks': 54, 'intl-stocks': 36, bonds: 10 } });
    const trust = { ticker: null, name: '  Target Retirement  2050 Trust II ', security_type: 'mutual fund' };
    expect(classify(trust, mine)).toEqual({ split: { 'us-stocks': 54, 'intl-stocks': 36, bonds: 10 }, by: 'yours' });
    // Its name doesn't classify one that has a ticker.
    expect(classify({ ...trust, ticker: 'VFIFX' }, mine)).toEqual({ split: null, why: 'fund' });
    expect(securityKey({ ticker: null, name: 'Unknown' })).toBeNull();
    expect(securityKey({ ticker: '  vti ' })).toEqual({ ticker: 'VTI' });
    expect(securityKey({ ticker: null, name: null })).toBeNull();
  });

  test('a target-date, balanced or unknown fund is unclassified until the person classifies it', () => {
    expect(classify(fund('VFIFX', { name: 'Vanguard Target Retirement 2050 Fund', security_type: 'mutual fund' }))).toEqual({ split: null, why: 'fund' });
    expect(classify(fund('VWELX', { name: 'Vanguard Wellington Fund', security_type: 'mutual fund' }))).toEqual({ split: null, why: 'fund' });
    expect(classify(fund('ARKK'))).toEqual({ split: null, why: 'fund' });
    expect(classify({ ticker: 'XYZ', security_type: 'other' })).toEqual({ split: null, why: 'unknown' });
    expect(classify({ ticker: 'XYZ', security_type: null })).toEqual({ split: null, why: 'unknown' });
    expect(classify({ ticker: 'XYZ', security_type: 'warrant of the future' })).toEqual({ split: null, why: 'unknown' });
    expect(classify({ ticker: 'XYZ', security_type: 'constructor' })).toEqual({ split: null, why: 'unknown' });
  });

  test('a security that is one class by itself is classified by Plaid’s type', () => {
    // "Domestic and foreign equities": a stock, region unknown.
    expect(classify({ ticker: 'AAPL', security_type: 'equity' })).toEqual({ split: { stocks: 100 }, by: 'type' });
    expect(classify({ ticker: 'T 2.5 2030', security_type: 'fixed income' })).toEqual({ split: { bonds: 100 }, by: 'type' });
    expect(classify({ ticker: 'BTC', security_type: 'cryptocurrency' })).toEqual({ split: { crypto: 100 }, by: 'type' });
    expect(classify({ ticker: 'AAPL250117C00150000', security_type: 'derivative' })).toEqual({ split: { other: 100 }, by: 'type' });
    expect(classify({ ticker: 'NOTE1', security_type: 'Loan' })).toEqual({ split: { other: 100 }, by: 'type' });
  });

  test('a saved split that doesn’t add up is used for nothing', () => {
    expect(classify(fund('VTI'), splits({ VTI: { 'us-stocks': 99 } }))).toEqual({ split: null, why: 'bad-split' });
  });

  test('with no splits at all', () => {
    expect(classify(fund('VTI'), NONE)).toEqual({ split: { 'us-stocks': 100 }, by: 'list' });
  });
});

describe('Nya’s list of funds', () => {
  test('every entry is a complete split under a ticker in Plaid’s format, with its name', () => {
    for (const [ticker, entry] of Object.entries(FUNDS)) {
      expect(TICKER.test(ticker)).toBe(true);
      expect(isCompleteSplit(entry.split)).toBe(true);
      expect(entry.name.length).toBeGreaterThan(5);
      expect(fundSplit(ticker.toLowerCase())).toBe(entry);
    }
  });

  test('holds no target-date fund, whose mix moves every year', () => {
    for (const entry of Object.values(FUNDS)) expect(entry.name).not.toMatch(/target|retirement 20\d\d|20[2-7]\d fund/i);
  });

  test('is a small list', () => {
    const n = Object.keys(FUNDS).length;
    expect(n).toBeGreaterThan(50);
    expect(n).toBeLessThan(150);
  });

  test('a ticker it doesn’t have, or a prototype name, is not on it', () => {
    expect(fundSplit('NOPE')).toBeNull();
    expect(fundSplit('constructor')).toBeNull();
    expect(fundSplit('__proto__')).toBeNull();
  });
});

describe('the settings’ validation', () => {
  const full: AllocationSettings = {
    v: 1,
    buckets: [
      { account_id: 'acc_401k', bucket: 'roth' },
      { account_id: 'manual_9bcb3f0c-5760', bucket: 'taxable' },
    ],
    funds: [
      { ticker: 'VFIFX', split: { 'us-stocks': 54, 'intl-stocks': 36, bonds: 10 } },
      { name: 'Target Retirement 2050 Trust II', split: { stocks: 90, bonds: 10 } },
    ],
    accounts: [{ account_id: 'manual_9bcb3f0c-5760', split: { 'us-stocks': 80, bonds: 20 } }],
    target: { 'us-stocks': 50, 'intl-stocks': 30, bonds: 20 },
  };

  test('nothing set, and everything set, come back as they went in', () => {
    expect(parseSettings(EMPTY_SETTINGS)).toEqual({ settings: EMPTY_SETTINGS });
    expect(parseSettings(JSON.parse(JSON.stringify(full)))).toEqual({ settings: full });
    expect(isAllocationSettings(full)).toBe(true);
  });

  test('a ticker is kept upper case and a name trimmed, as they are compared', () => {
    const r = parseSettings({ ...EMPTY_SETTINGS, funds: [{ ticker: ' brk.b ', split: { stocks: 100 } }, { name: '  A   Trust ', split: { bonds: 100 } }] });
    expect('settings' in r && r.settings.funds).toEqual([
      { ticker: 'BRK.B', split: { stocks: 100 } },
      { name: 'A Trust', split: { bonds: 100 } },
    ]);
  });

  const bad: [string, unknown][] = [
    ['not an object', 'settings'],
    ['null', null],
    ['another version', { ...full, v: 2 }],
    ['an unknown field', { ...full, extra: 1 }],
    ['a missing field', { v: 1, buckets: [], funds: [], target: null }],
    ['an unknown bucket', { ...full, buckets: [{ account_id: 'a', bucket: 'offshore' }] }],
    ['unclassified as a bucket', { ...full, buckets: [{ account_id: 'a', bucket: 'unclassified' }] }],
    ['an account id with a space', { ...full, buckets: [{ account_id: 'has space', bucket: 'roth' }] }],
    ['an account twice', { ...full, buckets: [{ account_id: 'a', bucket: 'roth' }, { account_id: 'a', bucket: 'taxable' }] }],
    ['a bucket with an extra field', { ...full, buckets: [{ account_id: 'a', bucket: 'roth', note: 'x' }] }],
    ['too many buckets', { ...full, buckets: Array.from({ length: SETTINGS_LIMITS.buckets + 1 }, (_, i) => ({ account_id: `a${i}`, bucket: 'roth' })) }],
    ['a ticker with a space', { ...full, funds: [{ ticker: 'BAD TICKER', split: { stocks: 100 } }] }],
    ['an empty ticker', { ...full, funds: [{ ticker: '  ', split: { stocks: 100 } }] }],
    ['a ticker too long', { ...full, funds: [{ ticker: 'A'.repeat(25), split: { stocks: 100 } }] }],
    ['a ticker twice, in any case', { ...full, funds: [{ ticker: 'VTI', split: { stocks: 100 } }, { ticker: 'vti', split: { bonds: 100 } }] }],
    ['a name twice', { ...full, funds: [{ name: 'A Trust', split: { stocks: 100 } }, { name: 'a  trust', split: { bonds: 100 } }] }],
    ['an empty name', { ...full, funds: [{ name: '   ', split: { stocks: 100 } }] }],
    ['a name too long', { ...full, funds: [{ name: 'x'.repeat(121), split: { stocks: 100 } }] }],
    ['a name with a control character', { ...full, funds: [{ name: 'A\u0000Trust', split: { stocks: 100 } }] }],
    ['a fund by ticker and name both', { ...full, funds: [{ ticker: 'VTI', name: 'x', split: { stocks: 100 } }] }],
    ['a fund by neither', { ...full, funds: [{ split: { stocks: 100 } }] }],
    ['a split short of 100', { ...full, funds: [{ ticker: 'VTI', split: { 'us-stocks': 99.9 } }] }],
    ['a split over 100', { ...full, funds: [{ ticker: 'VTI', split: { 'us-stocks': 70, bonds: 40 } }] }],
    ['a split with a negative share', { ...full, funds: [{ ticker: 'VTI', split: { 'us-stocks': 110, cash: -10 } }] }],
    ['a split with two decimals', { ...full, funds: [{ ticker: 'VTI', split: { 'us-stocks': 99.95, cash: 0.05 } }] }],
    ['a split of an unknown class', { ...full, funds: [{ ticker: 'VTI', split: { gold: 100 } }] }],
    ['a split as a list', { ...full, funds: [{ ticker: 'VTI', split: [100] }] }],
    ['too many funds', { ...full, funds: Array.from({ length: SETTINGS_LIMITS.funds + 1 }, (_, i) => ({ ticker: `T${i}`, split: { stocks: 100 } })) }],
    ['an account split twice', { ...full, accounts: [{ account_id: 'a', split: { cash: 100 } }, { account_id: 'a', split: { bonds: 100 } }] }],
    ['an account split short of 100', { ...full, accounts: [{ account_id: 'a', split: { cash: 50 } }] }],
    ['too many account splits', { ...full, accounts: Array.from({ length: SETTINGS_LIMITS.accounts + 1 }, (_, i) => ({ account_id: `a${i}`, split: { cash: 100 } })) }],
    ['a target short of 100', { ...full, target: { 'us-stocks': 50, bonds: 40 } }],
    ['a target naming stocks both ways', { ...full, target: { stocks: 50, 'us-stocks': 30, bonds: 20 } }],
    ['a target as a number', { ...full, target: 100 }],
  ];
  for (const [name, value] of bad) {
    test(`refuses ${name}`, () => {
      const r = parseSettings(value);
      expect('error' in r).toBe(true);
    });
  }

  // A stored value is checked for its shape, not today's formats and sums: a
  // later release that changes them must not make what an earlier one saved
  // unreadable. A save is still held to all of them.
  test('a stored value outside today’s formats and sums still reads; a save refuses it', () => {
    for (const value of [
      { ...full, funds: [{ ticker: 'not a ticker', split: { 'us-stocks': 99 } }] },
      { ...full, buckets: [{ account_id: 'a', bucket: 'roth' }, { account_id: 'a', bucket: 'hsa' }] },
      { ...full, target: { stocks: 50, 'us-stocks': 50 } },
    ]) {
      expect(isAllocationSettings(value)).toBe(true);
      expect('error' in parseSettings(value)).toBe(true);
    }
  });

  test('a stored value in a shape this release doesn’t know is not recognised', () => {
    for (const value of [{ ...full, v: 2 }, { ...full, extra: true }, { ...full, funds: [{ ticker: 'VTI', split: { gold: 100 } }] }, { ...full, buckets: [{ account_id: 'a', bucket: 'offshore' }] }, null, []]) {
      expect(isAllocationSettings(value)).toBe(false);
    }
  });

  test('read as lookups, and changed one setting at a time', () => {
    const o = overridesOf(full);
    expect(o.buckets.get('acc_401k')).toBe('roth');
    expect(o.splits.byTicker.get('VFIFX')).toEqual({ 'us-stocks': 54, 'intl-stocks': 36, bonds: 10 });
    expect(o.splits.byName.get('target retirement 2050 trust ii')).toEqual({ stocks: 90, bonds: 10 });
    expect(o.accounts.get('manual_9bcb3f0c-5760')).toEqual({ 'us-stocks': 80, bonds: 20 });
    expect(overridesOf(null).buckets.size).toBe(0);

    const a = withBucket(full, 'acc_401k', 'tax-deferred');
    expect(a.buckets).toEqual([{ account_id: 'manual_9bcb3f0c-5760', bucket: 'taxable' }, { account_id: 'acc_401k', bucket: 'tax-deferred' }]);
    expect(withBucket(full, 'acc_401k', null).buckets).toEqual([{ account_id: 'manual_9bcb3f0c-5760', bucket: 'taxable' }]);
    const b = withFund(full, { ticker: 'vfifx' }, { stocks: 100 });
    expect(b.funds.filter((f) => 'ticker' in f)).toEqual([{ ticker: 'VFIFX', split: { stocks: 100 } }]);
    expect(withFund(full, { name: 'target retirement 2050 TRUST II' }, null).funds).toEqual([full.funds[0]]);
    expect(withAccountSplit(full, 'manual_9bcb3f0c-5760', null).accounts).toEqual([]);
    // What the helpers make, a save takes.
    for (const s of [a, b, withAccountSplit(full, 'x', { cash: 100 })]) expect('settings' in parseSettings(s)).toBe(true);
  });
});
