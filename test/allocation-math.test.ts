import { describe, expect, test } from 'bun:test';
import {
  allocate,
  bankCash,
  drift,
  planMix,
  shareLabel,
  shares,
  wholePercents,
  type AllocAccount,
  type AllocHolding,
  type AllocInstitution,
} from '@/lib/allocation/allocation';
import { SLOTS } from '@/lib/allocation/classes';
import { BUCKET_SLOTS } from '@/lib/allocation/buckets';
import { EMPTY_SETTINGS, type AllocationSettings } from '@/lib/allocation/settings';
import { allocationSeries, commonCurrency, KNOWN_ALWAYS, seriesBuilder, type SeriesAccount, type SeriesDayIn, type SeriesInput } from '@/lib/allocation/series';

const acct = (account_id: string, over: Partial<AllocAccount> = {}): AllocAccount => ({
  account_id,
  name: account_id,
  type: 'investment',
  subtype: 'brokerage',
  balance: 0,
  currency: 'USD',
  ...over,
});
const inst = (name: string, accounts: AllocAccount[], over: Partial<AllocInstitution> = {}): AllocInstitution => ({
  name,
  error: false,
  staleAsOf: null,
  missing: 0,
  accounts,
  ...over,
});
const hold = (account_id: string, ticker: string | null, value: number | null, over: Partial<AllocHolding> = {}): AllocHolding => ({
  account_id,
  ticker,
  name: ticker ?? 'Unknown',
  security_type: 'etf',
  is_cash_equivalent: false,
  value,
  ...over,
});
const sumOf = (r: Record<string, number>) => Object.values(r).reduce((s, n) => s + n, 0);
const settings = (over: Partial<AllocationSettings> = {}): AllocationSettings => ({ ...EMPTY_SETTINGS, ...over });

