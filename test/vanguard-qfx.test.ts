// The reader of Vanguard's transactions download as QFX (lib/import/vanguard-qfx.ts),
// on synthetic files in its layout (test/vanguard-transactions-qfx.ts), what
// lib/investments.ts makes of the rows it reads, and the OFX reader's bank
// path, which still refuses an investment statement.

import { describe, expect, test } from 'bun:test';
import { isVanguardQfx, readVanguardQfx, type VanguardQfxRead } from '@/lib/import/vanguard-qfx';
import { parseOfx } from '@/lib/import/ofx';
import { isVanguardTransactions } from '@/lib/import/vanguard-transactions';
import { contributedAmount, countedTrades, isContribution, isIncomingRollover, type InvestmentTxn } from '@/lib/investments';
import { vanguardQfx, type QfxAccount } from './vanguard-transactions-qfx';

const DAYS = { start: '2025-05-13', end: '2026-11-12' };

function ok(read: VanguardQfxRead) {
  if (!read.ok) throw new Error(`not read: ${JSON.stringify(read)}`);
  return read;
}
const accountOf = (read: VanguardQfxRead, mask: string) => {
  const found = ok(read).accounts.find((a) => a.mask === mask);
  if (!found) throw new Error(`no account ${mask}`);
  return found;
};
const asTxn = (r: object, i: number): InvestmentTxn => ({ ...(r as InvestmentTxn), investment_transaction_id: `imp:${i}`, account_id: 'acct' });

const ACCOUNTS: QfxAccount[] = [
  {
    number: '11114421',
    txns: [
      { kind: 'bank', posted: '2026-01-05', amount: 2000 },
      { kind: 'buy', trade: '2026-01-06', units: 6.25, price: 320, total: -2000 },
      { kind: 'reinvest', trade: '2026-03-25', units: 0.5, price: 330, total: 165 },
      { kind: 'sell', trade: '2026-04-02', units: -40, price: 1, total: 40 },
      { kind: 'income', trade: '2026-04-30', total: 3.21, income: 'INTEREST', fund: '000000003' },
      { kind: 'bank', posted: '2026-06-01', amount: -500 },
    ],
  },
  { number: '22223307', txns: [{ kind: 'bank', posted: '2026-02-10', amount: 7000 }] },
  { number: '33335519', txns: [] },
];

describe('which files', () => {
  test('Vanguard’s QFX, and its OFX: known by an investment statement at vanguard.com', () => {
    const text = vanguardQfx(ACCOUNTS, DAYS);
    expect(isVanguardQfx(text)).toBe(true);
    expect(isVanguardQfx(text.replaceAll('<BROKERID>vanguard.com', '<BROKERID>fidelity.com'))).toBe(false);
    expect(isVanguardTransactions(text)).toBe(false);
  });

  test('another firm’s investment statement isn’t this download, and the bank path still refuses it', () => {
    const text = vanguardQfx(ACCOUNTS, DAYS).replaceAll('<BROKERID>vanguard.com', '<BROKERID>fidelity.com');
    expect(readVanguardQfx(text)).toEqual({ ok: false, reason: 'not-this-file' });
    expect(parseOfx(vanguardQfx(ACCOUNTS, DAYS)).error).toBe('This is an investment statement, which can’t be imported yet: only bank and credit card statements can.');
  });
});

