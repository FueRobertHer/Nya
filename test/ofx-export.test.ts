import { describe, expect, test } from 'bun:test';
import { ofxDocument, statementsOf, ofxAmount, ofxAccountId, ofxDate, to1252, encode1252, NAME_MAX, MEMO_MAX, type OfxAccount, type OfxRow } from '@/lib/ofx-export';
import { decodeFile } from '@/lib/import/text';
import { parseOfx, ofxRecords } from '@/lib/import/ofx';
import { readImport } from '@/lib/import/read';
import { normalizeRecords } from '@/lib/import/normalize';
import { planImport } from '@/lib/import/commit';
import { ofxFilename, ofxKindOf, ofxRefusal } from '@/lib/download-options';
import type { ManualTxn } from '@/lib/manual-txns';

// One account's statement as OFX (lib/ofx-export.ts): its shape and escaping,
// the sign of each kind of account, several currencies, an empty account,
// and the round trip through Nya's own OFX import (lib/import/), where every
// row comes back with its date, amount, sign and id, and a second import of
// the same file adds nothing. The download that serves it is
// test/my-data-ownership.test.ts.

const NOW = new Date('2026-10-10T14:32:05.123Z');

const row = (over: Partial<OfxRow>): OfxRow => ({
  id: 'txn_1',
  date: '2026-09-01',
  user_date: null,
  amount: 4.5,
  currency: 'USD',
  name: 'Blue Bottle',
  description: null,
  note: null,
  check_number: null,
  transaction_code: null,
  excluded: false,
  ...over,
});

const checking = (rows: OfxRow[], over: Partial<OfxAccount> = {}): OfxAccount => ({
  account_id: 'acc_chk',
  kind: 'bank',
  subtype: 'checking',
  mask: '1111',
  currency: 'USD',
  balance: { amount: 1550.25, as_of: '2026-10-09', currency: 'USD' },
  rows,
  ...over,
});

/** The file as bytes, as the download sends it. */
const bytesOf = (account: OfxAccount) => {
  const doc = ofxDocument(account, NOW);
  const parts = doc.pieces.map(encode1252);
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return { bytes: all, notes: doc.notes };
};
const textOf = (account: OfxAccount) => ofxDocument(account, NOW).pieces.join('');

/** The file read back by Nya's own import: each statement's records. */
function readBack(bytes: Uint8Array) {
  const decoded = decodeFile(bytes);
  const file = parseOfx(decoded.text);
  expect(file.error).toBeNull();
  expect(file.repairs).toEqual([]);
  return { encoding: decoded.encoding, statements: file.statements.map((s) => ({ s, ...ofxRecords(s) })) };
}

