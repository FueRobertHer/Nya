import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { InvestmentTxn } from '@/lib/investments';

// Stands in for the Plaid client so pagination can be driven deterministically.
// Declared before the mock.module call because that call is hoisted with the
// imports below it.
// `error` is a Plaid error_code (an HTTP response); `netCode` is an axios
// transport failure, which arrives with NO response and so no error_code at all
// -- the shape a client-side timeout actually takes.
let pages: { rows: any[]; total?: number | null; error?: string; netCode?: string }[] = [];
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
      if (page.error) throw { response: { data: { error_code: page.error } } };
      if (page.netCode) throw { code: page.netCode, message: 'timeout of 45000ms exceeded' };
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

const {
  valueDelta,
  isContribution,
  isRollover,
  isIncomingRollover,
  fetchInvestmentTxns,
  externalFlow,
  dailyFlows,
  countedTrades,
  walkDelta,
  contributedAmount,
} =
  await import('@/lib/investments');

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

  // The case this whole split exists for: a rollover arrives wearing a
  // contribution subtype, and at 401k sizes it dwarfs a real year of saving.
  test('excludes rollovers', () => {
    const rollover = txn({
      type: 'transfer',
      subtype: 'transfer',
      name: 'ROLLOVER CONTRIBUTION',
      amount: -60_000,
    });
    expect(isContribution(rollover)).toBe(false);
    expect(isIncomingRollover(rollover)).toBe(true);
  });
});