describe('what each transaction is', () => {
  const read = readVanguardQfx(vanguardQfx(ACCOUNTS, DAYS));

  test('every account by its last four digits, the days every statement states, and the rows', () => {
    const r = ok(read);
    expect(r.stated).toEqual({ from: '2025-05-13', end: '2026-11-12' });
    expect(r.accounts.map((a) => [a.mask, a.lines, a.rows.length, a.unreadable, a.repeated, a.in_holdings])).toEqual([
      ['4421', 7, 7, null, false, true],
      ['3307', 1, 1, null, false, true],
      ['5519', 0, 0, null, false, true],
    ]);
    expect(r.rows).toBe(8);
    expect(JSON.stringify(r)).not.toContain('11114421');
  });

  test('cash in or out with nothing more said: money in or out of the account, never new savings', () => {
    const [money, , , , , , out] = accountOf(read, '4421').rows;
    expect(money).toEqual({ line: 1, kind: 'INVBANKTRAN', date: '2026-01-05', name: 'Money in', type: 'cash', subtype: 'unlabeled', quantity: 0, price: 0, amount: -2000, fees: 0, currency: 'USD', security: null });
    expect(out).toMatchObject({ name: 'Money out', subtype: 'unlabeled', amount: 500 });
    const t = asTxn(money, 0);
    const counted = countedTrades([t]);
    expect(contributedAmount(t, counted)).toBe(2000);
    expect(isContribution(t, counted)).toBe(false);
    expect(isIncomingRollover(t, counted)).toBe(false);
  });

  test('a buy, a sell, a reinvestment as its income and its buy, and interest paid in cash, each named by its fund', () => {
    const [, buy, income, reinvested, sell, interest] = accountOf(read, '4421').rows;
    expect(buy).toMatchObject({ kind: 'BUYMF', date: '2026-01-06', name: 'Buy', type: 'buy', subtype: 'buy', quantity: 6.25, price: 320, amount: 2000, security: 'Total Stock Market Index Fund Admiral' });
    // Vanguard writes the reinvested amount in FEES too: read as that, never a fee.
    expect(income).toMatchObject({ kind: 'REINVEST', name: 'Dividend', type: 'cash', subtype: 'dividend', amount: -165, fees: 0 });
    expect(reinvested).toMatchObject({ kind: 'REINVEST', name: 'Reinvestment', type: 'buy', subtype: 'dividend reinvestment', quantity: 0.5, price: 330, amount: 165, fees: 0 });
    expect(sell).toMatchObject({ kind: 'SELLMF', name: 'Sell', type: 'sell', subtype: 'sell', quantity: -40, amount: -40 });
    expect(interest).toMatchObject({ kind: 'INCOME', name: 'Interest', type: 'cash', subtype: 'interest', amount: -3.21, security: 'Federal Money Market Fund' });
    // Places among the account's transactions, a reinvestment's two rows one place.
    expect(accountOf(read, '4421').rows.map((r) => r.line)).toEqual([1, 2, 3, 3, 4, 5, 6]);
  });
});