describe('the file', () => {
  test('OFX 1.0.2 in SGML: the headers banks write, one tag a line, CRLF, a bank statement for a bank account', () => {
    const text = textOf(checking([row({})]));
    expect(text).toStartWith(
      'OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nSECURITY:NONE\r\nENCODING:USASCII\r\nCHARSET:1252\r\nCOMPRESSION:NONE\r\nOLDFILEUID:NONE\r\nNEWFILEUID:NONE\r\n\r\n<OFX>\r\n'
    );
    expect(text).toContain('<SONRS>\r\n<STATUS>\r\n<CODE>0\r\n<SEVERITY>INFO\r\n</STATUS>\r\n<DTSERVER>20261010143205.123[0:GMT]\r\n<LANGUAGE>ENG\r\n</SONRS>');
    expect(text).toContain(
      `<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<TRNUID>1\r\n<STATUS>\r\n<CODE>0\r\n<SEVERITY>INFO\r\n</STATUS>\r\n<STMTRS>\r\n<CURDEF>USD\r\n<BANKACCTFROM>\r\n<ACCTID>${ofxAccountId('acc_chk', '1111')}\r\n<ACCTTYPE>CHECKING\r\n</BANKACCTFROM>\r\n`
    );
    expect(text).toContain(
      '<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20260901120000\r\n<TRNAMT>-4.50\r\n<FITID>txn_1\r\n<NAME>Blue Bottle\r\n</STMTTRN>\r\n'
    );
    expect(text).toContain('<LEDGERBAL>\r\n<BALAMT>1550.25\r\n<DTASOF>20261009120000\r\n</LEDGERBAL>\r\n</STMTRS>\r\n</STMTTRNRS>\r\n</BANKMSGSRSV1>\r\n</OFX>\r\n');
    expect(text).toEndWith('</OFX>\r\n');
    // Every line ends CRLF; no routing number is invented.
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(text).not.toContain('BANKID');
    // Aggregates are closed, leaf elements are not.
    for (const tag of ['OFX', 'SIGNONMSGSRSV1', 'SONRS', 'STATUS', 'BANKMSGSRSV1', 'STMTTRNRS', 'STMTRS', 'BANKACCTFROM', 'BANKTRANLIST', 'STMTTRN', 'LEDGERBAL']) {
      expect([tag, text.split(`<${tag}>`).length]).toEqual([tag, text.split(`</${tag}>`).length]);
    }
    expect(text).not.toContain('</TRNAMT>');
  });

  test('a card is a card statement, with no account type', () => {
    const text = textOf(checking([row({ amount: 30 })], { kind: 'creditcard', subtype: 'credit card', mask: '2222', balance: { amount: 500, as_of: '2026-10-09', currency: 'USD' } }));
    expect(text).toContain('<CREDITCARDMSGSRSV1>\r\n<CCSTMTTRNRS>\r\n<TRNUID>1\r\n');
    expect(text).toContain(`<CCSTMTRS>\r\n<CURDEF>USD\r\n<CCACCTFROM>\r\n<ACCTID>${ofxAccountId('acc_chk', '2222')}\r\n</CCACCTFROM>\r\n`);
    expect(text).not.toContain('BANKMSGSRSV1');
    expect(text).not.toContain('ACCTTYPE');
    expect(text).toEndWith('</CCSTMTRS>\r\n</CCSTMTTRNRS>\r\n</CREDITCARDMSGSRSV1>\r\n</OFX>\r\n');
  });

  test('the account’s id: stable, short enough for OFX, ending in its last digits, never more of its number', () => {
    const id = ofxAccountId('acc_chk', '1111');
    expect(id).toMatch(/^NYA-[0-9A-F]{12}-1111$/);
    expect(id.length).toBeLessThanOrEqual(22);
    expect(ofxAccountId('acc_chk', '1111')).toBe(id);
    expect(ofxAccountId('acc_sav', '1111')).not.toBe(id);
    expect(ofxAccountId('manual_x', null)).toMatch(/^NYA-[0-9A-F]{12}$/);
    expect(ofxAccountId('acc', '12-34 56')).toEndWith('-3456');
  });

  test('a savings or money market account says so; every other bank account is a checking account', () => {
    expect(textOf(checking([], { subtype: 'savings' }))).toContain('<ACCTTYPE>SAVINGS');
    expect(textOf(checking([], { subtype: 'money market' }))).toContain('<ACCTTYPE>MONEYMRKT');
    for (const subtype of ['checking', 'cd', 'cash management', null]) expect(textOf(checking([], { subtype }))).toContain('<ACCTTYPE>CHECKING');
  });

  test('dates are the bank’s days at noon, DTUSER only where it differs, and the list spans the rows', () => {
    const text = textOf(checking([row({ id: 'b', date: '2026-09-05', user_date: '2026-09-03' }), row({ id: 'a', date: '2026-08-31', user_date: '2026-08-31' })]));
    expect(text).toContain('<BANKTRANLIST>\r\n<DTSTART>20260831120000\r\n<DTEND>20260905120000\r\n');
    expect(text).toContain('<DTPOSTED>20260905120000\r\n<DTUSER>20260903120000\r\n');
    expect(text.indexOf('<FITID>a')).toBeLessThan(text.indexOf('<FITID>b'));
    expect(text.match(/<DTUSER>/g)).toHaveLength(1);
    expect(ofxDate('2026-01-02')).toBe('20260102120000');
  });

  test('the bank’s own transaction codes, a check number, and otherwise the sign', () => {
    const types = (rows: Partial<OfxRow>[]) => [...textOf(checking(rows.map((r, i) => row({ id: `t${i}`, ...r })))).matchAll(/<TRNTYPE>(\w+)/g)].map((m) => m[1]);
    expect(
      types([
        { amount: 60, transaction_code: 'atm' },
        { amount: 2, transaction_code: 'bank charge' },
        { amount: -1, transaction_code: 'interest' },
        { amount: 100, transaction_code: 'transfer' },
        { amount: 20, transaction_code: 'direct debit' },
        { amount: 20, transaction_code: 'standing order' },
        { amount: 20, transaction_code: 'purchase' },
        { amount: -20, transaction_code: null },
        { amount: 0 },
      ])
    ).toEqual(['ATM', 'FEE', 'INT', 'XFER', 'DIRECTDEBIT', 'REPEATPMT', 'DEBIT', 'CREDIT', 'OTHER']);
    const text = textOf(checking([row({ amount: 125, check_number: '1042' })]));
    expect(text).toContain('<TRNTYPE>CHECK\r\n');
    expect(text).toContain('<FITID>txn_1\r\n<CHECKNUM>1042\r\n<NAME>');
  });
});

