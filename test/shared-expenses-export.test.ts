import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// Shared expenses (#49) in the download of your data: the JSON file holds
// all six stores (the people's names only in `expense-people`); the
// transactions CSV lists each shared transaction once with its own amount,
// your part in `nya_amount`, and each other person's part, each part a
// payment paid back and each IOU you owe a row of its own, so `amount` still
// adds up to the money as it moved and nothing counts twice; the CSV and an
// OFX statement name a person by their random id at most, never by name or
// handle; and what can't be read leaves those rows as the bank shows them.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, seedPerson } = await import('./api-fixture');
const { forgetEpochs } = await import('@/lib/sessions');
const { ensureTaxonomy } = await import('@/lib/category-store');
const { collectUserData, buildUserExport, exportFile, TRANSACTION_COLUMNS } = await import('@/lib/user-export');
const { ofxFile } = await import('@/lib/ofx-export');
const { createPerson, saveShare, saveIou, confirmPayment } = await import('@/lib/shared-expenses/edits');

const SAM = 'SECRET-SAM-NAME Rivera';
const ALEX = 'SECRET-ALEX-NAME Kim';
let cat: (name: string) => string;

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  await seedPerson(fake);
  const taxonomy = await ensureTaxonomy(ctx);
  cat = (name) => taxonomy.categories.find((c) => c.name === name)!.id;
});
afterEach(() => {
  process.env = { ...saved };
});

/** Rent shared half with Sam; the card's 80 with Alex, who owes 30 of it; an
 *  IOU you owe Alex for groceries, 25; and the ATM's 100 paid it back. */
async function shared() {
  const sam = (await createPerson(ctx, { name: SAM, venmo: 'sam-secret-handle', app: 'venmo' })).id;
  const alex = (await createPerson(ctx, { name: ALEX, cashtag: 'alexsecretcash' })).id;
  const rent = await saveShare(ctx, 't_rent', { entries: [{ person: sam, amount: 600, how: { kind: 'half' } }] });
  const cardShare = await saveShare(ctx, 't_card', { entries: [{ person: alex, amount: 30, how: { kind: 'amount' } }] });
  const iou = await saveIou(ctx, null, { person: alex, direction: 'by_you', amount: 25, currency: 'USD', date: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10), what: 'Groceries Alex bought', category_id: cat('food and drink') });
  await confirmPayment(ctx, 't_atm', { allocations: [{ item: iou.id, amount: 25 }] });
  return { sam, alex, rentEntry: rent.entries[0].id, cardEntry: cardShare.entries[0].id, iou: iou.id };
}

async function download() {
  const data = await collectUserData({ ctx, userId: 'user_me' });
  return { data, doc: buildUserExport(data, new Date()) };
}
const units = (s: string) => (s === '' ? 0 : Math.round(Number(s) * 100));

async function csv() {
  const { doc } = await download();
  const file = exportFile(doc, 'transactions-csv');
  const text = [...file.pieces()].join('');
  const [header, ...rows] = parseCsv(text);
  expect(header).toEqual([...TRANSACTION_COLUMNS]);
  const col = (r: string[], name: (typeof TRANSACTION_COLUMNS)[number]) => r[TRANSACTION_COLUMNS.indexOf(name)];
  return { text, rows, col, file };
}

describe('the JSON download', () => {
  test('holds all six stores, and the names only in expense-people', async () => {
    const ids = await shared();
    const { doc } = await download();
    const people = doc['expense-people'] as any[];
    expect(people.map((e) => e.value.name).sort()).toEqual([ALEX, SAM]);
    expect((doc['expense-shares'] as any[]).map((e) => e.id).sort()).toEqual(['t_card', 't_rent']);
    expect((doc['expense-ious'] as any[]).map((e) => e.id)).toEqual([ids.iou]);
    expect((doc['expense-payments'] as any[]).map((e) => [e.id, e.value.allocations])).toEqual([['t_atm', [{ item: ids.iou, amount: 25 }]]]);
    expect(doc['expense-dismissed']).toEqual([]);
    // The setting was never changed: nothing is kept, so the default applies.
    expect(doc['expense-settings']).toBeNull();
    // A share names its person by id, never by name.
    const kept = JSON.stringify([doc['expense-shares'], doc['expense-ious'], doc['expense-payments']]);
    for (const secret of ['SECRET-SAM-NAME', 'SECRET-ALEX-NAME', 'sam-secret-handle', 'alexsecretcash']) expect(kept).not.toContain(secret);
  });
});

