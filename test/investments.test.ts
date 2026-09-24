import { describe, expect, test } from 'bun:test';
import type { InvestmentTxn } from '@/lib/investments';

const {
  valueDelta,
  isContribution,
  isRollover,
  isIncomingRollover,
  classifyFetchError,
  toInvestmentTxn,
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

// How a failed investment-transactions call is reported. Whether it is
// 'pending' is load-bearing: the backfill waits for pending failures and
// accepts the rest, so a transient one misread as standing would freeze an
// Item's investments flat.
describe('classifyFetchError', () => {
  test('a still-importing product is pending', () => {
    expect(classifyFetchError({ response: { data: { error_code: 'PRODUCT_NOT_READY' } } })).toEqual({
      note: 'Investment activity is still importing',
      pending: true,
    });
  });

  // A client-side timeout arrives with no Plaid error code at all.
  test('a timeout is pending, not a standing failure', () => {
    expect(classifyFetchError({ code: 'ECONNABORTED' }).pending).toBe(true);
    expect(classifyFetchError({ code: 'ETIMEDOUT' }).pending).toBe(true);
  });

  test('standing failures are not pending', () => {
    expect(classifyFetchError({ response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } })).toEqual({
      note: 'This account needs to be reconnected',
      pending: false,
    });
    expect(classifyFetchError({ response: { data: { error_code: 'PRODUCTS_NOT_SUPPORTED' } } }).pending).toBe(false);
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(classifyFetchError(new Error('boom'))).toEqual({ note: 'Could not fetch investment activity', pending: false });
    } finally {
      console.error = quiet;
    }
  });
});

describe('toInvestmentTxn', () => {
  const raw = {
    investment_transaction_id: 't',
    account_id: 'a',
    date: '2026-03-01',
    name: 'Buy',
    type: 'buy',
    subtype: 'buy',
    quantity: 1,
    price: 10,
    amount: 10,
    fees: null,
    iso_currency_code: 'USD',
    security_id: 'sec1',
  };

  test('resolves the security name, falling back to the ticker, then null', () => {
    expect(toInvestmentTxn(raw, { sec1: { name: 'Acme Corp', ticker_symbol: 'ACME' } }).security).toBe('Acme Corp');
    expect(toInvestmentTxn(raw, { sec1: { name: null, ticker_symbol: 'ACME' } }).security).toBe('ACME');
    expect(toInvestmentTxn(raw, {}).security).toBeNull();
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

describe('countedTrades evidence window', () => {
  const buy = (date: string) => txn({ investment_transaction_id: `b${date}`, date, type: 'buy', subtype: 'contribution', amount: 500 });
  const cashIn = (date: string) => txn({ investment_transaction_id: `c${date}`, date, type: 'cash', subtype: 'contribution', amount: -500 });

  // Evidence is nearby, not lifetime: a recordkeeper that booked cash rows
  // years ago says nothing about how it books paychecks now.
  test('a cash row more than 45 days away is not evidence', () => {
    expect(countedTrades([cashIn('2024-01-01'), buy('2026-03-01')]).size).toBe(1);
  });

  // Nor calendar year: a Dec 31 cash row and its Jan 2 buy are one paycheck.
  test('a cash row across a year boundary is evidence', () => {
    expect(countedTrades([cashIn('2025-12-31'), buy('2026-01-02')]).size).toBe(0);
  });
});

describe('fund exchanges', () => {
  // A sell/transfer and a buy/transfer is money moving between funds in the
  // same account: nothing added, nothing taken out.
  test('an exchange booked as two transfer trades nets to zero', () => {
    expect(
      dailyFlows([
        txn({ investment_transaction_id: 's', type: 'sell', subtype: 'transfer', amount: -10_000 }),
        txn({ investment_transaction_id: 'b', type: 'buy', subtype: 'transfer', amount: 10_000 }),
      ])
    ).toEqual([]);
  });
});

describe('in-kind valuation scope', () => {
  test('only a plain transfer is valued from quantity and price', () => {
    expect(valueDelta(txn({ type: 'transfer', subtype: 'distribution', amount: 0, quantity: 100, price: 400 })) == 0).toBe(true);
  });
});

describe('in-kind transfers as evidence', () => {
  // Shares moved in kind say nothing about how the account books cash, so they
  // must not suppress a genuine transfer trade nearby.
  test('an in-kind transfer does not make a nearby transfer trade internal', () => {
    const inKind = txn({ investment_transaction_id: 'k', type: 'transfer', subtype: 'transfer', amount: 0, quantity: 10, price: 50 });
    const buy = txn({ investment_transaction_id: 'b', type: 'buy', subtype: 'transfer', amount: 300 });
    expect(countedTrades([inKind, buy]).has(buy)).toBe(true);
  });
});

describe('classifyFetchError: temporary failures', () => {
  // Temporary by Plaid's own classification: the backfill must wait for these,
  // not hold investments flat and mark itself done.
  test('institution, API and rate-limit errors are pending', () => {
    for (const error_type of ['INSTITUTION_ERROR', 'API_ERROR', 'RATE_LIMIT_EXCEEDED']) {
      expect(classifyFetchError({ response: { data: { error_type, error_code: 'X' } } }).pending).toBe(true);
    }
  });

  test('HTTP 429 and 5xx without a Plaid body are pending', () => {
    expect(classifyFetchError({ response: { status: 429 } }).pending).toBe(true);
    expect(classifyFetchError({ response: { status: 503 } }).pending).toBe(true);
  });
});