describe('amounts and signs', () => {
  test('OFX’s sign is the holder’s: money in is positive, on a bank account and on a card', () => {
    const bank = textOf(checking([row({ id: 'out', amount: 4.5 }), row({ id: 'in', amount: -1200 })]));
    expect(bank).toContain('<TRNTYPE>DEBIT\r\n<DTPOSTED>20260901120000\r\n<TRNAMT>-4.50\r\n<FITID>out');
    expect(bank).toContain('<TRNTYPE>CREDIT\r\n<DTPOSTED>20260901120000\r\n<TRNAMT>1200.00\r\n<FITID>in');
    const card = textOf(checking([row({ id: 'buy', amount: 30 }), row({ id: 'pay', amount: -500 })], { kind: 'creditcard' }));
    expect(card).toContain('<TRNAMT>-30.00\r\n<FITID>buy');
    expect(card).toContain('<TRNAMT>500.00\r\n<FITID>pay');
  });

  test('the ledger balance: as kept on a bank account, negative while a card is owed, overdrawn stays negative', () => {
    expect(textOf(checking([], { balance: { amount: 1550.25, as_of: '2026-10-09', currency: 'USD' } }))).toContain('<BALAMT>1550.25\r\n');
    expect(textOf(checking([], { balance: { amount: -42, as_of: '2026-10-09', currency: 'USD' } }))).toContain('<BALAMT>-42.00\r\n');
    expect(textOf(checking([], { kind: 'creditcard', balance: { amount: 500, as_of: '2026-10-09', currency: 'USD' } }))).toContain('<BALAMT>-500.00\r\n');
    expect(textOf(checking([], { kind: 'creditcard', balance: { amount: -25, as_of: '2026-10-09', currency: 'USD' } }))).toContain('<BALAMT>25.00\r\n');
  });

  test('written with the currency’s decimals, or more where the amount has them: never rounded, never an exponent', () => {
    expect(ofxAmount(-4.5, 'USD')).toBe('-4.50');
    expect(ofxAmount(1200, 'USD')).toBe('1200.00');
    expect(ofxAmount(-1200, 'JPY')).toBe('-1200');
    expect(ofxAmount(1.25, 'KWD')).toBe('1.250');
    expect(ofxAmount(-12.345, 'USD')).toBe('-12.345');
    expect(ofxAmount(1e-7, 'USD')).toBe('0.0000001');
    expect(ofxAmount(123456789012.5, 'USD')).toBe('123456789012.50');
    expect(ofxAmount(0, 'USD')).toBe('0.00');
    expect(ofxAmount(-0, 'USD')).toBe('0.00');
  });
});