describe('the transactions CSV', () => {
  test('a shared transaction once, its own amount, your part beside it; the others’ parts and an IOU rows of their own; nothing counts twice', async () => {
    const { sam, alex, rentEntry, cardEntry, iou } = await shared();
    const { rows, col } = await csv();
    const byId = new Map(rows.map((r) => [col(r, 'transaction_id'), r]));
    const cells = (id: string) => {
      const r = byId.get(id)!;
      return [col(r, 'amount'), col(r, 'nya_amount'), col(r, 'excluded'), col(r, 'shared_of'), col(r, 'shared_kind'), col(r, 'shared_person')];
    };
    expect(rows.filter((r) => col(r, 'transaction_id') === 't_rent')).toHaveLength(1);
    expect(cells('t_rent')).toEqual(['1200', '600', 'false', '', '', '']);
    expect(cells(`share:${rentEntry}`)).toEqual(['', '600', 'true', 't_rent', 'theirs', sam]);
    expect(cells('t_card')).toEqual(['80', '50', 'false', '', '', '']);
    expect(cells(`share:${cardEntry}`)).toEqual(['', '30', 'true', 't_card', 'theirs', alex]);
    // The IOU: your part of what Alex paid, on no account.
    expect(cells(`iou:${iou}`)).toEqual(['', '25', 'false', '', 'iou', alex]);
    const iouRow = byId.get(`iou:${iou}`)!;
    expect([col(iouRow, 'source'), col(iouRow, 'account_id'), col(iouRow, 'nya_category')]).toEqual(['shared', '', 'food and drink']);
    // The ATM's 100 paid it back: 75 of it counts as the bank shows it, the
    // 25 that paid the IOU never does.
    expect(cells('t_atm')).toEqual(['100', '75', 'false', '', '', '']);
    expect(cells(`settled:t_atm:${iou}`)).toEqual(['', '25', 'true', 't_atm', 'repaid', alex]);
    // The rows a transaction adds come right after it.
    const at = rows.indexOf(byId.get('t_rent')!);
    expect(col(rows[at + 1], 'transaction_id')).toBe(`share:${rentEntry}`);
    // Added up, `amount` is the money as it moved; `nya_amount`, but the
    // IOU's (no money moved on an account), adds up the same.
    const counted = rows.filter((r) => col(r, 'superseded_by_posted') !== 'true');
    const amounts = counted.reduce((n, r) => n + units(col(r, 'amount')), 0);
    const nya = rows.filter((r) => col(r, 'shared_kind') !== 'iou').reduce((n, r) => n + units(col(r, 'nya_amount')), 0);
    expect(nya).toBe(amounts);
  });

  test('names no one: a person is their random id, never a name or a handle', async () => {
    const { sam, alex } = await shared();
    const { text } = await csv();
    for (const secret of ['SECRET-SAM-NAME', 'SECRET-ALEX-NAME', 'sam-secret-handle', 'alexsecretcash']) expect(text).not.toContain(secret);
    expect(text).toContain(sam);
    expect(text).toContain(alex);
  });

  test('counted as the bank shows it, the transactions are as the bank has them, and no row is added', async () => {
    await shared();
    const { saveSettings } = await import('@/lib/shared-expenses/edits');
    await saveSettings(ctx, { counting: 'bank' });
    const { rows, col } = await csv();
    expect(rows.some((r) => col(r, 'shared_kind') !== '')).toBe(false);
    const rent = rows.find((r) => col(r, 'transaction_id') === 't_rent')!;
    expect([col(rent, 'amount'), col(rent, 'nya_amount')]).toEqual(['1200', '1200']);
  });

  test('shares that can’t be read: those transactions whole, counted, and the file says so', async () => {
    const { rentEntry } = await shared();
    await fake.hset(`test:c:${ctx.container}:expense-shares`, { t_rent: 'not-ciphertext-but-long-enough-to-be-tried' });
    const { rows, col, file } = await csv();
    expect(file.incomplete).toEqual(['expense-shares']);
    expect(file.notes.join(' ')).toContain('Not all of your shared transactions could be read: 1 shared transaction whose stored data is damaged. Those transactions are in this file whole');
    const rent = rows.find((r) => col(r, 'transaction_id') === 't_rent')!;
    expect(col(rent, 'nya_amount')).toBe('1200');
    expect(rows.some((r) => col(r, 'transaction_id') === `share:${rentEntry}`)).toBe(false);
    // The card's share, which could be read, still applies.
    expect(col(rows.find((r) => col(r, 'transaction_id') === 't_card')!, 'nya_amount')).toBe('50');
    // And a statement says its memo can't say.
    const { data, doc } = await download();
    const made = ofxFile(data, doc, 'acc_chk', new Date());
    if (!('file' in made)) throw new Error(made.refused);
    expect(made.file.incomplete).toContain('expense-shares');
    expect(made.file.notes.join(' ')).toContain('Whether 1 of these transactions is shared, or paid something back, couldn’t be read');
  });
});

describe('an OFX statement', () => {
  test('lists a shared transaction once, whole, your part and the others’ in its memo, and names no one', async () => {
    await shared();
    const { data, doc } = await download();
    const text = (account: string) => {
      const made = ofxFile(data, doc, account, new Date());
      if (!('file' in made)) throw new Error(made.refused);
      return [...made.file.pieces()].join('');
    };
    const checking = text('acc_chk');
    expect(checking.match(/<FITID>t_rent\r\n/g)).toHaveLength(1);
    expect(checking).not.toContain('<FITID>share:');
    expect(checking).not.toContain('<FITID>iou:');
    expect(checking).toContain('<TRNAMT>-1200.00\r\n<FITID>t_rent');
    expect(checking).toContain('Shared in Nya: your part 600.00; others 600.00');
    expect(checking).toContain('Paid back in Nya: 25.00');
    expect(text('acc_card')).toContain('Shared in Nya: your part 50.00; others 30.00');
    for (const secret of ['SECRET-SAM-NAME', 'SECRET-ALEX-NAME', 'sam-secret-handle', 'alexsecretcash']) expect(checking + text('acc_card')).not.toContain(secret);
  });
});
