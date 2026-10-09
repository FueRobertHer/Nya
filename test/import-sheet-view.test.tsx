import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { CsvMapping, PastImports, PreviewView, countsWith, kindsText, undoText, type Conflict, type ImportSummary, type Picked, type Preview, type UndoPlan } from '@/components/ImportSheet';
import { decodeFile } from '@/lib/import/text';
import { readImport, type ImportOptions } from '@/lib/import/read';

// The import sheet's views (components/ImportSheet.tsx), rendered as the
// sheet renders them: what the preview says before Import, the mapping step
// of a CSV file, and the list of past imports with Undo's confirmation.
// Lists rather than tables throughout, so the sheet reads at a phone's width.

const noop = () => {};
const account = { account_id: 'manual_checking-1', name: 'Checking', type: 'depository', balance: 1000, currency: 'USD', institution_name: 'Cascade CU' };
const picked = (text: string, format: Picked['format'] = 'ofx'): Picked => ({ name: 'statement.ofx', blob: new Blob([text]), text, encoding: 'utf-8', format });
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const PREVIEW: Preview = {
  format: 'ofx',
  encoding: 'windows-1252',
  statement: { index: 0, label: 'Checking ending 4567', kind: 'bank', account: { bank_id: '325081403', mask: '4567', type: 'CHECKING' }, currency: 'USD', start: '2026-09-01', end: '2026-09-30', count: 9, ledger: { amount: 1946.05, as_of: '2026-09-30' } },
  read: { date_order: null, dates_ordered: false, decimal: null },
  counts: { new: 8, present: 0, repeated: 1, replaced: 0, skipped: 0, conflicts: 0, unreadable: 2 },
  rows: [
    { line: 43, date: '2026-09-01', name: 'ACME CORP PAYROLL', amount: -2450, currency: 'USD', category: null, note: null, outcome: 'new' },
    { line: 51, date: '2026-09-03', name: 'SQ *BLUE BOTTLE COFFEE', amount: 4.5, currency: 'USD', category: null, note: null, outcome: 'new' },
    { line: 90, date: '2026-09-12', name: 'AT&T *WIRELESS', amount: 61.37, currency: 'USD', category: null, note: null, outcome: 'repeated' },
  ],
  problems: [
    { line: 12, reason: 'Its date (2026-13-45) can’t be read.' },
    { line: 30, reason: 'It has no amount.' },
  ],
  more_problems: 0,
  conflicts: [],
  more_conflicts: 0,
  shared_ids: [],
  more_shared_ids: 0,
  kinds: { transfers: 0, atm: 0, payments: 0, fees: 0 },
  first_date: '2026-09-01',
  last_date: '2026-09-30',
  currency: 'USD',
  currency_from: 'file',
  other_currencies: [],
  totals: { out: 2043.47, in: 2450.42 },
  shortened: 0,
  warnings: [],
  account_mismatch: null,
  balance: { amount: 1946.05, as_of: '2026-09-30', from: 1000, refusal: 'past' },
};

const preview = (over: Partial<Preview> = {}, props: Partial<Parameters<typeof PreviewView>[0]> = {}) =>
  renderToStaticMarkup(
    <PreviewView
      preview={{ ...PREVIEW, ...over }}
      file={picked('')}
      options={{}}
      account={account}
      busy={false}
      error=""
      setBalance={false}
      onSetBalance={noop}
      acknowledged={false}
      onAcknowledge={noop}
      onFlip={noop}
      onImport={noop}
      onBack={noop}
      {...props}
    />
  );
/** The preview's main button: Import, Update, Set the balance, or Nothing. */
const importButton = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].find((m) => /^(Import \d|Update \d|Nothing|Set the balance)/.test(m[1]))!;

