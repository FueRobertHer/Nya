import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeRedis, storageMock, registerTestContainer } from './fake-redis';

// The sheet for switching from another app (components/MigrationSheet.tsx),
// rendered as it renders a real review: the one app/api/migration answers for
// a fixture. Every account asks where it goes until answered; the categories,
// the tags, the splits and each account's import are said in words; amounts
// go through lib/format.ts; nothing can be imported while an answer is
// missing or something blocks it.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { ReviewStep, MappingStep, PastMigrations, UndoConfirm, countsNow } = await import('@/components/MigrationSheet');
const routes = await import('@/app/api/migration/route');

const FIXTURES = join(import.meta.dir, 'fixtures', 'apps');
const noop = () => {};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

async function previewOf(name: string, meta: Record<string, unknown> = {}) {
  const form = new FormData();
  form.set('file', new Blob([readFileSync(join(FIXTURES, name))]), name);
  form.set('meta', JSON.stringify({ action: 'preview', file_name: name, ...meta }));
  const res = await routes.POST(new Request('http://localhost/api/migration', { method: 'POST', body: form }));
  return (await res.json()) as any;
}

const review = (r: any, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <ReviewStep r={r} taxonomy={null} options={{}} accounts={{}} categories={{}} tags={true} choices={{}} busy={false} error="" onAnswer={noop} onImport={noop} {...props} />
  );

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
});

describe('the review', () => {
  test('every account waits for an answer, and Import waits with it', async () => {
    const { preview } = await previewOf('ynab-register.csv');
    const html = review(preview);
    const words = text(html);
    expect(words).toContain('18 transactions in 4 accounts');
    expect(words).toContain('Read as YNAB’s export');
    expect(words).toContain('Where each account goes');
    for (const name of ['Checking', 'Savings', 'Visa', 'Brokerage']) expect(words).toContain(name);
    expect((html.match(/Choose where it goes/g) ?? []).length).toBe(4);
    expect(words).toContain('4 answers still needed');
    expect(html).toMatch(/<button disabled="">4 answers still needed<\/button>/);
  });

  test('answered: the categories, transfers, opening balances, tags, splits and each account’s import, in words', async () => {
    const accounts = Object.fromEntries(['Checking', 'Savings', 'Visa', 'Brokerage'].map((n) => [n, { to: 'new', name: n, institution: 'YNAB', type: n === 'Visa' ? 'credit' : 'depository', balance: 0 }]));
    const { preview } = await previewOf('ynab-register.csv', { accounts });
    const answers = Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, { ...v, balance: '0' }]));
    const html = review(preview, { accounts: answers });
    const words = text(html);
    expect(words).toContain('Inflow: Ready to Assign');
    expect(words).toContain('Your Income, counted as income');
    expect(words).toContain('New: Groceries, in Everyday Expenses (new), counted as spending');
    expect(words).toContain('6 transfers between your accounts, filed as transfers and left out of spending');
    expect(words).toContain('4 opening balances, under Starting balances, counted as neither income nor spending');
    expect(words).toContain('1 split transaction rebuilt, with 3 parts adding up exactly to each');
    expect(words).toContain('Bring the tags (2 tags, 2 new)');
    expect(words).toContain('Checking (new)');
    // Each account's rows with no category, and the currency read in.
    expect(words).toContain('1 with no category');
    expect(words).toContain('This file doesn’t say its currency, so amounts are read in the currency of the account they go into (USD for a new one). Change');
    // Amounts as lib/format.ts writes them.
    expect(words).toContain('new: $3,924.10 out, $6,501.25 in');
    expect(html).toMatch(/<button>Import<\/button>/);
    // The balance a new account would have, from the file, offered but not filled in.
    expect(words).toContain('Its transactions in this file come to');
  });

  test('a block is said, and keeps Import off', async () => {
    const accounts = { Checking: { to: 'new', name: 'Checking', institution: 'YNAB', type: 'credit', balance: -5 }, Savings: { to: 'skip' }, Visa: { to: 'skip' }, Brokerage: { to: 'skip' } };
    const { preview } = await previewOf('ynab-register.csv', { accounts });
    const html = review(preview);
    expect(text(html)).toContain('can’t be negative');
    expect(html).toMatch(/<button disabled="">Import<\/button>/);
  });

  test('Lunch Money: its sign is shown, and its export’s missing category settings are said', async () => {
    const { preview } = await previewOf('lunchmoney-transactions.csv');
    const words = text(review(preview));
    expect(words).toContain('Money out is written as negative in this file');
    expect(words).toContain('Lunch Money’s own way is positive');
    // Its first rows as read, to check that by, before any account is answered.
    expect(preview.targets).toEqual([]);
    expect(words).toContain('read as money out');
    expect(words).toContain('read as money in');
    expect(words).toContain('treat as income');
    // Its rows say their currency.
    expect(words).not.toContain('doesn’t say its currency');
  });

  test('a currency chosen is said, with the way back to each account’s own', async () => {
    const { preview } = await previewOf('ynab-register.csv', { currency: 'EUR' });
    const words = text(review(preview));
    expect(words).toContain('Amounts are read in EUR, as you chose. Change Use each account’s own');
  });
});