describe('the allocation', () => {
  const brokerage = acct('brk', { name: 'Brokerage', balance: 100_000 });
  const ira = acct('ira', { name: 'IRA', subtype: 'roth', balance: 50_000 });
  const institutions = [inst('Vanguard', [brokerage, ira])];
  const holdings = [
    hold('brk', 'VTI', 60_000),
    hold('brk', 'VXUS', 30_000),
    hold('brk', 'VMFXX', 10_000, { security_type: 'mutual fund' }),
    hold('ira', 'BND', 20_000),
    hold('ira', 'VFIFX', 30_000, { security_type: 'mutual fund', name: 'Vanguard Target Retirement 2050 Fund' }),
  ];

  test('by asset class and by tax bucket, adding up to the same whole', () => {
    const a = allocate({ institutions, holdings, settings: null, currency: 'USD' });
    expect(a.total).toBe(150_000);
    expect(a.classes).toMatchObject({ 'us-stocks': 60_000, 'intl-stocks': 30_000, cash: 10_000, bonds: 20_000, unclassified: 30_000 });
    expect(a.buckets).toMatchObject({ taxable: 100_000, roth: 50_000, unclassified: 0 });
    expect(sumOf(a.classes)).toBe(sumOf(a.buckets));
    // The target-date fund is unclassified, never folded into another class.
    const vfifx = a.securities.find((s) => s.ticker === 'VFIFX')!;
    expect(vfifx.classified).toEqual({ split: null, why: 'fund' });
    expect(vfifx.amount).toBe(30_000);
    // Largest first, ties in key order.
    expect(a.securities.map((s) => s.ticker)).toEqual(['VTI', 'VFIFX', 'VXUS', 'BND', 'VMFXX']);
  });

  test('the person’s split classifies a fund, and their bucket places an account', () => {
    const mine = settings({
      funds: [{ ticker: 'VFIFX', split: { 'us-stocks': 54, 'intl-stocks': 36, bonds: 10 } }],
      buckets: [{ account_id: 'brk', bucket: 'tax-deferred' }],
    });
    const a = allocate({ institutions, holdings, settings: mine, currency: 'USD' });
    expect(a.classes.unclassified).toBe(0);
    expect(a.classes['us-stocks']).toBeCloseTo(60_000 + 16_200, 6);
    expect(a.classes.bonds).toBeCloseTo(23_000, 6);
    expect(a.buckets['tax-deferred']).toBe(100_000);
    expect(a.accounts.find((r) => r.account_id === 'brk')!.bucket).toMatchObject({ bucket: 'tax-deferred', from: 'you', subtype: 'taxable' });
  });

  test('the same ticker classified two ways is two rows, each saying what its money is', () => {
    const a = allocate({
      institutions: [inst('A', [acct('a', { balance: 10 })]), inst('B', [acct('b', { balance: 5 })])],
      holdings: [hold('a', 'XYZ', 10, { security_type: 'mutual fund', is_cash_equivalent: true }), hold('b', 'XYZ', 5, { security_type: 'mutual fund' })],
      settings: null,
      currency: 'USD',
    });
    expect(a.securities.map((s) => [s.ticker, s.amount, s.classified])).toEqual([
      ['XYZ', 10, { split: { cash: 100 }, by: 'cash' }],
      ['XYZ', 5, { split: null, why: 'fund' }],
    ]);
    expect(a.classes).toMatchObject({ cash: 10, unclassified: 5 });
  });

  test('a balance more than its positions: the difference is unclassified, never assumed cash', () => {
    const a = allocate({ institutions: [inst('Schwab', [acct('s', { name: 'Schwab', balance: 10_500 })])], holdings: [hold('s', 'VTI', 10_000)], settings: null, currency: 'USD' });
    expect(a.classes.cash).toBe(0);
    expect(a.classes.unclassified).toBe(500);
    expect(a.gaps).toEqual([{ kind: 'not-in-position', account_id: 's', account: 'Schwab', institution: 'Schwab', amount: 500, asOf: null, asOfAt: null, split: null, manual: false }]);
    expect(a.total).toBe(10_500);
    expect(a.buckets.taxable).toBe(10_500);
  });

  test('a difference of rounding is not money', () => {
    const a = allocate({ institutions: [inst('X', [acct('s', { balance: 10_000.4 })])], holdings: [hold('s', 'VTI', 10_000)], settings: null, currency: 'USD' });
    expect(a.gaps).toEqual([]);
    expect(a.over).toEqual([]);
    expect(a.total).toBe(10_000);
    expect(sumOf(a.buckets)).toBe(10_000);
  });

  test('positions worth more than the balance are counted as listed, and named', () => {
    const a = allocate({ institutions: [inst('X', [acct('m', { name: 'Margin', balance: 80_000 })])], holdings: [hold('m', 'VTI', 100_000)], settings: null, currency: 'USD' });
    expect(a.classes['us-stocks']).toBe(100_000);
    expect(a.over).toEqual([{ account: 'Margin', institution: 'X', amount: 20_000 }]);
    expect(a.total).toBe(100_000);
    expect(a.buckets.taxable).toBe(100_000);
  });

  test('a margin balance is negative cash, so shares go above 100% and below 0, as held', () => {
    const a = allocate({
      institutions: [inst('X', [acct('m', { balance: 100_000 })])],
      holdings: [hold('m', 'VTI', 120_000), hold('m', 'CUR:USD', -20_000, { security_type: 'cash', is_cash_equivalent: true })],
      settings: null,
      currency: 'USD',
    });
    expect(a.classes.cash).toBe(-20_000);
    expect(a.gaps).toEqual([]);
    const s = shares(a.classes, SLOTS);
    expect(s).toEqual([
      { slot: 'us-stocks', amount: 120_000, pct: 120, label: '120%' },
      { slot: 'cash', amount: -20_000, pct: -20, label: '-20%' },
    ]);
  });

  test('a short position counts against its class', () => {
    const a = allocate({
      institutions: [inst('X', [acct('s', { balance: 15_000 })])],
      holdings: [hold('s', 'VTI', 20_000), hold('s', 'TSLA', -5_000, { security_type: 'equity' })],
      settings: null,
      currency: 'USD',
    });
    expect(a.classes['us-stocks']).toBe(20_000);
    expect(a.classes.stocks).toBe(-5_000);
    expect(a.total).toBe(15_000);
  });

  test('zero and unpriced positions add nothing; an unpriced one is counted as such', () => {
    const a = allocate({
      institutions: [inst('X', [acct('s', { balance: 1_000 })])],
      holdings: [hold('s', 'VTI', 1_000), hold('s', 'OLD', 0, { security_type: 'equity' }), hold('s', 'NEW', null)],
      settings: null,
      currency: 'USD',
    });
    expect(a.classes['us-stocks']).toBe(1_000);
    expect(a.unpriced).toBe(1);
    expect(a.total).toBe(1_000);
  });

  test('an account with no positions is unclassified whole, unless the person split it', () => {
    const manual = inst('Manual accounts', [acct('manual_1', { name: '401(k) at work', subtype: null, balance: 40_000 })], { item_id: null });
    const a = allocate({ institutions: [manual], holdings: [], settings: null, currency: 'USD' });
    expect(a.classes.unclassified).toBe(40_000);
    expect(a.gaps[0]).toMatchObject({ kind: 'no-positions', account: '401(k) at work', amount: 40_000, split: null, manual: true });
    expect(a.accounts[0].manual).toBe(true);
    expect(a.buckets.unclassified).toBe(40_000);
    const split = allocate({ institutions: [manual], holdings: [], settings: settings({ accounts: [{ account_id: 'manual_1', split: { 'us-stocks': 80, bonds: 20 } }] }), currency: 'USD' });
    expect(split.classes).toMatchObject({ 'us-stocks': 32_000, bonds: 8_000, unclassified: 0 });
    expect(split.gaps[0].split).toEqual({ 'us-stocks': 80, bonds: 20 });
  });

  test('an account split classifies only what no position explains', () => {
    const a = allocate({
      institutions: [inst('X', [acct('s', { balance: 12_000 })])],
      holdings: [hold('s', 'BND', 10_000)],
      settings: settings({ accounts: [{ account_id: 's', split: { cash: 100 } }] }),
      currency: 'USD',
    });
    expect(a.classes).toMatchObject({ bonds: 10_000, cash: 2_000, unclassified: 0 });
  });

  test('an institution that couldn’t be reached: what it holds isn’t known, whatever was recovered', () => {
    const stale = inst('Fidelity', [acct('f', { name: '401(k)', subtype: '401k', balance: 70_000 })], { error: true, staleAsOf: '2026-10-01', staleAsOfAt: '2026-10-01T14:00:00Z' });
    const gone = inst('Chase', [], { error: true });
    const a = allocate({
      institutions: [stale, gone],
      holdings: [],
      // Its split is for money no listed position explains, not for an
      // account whose positions aren't known today.
      settings: settings({ accounts: [{ account_id: 'f', split: { 'us-stocks': 100 } }] }),
      currency: 'USD',
    });
    expect(a.classes.unclassified).toBe(70_000);
    expect(a.gaps[0]).toMatchObject({ kind: 'unreachable', asOf: '2026-10-01', asOfAt: '2026-10-01T14:00:00Z', split: null });
    expect(a.buckets['tax-deferred']).toBe(70_000);
    expect(a.caveats).toEqual([{ kind: 'unreachable', institution: 'Chase' }]);
  });

  test('accounts it couldn’t show are named', () => {
    const a = allocate({ institutions: [inst('Schwab', [acct('s', { balance: 10 })], { missing: 2 })], holdings: [hold('s', 'VTI', 10)], settings: null, currency: 'USD' });
    expect(a.caveats).toEqual([{ kind: 'missing', institution: 'Schwab', count: 2 }]);
  });

  test('mixed currencies are left out and named, never added', () => {
    const a = allocate({
      institutions: [
        inst('Vanguard', [acct('us', { balance: 10_000 })]),
        inst('Questrade', [acct('ca', { name: 'TFSA', subtype: 'tfsa', balance: 5_000, currency: 'CAD' })]),
        inst('IBKR', [acct('mix', { balance: 3_000 })]),
      ],
      holdings: [
        hold('us', 'VTI', 10_000),
        hold('ca', 'XEQT', 5_000),
        hold('mix', 'VTI', 2_000),
        hold('mix', 'SAP', 1_000, { currency: 'EUR', security_type: 'equity' }),
      ],
      settings: null,
      currency: 'USD',
    });
    expect(a.total).toBe(12_000);
    expect(a.otherCurrencies).toEqual([
      { currency: 'CAD', amount: 5_000 },
      { currency: 'EUR', amount: 1_000 },
    ]);
    // The account in another currency adds to no bucket, and says so.
    expect(a.buckets.roth).toBe(0);
    expect(a.accounts.find((r) => r.account_id === 'ca')).toMatchObject({ amount: null, otherCurrency: 'CAD' });
    // Its balance holds the euro position converted, so it isn't compared.
    expect(a.gaps).toEqual([]);
    // A figure with no currency is in the allocation's.
    const plain = allocate({ institutions: [inst('X', [acct('n', { balance: 5, currency: null })])], holdings: [hold('n', 'VTI', 5)], settings: null, currency: 'USD' });
    expect(plain.total).toBe(5);
  });

  test('hidden accounts, and accounts that aren’t investments, are left out with their positions', () => {
    const a = allocate({
      institutions: [inst('X', [acct('h', { hidden: true, balance: 9 }), acct('chk', { type: 'depository', subtype: 'checking', balance: 7 }), acct('s', { balance: 1 })])],
      holdings: [hold('h', 'VTI', 9), hold('s', 'VTI', 1), hold('nowhere', 'VTI', 4)],
      settings: null,
      currency: 'USD',
    });
    expect(a.total).toBe(1);
    expect(a.accounts.map((r) => r.account_id)).toEqual(['s']);
    // The hidden account's position is left out with it; the one naming no
    // account at all is counted, never added.
    expect(a.unattributed).toBe(1);
  });

  test('an account with no balance and no position counts nothing, and is counted', () => {
    const a = allocate({ institutions: [inst('X', [acct('s', { balance: null })])], holdings: [], settings: null, currency: 'USD' });
    expect(a.noBalance).toBe(1);
    expect(a.total).toBe(0);
    expect(shares(a.classes, SLOTS)).toEqual([]);
    expect(shares(a.buckets, BUCKET_SLOTS)).toEqual([]);
  });
});