describe('the preview', () => {
  test('says what is new, what isn’t and why, the dates, the currency and the money, before anything is stored', () => {
    const html = preview();
    const t = text(html);
    expect(t).toContain('8 new transactions');
    expect(t).toContain('1 listed twice in the file · 2 lines can’t be read');
    expect(t).toContain('in USD');
    expect(t).toContain('Read as OFX, Checking ending 4567, Windows-1252 text.');
    expect(text(preview({ format: 'csv', statement: null, encoding: 'utf-8', read: { date_order: 'dmy', dates_ordered: true, date_style: 'dmy', decimal: ',' } }))).toContain(
      'Read as CSV, dates day/month/year (UK, Europe), decimal comma.'
    );
    expect(t).toContain('Line 12: Its date (2026-13-45) can’t be read.');
    expect(t).toContain('Line 30: It has no amount.');
    // The rows as the Activity tab shows amounts: money in signed plus.
    expect(t).toContain('ACME CORP PAYROLL');
    expect(t).toContain('+$2,450.00');
    expect(t).toContain('-$4.50');
    expect(t).toContain('AT&T *WIRELESS');
    expect(t).toContain('listed twice in the file');
    expect(importButton(html)[1]).toBe('Import 8 transactions');
    expect(importButton(html)[0]).not.toContain('disabled');
    // Lists, never a table wider than a phone.
    expect(html).not.toContain('<table');
  });

  test('a past statement’s balance is shown, never offered; today’s is offered as a choice, unticked', () => {
    const past = text(preview());
    expect(past).toContain('The statement’s balance on Sep 30, 2026 was $1,946.05.');
    expect(past).toContain('only when it is today’s or yesterday’s');
    expect(past).not.toContain('Also set');
    const today = preview({ balance: { amount: 1946.05, as_of: '2026-10-09', from: 1000, refusal: null } });
    expect(text(today)).toContain('Also set Checking’s balance to $1,946.05, the statement’s balance on Oct 9, 2026 (now $1,000.00)');
    expect(today).not.toMatch(/type="checkbox"[^>]*checked=""[^>]*\/>\s*<span>Also set/);
    expect(text(today)).toContain('Importing doesn’t change Checking’s balance unless you tick the box.');
  });

  test('a file for another account is held until the person says it is the right one', () => {
    const mismatch = { expected: 'an account ending 4567 at bank 325081403', found: 'an account ending 8877 at bank 325081403' };
    const held = preview({ account_mismatch: mismatch });
    expect(text(held)).toContain('This file is for an account ending 8877 at bank 325081403, but Checking’s last OFX file was for an account ending 4567');
    expect(importButton(held)[0]).toContain('disabled');
    expect(importButton(preview({ account_mismatch: mismatch }, { acknowledged: true }))[0]).not.toContain('disabled');
  });

  test('nothing new is said plainly, and there is nothing to press', () => {
    const html = preview({ counts: { new: 0, present: 8, repeated: 1, replaced: 0, skipped: 0, conflicts: 0, unreadable: 0 } });
    expect(text(html)).toContain('Nothing new to import into Checking');
    expect(text(html)).toContain('8 already in Checking');
    expect(importButton(html)[1]).toBe('Nothing to import');
    expect(importButton(html)[0]).toContain('disabled');
  });
});

