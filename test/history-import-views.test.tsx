import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewView, countsNow, undoText, type Review } from '@/components/HistoryImportSheet';
import ImportedHistoryNote from '@/components/ImportedHistoryNote';
import MonthBreakdown from '@/components/MonthBreakdown';
import type { Picked } from '@/components/ImportSheet';
import { importedRowsNote } from '@/lib/history-import/view';
import { localMonth } from '@/lib/local-date';
import type { Txn } from '@/lib/transactions';

// What the person sees of importing history into a linked account: the review
// (components/HistoryImportSheet.tsx), with every likely duplicate beside the
// bank's row and nothing merged without an answer; the note under the
// net-worth chart (components/ImportedHistoryNote.tsx); and a month's totals
// on the Activity tab saying what came from files.

const noop = () => {};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const account = { account_id: 'acc_chk', name: 'Checking', institution_name: 'Chase', type: 'depository', currency: 'USD' };
const picked: Picked = { name: 'statement.ofx', blob: new Blob(['']), text: '', encoding: 'utf-8', format: 'ofx' };

const REVIEW: Review = {
  format: 'ofx',
  statement: null,
  read: { date_order: null, decimal: null },
  counts: { new: 3, duplicates: 1, already: 0, present: 2, repeated: 0, skipped: 0, conflicts: 0, unanswered: 1, unreadable: 0 },
  rows: [{ line: 10, date: '2024-03-01', name: 'OLD STORE', amount: 100, currency: 'USD', category: null, outcome: 'new' }],
  problems: [],
  more_problems: 0,
  proposals: [
    {
      index: 4,
      line: 40,
      file: { date: '2026-08-01', name: 'GROCERY OUTLET', amount: 60, currency: 'USD' },
      twin: { kind: 'bank', date: '2026-08-06', name: 'Shell', amount: 60, currency: 'USD', id: 'b1', descriptor: 'SHELL OIL 5544', import_id: null },
      days: 5,
      confidence: 'low',
      similar: false,
      edge: null,
      choice: null,
    },
    {
      index: 7,
      line: 70,
      file: { date: '2026-08-10', name: 'Online Transfer to Landlord', amount: 1850, currency: 'USD' },
      twin: { kind: 'bank', date: '2026-08-10', name: 'ZELLE PAYMENT TO LANDLORD', amount: 1850, currency: 'USD', id: 'b2', descriptor: 'ZELLE PAYMENT TO LANDLORD', import_id: null },
      days: 0,
      confidence: 'high',
      similar: true,
      edge: null,
      choice: 'same',
    },
  ],
  more_proposals: 0,
  conflicts: [],
  more_conflicts: 0,
  kinds: { transfers: 0, atm: 0, payments: 0, fees: 0 },
  first_date: '2024-03-01',
  last_date: '2026-08-10',
  covers: { from: '2024-03-01', to: '2026-08-31', stated: false },
  bank_from: '2026-07-15',
  before_bank: 2,
  within_bank: 1,
  pending_alike: 0,
  currency: 'USD',
  other_currencies: [],
  totals: { out: 160, in: 0 },
  shortened: 0,
  warnings: [],
  account_mismatch: null,
  review: '0123456789abcdef0123456789abcdef',
};

const render = (choices = { each: {} as Record<string, 'same' | 'new'> }, sent = { each: {} as Record<string, 'same' | 'new'> }) =>
  renderToStaticMarkup(
    <ReviewView
      review={REVIEW}
      file={picked}
      options={{}}
      account={account}
      busy={false}
      error=""
      acknowledged={false}
      onAcknowledge={noop}
      choices={choices}
      sentChoices={sent}
      onChoose={noop}
      onChooseAll={noop}
      conflicts={{ each: {} }}
      onConflict={noop}
      onConflictAll={noop}
      onCovers={noop}
      onFlip={noop}
      onImport={noop}
      onBack={noop}
    />
  );
const importButton = (html: string) => [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].find((m) => /^(Import \d|Keep as|Nothing)/.test(m[2]))!;