describe('shares', () => {
  test('whole percents that add up to exactly 100', () => {
    expect(wholePercents([1, 1, 1])).toEqual([34, 33, 33]);
    expect(wholePercents([72.4, 19.6, 8])).toEqual([72, 20, 8]);
    expect(wholePercents([0.5, 99.5])).toEqual([1, 99]);
    expect(wholePercents([120.4, -20.4])).toEqual([120, -20]);
    for (const set of [[3, 3, 3, 1], [7, 11, 13, 17, 19], [0.1, 0.2, 99.7], [1e9, 1, 1]]) {
      expect(wholePercents(set)!.reduce((s, n) => s + n, 0)).toBe(100);
    }
  });

  test('none of a whole that is zero or below', () => {
    expect(wholePercents([])).toBeNull();
    expect(wholePercents([0, 0])).toBeNull();
    expect(wholePercents([10, -20])).toBeNull();
  });

  test('money that is there never reads 0%, and a share short of the whole never 100%', () => {
    expect(shareLabel(0.3, 0, 100)).toBe('<1%');
    expect(shareLabel(99.7, 100, 100)).toBe('>99%');
    expect(shareLabel(100, 100, 100)).toBe('100%');
    expect(shareLabel(-0.2, 0, 100)).toBe('>-1%');
    const s = shares({ a: 9_970, b: 30, c: 0 }, ['a', 'b', 'c']);
    expect(s.map((x) => x.label)).toEqual(['>99%', '<1%']);
  });

  test('rounding residue is not money: no row, no share', () => {
    // Cash positions of 0.1, 0.2 and -0.3 leave 5.55e-17 behind.
    const a = allocate({
      institutions: [inst('X', [acct('m', { balance: 1_000 })])],
      holdings: [hold('m', 'VTI', 1_000), ...[0.1, 0.2, -0.3].map((v) => hold('m', 'CUR:USD', v, { security_type: 'cash' }))],
      settings: null,
      currency: 'USD',
    });
    expect(a.classes.cash).not.toBe(0);
    expect(shares(a.classes, SLOTS)).toEqual([{ slot: 'us-stocks', amount: 1_000, pct: 100, label: '100%' }]);
    expect(drift(a, { 'us-stocks': 100 })!.rows.map((r) => r.slot)).toEqual(['us-stocks']);
    expect(planMix(a).leftOut).toEqual([]);
  });
});

