import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { InvestmentTxn } from '@/lib/investments';

// Stands in for the Plaid client so pagination can be driven deterministically.
// Declared before the mock.module call because that call is hoisted with the
// imports below it.
let pages: { rows: any[]; total?: number | null }[] = [];
let calls: { offset: number; count: number; account_ids?: string[] }[] = [];

mock.module('@/lib/plaid', () => ({
  plaidClient: {
    investmentsTransactionsGet: async (req: any) => {
      calls.push({
        offset: req.options.offset,
        count: req.options.count,
        account_ids: req.options.account_ids,
      });
      const page = pages[calls.length - 1] ?? { rows: [] };
      return {
        data: {
          investment_transactions: page.rows,
          securities: [{ security_id: 'sec1', name: 'Acme Corp', ticker_symbol: 'ACME' }],
          total_investment_transactions: page.total === undefined ? page.rows.length : page.total,
        },
      };
    },
  },
}));

const { valueDelta, isContribution, fetchInvestmentTxns } = await import('@/lib/investments');

const txn = (over: Partial<InvestmentTxn> = {}): InvestmentTxn => ({
  investment_transaction_id: 'it1',
  account_id: 'acct',
  date: '2026-03-01',
  name: 'Thing',
  type: 'cash',
  subtype: 'deposit',
  quantity: 0,
  price: 0,
  amount: -100,
  fees: null,
  currency: 'USD',
  security: null,
  ...over,
});

describe('valueDelta', () => {
  // Plaid's convention: amount is POSITIVE when cash is debited from the
  // account. So an external inflow arrives negative and raises the balance.
  test('external cash inflow raises account value by its magnitude', () => {
    expect(valueDelta(txn({ type: 'cash', subtype: 'deposit', amount: -500 }))).toBe(500);
  });

  test('external cash outflow lowers it', () => {
    expect(valueDelta(txn({ type: 'cash', subtype: 'withdrawal', amount: 500 }))).toBe(-500);
  });

  test('dividends, interest and capital gains count as value arriving', () => {
    for (const subtype of ['dividend', 'qualified dividend', 'interest', 'long-term capital gain']) {
      expect(valueDelta(txn({ type: 'cash', subtype, amount: -12.5 }))).toBe(12.5);
    }
  });

  test('fees lower value', () => {
    expect(valueDelta(txn({ type: 'fee', subtype: 'account fee', amount: 3 }))).toBe(-3);
  });

  // Buys and sells move cash to securities and back inside the same account, so
  // the principal nets out. Not to zero though: `amount` is the complete value
  // of the transaction and fees are inside it, so the account is down by fees.
  describe('buys and sells are internal apart from fees', () => {
    test('a buy costs only its fees', () => {
      expect(valueDelta(txn({ type: 'buy', subtype: 'buy', amount: 1000, fees: 4.95 }))).toBe(-4.95);
    });

    test('a sell likewise', () => {
      expect(valueDelta(txn({ type: 'sell', subtype: 'sell', amount: -1000, fees: 4.95 }))).toBe(
        -4.95
      );
    });

    test('a fee-free trade is exactly neutral', () => {
      expect(valueDelta(txn({ type: 'buy', subtype: 'buy', amount: 1000, fees: null }))).toBe(0);
    });
  });

  // The regression this guards: a spin-off reports the notional value of shares
  // RECEIVED while the matching position leaves the account. Booking that as
  // external inflow puts the account that much lower a year ago -- the same
  // class of error the whole feature exists to remove.
  describe('corporate actions move no value', () => {
    for (const subtype of ['merger', 'spin off', 'split', 'stock distribution', 'rebalance']) {
      test(`${subtype} is neutral`, () => {
        expect(valueDelta(txn({ type: 'transfer', subtype, amount: 5000 }))).toBe(0);
      });
    }
  });

  // ...but the list is scoped to type 'transfer'. Unscoped it shadowed the type
  // checks, and several of its members are ordinary subtypes elsewhere.
  describe('the corporate-action list does not shadow other types', () => {
    test('a cash adjustment is a real balance correction', () => {
      expect(valueDelta(txn({ type: 'cash', subtype: 'adjustment', amount: -250 }))).toBe(250);
    });

    test('a bond buy reported as subtype "trade" still costs its fees', () => {
      expect(valueDelta(txn({ type: 'buy', subtype: 'trade', amount: 900, fees: 2 }))).toBe(-2);
    });
  });

  test('genuine transfers in and out move value', () => {
    expect(valueDelta(txn({ type: 'transfer', subtype: 'transfer', amount: -2000 }))).toBe(2000);
    expect(valueDelta(txn({ type: 'transfer', subtype: 'withdrawal', amount: 2000 }))).toBe(-2000);
  });

  test('an unrecognized subtype is neutral rather than guessed at', () => {
    expect(valueDelta(txn({ type: 'transfer', subtype: 'something plaid added later' }))).toBe(0);
  });

  test('type and subtype matching is case-insensitive', () => {
    expect(valueDelta(txn({ type: 'CASH', subtype: 'DEPOSIT', amount: -100 }))).toBe(100);
  });
});