describe('isRollover', () => {
  test('matches the spellings and separators institutions use', () => {
    for (const name of [
      'ROLLOVER CONTRIBUTION',
      'Direct Rollover In',
      'roll over from 401k',
      'Roll-Over Deposit',
      'ROLL  OVER 401K', // runs of spaces, common in fixed-width descriptions
      'ROLLED OVER FROM PRIOR PLAN',
      'Rolling over to IRA',
      'Incoming rollovers',
    ]) {
      expect(isRollover(txn({ subtype: 'deposit', name }))).toBe(true);
    }
  });

  // The sending side of the same move, which the subtype gate has to admit too.
  test('matches the outgoing leg', () => {
    for (const subtype of ['withdrawal', 'distribution']) {
      expect(isRollover(txn({ type: 'cash', subtype, name: 'ROLLOVER TO IRA', amount: 60_000 }))).toBe(
        true
      );
    }
  });

  test('matches a rollover subtype, should Plaid ever emit one', () => {
    expect(isRollover(txn({ subtype: 'ROLLOVER', name: 'Transfer' }))).toBe(true);
  });

  // A subtype Plaid doesn't emit yet must still move value, or the row would be
  // dropped from the balance walk and from both figures the panel shows.
  test('a rollover subtype moves account value', () => {
    expect(valueDelta(txn({ type: 'transfer', subtype: 'rollover', amount: -60_000 }))).toBe(60_000);
    expect(isIncomingRollover(txn({ type: 'transfer', subtype: 'rollover', amount: -60_000 }))).toBe(
      true
    );
  });

  test('leaves ordinary activity alone', () => {
    for (const name of ['PAYROLL OVERTIME', 'Contribution', 'ACME CORP DIVIDEND', '']) {
      expect(isRollover(txn({ subtype: 'deposit', name }))).toBe(false);
    }
  });

  // "Rollover IRA" is the account's name, stamped on every row in the account by
  // the institutions that use it at all. Reading it as an event would break the
  // figure for exactly the people this split is for. Every spelling has to be
  // covered: recognising one word order and not another would split an
  // account's rows between the two figures on phrasing alone.
  test('reads the account label as a label, in any word order', () => {
    for (const name of [
      'CONTRIBUTION ROLLOVER IRA 2026',
      'ROLLOVER IRA CONTRIBUTION 2026',
      'IRA ROLLOVER CONTRIBUTION 2026',
      'IRA-ROLLOVER CONTRIBUTION 2026',
      'ROLLOVER ROTH IRA CONTRIBUTION 2026',
      'ROLLOVER IRAS CONTRIBUTION 2026',
      'ROLLOVER INDIVIDUAL RETIREMENT ACCOUNT PAYROLL CONTRIB',
    ]) {
      const row = txn({ type: 'cash', subtype: 'contribution', name, amount: -7000 });
      expect(isRollover(row)).toBe(false);
      // The half that actually matters to the user, and the half a predicate
      // test can silently leave unstated: it still counts as a contribution.
      expect(isContribution(row)).toBe(true);
    }
  });

  // The label is only believed when what's left describes an ordinary
  // contribution by itself. "ROLLOVER IRA DEPOSIT" is a plain description of an
  // arriving 401k, and misreading it costs the whole balance on the headline
  // figure -- an unbounded error, where the one above is capped by the annual
  // contribution limit.
  test('a label plus a neutral verb is still a rollover', () => {
    for (const name of [
      'ROLLOVER IRA DEPOSIT',
      'ROLLOVER-IRA DEPOSIT',
      'ROLLOVER IRA BDA DEPOSIT',
      'ROLLOVER IRA - ROLLOVER DEPOSIT', // said again outside the label
      'RolloverIRA Deposit', // label with the space left out
    ]) {
      const row = txn({ type: 'cash', subtype: 'deposit', name, amount: -62_400 });
      expect(isRollover(row)).toBe(true);
      expect(isContribution(row)).toBe(false);
    }
  });

  // The industry's own term for arriving rollover money. No account label to
  // strip, so the contribution marker must not reach it.
  test('"rollover contribution" is a rollover', () => {
    const row = txn({ type: 'cash', subtype: 'contribution', name: 'ROLLOVER CONTRIBUTION', amount: -60_000 });
    expect(isRollover(row)).toBe(true);
    expect(isContribution(row)).toBe(false);
  });

  // Every one of these has a positive valueDelta inside an account whose name
  // is on the row, so without the subtype gate each would post to the rollover
  // line and accumulate a figure with no event behind it.
  test('income credited inside a rollover IRA is not a rollover', () => {
    for (const subtype of ['qualified dividend', 'interest', 'long-term capital gain']) {
      const income = txn({ type: 'cash', subtype, name: `${subtype} ROLLOVER IRA`, amount: -320 });
      expect(isRollover(income)).toBe(false);
      expect(isIncomingRollover(income)).toBe(false);
      expect(isContribution(income)).toBe(false);
    }
  });

  test('direction comes from the value it moves, not the word', () => {
    // Plaid's convention: positive amount = cash leaving. The sending 401k's
    // leg is a rollover too, but nothing rolled INTO this account.
    const outgoing = txn({ type: 'transfer', subtype: 'transfer', name: 'Rollover', amount: 60_000 });
    expect(isRollover(outgoing)).toBe(true);
    expect(isIncomingRollover(outgoing)).toBe(false);
  });

  test('a rollover still moves the account value', () => {
    // valueDelta is untouched by the split: the balance reconstruction needs it.
    expect(valueDelta(txn({ type: 'transfer', subtype: 'transfer', name: 'Rollover', amount: -60_000 }))).toBe(
      60_000
    );
  });
});