describe('drift against a target', () => {
  const alloc = (classes: Record<string, number>) => {
    const a = allocate({ institutions: [], holdings: [], settings: null, currency: 'USD' });
    Object.assign(a.classes, classes);
    a.total = sumOf(a.classes);
    return a;
  };

  test('by class, over what is classified, with what it takes to get back on target', () => {
    const d = drift(alloc({ 'us-stocks': 55_000, 'intl-stocks': 25_000, bonds: 20_000, unclassified: 10_000 }), { 'us-stocks': 50, 'intl-stocks': 30, bonds: 20 })!;
    expect(d.basis).toBe(100_000);
    expect(d.unclassified).toBe(10_000);
    expect(d.byRegion).toBe(true);
    expect(d.rows).toEqual([
      { slot: 'us-stocks', target: 50, actual: 55, diff: 5, toTarget: -5_000 },
      { slot: 'intl-stocks', target: 30, actual: 25, diff: -5, toTarget: 5_000 },
      { slot: 'bonds', target: 20, actual: 20, diff: 0, toTarget: 0 },
    ]);
  });

  test('a class held with no target drifts from 0, and a target with nothing held from its share', () => {
    const d = drift(alloc({ 'us-stocks': 90, crypto: 10 }), { 'us-stocks': 80, bonds: 20 })!;
    expect(d.rows).toEqual([
      { slot: 'us-stocks', target: 80, actual: 90, diff: 10, toTarget: -10 },
      { slot: 'bonds', target: 20, actual: 0, diff: -20, toTarget: 20 },
      { slot: 'crypto', target: 0, actual: 10, diff: 10, toTarget: -10 },
    ]);
  });

  test('stocks of an unknown region have no target under one split by region', () => {
    const d = drift(alloc({ 'us-stocks': 50, stocks: 10, bonds: 40 }), { 'us-stocks': 60, bonds: 40 })!;
    expect(d.rows.find((r) => r.slot === 'stocks')).toEqual({ slot: 'stocks', target: null, actual: 10, diff: null, toTarget: null });
  });

  test('a target with no stocks at all holds every stock against 0%, whatever its region', () => {
    const d = drift(alloc({ stocks: 1_000, 'us-stocks': 500, bonds: 1_000 }), { bonds: 100 })!;
    expect(d.byRegion).toBe(false);
    expect(d.rows).toEqual([
      { slot: 'all-stocks', target: 0, actual: 60, diff: 60, toTarget: -1_500 },
      { slot: 'bonds', target: 100, actual: 40, diff: -60, toTarget: 1_500 },
    ]);
  });

  test('a target of stocks of any region counts every region together', () => {
    const d = drift(alloc({ 'us-stocks': 50, 'intl-stocks': 20, stocks: 10, bonds: 20 }), { stocks: 80, bonds: 20 })!;
    expect(d.byRegion).toBe(false);
    expect(d.rows).toEqual([
      { slot: 'all-stocks', target: 80, actual: 80, diff: 0, toTarget: 0 },
      { slot: 'bonds', target: 20, actual: 20, diff: 0, toTarget: 0 },
    ]);
  });

  test('nothing classified, or a stored target this release can’t use, has no drift', () => {
    expect(drift(alloc({ unclassified: 100 }), { bonds: 100 })).toBeNull();
    expect(drift(alloc({ bonds: 100 }), { bonds: 90 })).toBeNull();
  });
});