describe('isContribution', () => {
  test('counts money the holder put in', () => {
    expect(isContribution(txn({ type: 'cash', subtype: 'contribution', amount: -1500 }))).toBe(true);
    expect(isContribution(txn({ type: 'cash', subtype: 'deposit', amount: -1500 }))).toBe(true);
  });

  // Every one of these lives under type 'cash' and has a positive valueDelta,
  // so a naive "positive cash delta" rule would count them all as contributions
  // and badly overstate the YTD figure.
  test('excludes income the account generated itself', () => {
    for (const subtype of [
      'dividend',
      'qualified dividend',
      'interest',
      'long-term capital gain',
      'return of principal',
    ]) {
      expect(isContribution(txn({ type: 'cash', subtype, amount: -50 }))).toBe(false);
    }
  });

  test('excludes outflows that share a contribution subtype', () => {
    expect(isContribution(txn({ type: 'transfer', subtype: 'transfer', amount: 2000 }))).toBe(false);
  });
});

describe('fetchInvestmentTxns', () => {
  beforeEach(() => {
    pages = [];
    calls = [];
  });

  const row = (over: Record<string, unknown> = {}) => ({
    investment_transaction_id: `it${Math.random()}`,
    account_id: 'acct',
    date: '2026-03-01',
    name: 'Row',
    type: 'buy',
    subtype: 'buy',
    quantity: 1,
    price: 1,
    amount: 1,
    fees: 0,
    iso_currency_code: 'USD',
    security_id: 'sec1',
    ...over,
  });

  test('returns a single short page without asking for more', async () => {
    pages = [{ rows: [row(), row()] }];
    const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
    expect(res.txns).toHaveLength(2);
    expect(res.note).toBeNull();
    expect(calls).toHaveLength(1);
  });

  // The bug this guards: the truncation check ran before `offset` was advanced,
  // so `offset < total` was true on every ordinary single-page fetch. Every
  // account got flagged truncated, which zeroed invCovered and silently
  // disabled the entire walk.
  test('does not flag an ordinary fetch as truncated', async () => {
    pages = [{ rows: [row(), row(), row()] }];
    const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
    expect(res.truncated).toBe(false);
  });

  test('an empty result is not truncated either', async () => {
    pages = [{ rows: [] }];
    const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
    expect(res.txns).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.note).toBeNull();
  });

  test('pages until the reported total is reached, advancing the offset', async () => {
    const full = Array.from({ length: 500 }, () => row());
    pages = [
      { rows: full, total: 750 },
      { rows: Array.from({ length: 250 }, () => row()), total: 750 },
    ];
    const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
    expect(res.txns).toHaveLength(750);
    expect(res.truncated).toBe(false);
    expect(calls.map((c) => c.offset)).toEqual([0, 500]);
  });

  test('flags truncation when the page cap is hit with rows outstanding', async () => {
    pages = Array.from({ length: 25 }, () => ({
      rows: Array.from({ length: 500 }, () => row()),
      total: 100_000,
    }));
    const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
    expect(res.truncated).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(20); // MAX_PAGES
  });

  // A full page with no reported total means "unknown", not "exactly this many".
  test('treats a missing total on a full page as unknown rather than complete', async () => {
    pages = Array.from({ length: 25 }, () => ({
      rows: Array.from({ length: 500 }, () => row()),
      total: null,
    }));
    const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
    expect(res.truncated).toBe(true);
  });

  test('drops unsettled rows, which have no pending flag of their own', async () => {
    pages = [{ rows: [row({ subtype: 'pending credit' }), row({ subtype: 'pending debit' }), row()] }];
    const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
    expect(res.txns).toHaveLength(1);
  });

  test('drops cancellations and the rows they reverse', async () => {
    pages = [
      {
        rows: [
          row({ investment_transaction_id: 'original' }),
          row({ investment_transaction_id: 'reversal', type: 'cancel', cancel_transaction_id: 'original' }),
          row({ investment_transaction_id: 'kept' }),
        ],
      },
    ];
    const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
    expect(res.txns.map((t) => t.investment_transaction_id)).toEqual(['kept']);
  });

  test('resolves security names, falling back to the ticker then null', async () => {
    pages = [{ rows: [row({ security_id: 'sec1' }), row({ security_id: 'unknown' })] }];
    const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
    expect(res.txns[0].security).toBe('Acme Corp');
    expect(res.txns[1].security).toBeNull();
  });

  test('passes account_ids through so Plaid filters server-side', async () => {
    pages = [{ rows: [] }];
    await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01', ['acct']);
    expect(calls[0].account_ids).toEqual(['acct']);
  });
});
