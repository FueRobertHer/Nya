// The reader of Vanguard's transactions download (lib/import/vanguard-transactions.ts),
// on synthetic files in its layout (test/vanguard-transactions-csv.ts), and
// what lib/investments.ts makes of the rows it reads.

import { describe, expect, test } from 'bun:test';
import {
  isVanguardTransactions,
  KINDS,
  readVanguardTransactions,
  TRANSACTIONS_HEADER,
  type VanguardAccount,
  type VanguardTransactionsRead,
  type VanguardTxn,
} from '@/lib/import/vanguard-transactions';
import { MAX_IMPORT_ROWS } from '@/lib/import/record';
import { countedTrades, dailyFlows, externalFlow, isContribution, isIncomingRollover, isRollover, valueDelta, type InvestmentTxn } from '@/lib/investments';
import { ACCOUNTS, SAMPLE_HOLDINGS, SAMPLE_TXNS, sampleCsv, vanguardCsv, type Txn } from './vanguard-transactions-csv';

function ok(read: VanguardTransactionsRead) {
  if (!read.ok) throw new Error(`not read: ${JSON.stringify(read)}`);
  return read;
}

function account(read: VanguardTransactionsRead, mask: string): VanguardAccount {
  const found = ok(read).accounts.find((a) => a.mask === mask);
  if (!found) throw new Error(`no account ${mask}`);
  return found;
}

/** A row as the store would keep it: ids from the import and the account. */
function stored(rows: VanguardTxn[], account_id: string): InvestmentTxn[] {
  return rows.map(({ line, kind, ...t }, i) => ({ ...t, investment_transaction_id: `imp:${i}`, account_id }));
}

const one = (t: Partial<Txn> & Pick<Txn, 'type' | 'net'>): Txn => ({ account: ACCOUNTS.individual, trade: '2026-05-01', ...t });

