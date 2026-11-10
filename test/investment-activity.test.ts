import { describe, expect, test } from 'bun:test';
import { activityFromSync } from '@/lib/investment-activity';
import { dailyFlows, type InvestmentTxn } from '@/lib/investments';
import type { InvSync } from '@/lib/invstore';

// The flows the activity serves (lib/investment-activity.ts): the chart's
// line, its readout, the sheet's figures and Accounts > Investments all count
// from them, so a move must already be out of them.

let n = 0;
const txn = (date: string, type: string, subtype: string, amount: number): InvestmentTxn => ({
  investment_transaction_id: `t${++n}`,
  account_id: 'acct',
  date,
  name: `${type} ${subtype}`,
  type,
  subtype,
  quantity: 1,
  price: Math.abs(amount),
  amount,
  fees: null,
  currency: 'USD',
  security: type === 'cash' ? null : 'sec',
});
const sync = (rows: InvestmentTxn[]): InvSync => ({
  rows,
  coverage: { acct: { from: '2026-01-01', through: '2026-11-05' } },
  note: null,
  pending: false,
  storeNote: null,
  unconfirmed: {},
  unconfirmedIds: [],
  busy: false,
});

describe('the flows', () => {
  // A fund exchange booked as a sell and a buy, both "transfer", on days two
  // apart: each day's net alone reads as $10,000 out, then $10,000 in.
  test('an exchange whose legs land on different days is neither money in nor out', () => {
    const rows = [
      txn('2026-03-02', 'sell', 'transfer', -10_000),
      txn('2026-03-04', 'buy', 'transfer', 10_000),
      txn('2026-03-16', 'cash', 'contribution', -500),
    ];
    expect(dailyFlows(rows)).toEqual([
      { date: '2026-03-02', amount: -10_000 },
      { date: '2026-03-04', amount: 10_000 },
      { date: '2026-03-16', amount: 500 },
    ]);
    const a = activityFromSync(sync(rows), 'acct');
    expect(a.flows).toEqual([{ date: '2026-03-16', amount: 500 }]);
    expect(a.moves).toEqual([{ from: '2026-03-02', to: '2026-03-04' }]);
  });

  test('a withdrawal stays money out', () => {
    const rows = [txn('2026-03-02', 'cash', 'withdrawal', 2_000), txn('2026-03-16', 'cash', 'contribution', -500)];
    expect(activityFromSync(sync(rows), 'acct').flows).toEqual([
      { date: '2026-03-02', amount: -2_000 },
      { date: '2026-03-16', amount: 500 },
    ]);
  });
});