// The two figures the activity panel shows are built from these predicates, so
// the property that keeps them honest -- no row in both, so nothing is counted
// twice -- is worth pinning across the whole subtype space rather than at the
// handful of points the cases above happen to touch.
describe('contributions and rollovers never overlap', () => {
  test('across every subtype, type and direction', () => {
    const subtypes = [
      'contribution', 'deposit', 'transfer', 'withdrawal', 'distribution', 'send', 'request',
      'rollover', 'dividend', 'qualified dividend', 'interest', 'long-term capital gain',
      'return of principal', 'adjustment', 'merger', 'spin off', 'buy', 'sell', 'account fee',
    ];
    for (const subtype of subtypes) {
      for (const type of ['cash', 'transfer', 'buy', 'sell', 'fee']) {
        for (const amount of [-60_000, 0, 60_000]) {
          for (const name of ['ROLLOVER CONTRIBUTION', 'ROLLOVER IRA CONTRIBUTION', 'ACME DEPOSIT']) {
            const row = txn({ type, subtype, amount, name });
            expect(isContribution(row) && isIncomingRollover(row)).toBe(false);
          }
        }
      }
    }
  });

  // Not a bug, but the invariant is "every FLOW-subtype arrival lands in exactly
  // one figure", not "every arrival does": valueDelta credits any `cash` row,
  // while both predicates gate on the flow subtypes. Pinned so the gap is a
  // documented choice rather than a later surprise.
  test('a cash subtype outside the flow set lands in neither', () => {
    const row = txn({ type: 'cash', subtype: 'adjustment', name: 'ROLLOVER ADJUSTMENT', amount: -60_000 });
    expect(valueDelta(row)).toBe(60_000);
    expect(isContribution(row)).toBe(false);
    expect(isIncomingRollover(row)).toBe(false);
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

  // `pending` is the one failure that fixes itself, and backfill leans on the
  // distinction: it holds an Item's investment accounts flat either way, but
  // only a standing failure lets it mark the reconstruction done. Marking it
  // done while Plaid was still extracting froze the gap in place -- the flows
  // never arrived, and nothing retried -- which is how an account's chart ends
  // up missing a rollover its own activity list shows.
  test('reports a still-importing product as pending', async () => {
    pages = [{ rows: [], error: 'PRODUCT_NOT_READY' }];
    const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
    expect(res.note).toBe('Investment activity is still importing');
    expect(res.pending).toBe(true);
  });

  // lib/plaid.ts now sets an axios timeout, and a timeout is transient in
  // exactly the way PRODUCT_NOT_READY is. Getting this wrong is not a cosmetic
  // misclassification: /api/backfill treats an investment failure as
  // non-blocking, so an unclassified timeout leaves invCovered and invPending
  // both false and the run marks the reconstruction DONE with every investment
  // account held flat -- permanently, since nothing retries a done backfill.
  test('a client-side timeout is pending, not a standing failure', async () => {
    for (const netCode of ['ECONNABORTED', 'ETIMEDOUT']) {
      calls = [];
      pages = [{ rows: [], netCode }];
      const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
      expect(res.pending).toBe(true);
      expect(res.note).toBe('Investment activity timed out');
      expect(res.txns).toEqual([]);
    }
  });

  test('a standing failure is not pending', async () => {
    for (const code of [
      'PRODUCTS_NOT_SUPPORTED',
      'NO_INVESTMENT_ACCOUNTS',
      'ITEM_LOGIN_REQUIRED',
      'INTERNAL_SERVER_ERROR',
    ]) {
      pages = [{ rows: [], error: code }];
      calls = [];
      const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
      expect(res.note).not.toBeNull();
      expect(res.pending).toBe(false);
    }
  });

  test('a clean fetch is not pending', async () => {
    pages = [{ rows: [row()] }];
    const res = await fetchInvestmentTxns('tok', '2025-01-01', '2026-01-01');
    expect(res.note).toBeNull();
    expect(res.pending).toBe(false);
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

// The "money added" side of the chart's added-vs-growth split. Anything counted
// here is subtracted from growth, so both directions of error show on screen.
describe('externalFlow', () => {
  test('money crossing the boundary counts, in both directions', () => {
    expect(externalFlow(txn({ subtype: 'contribution', amount: -500 }))).toBe(500);
    expect(externalFlow(txn({ subtype: 'deposit', amount: -100 }))).toBe(100);
    expect(externalFlow(txn({ type: 'transfer', subtype: 'transfer', amount: -2000 }))).toBe(2000);
    expect(externalFlow(txn({ subtype: 'withdrawal', amount: 300 }))).toBe(-300);
    expect(externalFlow(txn({ subtype: 'distribution', amount: 50 }))).toBe(-50);
  });

  // For this account a rollover is money arriving, not money the market made.
  test('counts a rollover', () => {
    expect(externalFlow(txn({ type: 'transfer', subtype: 'transfer', name: 'ROLLOVER FROM 401K', amount: -60_000 }))).toBe(60_000);
  });

  test('leaves growth out: dividends, interest and fees', () => {
    expect(externalFlow(txn({ subtype: 'dividend', amount: -40 }))).toBe(0);
    expect(externalFlow(txn({ subtype: 'interest', amount: -3 }))).toBe(0);
    expect(externalFlow(txn({ type: 'fee', subtype: 'account fee', amount: 25 }))).toBe(0);
  });

  test('leaves internal movement out, even under an external-sounding subtype', () => {
    expect(externalFlow(txn({ type: 'buy', subtype: 'buy', amount: 1000, fees: 1 }))).toBe(0);
    expect(externalFlow(txn({ type: 'buy', subtype: 'contribution', amount: 1000 }))).toBe(0);
    expect(externalFlow(txn({ type: 'transfer', subtype: 'merger', amount: -900 }))).toBe(0);
  });
});

describe('dailyFlows', () => {
  test('sums per date, ascending, dropping net-zero days and non-flows', () => {
    expect(
      dailyFlows([
        txn({ date: '2026-03-02', subtype: 'contribution', amount: -500 }),
        txn({ date: '2026-03-01', subtype: 'deposit', amount: -100 }),
        txn({ date: '2026-03-02', subtype: 'contribution', amount: -250 }),
        txn({ date: '2026-03-03', subtype: 'deposit', amount: -100 }),
        txn({ date: '2026-03-03', subtype: 'withdrawal', amount: 100 }),
        txn({ date: '2026-03-04', subtype: 'dividend', amount: -40 }),
      ])
    ).toEqual([
      { date: '2026-03-01', amount: 100 },
      { date: '2026-03-02', amount: 750 },
    ]);
  });
});

describe('externalFlow edge cases from review', () => {
  test('a 401k loan repayment is money added', () => {
    expect(externalFlow(txn({ type: 'cash', subtype: 'loan payment', amount: -200 }))).toBe(200);
  });

  // Plaid defines a distribution as money leaving; one arriving is a fund
  // paying out into the account, which is growth.
  test('a distribution paid INTO the account is growth, not money added', () => {
    expect(externalFlow(txn({ subtype: 'distribution', amount: -75 }))).toBe(0);
  });
});

describe('dailyFlows with contribution trades', () => {
  // Some recordkeepers book a paycheck as one buy that uses outside money.
  test('a lone contribution buy is money added', () => {
    expect(dailyFlows([txn({ type: 'buy', subtype: 'contribution', amount: 500 })])).toEqual([
      { date: '2026-03-01', amount: 500 },
    ]);
  });

  test('a lone distribution sell is money out', () => {
    expect(dailyFlows([txn({ type: 'sell', subtype: 'distribution', amount: -800 })])).toEqual([
      { date: '2026-03-01', amount: -800 },
    ]);
  });

  // Others report the money arriving AND the shares it bought: counted once.
  test('a contribution buy matched by a same-day cash contribution is not counted twice', () => {
    expect(
      dailyFlows([
        txn({ investment_transaction_id: 'c', type: 'cash', subtype: 'contribution', amount: -500 }),
        txn({ investment_transaction_id: 'b', type: 'buy', subtype: 'contribution', amount: 500 }),
      ])
    ).toEqual([{ date: '2026-03-01', amount: 500 }]);
  });

  // One paycheck split across two funds: the cash row is the money, the buys
  // are where it went. Pairing rows one to one counted it twice.
  test('a paycheck split across funds is counted once', () => {
    expect(
      dailyFlows([
        txn({ investment_transaction_id: 'c', type: 'cash', subtype: 'contribution', amount: -500 }),
        txn({ investment_transaction_id: 'b1', type: 'buy', subtype: 'contribution', amount: 300 }),
        txn({ investment_transaction_id: 'b2', type: 'buy', subtype: 'contribution', amount: 200 }),
      ])
    ).toEqual([{ date: '2026-03-01', amount: 500 }]);
  });
});

// One answer, over the whole set, to "did this contribution trade carry its own
// money", shared by the walk, the chart's flows and the year-to-date figures.
describe('countedTrades', () => {
  const buy = (over: Partial<InvestmentTxn> = {}) =>
    txn({ investment_transaction_id: 'b', type: 'buy', subtype: 'contribution', amount: 500, ...over });
  const cashIn = (over: Partial<InvestmentTxn> = {}) =>
    txn({ investment_transaction_id: 'c', type: 'cash', subtype: 'contribution', amount: -500, ...over });

  test('a lone contribution buy counts', () => {
    const b = buy();
    expect([...countedTrades([b])]).toEqual([b]);
  });

  test('a same-day cash row of the same amount covers it', () => {
    expect(countedTrades([cashIn(), buy()]).size).toBe(0);
  });

  // Decided per account: a cash row in the next account over proves nothing.
  test('a cash row in another account does not cover it', () => {
    expect(countedTrades([cashIn({ account_id: 'other' }), buy()]).size).toBe(1);
  });

  // An account that books cash rows books ALL its money that way, so its buys
  // are internal whatever their dates or amounts. Each of these counted twice
  // under same-day, same-amount pairing.
  test('an account that books cash rows never counts its buys', () => {
    // Settlement lag: cash on Friday, buy on Monday.
    expect(countedTrades([cashIn({ date: '2026-02-27' }), buy({ date: '2026-03-02' })]).size).toBe(0);
    // Employee contribution plus employer match, bought as one.
    expect(
      countedTrades([cashIn({ investment_transaction_id: 'e', amount: -300 }), cashIn({ amount: -200 }), buy()]).size
    ).toBe(0);
  });

  test('a distribution with tax withheld is counted once', () => {
    const rows = [
      txn({ investment_transaction_id: 's', type: 'sell', subtype: 'distribution', amount: -1000 }),
      txn({ investment_transaction_id: 'w', type: 'cash', subtype: 'tax withheld', amount: 100 }),
      txn({ investment_transaction_id: 'd', type: 'cash', subtype: 'distribution', amount: 900 }),
    ];
    const counted = countedTrades(rows);
    expect(counted.size).toBe(0);
    expect(rows.reduce((sum, t) => sum + walkDelta(t, counted), 0)).toBe(-1000);
  });

  // Matched on the SAME subtype: a rollover arriving as a cash transfer says
  // nothing about how the account books its paychecks.
  test('an unrelated cash row does not suppress the buys', () => {
    const rollover = txn({ investment_transaction_id: 'r', type: 'transfer', subtype: 'transfer', name: 'ROLLOVER', amount: -60_000 });
    expect(countedTrades([rollover, buy()]).size).toBe(1);
  });

  // Same shape as a paycheck: buys made with outside money.
  test('a loan repayment booked as a buy counts', () => {
    expect(countedTrades([buy({ subtype: 'loan payment', amount: 200 })]).size).toBe(1);
  });

  test('ordinary trades are never counted', () => {
    expect(countedTrades([txn({ type: 'buy', subtype: 'buy', amount: 500 })]).size).toBe(0);
  });
});

describe('walkDelta and contributedAmount', () => {
  // $500 of outside money with a $2 fee buys $498 of fund: the account's
  // value moves by 498, while $500 is what was contributed.
  test('a counted contribution buy moves value by amount less fees', () => {
    const b = txn({ type: 'buy', subtype: 'contribution', amount: 500, fees: 2 });
    const counted = countedTrades([b]);
    expect(walkDelta(b, counted)).toBe(498);
    expect(contributedAmount(b, counted)).toBe(500);
  });

  test('a counted distribution sell moves value out', () => {
    const s = txn({ type: 'sell', subtype: 'distribution', amount: -800, fees: 0 });
    expect(walkDelta(s, countedTrades([s]))).toBe(-800);
  });

  // Covered by the cash row, the buy is an internal trade again: the pair
  // moves value by the cash row less the buy's fees, not twice the paycheck.
  test('a covered buy falls back to valueDelta', () => {
    const c = txn({ investment_transaction_id: 'c', type: 'cash', subtype: 'contribution', amount: -500 });
    const b = txn({ investment_transaction_id: 'b', type: 'buy', subtype: 'contribution', amount: 500, fees: 2 });
    const counted = countedTrades([c, b]);
    expect(walkDelta(c, counted) + walkDelta(b, counted)).toBe(498);
  });
});

describe('year-to-date figures with contribution trades', () => {
  test('a lone contribution buy is contributed money', () => {
    const b = txn({ type: 'buy', subtype: 'contribution', amount: 500 });
    expect(isContribution(b)).toBe(false); // judged alone, as before
    expect(isContribution(b, countedTrades([b]))).toBe(true);
  });

  test('a covered buy is not counted on top of its cash row', () => {
    const c = txn({ investment_transaction_id: 'c', type: 'cash', subtype: 'contribution', amount: -500 });
    const b = txn({ investment_transaction_id: 'b', type: 'buy', subtype: 'contribution', amount: 500 });
    const counted = countedTrades([c, b]);
    const total = [c, b]
      .filter((t) => isContribution(t, counted))
      .reduce((s, t) => s + contributedAmount(t, counted), 0);
    expect(total).toBe(500);
  });

  test('a rollover arriving as a single buy is a rollover, not a contribution', () => {
    const b = txn({ type: 'buy', subtype: 'contribution', name: 'ROLLOVER FROM 401K', amount: 60_000 });
    const counted = countedTrades([b]);
    expect(isIncomingRollover(b, counted)).toBe(true);
    expect(isContribution(b, counted)).toBe(false);
  });

  // The readers must agree: what the chart calls money added over a span of
  // contributions is what the year-to-date figure calls contributed.
  // One account of each reporting style: buys only, and cash rows plus buys.
  test('agrees with dailyFlows', () => {
    const rows = [
      txn({ investment_transaction_id: '1', account_id: 'k401', date: '2026-03-01', type: 'buy', subtype: 'contribution', amount: 500 }),
      txn({ investment_transaction_id: '2', account_id: 'k401', date: '2026-03-15', type: 'buy', subtype: 'contribution', amount: 500 }),
      txn({ investment_transaction_id: '3', account_id: 'ira', date: '2026-03-15', type: 'cash', subtype: 'contribution', amount: -500 }),
      txn({ investment_transaction_id: '4', account_id: 'ira', date: '2026-03-15', type: 'buy', subtype: 'contribution', amount: 500 }),
    ];
    const counted = countedTrades(rows);
    const ytd = rows
      .filter((t) => isContribution(t, counted))
      .reduce((s, t) => s + contributedAmount(t, counted), 0);
    const flows = dailyFlows(rows).reduce((s, f) => s + f.amount, 0);
    expect(ytd).toBe(1500);
    expect(flows).toBe(1500);
  });
});

// Deposits, transfers and withdrawals booked as trades, under the same
// per-account evidence rule as contributions.
describe('other single-row money trades', () => {
  test('a buy booked as a deposit or transfer is money added in a buys-only account', () => {
    expect(dailyFlows([txn({ type: 'buy', subtype: 'deposit', amount: 400 })])).toEqual([{ date: '2026-03-01', amount: 400 }]);
    expect(dailyFlows([txn({ type: 'buy', subtype: 'transfer', amount: 250 })])).toEqual([{ date: '2026-03-01', amount: 250 }]);
  });

  test('a sell booked as a withdrawal is money out in a sells-only account', () => {
    expect(dailyFlows([txn({ type: 'sell', subtype: 'withdrawal', amount: -300 })])).toEqual([{ date: '2026-03-01', amount: -300 }]);
  });

  // The account books deposits as cash, so the buy is where that money went.
  test('an account that books deposits as cash never counts its deposit buys', () => {
    const rows = [
      txn({ investment_transaction_id: 'c', type: 'cash', subtype: 'deposit', amount: -400 }),
      txn({ investment_transaction_id: 'b', type: 'buy', subtype: 'deposit', amount: 400 }),
    ];
    expect(dailyFlows(rows)).toEqual([{ date: '2026-03-01', amount: 400 }]);
  });
});

// Shares moved between institutions with no cash, reported at amount 0.
describe('in-kind transfers', () => {
  test('are valued from quantity and price, in both directions', () => {
    expect(valueDelta(txn({ type: 'transfer', subtype: 'transfer', amount: 0, quantity: 100, price: 400 }))).toBe(40_000);
    expect(valueDelta(txn({ type: 'transfer', subtype: 'transfer', amount: 0, quantity: -10, price: 50 }))).toBe(-500);
    expect(externalFlow(txn({ type: 'transfer', subtype: 'transfer', amount: 0, quantity: 100, price: 400 }))).toBe(40_000);
  });

  // Only a transfer reported at exactly 0 is valued this way.
  test('leave rows that report an amount, or are not transfers, alone', () => {
    expect(valueDelta(txn({ type: 'transfer', subtype: 'transfer', amount: -900, quantity: 100, price: 400 }))).toBe(900);
    // A cash row at 0 is worth 0 (compared with ==, since -amount is -0).
    expect(valueDelta(txn({ type: 'cash', subtype: 'deposit', amount: 0, quantity: 100, price: 400 })) == 0).toBe(true);
    expect(valueDelta(txn({ type: 'transfer', subtype: 'merger', amount: 0, quantity: 100, price: 400 }))).toBe(0);
  });
});