describe('reading the download', () => {
  test('every account, by its last four digits, with its rows and the days the file covers', () => {
    const read = ok(readVanguardTransactions(sampleCsv()));
    expect(read.accounts.map((a) => [a.mask, a.lines, a.rows.length, a.in_holdings, a.repeated, a.unreadable])).toEqual([
      ['4421', 7, 7, true, false, null],
      ['3307', 4, 4, true, false, null],
      ['5519', 3, 3, true, false, null],
      ['8802', 1, 1, true, false, null],
      // Listed in the holdings, with no transactions.
      ['6610', 0, 0, true, false, null],
    ]);
    expect(read.span).toEqual({ from: '2025-05-14', to: '2026-11-02' });
    expect(read.rows).toBe(SAMPLE_TXNS.length);
  });

  test('no full account number and no holding comes out of it', () => {
    const text = JSON.stringify(readVanguardTransactions(sampleCsv()));
    for (const number of Object.values(ACCOUNTS)) expect(text).not.toContain(number);
    for (const h of SAMPLE_HOLDINGS) {
      expect(text).not.toContain(h.shares.toFixed(4));
      expect(text).not.toContain((h.shares * h.price).toFixed(2));
    }
  });

  test('a run of five or more digits in a description keeps only its last four', () => {
    const read = readVanguardTransactions(vanguardCsv([], [one({ type: 'Conversion (incoming)', description: 'Conversion from 33335519', net: 600 })]));
    expect(account(read, '4421').rows[0].name).toBe('Conversion (incoming): Conversion from ••5519');
  });

  test('each type as Plaid would type it, with Plaid’s sign: positive when cash leaves', () => {
    const rows = account(readVanguardTransactions(sampleCsv()), '4421').rows;
    expect(rows.map((r) => [r.kind, r.type, r.subtype, r.amount, r.date])).toEqual([
      ['Funds Received', 'cash', 'deposit', -2000, '2026-11-02'],
      ['Sweep in', 'buy', 'buy', 2000, '2026-11-02'],
      // A buy's day is its trade date, not its settlement date.
      ['Buy', 'buy', 'buy', 2000, '2026-10-30'],
      ['Sweep out', 'sell', 'sell', -2000, '2026-10-30'],
      ['Dividend', 'cash', 'dividend', -212.4, '2026-09-28'],
      ['Reinvestment', 'buy', 'dividend reinvestment', 212.4, '2026-09-28'],
      ['Interest', 'cash', 'interest', -3.12, '2026-06-30'],
    ]);
    const buy = rows[2];
    expect([buy.quantity, buy.price, buy.fees, buy.currency, buy.security, buy.line]).toEqual([14.2349, 140.5, 0, 'USD', 'Total Stock Market Index Fund', 16]);
    // A cash row's Investment Name is the account's cash: no security.
    expect(rows[0].security).toBeNull();
  });

  test('a row’s name is its description, with its type in front when the description doesn’t say it', () => {
    const read = readVanguardTransactions(sampleCsv());
    expect(account(read, '4421').rows[0].name).toBe('Funds Received via electronic transfer');
    expect(account(read, '3307').rows.map((r) => r.name)).toEqual([
      'Conversion (incoming): Roth conversion',
      'Conversion (incoming): Roth conversion',
      'Contribution for 2026',
      'Rollover (incoming): Direct rollover from employer plan',
    ]);
    const bare = readVanguardTransactions(vanguardCsv([], [one({ type: 'Interest', description: '', net: 1 })]));
    expect(account(bare, '4421').rows[0].name).toBe('Interest');
  });

  test('every type Nya knows maps to a type and subtype, the in-kind ones by their shares', () => {
    for (const [kind, rule] of Object.entries(KINDS)) {
      const cash = typeof rule === 'function' ? rule({ shares: 0 }) : rule;
      const shares = typeof rule === 'function' ? rule({ shares: 5 }) : rule;
      expect([kind, cash.type.length > 0, cash.subtype.length > 0]).toEqual([kind, true, true]);
      if (typeof rule === 'function') expect([kind, cash.type, shares.type]).toEqual([kind, 'cash', 'transfer']);
    }
  });

  test('two rows alike in every way are both kept', () => {
    const t = one({ type: 'Funds Received', net: 100 });
    expect(account(readVanguardTransactions(vanguardCsv([], [t, t])), '4421').rows).toHaveLength(2);
  });

  test('a byte order mark, Windows line ends and quoted fields read the same', () => {
    const plain = ok(readVanguardTransactions(sampleCsv()));
    const other = ok(readVanguardTransactions(sampleCsv({ eol: '\r\n', bom: true })));
    expect(other.accounts).toEqual(plain.accounts);
    const quoted = readVanguardTransactions(vanguardCsv([], [one({ type: 'Funds Received', description: 'Funds Received, "early"', net: 10 })]));
    expect(account(quoted, '4421').rows[0].name).toBe('Funds Received, "early"');
  });

  test('with no holdings table, the transactions are still read', () => {
    const read = ok(readVanguardTransactions(sampleCsv({ noHoldings: true })));
    expect(read.accounts.map((a) => [a.mask, a.in_holdings])).toEqual([
      ['4421', false],
      ['3307', false],
      ['5519', false],
      ['8802', false],
    ]);
  });

  test('two accounts ending in the same four digits are both said to', () => {
    const read = ok(readVanguardTransactions(vanguardCsv([], [one({ type: 'Funds Received', net: 1 }), one({ account: '99994421', type: 'Funds Received', net: 2 })])));
    expect(read.accounts.map((a) => [a.mask, a.repeated, a.rows[0].amount])).toEqual([
      ['4421', true, -1],
      ['4421', true, -2],
    ]);
  });

  test('an empty transactions table reads as no rows and no days', () => {
    const read = ok(readVanguardTransactions(vanguardCsv(SAMPLE_HOLDINGS, [])));
    expect(read.span).toBeNull();
    expect(read.accounts.every((a) => a.rows.length === 0 && a.in_holdings)).toBe(true);
  });
});