describe('text', () => {
  test('&, < and > are escaped; control characters are spaces', () => {
    const text = textOf(checking([row({ name: 'AT&T <Wireless>', description: 'AT&T\tWIRELESS\u0000BILL' })]));
    expect(text).toContain('<NAME>AT&amp;T &lt;Wireless&gt;\r\n<MEMO>AT&amp;T WIRELESS BILL\r\n');
  });

  test('Windows-1252, as the header says: accents as one byte each, the euro sign and curly quotes too', () => {
    const { bytes } = bytesOf(checking([row({ name: 'Café Größe €5 ‘x’' })]));
    const name = Buffer.from(bytes).toString('latin1').match(/<NAME>([^\r]*)/)![1];
    expect([...Buffer.from(name, 'latin1')]).toEqual([...Buffer.from('Caf', 'latin1'), 0xe9, 0x20, 0x47, 0x72, 0xf6, 0xdf, 0x65, 0x20, 0x80, 0x35, 0x20, 0x91, 0x78, 0x92]);
  });

  test('a character Windows-1252 lacks: its plain letter where it has one, else ?, and a note counts them', () => {
    expect(to1252('Łódź')).toEqual({ text: 'Lódz', lossy: false });
    expect(to1252('ﬁne')).toEqual({ text: 'fine', lossy: false });
    expect(to1252('東京 Ramen')).toEqual({ text: '?? Ramen', lossy: true });
    const { notes } = bytesOf(checking([row({ id: 'a', name: '東京 Ramen' }), row({ id: 'b', name: 'Plain', note: 'Москва' }), row({ id: 'c', name: 'Café' })]));
    expect(notes).toContain(
      '2 transactions have characters OFX’s character set (Windows-1252) doesn’t have, such as letters of non-Latin scripts, written as ?. The JSON and CSV downloads have them as they are.'
    );
  });

  test(`a name over ${NAME_MAX} characters is cut there, and given whole at the start of its memo, before the bank’s words and the note`, () => {
    const long = 'Grocery Outlet of Springfield Main Street';
    const text = textOf(checking([row({ name: long, description: 'GROCERY OUTLET #12 SPRINGFIELD', note: 'for the party', excluded: true })]));
    expect(text).toContain(`<NAME>${long.slice(0, NAME_MAX).trimEnd()}\r\n`);
    expect(text).toContain(`<MEMO>Excluded from budgets and reports in Nya; ${long}; GROCERY OUTLET #12 SPRINGFIELD; for the party\r\n`);
    expect(bytesOf(checking([row({ name: long })])).notes).toContain(
      '1 payee’s name is longer than OFX’s 32 characters, so each is cut there and given whole at the start of its memo.'
    );
  });

  test(`a memo is at most ${MEMO_MAX} characters, and the bank’s words that are the name aren’t repeated`, () => {
    const memo = textOf(checking([row({ note: 'n'.repeat(400) })])).match(/<MEMO>([^\r]*)/)![1];
    expect(memo.length).toBe(MEMO_MAX);
    expect(memo).toEndWith('...');
    expect(textOf(checking([row({ name: 'Shell', description: 'SHELL' })]))).not.toContain('<MEMO>');
  });
});

describe('statements', () => {
  test('one per currency: the account’s own first, with the balance, then the others, nothing converted', () => {
    const account = checking([
      row({ id: 'u1', amount: 10 }),
      row({ id: 'e1', amount: 20, currency: 'EUR', date: '2026-09-02' }),
      row({ id: 'j1', amount: 1500, currency: 'JPY', date: '2026-09-03' }),
      row({ id: 'u2', amount: -5, currency: null }),
    ]);
    const { statements, notes } = statementsOf(account);
    expect(statements.map((s) => [s.currency, s.rows.map((r) => r.id), !!s.ledger])).toEqual([
      ['USD', ['u1', 'u2'], true],
      ['EUR', ['e1'], false],
      ['JPY', ['j1'], false],
    ]);
    expect(notes).toEqual([
      'This account’s transactions are in more than one currency (USD, EUR, JPY), and an OFX statement has one, so the file has a statement for each, in that order. Nothing is converted.',
    ]);
    const text = textOf(account);
    expect(text.match(/<STMTTRNRS>/g)).toHaveLength(3);
    expect([...text.matchAll(/<TRNUID>(\d+)/g)].map((m) => m[1])).toEqual(['1', '2', '3']);
    expect([...text.matchAll(/<CURDEF>(\w+)/g)].map((m) => m[1])).toEqual(['USD', 'EUR', 'JPY']);
    expect(text).toContain('<TRNAMT>-1500\r\n<FITID>j1');
    // The same account in each, so an app files them together.
    expect(new Set([...text.matchAll(/<ACCTID>([^\r]+)/g)].map((m) => m[1])).size).toBe(1);
    expect(text.match(/<LEDGERBAL>/g)).toHaveLength(1);
  });

  test('with no currency of its own, the one most of its transactions are in', () => {
    const { statements } = statementsOf(checking([row({ id: 'a', currency: 'EUR' }), row({ id: 'b', currency: 'EUR' }), row({ id: 'c', currency: 'USD' })], { currency: null, balance: null }));
    expect(statements.map((s) => s.currency)).toEqual(['EUR', 'USD']);
  });

  test('a balance in another currency than the statement’s, or none known, is left out, and said', () => {
    expect(statementsOf(checking([row({ currency: 'EUR' })], { currency: null, balance: { amount: 10, as_of: '2026-10-01', currency: 'USD' } })).notes).toContain(
      'The statement has no balance: the account’s balance is in USD, and its transactions are in EUR.'
    );
    const none = statementsOf(checking([row({})], { balance: null, no_balance: 'Nya has no recorded balance for this account.' }));
    expect(none.statements[0].ledger).toBeNull();
    expect(none.notes).toEqual(['The statement has no balance: Nya has no recorded balance for this account.']);
    expect(textOf(checking([row({})], { balance: null }))).not.toContain('LEDGERBAL');
  });

  test('nothing stored saying the currency: US dollars, and the note asks to check', () => {
    const { statements, notes } = statementsOf(checking([row({ currency: null })], { currency: null, balance: null }));
    expect(statements[0].currency).toBe('USD');
    expect(notes[0]).toBe('Nothing stored says which currency this account is in, so the statement says US dollars (USD): check that this is right before you import it.');
  });

  test('an empty account: one statement, no list of transactions, its balance if known', () => {
    const text = textOf(checking([]));
    expect(text.match(/<STMTRS>/g)).toHaveLength(1);
    expect(text).not.toContain('BANKTRANLIST');
    expect(text).not.toContain('STMTTRN>');
    expect(text).toContain('<BALAMT>1550.25');
    const read = readBack(bytesOf(checking([])).bytes);
    expect(read.statements.map((s) => [s.s.currency, s.records.length, s.s.ledger])).toEqual([['USD', 0, { amount: 1550.25, as_of: '2026-10-09' }]]);
  });
});

