import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { setAmountsHidden } from '@/lib/format';
import { amountTyped, receiptRows, unknownNote } from '@/components/receipt-filter';
import { candidates, findCandidates } from '@/components/attachment-pick';
import { isHeicBytes, isPdfBytes, looksLike, targetSize, LONG_SIDE, TALL_LONG_SIDE, THUMB_SIDE } from '@/components/attachment-capture';
import { looseWords, quotaNote, sizeWords, type FileView } from '@/components/attachment-client';
import AttachmentViewer, { altText, savedName } from '@/components/AttachmentViewer';
import AttachmentSection, { attachTarget, shownIds } from '@/components/AttachmentSection';
import { downloadReminder, filterFiles, needOf, volumeFilename } from '@/components/ReceiptsCard';
import MonthBreakdown, { type Txn } from '@/components/MonthBreakdown';

// The page's side of receipts and documents (#47): the filter by receipt on
// the Activity tab, choosing the transaction a file goes on, getting a
// photo ready (its size, what a file is), the words the sheets say, the
// viewer (a photo kept from view while amounts are hidden, a PDF never drawn
// in the page), the Manage card's filters and its reminder, and the Activity
// list's paperclip, there only where the file store is connected.

const MB = 1024 * 1024;

/** With amounts hidden for the render, as the switch hides them in a browser. */
function hiddenRender(node: React.ReactElement): string {
  const g = globalThis as Record<string, unknown>;
  const none = g.window === undefined;
  if (none) g.window = {};
  setAmountsHidden(true);
  if (none) delete g.window;
  try {
    return renderToStaticMarkup(node);
  } finally {
    setAmountsHidden(false);
  }
}
afterEach(() => setAmountsHidden(false));

const file = (over: Partial<FileView> = {}): FileView => ({
  id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d',
  kind: 'image',
  bytes: 310 * 1024,
  thumb: true,
  name: null,
  created_at: '2026-09-12T10:00:00.000Z',
  place: { on: 'transaction', transaction_id: 't_coffee' },
  as_placed: { date: '2026-09-11', amount: 4.5, currency: 'USD', name: 'Blue Bottle' },
  ...over,
});

