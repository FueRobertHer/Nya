import { describe, expect, test } from 'bun:test';
import {
  cashByAccount,
  isCashHolding,
  summarizeCash,
  type CashHolding,
} from '@/lib/cash';

// The rule behind the "uninvested" badge. Both directions cost something: a
// missed cash line is money quietly sitting idle, which is the whole point of
// the feature, and a false one puts an amber warning on a position somebody
// chose on purpose.

const holding = (over: Partial<CashHolding> = {}): CashHolding => ({
  account_id: 'acct',
  name: 'Vanguard Total Stock Market Index Fund',
  ticker: 'VTSAX',
  security_type: 'mutual fund',
  is_cash_equivalent: false,
  value: 1000,
  ...over,
});

describe('isCashHolding', () => {
  test("believes Plaid's flag", () => {
    expect(isCashHolding(holding({ is_cash_equivalent: true }))).toBe(true);
  });

  test('catches the plain cash row', () => {
    expect(
      isCashHolding(holding({ name: 'US Dollar', ticker: 'CUR:USD', security_type: 'cash' }))
    ).toBe(true);
  });

  // The case that prompted this: the flag is reference data and isn't always
  // populated, and a settlement fund read as an investment is exactly what the
  // badge exists to surface.
  test('catches a known settlement fund whose flag is unset or wrong', () => {
    for (const ticker of ['VMFXX', 'SPAXX', 'SWVXX']) {
      expect(isCashHolding(holding({ ticker, is_cash_equivalent: null }))).toBe(true);
      expect(isCashHolding(holding({ ticker, is_cash_equivalent: false }))).toBe(true);
    }
  });

  test('falls back to the fund name for brokers off the ticker list', () => {
    expect(
      isCashHolding(
        holding({ name: 'Acme Government Money Market Fund', ticker: 'AGMXX', is_cash_equivalent: null })
      )
    ).toBe(true);
    expect(isCashHolding(holding({ name: 'Cash Reserves', ticker: null }))).toBe(true);
  });

  test('leaves ordinary positions alone', () => {
    expect(isCashHolding(holding())).toBe(false);
    expect(isCashHolding(holding({ name: 'Apple Inc.', ticker: 'AAPL', security_type: 'equity' }))).toBe(
      false
    );
    // Cash-LIKE, but still a position someone picked. Flagging it would cry
    // wolf on a badge whose only job is to mean something.
    expect(
      isCashHolding(
        holding({ name: 'iShares Short Treasury Bond ETF', ticker: 'SHV', security_type: 'etf' })
      )
    ).toBe(false);
  });

  test('survives a payload cached before the security fields existed', () => {
    expect(isCashHolding({ name: 'Apple Inc.', value: 100 })).toBe(false);
  });
});

describe('summarizeCash', () => {
  test('splits cash from invested', () => {
    const s = summarizeCash([
      holding({ value: 40_000 }),
      holding({ ticker: 'VMFXX', value: 10_000 }),
    ]);
    expect(s.cash).toBe(10_000);
    expect(s.invested).toBe(40_000);
    expect(s.total).toBe(50_000);
    expect(s.share).toBeCloseTo(0.2);
    expect(s.flagged).toBe(true);
  });

  // Every settlement account carries a little float -- a dividend that landed
  // this morning, the rounding left over from a buy. Flagging that would make
  // the badge meaningless within a week.
  test('does not flag ordinary settlement float', () => {
    const s = summarizeCash([
      holding({ value: 100_000 }),
      holding({ ticker: 'VMFXX', value: 120 }),
    ]);
    expect(s.cash).toBe(120);
    expect(s.flagged).toBe(false);
  });

  // Share alone would miss this one.
  test('flags a large amount even at a small share', () => {
    const s = summarizeCash([
      holding({ value: 5_000_000 }),
      holding({ ticker: 'VMFXX', value: 25_000 }),
    ]);
    expect(s.share).toBeLessThan(0.02);
    expect(s.flagged).toBe(true);
  });

  // ...and size alone would miss this one: a contribution that was never placed.
  test('flags a small account that is entirely cash', () => {
    const s = summarizeCash([holding({ ticker: 'VMFXX', value: 600 })]);
    expect(s.share).toBe(1);
    expect(s.flagged).toBe(true);
  });

  test('a fully invested account reports nothing', () => {
    const s = summarizeCash([holding({ value: 1000 })]);
    expect(s).toEqual({ cash: 0, invested: 1000, total: 1000, share: 0, flagged: false });
  });

  test('empty list divides by nothing', () => {
    expect(summarizeCash([])).toEqual({
      cash: 0,
      invested: 0,
      total: 0,
      share: 0,
      flagged: false,
    });
  });

  // A null value is unknown, not zero: counting it as zero would shrink the
  // denominator and overstate the cash share.
  test('skips holdings with no value', () => {
    const s = summarizeCash([holding({ value: null }), holding({ ticker: 'VMFXX', value: 1000 })]);
    expect(s.total).toBe(1000);
    expect(s.cash).toBe(1000);
  });
});

describe('cashByAccount', () => {
  test('summarizes each account separately', () => {
    const byAcct = cashByAccount([
      holding({ account_id: 'brokerage', value: 9000 }),
      holding({ account_id: 'brokerage', ticker: 'VMFXX', value: 1000 }),
      holding({ account_id: 'ira', ticker: 'VMFXX', value: 7000 }),
    ]);
    expect(byAcct.brokerage.cash).toBe(1000);
    expect(byAcct.brokerage.share).toBeCloseTo(0.1);
    expect(byAcct.ira.share).toBe(1);
    expect(byAcct.ira.flagged).toBe(true);
  });

  // Holdings from a payload cached before account_id was carried can't be
  // attributed to a row. Dropping them keeps them out of a bogus key; the
  // institution-level figure still counts them because it sums the whole list.
  test('drops holdings that name no account', () => {
    expect(cashByAccount([holding({ account_id: undefined, ticker: 'VMFXX' })])).toEqual({});
  });
});
