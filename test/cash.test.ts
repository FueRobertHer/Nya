import { describe, expect, test } from 'bun:test';
import {
  cashByAccount,
  isCashByDesign,
  isCashHolding,
  summarizeCash,
  IDLE_CASH_LARGE_VALUE,
  IDLE_CASH_MIN_SHARE,
  IDLE_CASH_MIN_VALUE,
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

  test('normalizes case on both the ticker and the security type', () => {
    expect(isCashHolding(holding({ ticker: 'vmfxx', is_cash_equivalent: null }))).toBe(true);
    expect(isCashHolding(holding({ security_type: 'Cash', is_cash_equivalent: null }))).toBe(true);
  });

  // A payload cached in localStorage before the security fields shipped carries
  // a name and nothing else. The name rule is what keeps an offline first paint
  // from quietly reporting a settlement fund as invested, so it is deliberate
  // that this degrades rather than blanks -- see the Holding type in
  // components/Dashboard.tsx.
  test('still classifies from a payload cached before the security fields existed', () => {
    expect(isCashHolding({ name: 'Apple Inc.', value: 100 })).toBe(false);
    expect(
      isCashHolding({ name: 'Vanguard Federal Money Market Fund', value: 12_000 })
    ).toBe(true);
  });
});

// An account that is cash by design can never act on the warning, so it never
// gets one.
describe('isCashByDesign', () => {
  test('exempts the subtypes whose whole purpose is holding cash', () => {
    expect(isCashByDesign('cash management')).toBe(true);
    expect(isCashByDesign('money market')).toBe(true);
    expect(isCashByDesign('Cash Management')).toBe(true);
  });

  test('leaves ordinary investment accounts alone', () => {
    expect(isCashByDesign('brokerage')).toBe(false);
    expect(isCashByDesign('roth')).toBe(false);
    expect(isCashByDesign(null)).toBe(false);
    expect(isCashByDesign(undefined)).toBe(false);
    // An HSA sitting in cash is the textbook case of money that should have
    // been invested, so it stays eligible on purpose.
    expect(isCashByDesign('hsa')).toBe(false);
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

  // The feature IS these three numbers, so pin them at the edge: a `>=` quietly
  // becoming a `>` passes every other test in this file.
  describe('at the threshold boundaries', () => {
    const withCash = (cash: number, invested: number) =>
      summarizeCash([
        ...(invested > 0 ? [holding({ value: invested })] : []),
        holding({ ticker: 'VMFXX', value: cash }),
      ]);

    test('the minimum value is inclusive', () => {
      // Share is 100% in both, so only the value rule is under test.
      expect(withCash(IDLE_CASH_MIN_VALUE, 0).flagged).toBe(true);
      expect(withCash(IDLE_CASH_MIN_VALUE - 0.01, 0).flagged).toBe(false);
    });

    test('the minimum share is inclusive', () => {
      // 1000 of 50000 is exactly 2%, and 1000 clears the value floor.
      const at = withCash(1000, 49_000);
      expect(at.share).toBeCloseTo(IDLE_CASH_MIN_SHARE);
      expect(at.flagged).toBe(true);
      // Same cash, larger portfolio: below the share line and below the
      // large-value line, so nothing fires.
      expect(withCash(1000, 999_000).flagged).toBe(false);
    });

    test('the large-value rule is inclusive and ignores the share', () => {
      expect(withCash(IDLE_CASH_LARGE_VALUE, 100_000_000).flagged).toBe(true);
      expect(withCash(IDLE_CASH_LARGE_VALUE - 0.01, 100_000_000).flagged).toBe(false);
    });
  });

  // Plaid reports a short position or a margin debit with a negative
  // institution_value, which can make the denominator smaller than the cash
  // pile or negative outright. "150% of holdings is sitting in cash" is not a
  // sentence worth shipping.
  describe('with negative holding values', () => {
    test('clamps the share at 1', () => {
      const s = summarizeCash([
        holding({ ticker: 'VMFXX', value: 15_000 }),
        holding({ name: 'Tesla Inc.', ticker: 'TSLA', value: -5_000 }),
      ]);
      expect(s.cash).toBe(15_000); // the cash figure itself stays exact
      expect(s.total).toBe(10_000);
      expect(s.share).toBe(1);
      expect(s.flagged).toBe(true);
    });

    // The mirror case: a denominator at or below zero must not silently read as
    // "0% cash" and hide a real pile.
    test('still flags cash when the total is wiped out', () => {
      const s = summarizeCash([
        holding({ ticker: 'VMFXX', value: 5_000 }),
        holding({ name: 'Tesla Inc.', ticker: 'TSLA', value: -8_000 }),
      ]);
      expect(s.share).toBe(1);
      expect(s.flagged).toBe(true);
    });
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

  // Each account is judged on its own: the Accounts tab draws one badge per
  // row, and a flagged IRA must not put amber on the brokerage beside it.
  test('flags each account independently', () => {
    const byAcct = cashByAccount([
      holding({ account_id: 'brokerage', value: 200_000 }),
      holding({ account_id: 'brokerage', ticker: 'VMFXX', value: 40 }),
      holding({ account_id: 'ira', ticker: 'VMFXX', value: 7_000 }),
    ]);
    expect(byAcct.brokerage.flagged).toBe(false);
    expect(byAcct.ira.flagged).toBe(true);
  });

  // Holdings from a payload cached before account_id was carried can't be
  // attributed to a row. Dropping them keeps them out of a bogus key; the
  // institution-level figure still counts them because it sums the whole list.
  test('drops holdings that name no account', () => {
    expect(cashByAccount([holding({ account_id: undefined, ticker: 'VMFXX' })])).toEqual({});
  });
});