describe('through Nya’s own import', () => {
  const ROWS: OfxRow[] = [
    row({ id: 'plaid_txn_coffee', date: '2026-09-01', user_date: '2026-08-31', amount: 4.5, name: 'Blue Bottle', description: 'BLUE BOTTLE #12 OAKLAND' }),
    row({ id: 'plaid_txn_pay', date: '2026-09-02', amount: -2450, name: 'ACME CORP PAYROLL' }),
    row({ id: 'manual-txn:5b0e7c1a-3f2d-4c55-9a1e-0d6f7e8a9b10', date: '2026-09-03', amount: 60, name: 'Cash', transaction_code: 'atm', note: 'for the market' }),
    row({ id: 'plaid_txn_amp', date: '2026-09-04', amount: 89.99, name: 'AT&T <Wireless>' }),
    row({ id: 'plaid_txn_cafe', date: '2026-09-05', amount: 3.2, name: 'Café Größe', excluded: true }),
    row({ id: 'plaid_txn_long', date: '2026-09-06', amount: 12.34, name: 'Grocery Outlet of Springfield Main Street' }),
    row({ id: 'plaid_txn_check', date: '2026-09-07', amount: 125, name: 'Landlord', check_number: '1042' }),
    row({ id: 'plaid_txn_refund', date: '2026-09-08', amount: -19.99, name: 'Return' }),
    // Two of the same coffee on one day: two rows, two ids.
    row({ id: 'plaid_txn_twin_a', date: '2026-09-09', amount: 4.5, name: 'Blue Bottle' }),
    row({ id: 'plaid_txn_twin_b', date: '2026-09-09', amount: 4.5, name: 'Blue Bottle' }),
    row({ id: 'plaid_txn_eur', date: '2026-09-10', amount: 15, currency: 'EUR', name: 'Bäckerei' }),
  ];

  test('every row comes back with its date, amount, sign, id and currency, and what fits, its name and note', () => {
    for (const kind of ['bank', 'creditcard'] as const) {
      const { bytes } = bytesOf(checking(ROWS, { kind }));
      const read = readBack(bytes);
      expect(read.encoding).toBe('windows-1252');
      const records = read.statements.flatMap((s) => s.records);
      expect(read.statements.flatMap((s) => s.problems)).toEqual([]);
      expect(records.map((r) => [r.source_id ?? null, r.date, r.amount, r.currency ?? null])).toEqual(ROWS.map((r) => [r.id, r.date, r.amount, r.currency]));
      const by = new Map(records.map((r) => [r.source_id, r]));
      expect(by.get('plaid_txn_amp')!.description).toBe('AT&T <Wireless>');
      expect(by.get('plaid_txn_cafe')!.description).toBe('Café Größe');
      expect(by.get('plaid_txn_cafe')!.note).toBe('Excluded from budgets and reports in Nya');
      expect(by.get('plaid_txn_coffee')!.note).toBe('BLUE BOTTLE #12 OAKLAND');
      expect(by.get('plaid_txn_long')!.description).toBe('Grocery Outlet of Springfield Ma');
      expect(by.get('plaid_txn_long')!.note).toBe('Grocery Outlet of Springfield Main Street');
      // What the bank's code said comes back as Nya reads it from any file.
      expect(by.get('manual-txn:5b0e7c1a-3f2d-4c55-9a1e-0d6f7e8a9b10')).toMatchObject({ transaction_code: 'atm', note: 'for the market' });
      expect(read.statements.map((s) => [s.s.kind, s.s.currency, s.s.ledger?.amount ?? null])).toEqual([
        [kind, 'USD', kind === 'bank' ? 1550.25 : -1550.25],
        [kind, 'EUR', null],
      ]);
    }
  });

  test('imported into an account, then imported again: the second adds nothing', () => {
    const { bytes } = bytesOf(checking(ROWS));
    const text = decodeFile(bytes).text;
    let book = null as { version: 1; rows: ManualTxn[] } | null;
    for (const statement of [0, 1]) {
      const read = readImport(text, { options: { statement }, thisYear: 2026 });
      if (read.status !== 'ready') throw new Error(`not ready: ${read.status}`);
      const { rows, problems } = normalizeRecords(read.records, { today: '2026-10-10', currency: 'USD' });
      expect(problems).toEqual([]);
      const first = planImport(rows, problems, book);
      expect(first.counts).toMatchObject({ new: rows.length, present: 0, conflicts: 0 });
      const added: ManualTxn[] = rows.map((r, i) => ({
        id: `manual-txn:00000000-0000-4000-8000-${String(statement * 100 + i).padStart(12, '0')}`,
        account_id: 'manual_import',
        ...r.row,
        import_id: `import:${statement}`,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      }));
      book = { version: 1, rows: [...(book?.rows ?? []), ...added] };
      // The same file again: every row is already there, by its id.
      const second = planImport(rows, problems, book);
      expect(second.counts).toMatchObject({ new: 0, present: rows.length, conflicts: 0 });
      expect(second.outcomes.every((o) => o.outcome === 'present' && o.by === 'id')).toBe(true);
    }
    expect(book!.rows.map((r) => r.source_id).sort()).toEqual(ROWS.map((r) => r.id).sort());
  });
});

