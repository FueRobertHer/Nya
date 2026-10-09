import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, unscopedDataKeys } from './fake-redis';

// Transactions entered on manual accounts (lib/manual-txns.ts): the rules for
// what a row may hold (lib/manual-txn-input.ts), the store on the seam, and
// how rows are shown on the Activity tab.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Deserializing like Upstash: what production reads back.
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { UnreadableEntriesError, StoredValueTooLargeError } = await import('@/lib/repo');
const { declaredStore } = await import('@/lib/stores');
const { classify } = await import('@/lib/reencrypt');
const { saveManualAccount, MAX_BALANCE } = await import('@/lib/manual');
const input = await import('@/lib/manual-txn-input');
const {
  manualTxnStore,
  newManualTxn,
  newManualTxnId,
  isManualTxnId,
  isManualTxnBook,
  addManualTxn,
  findManualTxn,
  editManualTxn,
  deleteManualTxn,
  removeAccountTxns,
  manualRowsForDisplay,
  readManualTxnsForDisplay,
  noteBalanceUpdate,
  MANUAL_TXN_PREFIX,
} = await import('@/lib/manual-txns');
type ManualTxn = import('@/lib/manual-txns').ManualTxn;
type ManualAccount = import('@/lib/manual').ManualAccount;

const ctx = TEST_CTX;
const OTHER = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;

const WALLET: ManualAccount = {
  account_id: 'manual_wallet-1',
  name: 'Wallet',
  institution_name: 'Cash',
  type: 'depository',
  subtype: null,
  balance: 200,
  updated_at: '2026-10-01T12:00:00.000Z',
};
const CARD: ManualAccount = {
  account_id: 'manual_card-1',
  name: 'Travel card',
  institution_name: 'Credit Union',
  type: 'credit',
  subtype: 'credit card',
  balance: 500,
  updated_at: '2026-10-01T12:00:00.000Z',
};

const FIELDS = { date: '2026-10-05', amount: 12.5, currency: 'USD', name: 'Blue Bottle', category: 'food and drink', note: null };

/** A row as the app saves one, at a given time. */
function row(account_id: string, over: Partial<ManualTxn> = {}, at = '2026-10-05T09:00:00.000Z'): ManualTxn {
  return { ...newManualTxn(account_id, FIELDS, new Date(at)), ...over };
}

/** Runs `fn` with console.error and console.warn collected instead of printed. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T | Error; logged: string }> {
  const [error, warn] = [console.error, console.warn];
  const lines: string[] = [];
  console.error = console.warn = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  try {
    return { result: await fn().catch((e: Error) => e), logged: lines.join('\n') };
  } finally {
    [console.error, console.warn] = [error, warn];
  }
}

beforeEach(() => {
  fake.reset();
  delete (fake as any).eval; // a test's atNextWrite left armed
  delete process.env.MAX_TXN_BLOB_CHARS;
});

/** Runs `meanwhile` once, just before the next write of several entries
 *  (MapStore.updateMany's script) reaches storage, as another device would;
 *  or, with `fail`, makes that write fail, as a storage blip would. */
function atNextWrite(opts: { meanwhile?: () => Promise<unknown>; fail?: boolean }) {
  const original = fake.eval.bind(fake);
  (fake as any).eval = async (script: string, keys: string[], args: string[]) => {
    if (!script.startsWith('-- nya:repo-update-entries')) return original(script, keys, args);
    delete (fake as any).eval;
    if (opts.fail) throw new Error('storage blip');
    await opts.meanwhile?.();
    return original(script, keys, args);
  };
}

