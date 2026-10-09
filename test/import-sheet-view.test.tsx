import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { CsvMapping, PastImports, PreviewView, type ImportSummary, type Picked, type Preview } from '@/components/ImportSheet';
import { decodeFile } from '@/lib/import/text';
import { readImport, type ImportOptions } from '@/lib/import/read';

// The import sheet's views (components/ImportSheet.tsx), rendered as the
// sheet renders them: what the preview says before Import, the mapping step
// of a CSV file, and the list of past imports with Undo's confirmation.
// Lists rather than tables throughout, so the sheet reads at a phone's width.

const noop = () => {};
const account = { account_id: 'manual_checking-1', name: 'Checking', type: 'depository', balance: 1000, currency: 'USD', institution_name: 'Cascade CU' };
const picked = (text: string, format: Picked['format'] = 'ofx'): Picked => ({ name: 'statement.ofx', blob: new Blob([text]), text, encoding: 'utf-8', format });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const PREVIEW: Preview = {
  format: 'ofx',
  encoding: 'windows-1252',
  statement: { index: 0, label: 'Checking ending 4567', kind: 'bank', account: { bank_id: '325081403', mask: '4567', type: 'CHECKING' }, currency: 'USD', start: '2026-09-01', end: '2026-09-30', count: 9, ledger: { amount: 1946.05, as_of: '2026-09-30' } },
  read: { date_order: null, dates_ordered: false, decimal: null },
  counts: { new: 8, present: 0, repeated: 1, unreadable: 2 },
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
  first_date: '2026-09-01',
  last_date: '2026-09-30',
  currency: 'USD',
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
const importButton = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].find((m) => /Import|Nothing|Set the balance/.test(m[1]))!;

describe('the preview', () => {
  test('says what is new, what isn’t and why, the dates, the currency and the money, before anything is stored', () => {
    const html = preview();
    const t = text(html);
    expect(t).toContain('8 new transactions');
    expect(t).toContain('1 listed twice in the file · 2 lines can’t be read');
    expect(t).toContain('in USD');
    expect(t).toContain('Read as OFX, Checking ending 4567, Windows-1252 text.');
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
    const html = preview({ counts: { new: 0, present: 8, repeated: 1, unreadable: 0 } });
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
    expect(t).toContain('11 rows read');
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

  test('Undo’s confirmation says how many go, how many were changed since or moved, and that the balance stays', () => {
    const t = list([item], item);
    expect(t).toContain('Remove the 8 transactions this import added? 2 of them were changed since, and go too. 1 is on another account now, and goes too.');
    expect(t).toContain('Any you excluded are forgotten with them. The balance stays as it is.');
    expect(t).toContain('Keep it');
    expect(t).toContain('Undo import');
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