describe('the mapping step of a CSV file', () => {
  const csv = decodeFile(new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', 'import', 'card-debit-credit.csv')))).text;
  const map = (options: ImportOptions) => {
    const read = readImport(csv, { format: 'csv', options, thisYear: 2026 });
    return renderToStaticMarkup(<CsvMapping file={picked(csv, 'csv')} read={read} options={options} setOptions={noop} account="Visa" busy={false} error="" onNext={noop} />);
  };

  test('each column chosen from the file’s own names, and the first rows as they read with that', () => {
    const html = map({ csv: { columns: { date: 0, description: 3, category: 4, debit: 5, credit: 6 }, sign: 'negative-out', delimiter: ',' } });
    const t = text(html);
    expect(t).toContain('How the first rows read');
    expect(t).toContain('AMAZON MKTPL*2X3Y4, AMZN.COM/BILL WA');
    expect(t).toContain('-$23.99');
    expect(t).toContain('CAPITAL ONE MOBILE PYMT');
    expect(t).toContain('+$500.00');
    // Every row is counted a moment after the taps stop, never once per tap.
    expect(t).toContain('Counting the rows…');
    // The format its dates were found in, shown.
    expect(t).toContain('Dates are read as year-month-day (2026-09-30).');
    expect(html).toContain('Transaction Date');
    expect(html).not.toContain('<table');
  });

  test('dates that fit both orders are asked about, and the step can’t go on until they are answered', () => {
    const ambiguous = 'Date,Description,Amount\n09/01/2026,A,-1\n09/02/2026,B,-2\n';
    const options = { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' as const } };
    const read = readImport(ambiguous, { format: 'csv', options, thisYear: 2026 });
    const html = renderToStaticMarkup(<CsvMapping file={picked(ambiguous, 'csv')} read={read} options={options} setOptions={noop} account="Visa" busy={false} error="" onNext={noop} />);
    expect(text(html)).toContain('Every date in this file could be month first or day first (09/01/2026, 09/02/2026). Which is it?');
    const next = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].find((m) => m[1].startsWith('Check against'))!;
    expect(next[0]).toContain('disabled');
  });
});

describe('the list of past imports', () => {
  const item: ImportSummary = {
    id: 'import:1',
    record: 'ok',
    format: 'ofx',
    file_name: 'sept.ofx',
    imported_at: '2026-10-09T12:00:00.000Z',
    counts: { imported: 8, present: 0, repeated: 1, unreadable: 0 },
    first_date: '2026-09-01',
    last_date: '2026-09-30',
    currency: 'USD',
    statement: 'Checking ending 4567',
    balance_update: null,
    rows_now: 8,
    edited_now: 2,
    moved_now: 1,
  };
  const list = (imports: ImportSummary[], undoing: ImportSummary | null = null) =>
    text(renderToStaticMarkup(<PastImports past={{ imports }} error="" account="Checking" busy={false} undoing={undoing} onUndo={noop} onKeep={noop} onConfirm={noop} />));

  test('each import with what it added and when, and Undo', () => {
    const t = list([item]);
    expect(t).toContain('Past imports into Checking');
    expect(t).toContain('sept.ofx');
    expect(t).toContain('8 transactions added · Sep 1, 2026 to Sep 30, 2026');
    expect(t).toContain('Undo');
  });

  const plan = (over: Partial<UndoPlan> = {}): UndoPlan => ({ record: 'ok', remove: 8, edited: 2, moved: 1, kept: [], restore: 0, incomplete: false, ...over });
  const confirming = (p: { plan: UndoPlan | null; error: string } | null) =>
    renderToStaticMarkup(<PastImports past={{ imports: [item] }} error="" account="Checking" busy={false} undoing={item} plan={p} onUndo={noop} onKeep={noop} onConfirm={noop} />);
  const undoButton = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].find((m) => m[1] === 'Undo import')!;

  test('Undo’s confirmation, from the server’s plan: how many go, how many were changed since or moved, and that the balance stays', () => {
    const html = confirming({ plan: plan(), error: '' });
    const t = text(html);
    expect(t).toContain('Remove the 8 transactions this import added? 2 of them were changed since, and go too. 1 is on another account now, and goes too.');
    expect(t).toContain('Any you excluded are forgotten with them. The balance stays as it is.');
    expect(t).toContain('Keep it');
    expect(undoButton(html)[0]).not.toContain('disabled');
    // Until the plan is known, or when it can't be, nothing to confirm.
    expect(text(confirming(null))).toContain('Working out what undoing it would do…');
    expect(undoButton(confirming(null))[0]).toContain('disabled');
    expect(text(confirming({ plan: null, error: 'Could not reach the server.' }))).toContain('Could not reach the server.');
  });

  test('rows a later import relied on stay, and the confirmation says which import and why; rows it updated go back', () => {
    const later = { import_id: 'import:2', file_name: 'feb-apr.ofx', imported_at: '2026-10-09T13:00:00.000Z', count: 2 };
    expect(undoText(plan({ remove: 1, edited: 0, moved: 0, kept: [later] }))).toBe(
      'Remove the 1 transaction this import added? 2 more transactions it added stay: feb-apr.ofx, imported later, found them here and didn’t add them again, so they are kept for that import, whose Undo takes them out.'
    );
    expect(undoText(plan({ remove: 0, edited: 0, moved: 0, restore: 1 }))).toBe('Undo this import? 1 transaction it updated from its file goes back to how it was.');
    expect(undoText(plan({ remove: 0, edited: 0, moved: 0 }))).toBe('None of its transactions is left. Undo removes its record.');
    expect(undoText(plan({ record: 'unreadable', incomplete: true }))).toContain('Its record can’t be read, and goes too. Some accounts’ transactions can’t be read now: any of its transactions there stay.');
  });

  test('rows kept for an import when an earlier one was undone are said on it', () => {
    const t = list([{ ...item, counts: { imported: 1, present: 2, repeated: 0, unreadable: 0 }, taken_over: 2, rows_now: 3 }]);
    expect(t).toContain('1 transaction added');
    expect(t).toContain('2 transactions an earlier import added are kept for this one, since that one was undone.');
    expect(t).not.toContain('still stored');
  });

  test('an import whose record can’t be read can still be undone; one a later release wrote can’t be here', () => {
    const t = list([
      { ...item, id: 'import:2', record: 'unreadable', file_name: null, format: null, counts: null, imported_at: null, first_date: null, last_date: null },
      { ...item, id: 'import:3', record: 'unrecognised', file_name: null, format: null, counts: null },
    ]);
    expect(t).toContain('Its record can’t be read; Undo still takes its transactions out.');
    expect(t).toContain('A newer version of Nya saved it, so it can’t be undone here.');
    expect(t.match(/Undo/g)!.length).toBe(2); // the unreadable one's button, and its note
  });

  test('no imports, nothing listed', () => {
    expect(list([])).toBe('');
  });
});