describe('the review', () => {
  test('every likely duplicate is shown beside the bank’s row, how far apart and how sure, with the choice for it', () => {
    const t = text(render());
    expect(t).toContain('Likely already from Chase');
    expect(t).toContain('GROCERY OUTLET');
    expect(t).toContain('From Chase Shell');
    expect(t).toContain('SHELL OIL 5544');
    expect(t).toContain('5 days apart · possibly the same · choose one');
    expect(t).toContain('The same day, alike in name · very likely the same');
    expect(t).toContain('2 new transactions are older than Chase’s own');
    expect(t).toContain('1 new transaction falls in its period, though it has nothing like it.');
    expect(t).toContain('The file covers');
  });

  test('nothing is imported while a proposal has no answer; an answer moves the counts', () => {
    const waiting = render();
    expect(importButton(waiting)[1]).toContain('disabled');
    expect(text(waiting)).toContain('Say what the row above is, then import.');
    const answered = render({ each: { '4': 'new' } });
    expect(importButton(answered)[1]).not.toContain('disabled');
    expect(importButton(answered)[2]).toBe('Import 4 transactions');
    expect(countsNow(REVIEW, { each: {} }, { each: { '4': 'same', '7': 'new' } })).toMatchObject({ new: 4, duplicates: 1, unanswered: 0 });
  });

  test('a pair across an edge says why; an earlier file’s row is named by its file; lines that can’t be read ask whether they are transactions; a connection still sending its history says so', () => {
    const review: Review = {
      ...REVIEW,
      counts: { ...REVIEW.counts, unreadable: 2 },
      history_pending: true,
      proposals: [
        { ...REVIEW.proposals[0], edge: { kind: 'before-bank', day: '2026-07-15' } },
        {
          ...REVIEW.proposals[1],
          index: 9,
          twin: {
            kind: 'imported',
            date: '2026-08-10',
            name: 'ONLINE TRANSFER TO LANDLORD REF 99812',
            amount: 1850,
            currency: 'USD',
            id: 'imported-txn:00000000-0000-0000-0000-000000000001',
            descriptor: null,
            import_id: 'history-import:a1b2c3d4',
            file_name: 'export.csv',
            imported_at: '2026-09-01T12:00:00.000Z',
          },
        },
      ],
    };
    const view = (whole: boolean) =>
      text(
        renderToStaticMarkup(
          <ReviewView
            review={review}
            file={picked}
            options={{}}
            account={account}
            busy={false}
            error=""
            acknowledged={false}
            onAcknowledge={noop}
            choices={{ each: {} }}
            sentChoices={{ each: {} }}
            onChoose={noop}
            onChooseAll={noop}
            conflicts={{ each: {} }}
            onConflict={noop}
            onConflictAll={noop}
            onCovers={noop}
            whole={whole}
            onWhole={noop}
            onFlip={noop}
            onImport={noop}
            onBack={noop}
          />
        )
      );
    const t = view(false);
    expect(t).toContain('Chase has nothing before');
    expect(t).toContain('the same only if it posted days later.');
    expect(t).toContain('Likely already here');
    expect(t).toContain('Imported from export.csv');
    expect(t).toContain('The 2 lines that can’t be read aren’t transactions');
    expect(t).toContain('this file’s period isn’t used to draw the estimated history');
    expect(t).toContain('Chase is still sending this connection’s older transactions to Nya');
    expect(view(true)).not.toContain('this file’s period isn’t used to draw the estimated history');
    expect(t).not.toMatch(/[\u2013\u2014]/);
  });

  test('what undoing says before it is done', () => {
    expect(undoText({ record: 'ok', remove: 3, duplicates: 4, kept: [{ file_name: 'later.ofx', count: 2 }], incomplete: false })).toBe(
      'Remove the 3 transactions this import added? The 4 rows it kept as the bank’s own go too; the bank’s stay. 2 more transactions stay: later.ofx found them already here, so they are kept for that import.'
    );
  });
});

describe('the note under the net-worth chart', () => {
  test('names the stretch from imported rows and what isn’t drawn, by the accounts’ names', () => {
    const html = renderToStaticMarkup(
      <ImportedHistoryNote
        view={{
          until: '2025-10-10',
          from: '2021-12-31',
          accounts: [{ account_id: 'acc_chk', reach: '2021-12-31', bank_from: null }],
          gaps: [{ account_id: 'acc_chk', imported: { from: '2019-01-01', to: '2019-12-31' }, uncovered: { from: '2020-01-01', to: '2021-12-31' } }],
          unwalked: [],
          excluded: [],
          capped: [],
          redrawing: false,
          problem: null,
        }}
        institutions={[{ institution_name: 'Chase', accounts: [{ account_id: 'acc_chk', name: 'Checking' }] }]}
      />
    );
    const t = text(html);
    expect(t).toContain('Chase Checking: the estimate follows the transactions you imported, back to');
    expect(t).toContain('Not drawn: Chase Checking’s import from');
    expect(t).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('a month’s totals on the Activity tab', () => {
  const month = localMonth();
  const row = (over: Partial<Txn>): Txn => ({
    transaction_id: 't1',
    date: `${month}-01`,
    name: 'Grocer',
    amount: 25,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Chase',
    category: 'groceries',
    iso_currency_code: 'USD',
    vendor_key: 'grocer',
    logo_url: null,
    category_icon_url: null,
    subcategory: null,
    category_confidence: null,
    transaction_code: null,
    payment_channel: null,
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: null,
    region: null,
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
    ...over,
  });

  test('say how many of the month’s rows came from imported files, and mark each', () => {
    const imported = row({ transaction_id: 'imported-txn:6b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d', name: 'Old corner shop', source: 'import:ofx' });
    const t = text(renderToStaticMarkup(<MonthBreakdown txns={[row({}), imported]} notes={[]} loading={false} onRecategorize={noop} onRename={noop} />));
    expect(t).toContain('1 of this month’s transactions was imported from files, not sent by the bank.');
    // Its category as the person's categories name it, as any row's is.
    expect(t).toContain('Groceries · Chase · Checking · imported from OFX');
    expect(importedRowsNote([row({})])).toBeNull();
  });
});