let n = 0;
const row = (name: string, amount: number, over: Partial<Txn> = {}): Txn => ({
  transaction_id: `v${++n}`,
  date: '2026-09-11',
  name,
  amount,
  pending: false,
  account_name: 'Checking',
  institution_name: 'Chase',
  category: 'food and drink',
  iso_currency_code: 'USD',
  vendor_key: name.toLowerCase(),
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

describe('the filter by receipt', () => {
  test('reads an amount as it is written', () => {
    expect(['50', '50.5', '1,250', '1 250', '12,50', '1.250,50', ' 7 '].map(amountTyped)).toEqual([50, 50.5, 1250, 1250, 12.5, 1250.5, 7]);
    expect(['', 'abc', '-5', '5e3', '1.2.3'].map(amountTyped)).toEqual([null, null, null, null, null]);
  });

  test('keeps those with one, or those without one over an amount, and leaves out and counts what couldn’t be read', () => {
    const rows = [
      { transaction_id: 'a', amount: 30, attached: true as const },
      { transaction_id: 'b', amount: 80 },
      { transaction_id: 'c', amount: 20 },
      { transaction_id: 'd', amount: 100, attached: null },
      { transaction_id: 'pay', amount: -500 },
      { transaction_id: 'p1', amount: 40, split_of: 'S', split_parent: { amount: 90 } },
      { transaction_id: 'p2', amount: 50, split_of: 'S', split_parent: { amount: 90 } },
    ];
    const ids = (r: { rows: readonly { transaction_id: string }[] }) => r.rows.map((t) => t.transaction_id);
    expect(receiptRows(rows, '', '')).toEqual({ rows, unknown: 0 });
    expect(ids(receiptRows(rows, 'with', ''))).toEqual(['a']);
    expect(receiptRows(rows, 'with', '').unknown).toBe(1);
    // Money out over 50: a split transaction by its whole, all its parts.
    expect(ids(receiptRows(rows, 'without', '50'))).toEqual(['b', 'p1', 'p2']);
    // No amount: any money out; money in never.
    expect(ids(receiptRows(rows, 'without', ''))).toEqual(['b', 'c', 'p1', 'p2']);
    expect(unknownNote(0)).toBeNull();
    expect(unknownNote(1)).toBe('One transaction is left out: whether it has a receipt couldn’t be read just now.');
    expect(unknownNote(3)).toBe('3 transactions are left out: whether they have a receipt couldn’t be read just now.');
  });
});

describe('choosing the transaction a file goes on', () => {
  test('every transaction once: a split one as itself, a group’s each, never the one it is on', () => {
    const rows = [
      { transaction_id: 'plain', date: '2026-09-12', name: 'Blue Bottle', amount: 4.5, pending: false, iso_currency_code: 'USD' },
      { transaction_id: 'split:1', date: '2026-09-10', name: 'Costco', amount: 60, pending: false, iso_currency_code: 'USD', split_of: 'costco', split_parent: { amount: 100 } },
      { transaction_id: 'split:2', date: '2026-09-10', name: 'Costco', amount: 40, pending: false, iso_currency_code: 'USD', split_of: 'costco', split_parent: { amount: 100 } },
      {
        transaction_id: 'group:x',
        date: '2026-09-09',
        name: 'Trip',
        amount: 30,
        pending: false,
        iso_currency_code: 'USD',
        group_members: [
          { transaction_id: 'm1', date: '2026-09-09', name: 'Taxi', amount: 20, pending: false, iso_currency_code: 'USD' },
          { transaction_id: 'm2', date: '2026-09-09', name: 'Ferry', amount: 10, pending: true, iso_currency_code: 'USD' },
        ],
      },
    ];
    const all = candidates(rows, 'plain');
    expect(all.map((c) => [c.id, c.amount])).toEqual([
      ['costco', 100],
      ['m2', 10],
      ['m1', 20],
    ]);
    expect(findCandidates(all, 'tax').map((c) => c.id)).toEqual(['m1']);
    expect(findCandidates(all, '100').map((c) => c.id)).toEqual(['costco']);
    expect(findCandidates(all, '10.00').map((c) => c.id)).toEqual(['m2']);
    expect(findCandidates(all, '2026-09-09').map((c) => c.id)).toEqual(['m2', 'm1']);
    expect(findCandidates(all, 'nothing like it')).toEqual([]);
  });
});

describe('getting a photo ready', () => {
  test('shrunk to what a receipt needs, a tall till receipt kept taller, never made larger', () => {
    expect(targetSize(4032, 3024)).toEqual({ width: LONG_SIDE, height: 1536 });
    expect(targetSize(1000, 4000)).toEqual({ width: 768, height: TALL_LONG_SIDE });
    expect(targetSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(targetSize(4032, 3024, THUMB_SIDE)).toEqual({ width: THUMB_SIDE, height: 240 });
    expect(targetSize(0, 10)).toEqual({ width: 1, height: 1 });
  });

  test('what a file is, from its bytes and its name', () => {
    const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 24, ...Buffer.from(`ftyp${brand}`)]);
    expect(isHeicBytes(ftyp('heic'))).toBe(true);
    expect(isHeicBytes(ftyp('mif1'))).toBe(true);
    expect(isHeicBytes(ftyp('isom'))).toBe(false);
    expect(isPdfBytes(Buffer.from('\n\n%PDF-1.7 ...'))).toBe(true);
    expect(isPdfBytes(Buffer.from('<html>'))).toBe(false);
    expect(looksLike({ type: 'application/pdf', name: 'x' })).toBe('pdf');
    expect(looksLike({ type: '', name: 'IMG_0001.HEIC' })).toBe('heic');
    expect(looksLike({ type: 'image/png', name: 'scan.png' })).toBe('image');
    expect(looksLike({ type: '', name: 'letter.docx' })).toBe('other');
  });
});

describe('what the sheets say', () => {
  test('sizes, and the space used once it is nearly full', () => {
    expect([500, 1536 * 1024, 12 * MB, 1.5 * 1024 * MB].map(sizeWords)).toEqual(['1 KB', '1.5 MB', '12 MB', '1.5 GB']);
    const u = { bytes: 0, files: 1, quota_bytes: 1024 * MB, max_files: 4000 };
    expect(quotaNote({ ...u, bytes: 700 * MB })).toBeNull();
    expect(quotaNote({ ...u, bytes: 870 * MB })).toBe('84% of the space for receipts and documents on this copy of Nya is used (870 MB of 1 GB).');
    expect(quotaNote({ ...u, bytes: 1024 * MB, files: 12 })).toBe('The space for receipts and documents on this copy of Nya is full (1 GB of 1 GB, 12 files). Delete some to add more.');
    expect(quotaNote({ ...u, quota_bytes: null, bytes: 99 * MB })).toBeNull();
    expect(quotaNote(null)).toBeNull();
  });

  test('why a file isn’t on a transaction', () => {
    expect(looseWords({ on: 'transaction', transaction_id: 't' })).toBeNull();
    expect(looseWords({ on: 'transaction', transaction_id: 't', check: true })).toContain('Check which transaction');
    expect(looseWords({ on: 'earlier', account_id: 'a', pending: false, alike: 1 })).toContain('when you connect the bank again and link the account');
    expect(looseWords({ on: 'earlier', account_id: 'a', pending: true, alike: 1 })).toContain('attach it again by hand');
    expect(looseWords({ on: 'earlier', account_id: 'a', pending: false, alike: 2 })).toContain('choose which');
    for (const why of ['removed', 'gone', 'forgotten', 'emptied'] as const) expect(looseWords({ on: 'none', why, since: '2026-09-01T00:00:00.000Z' })).toStartWith('Not on a transaction: ');
  });
});

describe('the viewer', () => {
  const view = (f: FileView) => <AttachmentViewer files={[f]} index={0} onIndex={() => {}} onClose={() => {}} onChanged={() => {}} rows={[]} />;

  test('a photo, from the app’s own address, its text alternative naming its transaction', () => {
    const html = renderToStaticMarkup(view(file()));
    expect(html).toContain('src="/api/attachments/6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d/file"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).not.toContain('blob.vercel-storage.com');
    expect(altText(file())).toMatch(/^Receipt for Blue Bottle, \$4\.50 on /);
  });

  test('with amounts hidden, a photo is not drawn until asked for', () => {
    const html = hiddenRender(view(file()));
    expect(html).toContain('Show receipt');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('4.50');
  });

  test('a PDF is never drawn in the page, only saved; a damaged file says so', () => {
    const pdf = renderToStaticMarkup(view(file({ kind: 'pdf', thumb: false, name: 'Invoice.pdf' })));
    expect(pdf).not.toContain('<img');
    expect(pdf).not.toContain('<iframe');
    expect(pdf).toContain('A PDF opens in your own app: save it to read it.');
    expect(pdf).toContain('>Save<');
    const damaged = renderToStaticMarkup(view(file({ damaged: true })));
    expect(damaged).toContain('This file is damaged and can’t be opened.');
    expect(damaged).not.toContain('>Save<');
    expect(damaged).not.toContain('<img');
  });

  test('a file not on a transaction says why, and is offered one', () => {
    const html = renderToStaticMarkup(view(file({ place: { on: 'none', why: 'removed', since: '2026-09-20T00:00:00.000Z' } })));
    expect(html).toContain('Not on a transaction: your bank removed its transaction.');
    expect(html).toContain('Attach to a transaction');
  });

  test('a file saved is named for itself, or for its transaction and day', () => {
    expect(savedName(file())).toBe('2026-09-11 Blue Bottle.jpg');
    expect(savedName(file({ kind: 'pdf', name: 'Invoice' }))).toBe('Invoice.pdf');
    expect(savedName(file({ name: 'scan.JPG' }))).toBe('scan.JPG');
    expect(savedName(file({ as_placed: { date: '2026-09-11', amount: 1, currency: 'USD', name: '../../etc/passwd' } }))).toBe('2026-09-11 ....etcpasswd.jpg');
  });
});

describe('a transaction’s sheet', () => {
  test('a file goes on the transaction: a split one’s whole, never a group’s row', () => {
    expect(attachTarget({ transaction_id: 'split:1', split_of: 'costco' })).toBe('costco');
    expect(attachTarget({ transaction_id: 't1' })).toBe('t1');
    expect(attachTarget({ transaction_id: 'group:x', group_members: [] })).toBeNull();
    expect(shownIds({ transaction_id: 'posted', date: '', name: '', amount: 1, pending: false, iso_currency_code: null, attached: true, attached_on: ['imported-1'] })).toEqual(['posted', 'imported-1']);
  });

  test('says nothing for a row without one until it has read whether it may add one', () => {
    const t = row('Blue Bottle', 4.5);
    expect(renderToStaticMarkup(<AttachmentSection t={t} rows={[]} onChanged={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<AttachmentSection t={{ ...t, attached: true, attached_on: [t.transaction_id] }} rows={[]} onChanged={() => {}} />)).toContain('Receipts and documents');
  });
});

describe('the Manage card', () => {
  test('narrows by what needs the person, by year and by money out', () => {
    const files = [
      file({ id: 'a' }),
      file({ id: 'b', place: { on: 'none', why: 'gone', since: '2026-09-20T00:00:00.000Z' } }),
      file({ id: 'c', place: { on: 'earlier', account_id: 'x', pending: false, alike: 1 }, as_placed: { date: '2025-03-02', amount: 120, currency: 'USD', name: 'Hotel' } }),
      file({ id: 'd', place: { on: 'transaction', transaction_id: 't', check: true }, as_placed: null, created_at: '2025-01-01T00:00:00.000Z' }),
    ];
    expect(files.map(needOf)).toEqual(['', 'loose', 'waiting', 'check']);
    expect(filterFiles(files, { year: '', over: '', need: 'loose' }).map((f) => f.id)).toEqual(['b']);
    expect(filterFiles(files, { year: '2025', over: '', need: '' }).map((f) => f.id)).toEqual(['c', 'd']);
    expect(filterFiles(files, { year: '', over: '100', need: '' }).map((f) => f.id)).toEqual(['c']);
  });

  test('asks for a download when the files never were, or not for 90 days', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    expect(downloadReminder(null, 0, now)).toBeNull();
    expect(downloadReminder(null, 3, now)).toEqual({ ask: true, text: 'This copy of Nya keeps one copy of each file, so download them to keep your own. You haven’t downloaded them yet.' });
    expect(downloadReminder('2026-10-10T12:00:00.000Z', 3, now)?.ask).toBe(false);
    expect(downloadReminder('2026-06-10T12:00:00.000Z', 3, now)?.ask).toBe(true);
    expect(volumeFilename(2, 3, true, now)).toMatch(/^nya-attachments-\d{4}-\d{2}-\d{2}-2-of-3\.zip\.age$/);
  });
});

describe('the Activity list', () => {
  const props = { notes: [], loading: false, onRecategorize: () => {}, onRename: () => {} };
  const month = new Date().toISOString().slice(0, 7);
  const rows = () => [row('Blue Bottle', 4.5, { date: `${month}-01`, attached: true, attached_on: ['v'] }), row('Lunch place', 12, { date: `${month}-01` })];

  test('marks a transaction with one, and filters by it, where the file store is connected', () => {
    const html = renderToStaticMarkup(<MonthBreakdown {...props} txns={rows()} onAttachmentsChanged={() => {}} />);
    expect(html).toContain('has a receipt or document');
    expect(html.match(/class="attach-tag"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Show transactions by receipt"');
  });

  test('says nothing of them where it isn’t', () => {
    const html = renderToStaticMarkup(<MonthBreakdown {...props} txns={rows()} />);
    expect(html).not.toContain('attach-tag');
    expect(html).not.toContain('Show transactions by receipt');
  });
});