describe('a row that can’t be read stops its account only', () => {
  test('a type Nya doesn’t know, said by name, with its line', () => {
    const txns = [...SAMPLE_TXNS];
    txns.splice(9, 0, { account: ACCOUNTS.roth, trade: '2026-02-01', type: 'Exchange', net: 0 });
    const read = readVanguardTransactions(vanguardCsv(SAMPLE_HOLDINGS, txns));
    const roth = account(read, '3307');
    expect(roth.unreadable).toEqual({ reason: 'unknown-type', type: 'Exchange', line: 23 });
    expect([roth.rows, roth.lines]).toEqual([[], 5]);
    expect(account(read, '4421').rows).toHaveLength(7);
    // Its days still count toward the file's.
    expect(ok(read).span).toEqual({ from: '2025-05-14', to: '2026-11-02' });
  });

  test('a date or an amount that isn’t one', () => {
    const bad = (t: Partial<Txn>) => account(readVanguardTransactions(vanguardCsv([], [one({ type: 'Buy', net: -5, ...t })])), '4421').unreadable;
    expect(bad({ trade: '2026-02-30' })).toEqual({ reason: 'bad-row', field: 'date', line: 3 });
    expect(bad({ trade: '02/03/2026' })).toEqual({ reason: 'bad-row', field: 'date', line: 3 });
    const words = vanguardCsv([], [one({ type: 'Buy', net: -5 })]).replace(/-5\.00/g, 'n/a');
    expect(account(readVanguardTransactions(words), '4421').unreadable).toEqual({ reason: 'bad-row', field: 'amount', line: 3 });
  });

  test('shares moved in kind with no value in the file are never valued from elsewhere', () => {
    for (const type of ['Transfer (incoming)', 'Conversion (outgoing)', 'Rollover (incoming)', 'Contribution']) {
      const read = readVanguardTransactions(vanguardCsv([], [one({ type, symbol: 'TSMF', shares: 10, price: 0, net: 0 })]));
      expect(account(read, '4421').unreadable).toEqual({ reason: 'no-value', type, line: 3 });
    }
    // A reinvestment's shares are bought with its cash.
    const reinvested = readVanguardTransactions(vanguardCsv([], [one({ type: 'Reinvestment', symbol: 'TSMF', shares: 1.5, price: 0, net: 0 })]));
    expect(account(reinvested, '4421').unreadable).toBeNull();
  });

  test('a type named like an object’s own method is a type Nya doesn’t know', () => {
    for (const type of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const read = readVanguardTransactions(vanguardCsv([], [one({ type, net: 5 })]));
      expect(account(read, '4421').unreadable).toEqual({ reason: 'unknown-type', type, line: 3 });
    }
  });

  test('a fee, accrued interest, or a principal unlike the net amount: not read on a guess', () => {
    const unread = (t: Partial<Txn>) =>
      account(readVanguardTransactions(vanguardCsv([], [one({ type: 'Buy', symbol: 'TSMF', shares: 2, price: 50, net: -100, ...t })])), '4421').unreadable;
    expect(unread({ fees: 1 })).toEqual({ reason: 'not-yet-read', field: 'fees', line: 3 });
    expect(unread({ accrued: 0.5 })).toEqual({ reason: 'not-yet-read', field: 'accrued-interest', line: 3 });
    expect(unread({ principal: -99 })).toEqual({ reason: 'not-yet-read', field: 'principal', line: 3 });
    expect(unread({})).toBeNull();
  });
});

describe('a file that isn’t laid out as Nya knows is refused whole', () => {
  const refused = (text: string) => readVanguardTransactions(text);

  test('another CSV is not this file', () => {
    expect(refused('Date,Description,Amount\n2026-01-02,Coffee,-4.50\n')).toEqual({ ok: false, reason: 'not-this-file' });
    expect(refused('')).toEqual({ ok: false, reason: 'not-this-file' });
    expect(isVanguardTransactions('Date,Description,Amount\n')).toBe(false);
    expect(isVanguardTransactions(sampleCsv())).toBe(true);
    expect(isVanguardTransactions(sampleCsv({ bom: true, eol: '\r\n' }))).toBe(true);
  });

  test('a column renamed, added or moved', () => {
    const renamed = [...TRANSACTIONS_HEADER].map((h) => (h === 'Net Amount' ? 'Net amount' : h));
    expect(refused(sampleCsv({ header: renamed }))).toEqual({ ok: false, reason: 'unknown-layout', detail: { problem: 'columns', line: 13 } });
    expect(refused(sampleCsv({ header: [...TRANSACTIONS_HEADER, 'Exchange Rate'] }))).toMatchObject({ reason: 'unknown-layout', detail: { problem: 'columns' } });
    const moved = [...TRANSACTIONS_HEADER];
    [moved[10], moved[11]] = [moved[11], moved[10]];
    expect(refused(sampleCsv({ header: moved }))).toMatchObject({ reason: 'unknown-layout', detail: { problem: 'columns' } });
  });

  test('a line that is neither a holding nor a transaction', () => {
    const above = 'Report for all accounts,\n' + sampleCsv({ noHoldings: true });
    expect(refused(above)).toEqual({ ok: false, reason: 'unknown-layout', detail: { problem: 'line', line: 1 } });
    const below = sampleCsv() + 'Past performance is no guarantee of future results.,\n';
    expect(refused(below)).toMatchObject({ reason: 'unknown-layout', detail: { problem: 'row' } });
    const wide = sampleCsv().replace('Interest received,CASH,,0.0000,0.00,3.12,0.00,3.12,0.00,CASH,', 'Interest received,CASH,,0.0000,0.00,3.12,0.00,3.12,0.00,CASH,extra,');
    expect(wide).not.toBe(sampleCsv());
    expect(refused(wide)).toMatchObject({ reason: 'unknown-layout', detail: { problem: 'row' } });
  });

  test('a holdings table with no transactions table after it', () => {
    const text = sampleCsv().split('\nAccount Number,Trade Date')[0] + '\n';
    expect(refused(text)).toEqual({ ok: false, reason: 'unknown-layout', detail: { problem: 'no-transactions' } });
    // Still this file, so it is refused in this reader's words.
    expect(isVanguardTransactions(text)).toBe(true);
    // A quote never closed in the holdings stops the read before the table.
    const quoted = sampleCsv().replace('Total Bond Market Index Fund', '"Total Bond Market Index Fund');
    expect(refused(quoted)).toEqual({ ok: false, reason: 'unknown-layout', detail: { problem: 'split', line: 7 } });
  });

  test('a line narrower than the heading has lost a field, and is refused', () => {
    const text = sampleCsv().replace('Interest received,CASH,,0.0000,0.00,3.12,0.00,3.12,0.00,CASH,', 'Interest received,CASH,,0.0000,0.00,0.00,3.12,0.00,CASH,');
    expect(text).not.toBe(sampleCsv());
    expect(refused(text)).toEqual({ ok: false, reason: 'unknown-layout', detail: { problem: 'row', line: 20 } });
    // So is one that drops the last comma alone: the heading has it.
    const dropped = sampleCsv().replace('3.12,0.00,3.12,0.00,CASH,', '3.12,0.00,3.12,0.00,CASH');
    expect(refused(dropped)).toEqual({ ok: false, reason: 'unknown-layout', detail: { problem: 'row', line: 20 } });
    // A file with no last commas at all, the heading's included, reads the same.
    const bare = sampleCsv().replace(/,\n/g, '\n');
    expect(ok(refused(bare)).accounts).toEqual(ok(refused(sampleCsv())).accounts);
  });

  test('a quote never closed', () => {
    const text = vanguardCsv([], [one({ type: 'Interest', net: 1 })]).replace('Interest,CASH', '"Interest,CASH');
    expect(refused(text)).toMatchObject({ reason: 'unknown-layout', detail: { problem: 'split' } });
  });

  test('more rows than any import takes', () => {
    const t = one({ type: 'Interest', net: 1 });
    const read = refused(vanguardCsv([], Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => t)));
    expect(read).toEqual({ ok: false, reason: 'too-many-rows', rows: MAX_IMPORT_ROWS + 1 });
  });
});