describe('the Plan’s mix', () => {
  const base = (holdings: AllocHolding[], balance: number) =>
    allocate({ institutions: [inst('X', [acct('s', { balance })])], holdings, settings: null, currency: 'USD' });

  test('stocks of every region together, bonds and cash, in whole percents adding up to 100', () => {
    const m = planMix(base([hold('s', 'VTI', 50_000), hold('s', 'VXUS', 22_000), hold('s', 'BND', 20_000), hold('s', 'VMFXX', 8_000, { security_type: 'mutual fund' })], 100_000));
    expect(m).toMatchObject({ ok: true, stocksPct: 72, bondsPct: 20, cashPct: 8, stocks: 72_000, bonds: 20_000, cash: 8_000, leftOut: [] });
  });

  test('never counts unclassified money as stocks or bonds: it is left out and named, with what the plan has no history for', () => {
    const m = planMix(
      base(
        [
          hold('s', 'VTI', 60_000),
          hold('s', 'BND', 20_000),
          hold('s', 'VFIFX', 10_000, { security_type: 'mutual fund' }),
          hold('s', 'VNQ', 5_000),
          hold('s', 'BTC', 5_000, { security_type: 'cryptocurrency' }),
        ],
        100_000
      )
    );
    expect(m).toMatchObject({ ok: true, stocksPct: 75, bondsPct: 25, cashPct: 0 });
    expect(m.leftOut).toEqual([
      { slot: 'unclassified', amount: 10_000 },
      { slot: 'real-estate', amount: 5_000 },
      { slot: 'crypto', amount: 5_000 },
    ]);
  });

  test('checking and savings join cash when the plan counts them', () => {
    const insts = [inst('Bank', [acct('chk', { type: 'depository', subtype: 'checking', balance: 10_000 }), acct('eur', { type: 'depository', balance: 500, currency: 'EUR' }), acct('h', { type: 'depository', balance: 99, hidden: true })])];
    const bank = bankCash(insts, 'USD');
    expect(bank).toEqual({ amount: 10_000, otherCurrencies: [{ currency: 'EUR', amount: 500 }] });
    const m = planMix(base([hold('s', 'VTI', 90_000)], 90_000), bank.amount, bank.otherCurrencies);
    expect(m).toMatchObject({ ok: true, stocksPct: 90, bondsPct: 0, cashPct: 10, bank: 10_000, otherCurrencies: [{ currency: 'EUR', amount: 500 }] });
  });

  test('cash borrowed on margin can’t be a share of a mix, so none is offered', () => {
    const m = planMix(base([hold('s', 'VTI', 120_000), hold('s', 'CUR:USD', -20_000, { security_type: 'cash' })], 100_000));
    expect(m).toMatchObject({ ok: false, why: 'negative', cash: -20_000 });
  });

  test('with nothing classified as stocks, bonds or cash, none is offered', () => {
    const m = planMix(base([hold('s', 'VFIFX', 10_000, { security_type: 'mutual fund' })], 10_000));
    expect(m).toMatchObject({ ok: false, why: 'nothing', leftOut: [{ slot: 'unclassified', amount: 10_000 }] });
  });
});