describe('which accounts have a statement', () => {
  test('a bank account and a card do; a loan, an investment account and anything else say why not', () => {
    expect([ofxKindOf('depository'), ofxKindOf('credit'), ofxKindOf('loan'), ofxKindOf('investment'), ofxKindOf('other'), ofxKindOf(null)]).toEqual([
      'bank',
      'creditcard',
      null,
      null,
      null,
      null,
    ]);
    expect(ofxRefusal('depository')).toBeNull();
    expect(ofxRefusal('loan')).toStartWith('A loan has no statement in the version of OFX money apps read');
    expect(ofxRefusal('investment')).toStartWith('An investment account’s OFX statement lists holdings, trades and securities');
    for (const type of ['loan', 'investment', 'other', null]) expect(ofxRefusal(type)).toContain('JSON download');
  });

  test('its file is named for the account and the day', () => {
    expect(ofxFilename({ institution_name: 'Chase', name: 'Total Checking', mask: '1111' }, '2026-10-10')).toBe('nya-chase-total-checking-1111-2026-10-10.ofx');
    expect(ofxFilename({ institution_name: 'Crédit Agricole', name: 'Compte & Co.', mask: null }, '2026-10-10')).toBe('nya-credit-agricole-compte-co-2026-10-10.ofx');
    expect(ofxFilename({ name: '東京' }, '2026-10-10')).toBe('nya-account-2026-10-10.ofx');
  });
});
