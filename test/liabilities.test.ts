import { describe, expect, test } from 'bun:test';
import { normalizeLiabilities, type AccountLiability } from '@/lib/liabilities';

// Plaid's LiabilitiesObject is a big nominal type and these fixtures are
// deliberately partial -- the point of most of these cases is what happens when
// fields are missing, which is exactly what the type forbids expressing.
const obj = (o: unknown) => o as Parameters<typeof normalizeLiabilities>[0];

describe('normalizeLiabilities', () => {
  test('returns an empty map for null/undefined/empty input', () => {
    expect(normalizeLiabilities(null)).toEqual({});
    expect(normalizeLiabilities(undefined)).toEqual({});
    expect(normalizeLiabilities(obj({}))).toEqual({});
  });

  test('skips entries with no account_id, which Plaid types as nullable', () => {
    const out = normalizeLiabilities(
      obj({ credit: [{ account_id: null, aprs: [] }, { account_id: undefined }] })
    );
    expect(Object.keys(out)).toEqual([]);
  });

  describe('credit APR selection', () => {
    const aprsFor = (aprs: unknown): AccountLiability =>
      normalizeLiabilities(obj({ credit: [{ account_id: 'a', aprs }] }))['a'];

    test('prefers the purchase APR over higher rates', () => {
      const l = aprsFor([
        { apr_type: 'cash_apr', apr_percentage: 29.99 },
        { apr_type: 'purchase_apr', apr_percentage: 21.24 },
      ]);
      expect(l.apr).toBe(21.24);
      expect(l.apr_label).toBe('Purchase APR');
    });

    // The bug this guards: the label used to be hardcoded 'Purchase APR', so a
    // card reporting no purchase APR rendered "Purchase APR - 29.99%" over a
    // cash-advance rate.
    test('labels the fallback honestly when there is no purchase APR', () => {
      const l = aprsFor([
        { apr_type: 'balance_transfer_apr', apr_percentage: 0 },
        { apr_type: 'cash_apr', apr_percentage: 29.99 },
      ]);
      expect(l.apr).toBe(29.99);
      expect(l.apr_label).toBe('Highest APR');
    });

    test('falls back to the highest, never the first, so the rate shown is never rosier than reality', () => {
      expect(aprsFor([{ apr_percentage: 0 }, { apr_percentage: 24.99 }]).apr).toBe(24.99);
    });

    test('falls back when the purchase entry exists but reports no percentage', () => {
      const l = aprsFor([
        { apr_type: 'purchase_apr', apr_percentage: null },
        { apr_type: 'cash_apr', apr_percentage: 18.5 },
      ]);
      expect(l.apr).toBe(18.5);
      expect(l.apr_label).toBe('Highest APR');
    });

    test('yields a null rate and a null label rather than a mislabelled one', () => {
      for (const aprs of [[], null, undefined, 'nonsense', [{ apr_percentage: null }]]) {
        const l = aprsFor(aprs);
        expect(l.apr).toBeNull();
        expect(l.apr_label).toBeNull();
      }
    });

    test('ignores non-finite rates', () => {
      expect(aprsFor([{ apr_percentage: NaN }, { apr_percentage: Infinity }]).apr).toBeNull();
    });
  });

  test('maps a full credit card', () => {
    const out = normalizeLiabilities(
      obj({
        credit: [
          {
            account_id: 'card',
            aprs: [{ apr_type: 'purchase_apr', apr_percentage: 21.24 }],
            minimum_payment_amount: 35,
            next_payment_due_date: '2026-09-15',
            last_statement_balance: 410,
            last_payment_amount: 100,
            last_payment_date: '2026-08-01',
            is_overdue: false,
          },
        ],
      })
    );
    expect(out['card']).toEqual({
      kind: 'credit',
      apr: 21.24,
      apr_label: 'Purchase APR',
      minimum_payment: 35,
      next_due_date: '2026-09-15',
      last_statement_balance: 410,
      last_payment_amount: 100,
      last_payment_date: '2026-08-01',
      is_overdue: false,
    });
  });

  test('maps a student loan, including its payoff extras', () => {
    const out = normalizeLiabilities(
      obj({
        student: [
          {
            account_id: 'loan',
            interest_rate_percentage: 6.8,
            minimum_payment_amount: 420,
            next_payment_due_date: '2026-09-01',
            expected_payoff_date: '2031-01-01',
            outstanding_interest_amount: 55.2,
            is_overdue: true,
          },
        ],
      })
    );
    expect(out['loan']).toMatchObject({
      kind: 'student',
      apr: 6.8,
      apr_label: 'Interest rate',
      minimum_payment: 420,
      expected_payoff_date: '2031-01-01',
      outstanding_interest: 55.2,
      is_overdue: true,
      last_statement_balance: null, // student loans report no statement balance
    });
  });

  test('maps a mortgage, deriving is_overdue from past_due_amount', () => {
    const mortgage = (past_due_amount: unknown) =>
      normalizeLiabilities(
        obj({
          mortgage: [
            {
              account_id: 'm',
              interest_rate: { percentage: 5.25 },
              next_monthly_payment: 2100,
              maturity_date: '2051-06-01',
              escrow_balance: 3200,
              past_due_amount,
            },
          ],
        })
      )['m'];

    expect(mortgage(0)).toMatchObject({
      kind: 'mortgage',
      apr: 5.25,
      apr_label: 'Interest rate',
      minimum_payment: 2100, // the scheduled payment fills the "minimum" role
      escrow_balance: 3200,
      maturity_date: '2051-06-01',
      is_overdue: false,
    });
    expect(mortgage(150).is_overdue).toBe(true);
    // Absent is "unknown", not "not overdue" -- a false would render a
    // reassurance the data doesn't support.
    expect(mortgage(null).is_overdue).toBeNull();
  });

  test('survives a mortgage with no interest_rate object', () => {
    const out = normalizeLiabilities(obj({ mortgage: [{ account_id: 'm' }] }));
    expect(out['m'].apr).toBeNull();
  });

  // This runs inside lib/networth.ts's per-institution try block. A throw there
  // rejects the Promise.all and 500s both /api/net-worth and the snapshot cron.
  test('never throws on malformed input', () => {
    const garbage = [
      { credit: 'not an array' },
      { credit: [null, undefined, 42] },
      { student: [{ account_id: 'x', interest_rate_percentage: 'six' }] },
      { mortgage: [{ account_id: 'x', interest_rate: 'nope' }] },
    ];
    for (const g of garbage) {
      expect(() => normalizeLiabilities(obj(g))).not.toThrow();
    }
  });

  test('keys all three kinds into one flat map', () => {
    const out = normalizeLiabilities(
      obj({
        credit: [{ account_id: 'c', aprs: [] }],
        student: [{ account_id: 's', interest_rate_percentage: 4 }],
        mortgage: [{ account_id: 'm', interest_rate: { percentage: 3 } }],
      })
    );
    expect(Object.keys(out).sort()).toEqual(['c', 'm', 's']);
    expect(out['c'].kind).toBe('credit');
    expect(out['s'].kind).toBe('student');
    expect(out['m'].kind).toBe('mortgage');
  });
});