describe('rows whose bank id is on another transaction here', () => {
  const conflict = (over: Partial<Conflict> = {}): Conflict => ({
    index: 1,
    line: 9,
    row_id: 'manual-txn:s1',
    differs: { name: false, amount: true, date: true },
    suggested: null,
    choice: null,
    file: { date: '2026-10-03', name: 'BISTRO', amount: 60, currency: 'USD' },
    stored: { date: '2026-10-01', name: 'BISTRO', amount: 50, currency: 'USD' },
    ...over,
  });
  const asking = { counts: { new: 2, present: 0, repeated: 0, replaced: 0, skipped: 0, conflicts: 1, unreadable: 0 }, conflicts: [conflict()] };

  test('each listed with both versions, what differs, and a choice; Import waits for every answer', () => {
    const html = preview(asking);
    const t = text(html);
    expect(t).toContain('Bank ids already used in Checking');
    expect(t).toContain('This row has the bank’s id (FITID) of a transaction already in Checking, but doesn’t match it.');
    expect(t).toContain('In the file (line 9) BISTRO -$60.00 Oct 3, 2026 Already in Checking BISTRO -$50.00 Oct 1, 2026 · the amount and date differ · choose one');
    expect(t).toContain('1 bank id to decide');
    expect(t).toContain('Choose what to do with the transaction above whose bank id is already here, then import.');
    expect(html).toMatch(/aria-pressed="false"[^>]*>Import as new</);
    expect(importButton(html)[0]).toContain('disabled');
  });

  test('a choice made moves the counts at once, and lets Import go', () => {
    const replaced = preview(asking, { choices: { each: { '1': 'replace' } }, sentChoices: { each: {} } });
    expect(text(replaced)).toContain('2 new transactions');
    expect(text(replaced)).toContain('1 to update');
    expect(replaced).toMatch(/aria-pressed="true"[^>]*>Replace</);
    expect(importButton(replaced)[1]).toBe('Import 2 transactions, update 1');
    expect(importButton(replaced)[0]).not.toContain('disabled');
    expect(countsWith(asking, { each: { '1': 'skip' } })).toMatchObject({ skipped: 1, conflicts: 0, new: 2 });
    expect(countsWith(asking, { all: 'new', each: {} })).toMatchObject({ new: 3, conflicts: 0 });
    // A suggestion counts as chosen until changed.
    const suggested = { counts: { ...asking.counts, new: 3, conflicts: 0 }, conflicts: [conflict({ suggested: 'new', choice: 'new' })] };
    expect(countsWith(suggested, { each: {} })).toEqual(suggested.counts);
    expect(countsWith(suggested, { each: { '1': 'skip' } })).toMatchObject({ new: 2, skipped: 1 });
  });

  test('several get a choice for every one at once, and the ones not listed are said to follow it', () => {
    const many = { ...asking, conflicts: [conflict(), conflict({ index: 2, line: 10 })], more_conflicts: 3 };
    const t = text(preview(many));
    expect(t).toContain('These 5 rows have the bank’s id (FITID)');
    expect(t).toContain('All as new Replace all Skip all');
    expect(t).toContain('3 more rows like these aren’t listed, and follow the choice for every row above.');
  });
});