describe('what the rules make of the rows', () => {
  const read = readVanguardTransactions(sampleCsv());
  const roth = stored(account(read, '3307').rows, 'roth');
  const traditional = stored(account(read, '5519').rows, 'trad');
  const individual = stored(account(read, '4421').rows, 'ind');

  test('a conversion is money moving in and out, its shares at their value, in both accounts', () => {
    const [inKind, cash] = roth;
    expect([inKind.type, inKind.subtype, inKind.amount, inKind.quantity]).toEqual(['transfer', 'conversion', -15400, 98.1203]);
    expect([externalFlow(inKind), externalFlow(cash)]).toEqual([15400, 600]);
    expect([valueDelta(traditional[0]), externalFlow(traditional[0]), externalFlow(traditional[1])]).toEqual([-15400, -15400, -600]);
  });

  test('a conversion is never a contribution, nor a rollover; the contribution is', () => {
    const counted = countedTrades(roth);
    expect(roth.map((t) => [t.subtype, isContribution(t, counted), isRollover(t)])).toEqual([
      ['conversion', false, false],
      ['conversion', false, false],
      ['contribution', true, false],
      ['rollover', false, true],
    ]);
    expect(isIncomingRollover(roth[3], counted)).toBe(true);
    expect(isContribution(individual[0])).toBe(true);
    // A conversion out of an account named Rollover IRA is still a conversion.
    const named = stored(
      account(readVanguardTransactions(vanguardCsv([], [one({ type: 'Conversion (outgoing)', description: 'Conversion from Rollover IRA', net: -600 })])), '4421').rows,
      'r'
    );
    expect([isRollover(named[0]), isIncomingRollover(named[0]), externalFlow(named[0])]).toEqual([false, false, -600]);
  });

  test('deposits and withdrawals by day: the deposit, the conversion and the rollover; sweeps, buys and dividends are not money in or out', () => {
    // Signed as the account's value changes: positive is money in.
    expect(dailyFlows(individual)).toEqual([{ date: '2026-11-02', amount: 2000 }]);
    expect(dailyFlows(roth)).toEqual([
      { date: '2025-07-15', amount: 25000 },
      { date: '2026-01-05', amount: 7000 },
      { date: '2026-03-04', amount: 16000 },
    ]);
    expect(dailyFlows(traditional)).toEqual([{ date: '2026-03-04', amount: -16000 }]);
  });

  test('the dividend is growth, and so is the interest: their value comes in as cash', () => {
    expect(individual.filter((t) => t.subtype === 'dividend' || t.subtype === 'interest').map(valueDelta)).toEqual([212.4, 3.12]);
    // Buys, sweeps and reinvestments only move cash into shares.
    expect(individual.filter((t) => t.type === 'buy' || t.type === 'sell').map(valueDelta)).toEqual([0, 0, 0, 0]);
  });
});