describe('failing closed', () => {
  const withTxn = (txn: QfxAccount['txns'][number]) => readVanguardQfx(vanguardQfx([{ number: '11114421', txns: [{ kind: 'bank', posted: '2026-01-05', amount: 10 }, txn] }, ACCOUNTS[1]], DAYS));

  test('a kind it doesn’t know stops that account only, said with its name and place', () => {
    const read = withTxn({ kind: 'raw', text: '<TRANSFER><INVTRAN><FITID>1<DTTRADE>20260110<MEMO>X</INVTRAN><UNITS>3</TRANSFER>' });
    expect(accountOf(read, '4421')).toMatchObject({ rows: [], lines: 2, unreadable: { reason: 'unknown-type', type: 'TRANSFER', line: 2, place: 'transaction' } });
    expect(accountOf(read, '3307').rows).toHaveLength(1);
    const kind = withTxn({ kind: 'income', trade: '2026-01-10', total: 5, income: 'MISC' });
    expect(accountOf(kind, '4421').unreadable).toMatchObject({ reason: 'unknown-type', type: 'MISC' });
    const bank = withTxn({ kind: 'bank', posted: '2026-01-10', amount: 5, trntype: 'CHECK' });
    expect(accountOf(bank, '4421').unreadable).toMatchObject({ reason: 'unknown-type', type: 'CHECK' });
    // Only the cash type Vanguard writes: a dividend paid as cash this way is
    // one no file Nya was checked on had.
    const div = withTxn({ kind: 'bank', posted: '2026-01-10', amount: -50, trntype: 'DIV' });
    expect(accountOf(div, '4421').unreadable).toMatchObject({ reason: 'unknown-type', type: 'DIV' });
  });

  test('a fee, tax withheld, or a reinvestment’s fees unlike its total: not read yet', () => {
    expect(accountOf(withTxn({ kind: 'raw', text: '<BUYMF><INVBUY><INVTRAN><FITID>1<DTTRADE>20260110<MEMO>X</INVTRAN><UNITS>1<UNITPRICE>10<COMMISSION>1.00<TOTAL>-11</INVBUY><BUYTYPE>BUY</BUYMF>' }), '4421').unreadable).toMatchObject({ reason: 'not-yet-read', field: 'fees' });
    expect(accountOf(withTxn({ kind: 'sell', trade: '2026-01-10', units: -1, price: 10, total: 10, withholding: 1 }), '4421').unreadable).toMatchObject({ reason: 'not-yet-read', field: 'withholding' });
    expect(accountOf(withTxn({ kind: 'reinvest', trade: '2026-01-10', units: 1, price: 10, total: 10, fees: 2 }), '4421').unreadable).toMatchObject({ reason: 'not-yet-read', field: 'fees' });
  });

  test('a date or an amount it can’t read, or a buy that brings cash in', () => {
    expect(accountOf(withTxn({ kind: 'raw', text: '<INCOME><INVTRAN><FITID>1<DTTRADE>soon<MEMO>X</INVTRAN><INCOMETYPE>DIV<TOTAL>5</INCOME>' }), '4421').unreadable).toMatchObject({ reason: 'bad-row', field: 'date' });
    expect(accountOf(withTxn({ kind: 'buy', trade: '2026-01-10', units: 1, price: 10, total: 10 }), '4421').unreadable).toMatchObject({ reason: 'bad-row', field: 'amount' });
    // A sell that adds shares, and income that takes cash out: corrections, not read on a guess.
    expect(accountOf(withTxn({ kind: 'sell', trade: '2026-01-10', units: 1, price: 10, total: 10 }), '4421').unreadable).toMatchObject({ reason: 'bad-row', field: 'amount' });
    expect(accountOf(withTxn({ kind: 'income', trade: '2026-01-10', total: -5 }), '4421').unreadable).toMatchObject({ reason: 'bad-row', field: 'amount' });
  });

  test('statements that state other days, another currency, a bank statement beside them, a transaction outside the days: the whole file refused', () => {
    expect(readVanguardQfx(vanguardQfx([ACCOUNTS[0], { ...ACCOUNTS[1], start: '2025-06-01' }], DAYS))).toMatchObject({ ok: false, reason: 'unknown-layout', detail: { problem: 'days' } });
    expect(readVanguardQfx(vanguardQfx([ACCOUNTS[0], { ...ACCOUNTS[1], currency: 'CAD' }], DAYS))).toMatchObject({ ok: false, reason: 'unknown-layout', detail: { problem: 'currency' } });
    const bank = '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><ACCTID>1234</BANKACCTFROM></STMTRS></STMTTRNRS></BANKMSGSRSV1>';
    expect(readVanguardQfx(vanguardQfx(ACCOUNTS, { ...DAYS, after: bank }))).toEqual({ ok: false, reason: 'unknown-layout', detail: { problem: 'mixed' } });
    expect(readVanguardQfx(vanguardQfx([{ number: '11114421', txns: [{ kind: 'bank', posted: '2024-01-05', amount: 10 }] }], DAYS))).toMatchObject({ ok: false, reason: 'unknown-layout', detail: { problem: 'row' } });
    // Days that start after they end.
    expect(readVanguardQfx(vanguardQfx([{ number: '11114421', txns: [] }], { start: '2026-11-12', end: '2026-11-01' }))).toMatchObject({ ok: false, reason: 'unknown-layout', detail: { problem: 'days' } });
  });

  test('a transaction in its own currency, a field written twice or a structure that had to be repaired: the whole file refused', () => {
    const cad = '<BUYMF><INVBUY><INVTRAN><FITID>1<DTTRADE>20260110<MEMO>X</INVTRAN><UNITS>1<UNITPRICE>10<TOTAL>-10<CURRENCY><CURRATE>1.0<CURSYM>CAD</CURRENCY></INVBUY><BUYTYPE>BUY</BUYMF>';
    expect(readVanguardQfx(vanguardQfx([{ number: '11114421', txns: [{ kind: 'raw', text: cad }] }], DAYS))).toMatchObject({ ok: false, reason: 'unknown-layout', detail: { problem: 'currency' } });
    const usd = cad.replace('CAD', 'USD');
    expect(ok(readVanguardQfx(vanguardQfx([{ number: '11114421', txns: [{ kind: 'raw', text: usd }] }], DAYS))).rows).toBe(1);
    const twice = '<INCOME><INVTRAN><FITID>1<DTTRADE>20260110<MEMO>X</INVTRAN><INCOMETYPE>DIV<TOTAL>5<TOTAL>6</INCOME>';
    expect(readVanguardQfx(vanguardQfx([{ number: '11114421', txns: [{ kind: 'raw', text: twice }] }], DAYS))).toMatchObject({ ok: false, reason: 'unknown-layout', detail: { problem: 'row' } });
    const stray = '</SELLMF><INCOME><INVTRAN><FITID>1<DTTRADE>20260110<MEMO>X</INVTRAN><INCOMETYPE>DIV<TOTAL>5</INCOME>';
    expect(readVanguardQfx(vanguardQfx([{ number: '11114421', txns: [{ kind: 'raw', text: stray }] }], DAYS))).toEqual({ ok: false, reason: 'unknown-layout', detail: { problem: 'repaired' } });
    const unended = '<INVBANKTRAN><STMTTRN><TRNTYPE>OTHER<DTPOSTED>20260105<TRNAMT>5<FITID>9</STMTTRN><SUBACCTFUND>OTHER';
    expect(readVanguardQfx(vanguardQfx([{ number: '11114421', txns: [{ kind: 'raw', text: unended }] }], DAYS))).toEqual({ ok: false, reason: 'unknown-layout', detail: { problem: 'repaired' } });
  });

  test('two accounts that end alike: both said, so neither is taken', () => {
    const read = readVanguardQfx(vanguardQfx([ACCOUNTS[0], { number: '99994421', txns: [] }], DAYS));
    expect(ok(read).accounts.map((a) => a.repeated)).toEqual([true, true]);
  });
});