describe('what a manual transaction may hold', () => {
  const TODAY = '2026-10-08';
  const read = (body: Record<string, unknown>, partial = false) => input.readTxnFields(body, { partial, today: TODAY });

  test('a new one needs a date, an amount and a payee; currency, category and note have defaults', () => {
    expect(read({ date: '2026-10-05', amount: 12.5, name: '  Blue   Bottle ' })).toEqual({
      fields: { date: '2026-10-05', amount: 12.5, currency: 'USD', name: 'Blue Bottle', category: null, note: null },
    });
    expect(read({ amount: 1, name: 'x' })).toEqual({ error: 'Enter the date as YYYY-MM-DD' });
    expect(read({ date: TODAY, name: 'x' })).toEqual({ error: 'Enter an amount' });
    expect(read({ date: TODAY, amount: 1 })).toEqual({ error: 'Enter who was paid, or who paid you' });
  });

  test('each field is checked for its type, length and range', () => {
    const ok = { date: TODAY, amount: 5, name: 'Corner shop' };
    const bad: [Record<string, unknown>, string][] = [
      [{ amount: '5' }, 'Enter an amount'],
      [{ amount: NaN }, 'Enter an amount'],
      [{ amount: Infinity }, 'Enter an amount'],
      [{ amount: 0 }, 'Enter an amount other than zero'],
      [{ amount: MAX_BALANCE * 1.01 }, 'That amount is too large'],
      [{ date: '2026-02-30' }, 'That date is not a real day'],
      [{ date: '10/05/2026' }, 'Enter the date as YYYY-MM-DD'],
      [{ date: 20261005 }, 'Enter the date as YYYY-MM-DD'],
      [{ date: '1899-12-31' }, "The date can't be before 1900-01-01"],
      // After tomorrow: one day ahead is a clock in another time zone, no more.
      [{ date: '2026-10-10' }, "The date can't be in the future"],
      [{ date: '2027-10-08' }, "The date can't be in the future"],
      [{ name: '   ' }, 'Enter who was paid, or who paid you'],
      [{ name: 42 }, 'Enter who was paid, or who paid you'],
      [{ name: 'x'.repeat(101) }, 'The payee can be at most 100 characters'],
      [{ currency: 'dollars' }, 'Enter a currency as its three-letter code, like USD or EUR'],
      [{ currency: 'USX' }, 'Enter a currency as its three-letter code, like USD or EUR'],
      [{ currency: 840 }, 'Invalid currency'],
      [{ category: 7 }, 'Invalid category'],
      [{ category: 'c'.repeat(61) }, 'The category can be at most 60 characters'],
      [{ note: 'n'.repeat(501) }, 'The note can be at most 500 characters'],
      [{ note: ['a'] }, 'Invalid note'],
      // No more precise than the currency: a cent, a yen, a fils.
      [{ amount: 10.999 }, 'An amount in USD has at most 2 decimal places'],
      [{ amount: 0.001 }, 'An amount in USD has at most 2 decimal places'],
      [{ amount: 1e-7 }, 'An amount in USD has at most 2 decimal places'],
      [{ amount: 12.5, currency: 'JPY' }, 'An amount in JPY is a whole number'],
      [{ amount: 1.2345, currency: 'KWD' }, 'An amount in KWD has at most 3 decimal places'],
    ];
    for (const [over, error] of bad) expect([over, read({ ...ok, ...over })]).toEqual([over, { error }]);
    // The bounds themselves are taken.
    expect('fields' in read({ ...ok, date: '2026-10-09', amount: -MAX_BALANCE, name: 'x'.repeat(100) })).toBe(true);
    expect('fields' in read({ ...ok, date: '1900-01-01' })).toBe(true);
    expect('fields' in read({ ...ok, amount: 0.01 })).toBe(true);
    expect('fields' in read({ ...ok, amount: 3200, currency: 'JPY' })).toBe(true);
    expect('fields' in read({ ...ok, amount: 1.234, currency: 'KWD' })).toBe(true);
  });

  test('a currency has the minor unit Intl gives it', () => {
    expect(['USD', 'EUR', 'JPY', 'KWD'].map(input.minorDigits)).toEqual([2, 2, 0, 3]);
    expect(input.toMinorUnits(10.999, 'USD')).toBe(11);
    expect(input.toMinorUnits(-0.125, 'USD')).toBe(-0.13); // half away from zero
    expect(input.toMinorUnits(12.5, 'JPY')).toBe(13);
    expect(input.toMinorUnits(1.2345, 'KWD')).toBe(1.235);
  });

  test('text is tidied as the rest of the app stores it: categories lower case, empty means none', () => {
    expect(read({ date: TODAY, amount: 5, name: 'x', currency: ' eur ', category: '  Food And Drink ', note: '  for the trip ' })).toEqual({
      fields: { date: TODAY, amount: 5, currency: 'EUR', name: 'x', category: 'food and drink', note: 'for the trip' },
    });
    expect(read({ date: TODAY, amount: 5, name: 'x', category: '  ', note: '' })).toEqual({
      fields: { date: TODAY, amount: 5, currency: 'USD', name: 'x', category: null, note: null },
    });
  });

  test('an edit reads only what it carries, and null clears a category or a note', () => {
    expect(read({ amount: -20 }, true)).toEqual({ fields: { amount: -20 } });
    expect(read({ category: null, note: null }, true)).toEqual({ fields: { category: null, note: null } });
    expect(read({}, true)).toEqual({ fields: {} });
    expect(read({ date: 'tomorrow' }, true)).toEqual({ error: 'Enter the date as YYYY-MM-DD' });
  });

  test('the amount bound is a manual balance’s', () => {
    expect(input.MAX_AMOUNT).toBe(MAX_BALANCE);
  });

  test('an amount typed on any phone keypad reads as meant, and the rest reads as nothing', () => {
    const cases: [string, number | null][] = [
      ['12.50', 12.5],
      ['12,50', 12.5], // a comma-decimal keypad
      ['12,5', 12.5],
      ['1,234', 1234], // a US thousands separator
      ['1,234.56', 1234.56],
      ['1.234,56', 1234.56],
      ['1,234,567', 1234567],
      ['1.234.567', 1234567],
      [' 7 ', 7],
      ['.5', 0.5],
      ['5.', 5],
      ['0', null],
      ['', null],
      ['.', null],
      ['-5', null], // no sign: the form asks which way the money went
      ['12a', null],
      ['1.2.3,4.5', null],
      ['1e5', null],
      // A doubled or stray separator is a typo, never a hundredfold amount.
      ['12..50', null],
      ['12,,50', null],
      ['12.5.0', null],
      ['1.2.3', null],
      ['12,34,56', null],
      ['1,2,3', null],
      ['1,234.5.6', null],
      ['1.234,5,6', null],
      [',50', 0.5],
      // Rounded to the cent; nothing left is not an amount.
      ['10.999', 11],
      ['0,125', 0.13],
      ['0.001', null],
    ];
    for (const [typed, expected] of cases) expect([typed, input.parseAmountInput(typed)]).toEqual([typed, expected]);
    // In the currency's own units.
    expect(input.parseAmountInput('12.5', 'JPY')).toBe(13);
    expect(input.parseAmountInput('3,200', 'JPY')).toBe(3200);
    expect(input.parseAmountInput('0,125', 'KWD')).toBe(0.125);
  });

  test('a balance moves the way the money went: down on an account, up on what is owed', () => {
    expect(input.balanceAfter(200, 12.5, false)).toBe(187.5); // spent from cash
    expect(input.balanceAfter(200, -50, false)).toBe(250); // money in
    expect(input.balanceAfter(500, 12.5, true)).toBe(512.5); // a card purchase
    expect(input.balanceAfter(500, -100, true)).toBe(400); // a card payment
    expect(input.balanceAfter(0.1, -0.2, false)).toBe(0.3); // to the cent, no float dust
  });

  test('dates are real calendar days', () => {
    expect(input.isCalendarDay('2028-02-29')).toBe(true);
    expect(input.isCalendarDay('2026-02-29')).toBe(false);
    expect(input.isCalendarDay('2026-13-01')).toBe(false);
    expect(input.addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  test('a source is said in words on the row', () => {
    expect(input.sourceLabel('manual')).toBe('entered by hand');
    expect(input.sourceLabel('import:ofx')).toBe('imported from OFX');
    expect(input.sourceLabel('something:new')).toBe('something:new');
  });
});

describe('the store', () => {
  test('is declared on the seam: exportable, compressed, in the key inventory, inside a container only', () => {
    expect(declaredStore('manual-transactions')).toBe(manualTxnStore);
    expect(manualTxnStore.exportable).toBe(true);
    expect(classify('manual-transactions')).toBeNull(); // never outside a container
    expect(classify(`c:${ctx.container}:manual-transactions`)).toBe('hash');
  });

  test('ids are random, prefixed, and never a Plaid id', () => {
    const a = newManualTxnId();
    expect(a).toStartWith(MANUAL_TXN_PREFIX);
    expect(a).not.toBe(newManualTxnId());
    expect(isManualTxnId(a)).toBe(true);
    // Plaid's are letters and digits: never taken for a manual row's.
    expect(isManualTxnId('lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje')).toBe(false);
    expect(isManualTxnId(`${MANUAL_TXN_PREFIX}has space`)).toBe(false);
    expect(isManualTxnId(MANUAL_TXN_PREFIX)).toBe(false);
  });

  test('round trip: each account keeps its own book, a row is found, edited, moved and deleted by its id', async () => {
    const coffee = row(WALLET.account_id);
    const hotel = row(CARD.account_id, { name: 'Hotel', amount: 180 });
    await addManualTxn(ctx, coffee);
    await addManualTxn(ctx, hotel);
    expect([...(await manualTxnStore.getAll(ctx)).keys()]).toEqual([CARD.account_id, WALLET.account_id]);
    expect(await findManualTxn(ctx, coffee.id)).toEqual({ account_id: WALLET.account_id, row: coffee });

    const edited = await editManualTxn(ctx, coffee.id, { amount: 14, note: 'with a pastry' }, { now: new Date('2026-10-06T10:00:00.000Z') });
    expect(edited).toEqual({ ...coffee, amount: 14, note: 'with a pastry', updated_at: '2026-10-06T10:00:00.000Z' });
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toEqual([edited!]);

    // Moved onto the card: in its book, out of the wallet's (which goes, empty).
    const moved = await editManualTxn(ctx, coffee.id, { account_id: CARD.account_id }, { now: new Date('2026-10-07T10:00:00.000Z') });
    expect(moved).toMatchObject({ id: coffee.id, account_id: CARD.account_id, amount: 14, created_at: coffee.created_at });
    expect(await manualTxnStore.get(ctx, WALLET.account_id)).toBeNull();
    expect((await manualTxnStore.get(ctx, CARD.account_id))!.rows.map((r) => r.id)).toEqual([hotel.id, coffee.id]);

    expect(await deleteManualTxn(ctx, coffee.id)).toBe(true);
    expect(await deleteManualTxn(ctx, coffee.id)).toBe(false); // already gone
    expect(await editManualTxn(ctx, coffee.id, { amount: 1 })).toBeNull();
    expect((await manualTxnStore.get(ctx, CARD.account_id))!.rows).toEqual([hotel]);
  });

  describe('a move between accounts is one step', () => {
    test('a write that fails leaves the row where it was, once; tried again, it moves', async () => {
      const r = row(WALLET.account_id);
      await addManualTxn(ctx, r);
      atNextWrite({ fail: true });
      await expect(editManualTxn(ctx, r.id, { account_id: CARD.account_id }, { from: WALLET.account_id })).rejects.toThrow('storage blip');
      expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toEqual([r]);
      expect(await manualTxnStore.get(ctx, CARD.account_id)).toBeNull();
      const moved = await editManualTxn(ctx, r.id, { account_id: CARD.account_id }, { from: WALLET.account_id });
      expect(moved).toMatchObject({ id: r.id, account_id: CARD.account_id });
      expect(await manualTxnStore.get(ctx, WALLET.account_id)).toBeNull();
      expect((await manualTxnStore.get(ctx, CARD.account_id))!.rows.map((x) => x.id)).toEqual([r.id]);
    });

    test('a delete landing during a move is never undone', async () => {
      const r = row(WALLET.account_id);
      await addManualTxn(ctx, r);
      atNextWrite({ meanwhile: () => deleteManualTxn(ctx, r.id, WALLET.account_id) });
      expect(await editManualTxn(ctx, r.id, { account_id: CARD.account_id }, { from: WALLET.account_id })).toBeNull();
      expect(await manualTxnStore.count(ctx)).toBe(0);
    });

    test('an edit landing during a move goes with it, never lost', async () => {
      const r = row(WALLET.account_id);
      await addManualTxn(ctx, r);
      atNextWrite({ meanwhile: () => editManualTxn(ctx, r.id, { note: 'edited on the phone' }, { from: WALLET.account_id }) });
      const moved = await editManualTxn(ctx, r.id, { account_id: CARD.account_id }, { from: WALLET.account_id });
      expect(moved).toMatchObject({ account_id: CARD.account_id, note: 'edited on the phone' });
      expect((await manualTxnStore.get(ctx, CARD.account_id))!.rows).toEqual([moved!]);
      expect(await manualTxnStore.get(ctx, WALLET.account_id)).toBeNull();
    });

    test('an add sent again after its row was moved is still one row', async () => {
      const r = row(WALLET.account_id);
      await addManualTxn(ctx, r);
      await editManualTxn(ctx, r.id, { account_id: CARD.account_id });
      // The route finds it anywhere first (app/api/manual-transactions); the
      // store itself never adds an id its book already holds.
      expect((await findManualTxn(ctx, r.id))!.account_id).toBe(CARD.account_id);
    });
  });

  test('with the account a row is shown on, only that book is read', async () => {
    const r = row(WALLET.account_id);
    await addManualTxn(ctx, r);
    await fake.hset(ctxKey('manual-transactions'), { [CARD.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    expect(await editManualTxn(ctx, r.id, { note: 'read one book' }, { from: WALLET.account_id })).toMatchObject({ note: 'read one book' });
    // Not on the account named: deleted or moved meanwhile, as far as an edit can tell.
    expect(await findManualTxn(ctx, r.id, 'manual_somewhere-else')).toBeNull();
    expect(await editManualTxn(ctx, r.id, { note: 'lost' }, { from: 'manual_somewhere-else' })).toBeNull();
    expect(await deleteManualTxn(ctx, r.id, WALLET.account_id)).toBe(true);
    // A delete, though, takes the row wherever it is now: the person asked for it to go.
    const moved = row(WALLET.account_id, { name: 'Moved on another device' });
    await addManualTxn(ctx, moved);
    expect(await deleteManualTxn(ctx, moved.id, 'manual_where-it-was')).toBe(true);
    expect(await manualTxnStore.get(ctx, WALLET.account_id)).toBeNull();
  });

  test('an amount no longer whole in its currency is refused, and nothing is written', async () => {
    const r = row(WALLET.account_id); // 12.50 USD
    await addManualTxn(ctx, r);
    await expect(editManualTxn(ctx, r.id, { currency: 'JPY' })).rejects.toThrow('An amount in JPY is a whole number');
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toEqual([r]);
  });

  test('the balance an add moved is noted on its row, wherever it is now', async () => {
    const r = row(WALLET.account_id);
    await addManualTxn(ctx, r);
    await editManualTxn(ctx, r.id, { account_id: CARD.account_id });
    await noteBalanceUpdate(ctx, r.id, WALLET.account_id, { from: 200, to: 187.5 });
    expect((await findManualTxn(ctx, r.id))!.row.balance_update).toEqual({ from: 200, to: 187.5, account_id: WALLET.account_id });
    // Gone: nothing to note, no error.
    await deleteManualTxn(ctx, r.id);
    await noteBalanceUpdate(ctx, r.id, WALLET.account_id, { from: 200, to: 187.5 });
    expect(await manualTxnStore.count(ctx)).toBe(0);
  });

  test('kept encrypted and compressed: nothing a row holds is in the stored bytes', async () => {
    await addManualTxn(ctx, row(WALLET.account_id, { name: 'SECRET-PAYEE', note: 'SECRET-NOTE' }));
    const stored = fake.hashes.get(ctxKey('manual-transactions'))!.get(WALLET.account_id)!;
    expect(stored).not.toContain('SECRET');
    expect(stored).not.toContain('Blue');
  });

  test('two adds to one account at once both land', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(WALLET.account_id, { name: `Shop ${i}` }));
    await Promise.all(rows.map((r) => addManualTxn(ctx, r)));
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows.map((r) => r.name).sort()).toEqual(rows.map((r) => r.name).sort());
  });

  test('an add sent again is still one row, as first saved, and says so', async () => {
    const r = row(WALLET.account_id);
    expect(await addManualTxn(ctx, r)).toEqual({ row: r, added: true });
    expect(await addManualTxn(ctx, { ...r, amount: 13 })).toEqual({ row: r, added: false });
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toEqual([r]);
  });

  test('each container keeps its own', async () => {
    const mine = row(WALLET.account_id);
    await addManualTxn(OTHER, row(WALLET.account_id, { name: 'THEIRS' }));
    await addManualTxn(ctx, mine);
    expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toEqual([mine]);
    expect(await findManualTxn(OTHER, mine.id)).toBeNull();
    expect(await deleteManualTxn(OTHER, mine.id)).toBe(false);
    expect(await findManualTxn(ctx, mine.id)).not.toBeNull();
  });

  describe('reads are strict', () => {
    test('damaged bytes: unreadable, never an empty book, and an edit or delete is refused, leaving it as it was', async () => {
      const r = row(WALLET.account_id);
      await addManualTxn(ctx, r);
      await fake.hset(ctxKey('manual-transactions'), { [CARD.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
      await expect(manualTxnStore.getAll(ctx)).rejects.toBeInstanceOf(UnreadableEntriesError);
      // Found anyway when it is in a book that reads.
      expect(await findManualTxn(ctx, r.id)).toMatchObject({ account_id: WALLET.account_id });
      // Not found while a book can't be read: it might be there.
      const err = await findManualTxn(ctx, newManualTxnId()).catch((e) => e);
      expect(err).toBeInstanceOf(UnreadableEntriesError);
      expect(err.unreadable).toEqual([CARD.account_id]);
      expect(err.unrecognised).toEqual([]);
      await expect(deleteManualTxn(ctx, newManualTxnId())).rejects.toBeInstanceOf(UnreadableEntriesError);
      expect(fake.hashes.get(ctxKey('manual-transactions'))!.get(CARD.account_id)).toBe('not-ciphertext-but-long-enough-to-be-tried');
    });

    test('a shape this code does not know is unrecognised, never offered for removal', async () => {
      const flawed: [string, unknown][] = [
        ['another version', { version: 2, rows: [] }],
        ['rows not a list', { version: 1, rows: {} }],
        ['an amount as text', { version: 1, rows: [{ ...row(WALLET.account_id), amount: '12.50' }] }],
        ['a date that is not a day', { version: 1, rows: [{ ...row(WALLET.account_id), date: '2026-02-30' }] }],
        ['a lower-case currency', { version: 1, rows: [{ ...row(WALLET.account_id), currency: 'usd' }] }],
        ['an id that is not a manual one', { version: 1, rows: [{ ...row(WALLET.account_id), id: 'plaid-txn-1' }] }],
        ['one id twice', (() => { const r = row(WALLET.account_id); return { version: 1, rows: [r, r] }; })()],
        ['rows of two accounts', { version: 1, rows: [row(WALLET.account_id), row(CARD.account_id)] }],
      ];
      for (const [what, book] of flawed) {
        fake.reset();
        expect([what, isManualTxnBook(book)]).toEqual([what, false]);
        await fake.hset(ctxKey('manual-transactions'), { [WALLET.account_id]: await encrypt(JSON.stringify(book)) });
        const report = await manualTxnStore.getAllReport(ctx);
        expect([what, report.unreadable, report.unrecognised]).toEqual([what, [], [WALLET.account_id]]);
      }
    });

    test('fields a later release adds are kept, so a rollback still reads its rows and an edit keeps them', async () => {
      const later = { ...row(WALLET.account_id), raw: { FITID: '20261005-1' }, tags: ['trip'] };
      const book = { version: 1, rows: [later] };
      expect(isManualTxnBook(book)).toBe(true);
      await fake.hset(ctxKey('manual-transactions'), { [WALLET.account_id]: await encrypt(JSON.stringify(book)) });
      const edited = await editManualTxn(ctx, later.id, { amount: 3 });
      expect(edited).toMatchObject({ raw: { FITID: '20261005-1' }, tags: ['trip'], amount: 3 });
      expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows[0]).toMatchObject({ raw: { FITID: '20261005-1' } });
    });

    test('storage failing is an error, never no rows', async () => {
      await addManualTxn(ctx, row(WALLET.account_id));
      fake.failNext('hgetall');
      await expect(findManualTxn(ctx, newManualTxnId())).rejects.toThrow(/armed failure/);
      fake.failNext('eval');
      await expect(addManualTxn(ctx, row(WALLET.account_id))).rejects.toThrow(/armed failure/);
      expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toHaveLength(1);
    });
  });

  describe('size', () => {
    test('years of history fit: ten thousand rows, stored far under the ceiling, read back exactly', async () => {
      const start = Date.parse('2016-10-01T00:00:00Z');
      const rows = Array.from({ length: 10_000 }, (_, i) => {
        const day = new Date(start + Math.floor(i / 3) * 86_400_000).toISOString().slice(0, 10);
        return row(
          WALLET.account_id,
          {
            date: day,
            amount: Math.round(((i * 37) % 9000) + 99) / 100,
            name: ['Corner shop', 'Blue Bottle', 'Farmers market', 'Bus fare', 'Bakery'][i % 5],
            category: ['food and drink', 'transportation', 'general merchandise'][i % 3],
            source: 'import:ofx',
            source_id: `FITID-${i}`,
          },
          `${day}T12:00:00.000Z`
        );
      });
      await manualTxnStore.set(ctx, WALLET.account_id, { version: 1, rows });
      const stored = fake.hashes.get(ctxKey('manual-transactions'))!.get(WALLET.account_id)!;
      const json = JSON.stringify({ version: 1, rows }).length;
      // Rows this alike compress to about 50 characters each. Real ones (random
      // amounts and import ids) take about 100, so one account holds some
      // 80,000 under the 8,388,608 ceiling: decades of daily spending.
      expect(stored.length).toBeLessThan(json / 4);
      expect(stored.length).toBeLessThan(800_000);
      expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toEqual(rows);
      // And it still takes one more, by hand.
      await addManualTxn(ctx, row(WALLET.account_id));
      expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toHaveLength(10_001);
    });

    test('a book that would cross the ceiling is refused whole and loudly: nothing written, nothing trimmed', async () => {
      const first = row(WALLET.account_id, { note: 'kept' });
      await addManualTxn(ctx, first);
      const before = fake.hashes.get(ctxKey('manual-transactions'))!.get(WALLET.account_id);
      process.env.MAX_TXN_BLOB_CHARS = '600';
      const big = row(WALLET.account_id, { note: Array.from({ length: 40 }, (_, i) => `${i}-${crypto.randomUUID()}`).join(' ').slice(0, 500) });
      const { result, logged } = await quietly(() => addManualTxn(ctx, big));
      expect(result).toBeInstanceOf(StoredValueTooLargeError);
      expect((result as InstanceType<typeof StoredValueTooLargeError>).status).toBe(413);
      expect((result as Error).message).toStartWith('Your manual transactions are too large to save');
      expect(logged).toContain('refusing to save manual-transactions');
      delete process.env.MAX_TXN_BLOB_CHARS;
      expect(fake.hashes.get(ctxKey('manual-transactions'))!.get(WALLET.account_id)).toBe(before);
      expect((await manualTxnStore.get(ctx, WALLET.account_id))!.rows).toEqual([first]);
    });
  });

  test('deleting an account deletes its book, readable or not, and says which rows it held', async () => {
    const a = row(WALLET.account_id);
    const b = row(WALLET.account_id, { name: 'Bakery' });
    const card = row(CARD.account_id);
    for (const r of [a, b, card]) await addManualTxn(ctx, r);
    expect((await removeAccountTxns(ctx, WALLET.account_id)).sort()).toEqual([a.id, b.id].sort());
    expect(await manualTxnStore.has(ctx, WALLET.account_id)).toBe(false);
    expect(await manualTxnStore.has(ctx, CARD.account_id)).toBe(true);
    // Unreadable: deleted all the same, with no rows to name.
    await fake.hset(ctxKey('manual-transactions'), { [WALLET.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const { result } = await quietly(() => removeAccountTxns(ctx, WALLET.account_id));
    expect(result).toEqual([]);
    expect(await manualTxnStore.has(ctx, WALLET.account_id)).toBe(false);
  });
});

describe('balances stay typed', () => {
  // A manual account's balance is what was typed; rows typed beside it need
  // not add up to it. So nothing that records or estimates history reads them:
  // net worth, the daily snapshot and the estimated walk hold a manual account
  // at its typed balance, as before. (The route that adds a row moves the
  // balance only when asked: test/manual-txns-routes.test.ts.)
  test('nothing that writes or estimates history imports the manual transactions', () => {
    const root = join(import.meta.dir, '..');
    for (const file of ['lib/history.ts', 'lib/networth.ts', 'lib/snapshot-job.ts', 'lib/backfill.ts', 'app/api/backfill/route.ts', 'app/api/snapshot/route.ts', 'app/api/net-worth/route.ts']) {
      const imports = /from\s+['"][^'"]*manual-txns['"]/.test(readFileSync(join(root, file), 'utf8'));
      expect([file, imports]).toEqual([file, false]);
    }
  });
});

describe('on the Activity tab', () => {
  const ACCOUNTS = [WALLET, CARD, { ...WALLET, account_id: 'manual_wallet-2', name: 'Jar', institution_name: 'cash ' }];
  const opts = { hidden: new Set<string>(), cutoff: '2025-10-08' };

  test('each row as a transaction: the account’s name and institution, its source, its own category and payee', () => {
    const r = row(WALLET.account_id, { note: 'for the team' });
    const [t] = manualRowsForDisplay(ACCOUNTS, new Map([[WALLET.account_id, { version: 1, rows: [r] }]]), opts);
    expect(t).toEqual({
      transaction_id: r.id,
      date: '2026-10-05',
      name: 'Blue Bottle',
      amount: 12.5,
      pending: false,
      account_name: 'Wallet',
      institution_name: 'Cash',
      category: 'food and drink',
      iso_currency_code: 'USD',
      vendor_key: '', // no vendor rename applies: the payee is edited on the row
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
      source: 'manual',
      account_id: WALLET.account_id,
      note: 'for the team',
    });
  });

  test('institutions are named as the Accounts tab groups them (case and spacing aside)', () => {
    const jar = row('manual_wallet-2');
    const [t] = manualRowsForDisplay(ACCOUNTS, new Map([['manual_wallet-2', { version: 1, rows: [jar] }]]), opts);
    expect(t.institution_name).toBe('Cash');
  });

  test('newest first by date, then the most recently entered; older than the window and hidden accounts left out', () => {
    const old = row(WALLET.account_id, { date: '2025-10-07', name: 'Too old' });
    const early = row(WALLET.account_id, { date: '2026-10-05', name: 'Entered first' }, '2026-10-05T08:00:00.000Z');
    const late = row(WALLET.account_id, { date: '2026-10-05', name: 'Entered later' }, '2026-10-05T20:00:00.000Z');
    const newer = row(WALLET.account_id, { date: '2026-10-06', name: 'Next day' }, '2026-10-01T08:00:00.000Z');
    const edge = row(WALLET.account_id, { date: '2025-10-08', name: 'First day of the window' });
    const hidden = row(CARD.account_id, { name: 'On a hidden card' });
    const books = new Map([
      [WALLET.account_id, { version: 1 as const, rows: [old, early, late, newer, edge] }],
      [CARD.account_id, { version: 1 as const, rows: [hidden] }],
    ]);
    const shown = manualRowsForDisplay(ACCOUNTS, books, { hidden: new Set([CARD.account_id]), cutoff: opts.cutoff });
    expect(shown.map((t) => t.name)).toEqual(['Next day', 'Entered later', 'Entered first', 'First day of the window']);
  });

  test('a row of an account that no longer exists is not shown', () => {
    const orphan = row('manual_gone-1');
    expect(manualRowsForDisplay(ACCOUNTS, new Map([['manual_gone-1', { version: 1, rows: [orphan] }]]), opts)).toEqual([]);
  });

  test('a row left in two books by an interrupted move shows once: the copy saved last', () => {
    const r = row(WALLET.account_id);
    const moved = { ...r, account_id: CARD.account_id, updated_at: '2026-10-07T00:00:00.000Z' };
    const books = new Map([
      [CARD.account_id, { version: 1 as const, rows: [moved] }],
      [WALLET.account_id, { version: 1 as const, rows: [r] }],
    ]);
    const shown = manualRowsForDisplay(ACCOUNTS, books, opts);
    expect(shown.map((t) => [t.transaction_id, t.account_name])).toEqual([[r.id, 'Travel card']]);
  });

  test('read for the route: an account whose rows can’t be read gets a note naming it, and the rest still show', async () => {
    for (const a of [WALLET, CARD]) await saveManualAccount(ctx, a);
    const r = row(WALLET.account_id, { date: new Date().toISOString().slice(0, 10) });
    await addManualTxn(ctx, r);
    await fake.hset(ctxKey('manual-transactions'), { [CARD.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const cutoff = '2000-01-01';
    const read = await readManualTxnsForDisplay(ctx, { hidden: new Set(), cutoff });
    expect(read.txns.map((t) => t.transaction_id)).toEqual([r.id]);
    expect(read.notes).toEqual(["Credit Union: transactions entered for Travel card couldn't be read"]);
    // Hidden, it isn't shown, so nothing is said about it.
    expect((await readManualTxnsForDisplay(ctx, { hidden: new Set([CARD.account_id]), cutoff })).notes).toEqual([]);
  });

  test('read for the route: storage failing, or the accounts unreadable, is a note, never rows quietly missing', async () => {
    await saveManualAccount(ctx, WALLET);
    await addManualTxn(ctx, row(WALLET.account_id));
    const cutoff = '2000-01-01';
    fake.failNext('hgetall');
    const failed = await quietly(() => readManualTxnsForDisplay(ctx, { hidden: new Set(), cutoff }));
    expect(failed.result).toMatchObject({ txns: [], notes: [expect.stringContaining('Manual accounts: ')] });
    await fake.hset(ctxKey('manual:accounts'), { [CARD.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const unreadable = await quietly(() => readManualTxnsForDisplay(ctx, { hidden: new Set(), cutoff }));
    expect(unreadable.result).toEqual({ txns: [], notes: ["Manual accounts: couldn't be read, so transactions entered for them aren't shown"] });
  });

  test('read for the route: no manual accounts, nothing read wrong is worth a note', async () => {
    expect(await readManualTxnsForDisplay(ctx, { hidden: new Set(), cutoff: '2000-01-01' })).toEqual({ txns: [], notes: [] });
  });
});