describe('what else the preview says of a file', () => {
  test('what the file marks as transfers, cash, payments and fees, and how each counts', () => {
    expect(kindsText({ transfers: 2, atm: 1, payments: 1, fees: 2 })).toBe(
      'The file marks 2 transfers, 1 ATM withdrawal and 1 card or loan payment: like a linked bank’s, they count as neither spending nor income. 2 bank fees count as spending.'
    );
    expect(kindsText({ transfers: 0, atm: 0, payments: 0, fees: 1 })).toBe('1 bank fee counts as spending.');
    expect(kindsText({ transfers: 0, atm: 0, payments: 0, fees: 0 })).toBeNull();
    expect(text(preview({ kinds: { transfers: 1, atm: 0, payments: 0, fees: 0 } }))).toContain('The file marks 1 transfer: like a linked bank’s, they count as neither spending nor income.');
  });

  test('a file that doesn’t say its currency says what it is read in, with a way to change it; one that says doesn’t ask', () => {
    const qif = text(preview({ format: 'qif', statement: null, currency_from: 'default' }));
    expect(qif).toContain('Amounts are read in USD: this file doesn’t say its currency. Change');
    expect(text(preview({ format: 'qif', statement: null, currency: 'EUR', currency_from: 'chosen' }))).toContain('Amounts are read in EUR, as chosen for this account.');
    expect(text(preview())).not.toContain('Amounts are read in');
    // A CSV file's currency is chosen with its columns.
    expect(text(preview({ format: 'csv', statement: null, currency_from: 'default' }))).not.toContain('Amounts are read in');
  });

  test('a QIF file whose dates fit both orders shows the order read, changeable; one whose dates settle it doesn’t ask', () => {
    const open = preview({ format: 'qif', statement: null, read: { date_order: 'dmy', dates_ordered: true, order_open: true, decimal: '.' } });
    expect(text(open)).toContain('Dates are read as: month/day/year (US) day/month/year (UK, Europe)');
    expect(open).toMatch(/aria-pressed="true"[^>]*>day\/month\/year/);
    expect(text(preview({ format: 'qif', statement: null, read: { date_order: 'dmy', dates_ordered: true, order_open: false, decimal: '.' } }))).not.toContain('Dates are read as:');
  });

  test('rows that share a bank id but aren’t alike, and a file’s repaired structure, are said', () => {
    const t = text(
      preview({
        shared_ids: [{ line: 12, with_line: 4 }],
        warnings: ['3 transactions in this file have no end tag (</STMTTRN>), so each was read up to the next one. Check the rows below.'],
      })
    );
    expect(t).toContain('Line 12 shares its bank id with line 4: they aren’t alike, so each is imported as a transaction of its own.');
    expect(t).toContain('3 transactions in this file have no end tag (</STMTTRN>), so each was read up to the next one.');
  });
});
