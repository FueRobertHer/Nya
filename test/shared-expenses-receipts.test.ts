import { describe, expect, test } from 'bun:test';
import { applyShares, type ShareInputs } from '@/lib/shared-expenses/rows';
import type { Iou, Payment, Share } from '@/lib/shared-expenses/model';
import { bankRows } from '@/lib/split-rows';
import { markAttached } from '@/lib/activity';
import { receiptRows } from '@/components/receipt-filter';
import { candidates, findCandidates } from '@/components/attachment-pick';
import type { Txn } from '@/lib/transactions';
import { row as runwayRow } from './runway-fixture';

// Receipts and documents (#47) where shared expenses (#49) meet them: the
// Activity tab's filter by receipt and the "Attach to another transaction"
// picker read each transaction once, as the bank has it. The rows the layer
// adds (another's part, a part paid back) go with their transaction, never
// as one of their own, and an IOU's row, on no transaction, is in neither.

const AT = '2026-10-01T12:00:00.000Z';
const base = (id: string, over: Partial<Txn> = {}): Txn =>
  runwayRow(id, over.date ?? '2026-10-03', over.amount ?? 120, { account_id: 'chk', name: 'Joes Diner', category: 'food and drink', category_kind: 'expense', ...over });
const share = (entry: string, amount: number): Share => ({ version: 1, account_id: 'chk', amount_was: 120, currency: 'USD', date: '2026-10-03', what: 'Dinner', entries: [{ id: entry, person: 'p', amount }], created_at: AT, updated_at: AT });
const iou: Iou = { version: 1, person: 'p', direction: 'by_you', amount: 25, currency: 'USD', date: '2026-10-05', what: 'Groceries', category_id: 'c1', created_at: AT, updated_at: AT };
const pay: Payment = { version: 1, account_id: 'chk', row: { amount: -50, currency: 'USD', date: '2026-10-09' }, allocations: [{ item: 'e1', amount: 50 }], confirmed_at: AT };
const inputs = (over: Partial<ShareInputs> = {}): ShareInputs => ({
  counting: 'part',
  shares: new Map([['t_d', share('e1', 80)]]),
  sharesUnknown: new Set(),
  payments: new Map([['t_v', pay]]),
  paymentsUnknown: new Set(),
  ious: new Map([['i1', iou]]),
  iousUnread: 0,
  ix: null,
  ...over,
});

/** A $120 dinner shared $80 to Alex, Alex's $50 by Venmo confirmed against
 *  it, and an IOU you owe; `attached`, the ids with a receipt (null: that
 *  couldn't be read). */
function layered(attached: ReadonlySet<string> | null = new Set(), over: Partial<ShareInputs> = {}) {
  const rows = [base('t_v', { name: 'VENMO CASHOUT', amount: -50, date: '2026-10-09', category: 'transfer in', category_kind: 'transfer', transaction_code: 'transfer' }), base('t_d')];
  markAttached(rows, new Map(), attached);
  return applyShares(rows, inputs(over)).rows;
}
const ids = (rows: readonly { transaction_id: string }[]) => rows.map((t) => t.transaction_id);

describe('the filter by receipt reads each transaction once, at the bank’s amount', () => {
  test('the layer adds rows to the list: another’s part, a part paid back and an IOU', () => {
    expect(ids(layered()).sort()).toEqual(['iou:i1', 'settled:t_v:e1', 'share:e1', 't_d', 't_v']);
  });

  test('without a receipt, over $50: the dinner whole, its rows with it, never Alex’s part alone, the IOU or the payment in', () => {
    const kept = receiptRows(layered(), 'without', '50').rows;
    expect(ids(kept)).toEqual(['t_d', 'share:e1']);
    // Listed as the bank has it: one transaction, $120.
    expect(bankRows(kept, { groups: 'keep', ious: 'keep' }).map((t) => [t.transaction_id, t.amount])).toEqual([['t_d', 120]]);
    // Over $100: the dinner's $120, not your $40 or a half's $60.
    expect(ids(receiptRows(layered(), 'without', '100').rows)).toEqual(['t_d', 'share:e1']);
    const half = layered(new Set(), { shares: new Map([['t_d', share('e2', 60)]]), payments: new Map(), ious: new Map() });
    expect(ids(receiptRows(half, 'without', '100').rows)).toEqual(['t_d', 'share:e2']);
    expect(ids(receiptRows(layered(), 'without', '120').rows)).toEqual([]);
  });

  test('with a receipt: the transaction it is on, with its rows, never an IOU', () => {
    expect(ids(receiptRows(layered(new Set(['t_d'])), 'with', '').rows)).toEqual(['t_d', 'share:e1']);
    expect(ids(receiptRows(layered(new Set(['t_v'])), 'with', '').rows)).toEqual(['t_v', 'settled:t_v:e1']);
    expect(ids(receiptRows(layered(), 'with', '').rows)).toEqual([]);
  });

  test('while whether they have one can’t be read, each transaction is left out and counted once', () => {
    const r = receiptRows(layered(null), 'without', '');
    expect(r.rows).toEqual([]);
    expect(r.unknown).toBe(2);
  });

  test('as your bank shows it, nothing is added, and it reads the same', () => {
    const bank = layered(new Set(), { counting: 'bank' });
    expect(ids(receiptRows(bank, 'without', '100').rows)).toEqual(['t_d']);
  });
});

describe('the picker offers each transaction once, at the bank’s amount', () => {
  test('never a row the layer adds, and a shared dinner found by its whole amount', () => {
    const all = candidates(layered());
    expect(all.map((c) => [c.id, c.amount])).toEqual([
      ['t_v', -50],
      ['t_d', 120],
    ]);
    expect(findCandidates(all, '120').map((c) => c.id)).toEqual(['t_d']);
    expect(findCandidates(all, '40')).toEqual([]);
    expect(candidates(layered(), 't_d').map((c) => c.id)).toEqual(['t_v']);
  });
});