describe('the other steps', () => {
  test('the mapping step names the file’s columns and its first rows', () => {
    const q = { needs: 'mapping' as const, app: null, columns: {}, table: { header: ['When', 'Who', 'Out'], sample: [{ line: 2, cells: ['2026-09-01', 'Shop', '10.00'] }], rows: 1 }, problem: null };
    const words = text(renderToStaticMarkup(<MappingStep q={q} options={{}} busy={false} error="" onAnswer={noop} />));
    expect(words).toContain('Nya doesn’t recognise this file’s columns');
    expect(words).toContain('Line 2: 2026-09-01 · Shop · 10.00');
  });

  test('the list of imports, and what Undo takes out', () => {
    const entry = {
      app: 'ynab' as const,
      file_name: 'Budget.zip',
      started_at: '2026-10-01T12:00:00.000Z',
      status: 'done' as const,
      imports: [
        { account_id: 'manual_a', kind: 'manual' as const, name: 'Checking' },
        { account_id: 'acc_chk', kind: 'linked' as const, name: 'Chase Checking' },
      ],
      made: { accounts: [{ id: 'manual_a', name: 'Checking' }], categories: ['c1'], tags: [] },
      counts: { rows: 10, imported: 8, duplicates: 2, present: 0, splits: 1, tagged: 0 },
    };
    const listed = text(renderToStaticMarkup(<PastMigrations items={[{ id: 'app-import:1', record: 'ok', entry }]} error="" onUndo={noop} />));
    expect(listed).toContain('From YNAB, Budget.zip');
    expect(listed).toContain('8 transactions');
    expect(listed).toContain('Checking and Chase Checking');
    const undo = text(renderToStaticMarkup(<UndoConfirm item={{ id: 'app-import:1', record: 'ok', entry }} busy={false} error="" onConfirm={noop} onCancel={noop} />));
    expect(undo).toContain('The 1 account it made (Checking) goes too');
    expect(undo).toContain('The categories and tags it made go when nothing else uses them');
    expect(undo).toContain('Counting what it takes out');
    // What each account's Undo says it would take, added up.
    const preview = { remove: 8, edited: 2, moved: 1, duplicates: 2, restore: 0, kept: [{ file_name: 'bank.csv', count: 1 }], incomplete: false };
    const counted = text(renderToStaticMarkup(<UndoConfirm item={{ id: 'app-import:1', record: 'ok', entry }} preview={preview} busy={false} error="" onConfirm={noop} onCancel={noop} />));
    expect(counted).toContain('8 transactions go, and so do the 2 rows it kept as your banks’ own (your banks’ transactions stay).');
    expect(counted).toContain('2 of them were changed since, and go too.');
    expect(counted).toContain('1 is on another account now, and goes too.');
    expect(counted).toContain('1 more transaction stays: bank.csv found it already there, so it is kept for that import.');
    // Each Undo is named by its import, for a screen reader.
    expect(renderToStaticMarkup(<PastMigrations items={[{ id: 'app-import:1', record: 'ok', entry }]} error="" onUndo={noop} />)).toContain('aria-label="Undo the import from YNAB, Budget.zip"');
  });
});

describe('answers kept in the sheet until they are sent', () => {
  test('a new account’s fields are never disabled while the review is read, and each account’s first rows show its money out and in', async () => {
    const accounts = { Checking: { to: 'new', name: 'Checking', institution: 'YNAB', type: 'depository', balance: 0 }, Savings: { to: 'skip' }, Visa: { to: 'skip' }, Brokerage: { to: 'skip' } };
    const { preview } = await previewOf('ynab-register.csv', { accounts });
    const html = review(preview, { accounts: { ...accounts, Checking: { ...accounts.Checking, balance: '0' } }, busy: true });
    expect(html).toMatch(/<input maxLength="60" value="Checking"\/>/);
    expect(html).not.toMatch(/<input[^>]*disabled=""[^>]*value="Checking"/);
    const words = text(html);
    expect(words).toContain('Landlord');
    expect(words).toContain('money out');
    expect(words).toContain('money in');
  });

  test('a linked account’s answers count where they are given, and every one can be answered at once', () => {
    const proposal = (line: number, confidence: 'high' | 'low') => ({
      index: line,
      line,
      file: { date: '2026-09-05', name: `Row ${line}`, amount: 10, currency: 'USD' },
      twin: { date: '2026-09-06', name: `BANK ${line}`, amount: 10, currency: 'USD', kind: 'bank' as const, descriptor: null },
      days: 1,
      confidence,
      similar: false,
      choice: confidence === 'low' ? null : ('same' as const),
    });
    const t = { counts: { new: 0, duplicates: 1, unanswered: 1 }, proposals: [proposal(2, 'high'), proposal(3, 'low')] };
    expect(countsNow(t as any, { each: {} }, { each: { '3': 'new' } })).toMatchObject({ new: 1, duplicates: 1, unanswered: 0 });
    expect(countsNow(t as any, { each: {} }, { all: 'new', each: {} })).toMatchObject({ new: 2, duplicates: 0, unanswered: 0 });
  });
});