describe('allocation over time', () => {
  const pos = (ticker: string, value: number | null, over: Record<string, unknown> = {}) => ({ ticker, name: ticker, security_type: 'etf', is_cash_equivalent: false, value, currency: 'USD', ...over });
  const day = (date: string, accounts: Record<string, ReturnType<typeof pos>[]>, balances: Record<string, number> = {}) => ({
    day: { date, accounts: Object.entries(accounts).map(([account_id, positions]) => ({ account_id, positions })) } as SeriesDayIn,
    balances: new Map(Object.entries(balances)),
  });
  const shown = (...ids: string[]): SeriesAccount[] => ids.map((account_id) => ({ account_id, currency: 'USD', manual: false }));
  const input = (over: Partial<SeriesInput> = {}): SeriesInput => ({ shown: [], knownFrom: new Map(), recorded: new Map(), settings: null, currency: 'USD', ...over });

  test('one point per recorded day, oldest first, starting on the first one', () => {
    const s = allocationSeries([day('2026-10-03', { a: [pos('VTI', 110)] }), day('2026-10-01', { a: [pos('VTI', 100), pos('BND', 50)] })], input({ shown: shown('a') }));
    expect(s.days.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-03']);
    expect(s.days[0]).toEqual({ date: '2026-10-01', classes: { 'us-stocks': 100, bonds: 50 }, total: 150, unlisted: 0, missing: [], otherCurrencies: {}, noCurrency: 0, unpriced: 0 });
    expect(s.accounts).toEqual([{ account_id: 'a', shown: true, first: '2026-10-01', last: '2026-10-03', unlisted: false }]);
    // Nothing recorded is no point at all.
    expect(allocationSeries([], input()).days).toEqual([]);
  });

  test('days are added once each, oldest first', () => {
    const b = seriesBuilder(input({ shown: shown('a') }));
    b.add(day('2026-10-02', { a: [] }).day, new Map());
    expect(() => b.add(day('2026-10-02', { a: [] }).day, new Map())).toThrow('oldest first');
    expect(() => b.add(day('2026-10-01', { a: [] }).day, new Map())).toThrow('oldest first');
  });

  test('an account shown today is expected on every day after it was first recorded: a gap at the end is marked, not drawn whole', () => {
    // b's institution stops answering after the 2nd, through today.
    const s = allocationSeries(
      [
        day('2026-10-01', { a: [pos('VTI', 1)], b: [pos('BND', 3)] }),
        day('2026-10-02', { a: [pos('VTI', 1)], b: [pos('BND', 3)] }),
        day('2026-10-05', { a: [pos('VTI', 1)] }),
        day('2026-10-08', { a: [pos('VTI', 1)] }),
      ],
      input({ shown: shown('a', 'b') })
    );
    expect(s.days.map((d) => [d.date, d.missing])).toEqual([
      ['2026-10-01', []],
      ['2026-10-02', []],
      ['2026-10-05', ['b']],
      ['2026-10-08', ['b']],
    ]);
    expect(s.accounts.find((a) => a.account_id === 'b')).toEqual({ account_id: 'b', shown: true, first: '2026-10-01', last: '2026-10-02', unlisted: false });
  });

  test('before it was first recorded, only once the directory knew it, or the index has it from before the range', () => {
    const days = [day('2026-10-01', { a: [pos('VTI', 1)] }), day('2026-10-02', { a: [pos('VTI', 1)] }), day('2026-10-03', { a: [pos('VTI', 1)], b: [pos('BND', 1)] })];
    // Linked on the 3rd: not missing before.
    expect(allocationSeries(days, input({ shown: shown('a', 'b') })).days.map((d) => d.missing)).toEqual([[], [], []]);
    // Known since September, failing until the 3rd: missing before.
    expect(allocationSeries(days, input({ shown: shown('a', 'b'), knownFrom: new Map([['b', '2026-09-01']]) })).days.map((d) => d.missing)).toEqual([['b'], ['b'], []]);
    // Known from the 2nd.
    expect(allocationSeries(days, input({ shown: shown('a', 'b'), knownFrom: new Map([['b', '2026-10-02']]) })).days.map((d) => d.missing)).toEqual([[], ['b'], []]);
    // A directory entry that can't be read: there all along.
    expect(allocationSeries(days, input({ shown: shown('a', 'b'), knownFrom: new Map([['b', KNOWN_ALWAYS]]) })).days.map((d) => d.missing)).toEqual([['b'], ['b'], []]);
    // Recorded in August, before the range read.
    const recorded = new Map([['b', { first: '2026-08-01', last: '2026-10-03' }]]);
    expect(allocationSeries(days, input({ shown: shown('a', 'b'), recorded })).days.map((d) => d.missing)).toEqual([['b'], ['b'], []]);
  });

  test('a balance alone is a record: the account counts by it, and isn’t missing', () => {
    const s = allocationSeries([day('2026-10-01', { a: [pos('VTI', 100)] }, { a: 100, m: 50 }), day('2026-10-02', { a: [pos('VTI', 100)] }, { a: 100 })], input({ shown: [...shown('a'), { account_id: 'm', currency: 'USD', manual: true }] }));
    expect(s.days[0]).toMatchObject({ classes: { 'us-stocks': 100, unclassified: 50 }, unlisted: 50, missing: [] });
    // Named as an account whose unlisted money was counted as unclassified.
    expect(s.accounts.map((a) => [a.account_id, a.unlisted])).toEqual([
      ['a', false],
      ['m', true],
    ]);
    // Not recorded on the 2nd, after it was on the 1st.
    expect(s.days[1].missing).toEqual(['m']);
  });

  test('an account no longer shown is expected only between its first and last recorded days, from its positions alone', () => {
    const recorded = new Map([['gone', { first: '2026-10-01', last: '2026-10-03' }]]);
    const s = allocationSeries(
      [
        day('2026-10-01', { a: [pos('VTI', 1)], gone: [pos('BND', 5), pos('X', 7, { currency: null })] }, { a: 1, gone: 99 }),
        day('2026-10-02', { a: [pos('VTI', 1)] }),
        day('2026-10-03', { a: [pos('VTI', 1)], gone: [pos('BND', 5)] }),
        day('2026-10-04', { a: [pos('VTI', 1)] }),
      ],
      input({ shown: shown('a'), recorded })
    );
    expect(s.days.map((d) => [d.date, d.classes, d.missing, d.noCurrency])).toEqual([
      // Its balance isn't set against its positions (its currency isn't
      // known), and a position with no currency is left out.
      ['2026-10-01', { 'us-stocks': 1, bonds: 5 }, [], 7],
      ['2026-10-02', { 'us-stocks': 1 }, ['gone'], 0],
      ['2026-10-03', { 'us-stocks': 1, bonds: 5 }, [], 0],
      ['2026-10-04', { 'us-stocks': 1 }, [], 0],
    ]);
    expect(s.accounts).toEqual([
      { account_id: 'a', shown: true, first: '2026-10-01', last: '2026-10-04', unlisted: false },
      { account_id: 'gone', shown: false, first: '2026-10-01', last: '2026-10-03', unlisted: false },
    ]);
  });

  test('classified by the same rule as today’s, with the person’s splits', () => {
    const s = allocationSeries(
      [day('2026-10-01', { a: [pos('VFIFX', 100, { security_type: 'mutual fund' }), pos('VMFXX', 10, { security_type: 'mutual fund' }), pos('X', 5, { security_type: null })] })],
      input({ shown: shown('a'), settings: settings({ funds: [{ ticker: 'VFIFX', split: { 'us-stocks': 60, bonds: 40 } }] }) })
    );
    expect(s.days[0].classes).toEqual({ 'us-stocks': 60, bonds: 40, cash: 10, unclassified: 5 });
  });

  test('another currency is left out and summed by currency; an unpriced position is counted', () => {
    const s = allocationSeries(
      [day('2026-10-01', { a: [pos('VTI', 100), pos('XEQT', 50, { currency: 'CAD' }), pos('BTC', 2, { currency: null, unofficial_currency: 'BTC', security_type: 'cryptocurrency' }), pos('NEW', null)] })],
      input({ shown: shown('a') })
    );
    expect(s.days[0]).toMatchObject({ total: 100, classes: { 'us-stocks': 100 }, otherCurrencies: { CAD: 50, BTC: 2 }, unpriced: 1 });
  });

  test('a day is today’s allocation of what was recorded on it: the same figures as the current view', () => {
    // The current view's own case: positions, a balance beyond them, a fund
    // the person split, a manual account split by the person, a manual one
    // left unclassified, an account in another currency, and margin.
    const accounts = [
      { a: acct('brk', { balance: 105_000 }), manual: false },
      { a: acct('marg', { balance: 5_000 }), manual: false },
      { a: acct('m401', { balance: 40_000 }), manual: true },
      { a: acct('mira', { balance: 9_000 }), manual: true },
      { a: acct('rrsp', { balance: 7_000, currency: 'CAD' }), manual: false },
    ];
    const positions = [
      hold('brk', 'VTI', 60_000),
      hold('brk', 'VFIFX', 40_000, { security_type: 'mutual fund' }),
      hold('marg', 'QQQ', 9_000, { security_type: 'equity' }),
      hold('marg', 'CUR:USD', -4_000, { security_type: 'cash', is_cash_equivalent: true }),
      hold('rrsp', 'XEQT', 7_000, { currency: 'CAD' }),
    ];
    const set = settings({ funds: [{ ticker: 'VFIFX', split: { 'us-stocks': 50, bonds: 50 } }], accounts: [{ account_id: 'm401', split: { bonds: 100 } }] });
    const today = allocate({
      institutions: [inst('Linked', accounts.filter((x) => !x.manual).map((x) => x.a), { item_id: 'i' }), inst('Manual', accounts.filter((x) => x.manual).map((x) => x.a), { item_id: null })],
      holdings: positions,
      settings: set,
      currency: 'USD',
    });
    const recorded: Record<string, ReturnType<typeof pos>[]> = {};
    for (const h of positions) (recorded[h.account_id!] ??= []).push(pos(h.ticker!, h.value as number, { name: h.name, security_type: h.security_type, is_cash_equivalent: h.is_cash_equivalent, currency: h.currency ?? null }));
    const s = allocationSeries(
      [day('2026-10-09', recorded, Object.fromEntries(accounts.map((x) => [x.a.account_id, x.a.balance as number])))],
      input({ shown: accounts.map((x) => ({ account_id: x.a.account_id, currency: x.a.currency, manual: x.manual })), settings: set })
    );
    const d = s.days[0];
    for (const slot of SLOTS) expect(d.classes[slot] ?? 0).toBeCloseTo(today.classes[slot], 9);
    expect(d.total).toBeCloseTo(today.total, 9);
    expect(d.otherCurrencies).toEqual(Object.fromEntries(today.otherCurrencies.map((o) => [o.currency, o.amount])));
    expect(d.unlisted).toBe(today.gaps.filter((g) => g.split === null).reduce((sum, g) => sum + g.amount, 0));
    expect(d.unlisted).toBe(5_000 + 9_000);
  });

  test('the currency most of today’s accounts are in', () => {
    expect(commonCurrency([...shown('a', 'b'), { account_id: 'c', currency: 'CAD', manual: false }])).toBe('USD');
    expect(commonCurrency([{ account_id: 'c', currency: 'CAD', manual: false }, { account_id: 'u', currency: 'USD', manual: false }])).toBe('CAD');
    expect(commonCurrency([{ account_id: 'x', currency: null, manual: true }])).toBeNull();
    expect(commonCurrency([])).toBeNull();
  });
});
