import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Tags and notes (#40): the tags themselves (lib/tags.ts), what the person
// puts on a transaction or takes off it and a bank row's note
// (lib/txn-annotations.ts), applied on read (lib/txn-layers.ts) for bank,
// manual and imported rows alike, deleting a tag in a sequence that can't
// leave half a state (lib/tag-delete.ts), and everything said about a
// transaction pruned with it after a sync and carried across a re-link.

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// The real ceiling on a stored value: a file run before this one may have
// lowered it for its own tests (lib/blob.ts reads it on every write).
delete process.env.MAX_TXN_BLOB_CHARS;

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

// Each Item's transactions, by access token, as Plaid would send them; what a
// later sync says the bank removed.
const plaidTxns: Record<string, any[]> = {};
const plaidRemoved: Record<string, string[]> = {};
const plaidAccounts: Record<string, any[]> = {};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async (req: any) => ({
      data: {
        added: req.cursor ? [] : (plaidTxns[req.access_token] ?? []),
        modified: [],
        removed: req.cursor ? (plaidRemoved[req.access_token] ?? []).map((transaction_id) => ({ transaction_id })) : [],
        accounts: plaidAccounts[req.access_token] ?? [],
        next_cursor: 'c1',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
    accountsGet: async (req: any) => ({ data: { accounts: plaidAccounts[req.access_token] ?? [] } }),
    itemRemove: async () => ({ data: {} }),
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const links = await import('@/lib/links');
const { rememberAccounts } = await import('@/lib/last-known');
const tags = await import('@/lib/tags');
const ann = await import('@/lib/txn-annotations');
const { applyLayers } = await import('@/lib/txn-layers');
const { deleteTag, finishDeleting } = await import('@/lib/tag-delete');
const { saveManualAccount } = await import('@/lib/manual');
const { addManualTxn, newManualTxn, manualTxnStore } = await import('@/lib/manual-txns');
const { UnreadableValueError } = await import('@/lib/repo');

const account = (id: string) => ({
  account_id: id,
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask: '4821',
  balances: { available: 100, current: 100, limit: null, iso_currency_code: 'USD' },
});
const row = (id: string, account_id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  account_id,
  amount: 4.5,
  iso_currency_code: 'USD',
  date: daysAgo(3),
  name: 'BLUE BOTTLE',
  merchant_name: 'Blue Bottle',
  pending: false,
  counterparties: [],
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
  ...over,
});

/** An Item as it is after a successful load: stored, remembered, in the directory. */
async function addItem(item_id: string, account_id: string, txns: any[], seenOn = Date.now()) {
  const token = `token-${item_id}`;
  plaidTxns[token] = txns;
  plaidAccounts[token] = [account(account_id)];
  await fake.hset(ctxKey('plaid:items'), {
    [item_id]: JSON.stringify({ item_id, institution_name: 'Chase', encrypted_access_token: await encrypt(token) }),
  });
  const inst = { item_id, institution_name: 'Chase', institution_id: 'ins_3', error: null, accounts: [{ ...account(account_id), balance: 100 }] };
  await rememberAccounts(ctx, [inst as any]);
  await links.recordDirectory(ctx, [inst as any], seenOn);
}

const route = async (path: string, method: string, body?: unknown, raw?: string) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const url = `http://x/api/${path}${method === 'GET' ? '?refresh=1' : ''}`;
  const res = await mod[method](new Request(url, { method, body: raw ?? (body ? JSON.stringify(body) : undefined) }));
  return { status: res.status, body: await res.json() };
};
const listed = async () => (await route('transactions', 'GET')).body;
const rowOf = async (id: string) => (await listed()).transactions.find((t: any) => t.transaction_id === id);
const annotate = (body: Record<string, unknown>) => route('transaction-annotations', 'PATCH', body);
const tagAction = (body: Record<string, unknown>) => route('tags', 'POST', body);
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};

beforeEach(async () => {
  fake.reset();
  for (const k of Object.keys(plaidRemoved)) delete plaidRemoved[k];
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

/** A tag made through the route, by name. */
async function made(name: string, color?: string): Promise<string> {
  const r = await tagAction({ action: 'add', name, ...(color ? { color } : {}) });
  expect(r.status).toBe(200);
  return r.body.created;
}

describe('the tags', () => {
  const newSet = () => tags.emptyTagSet();
  let n = 0;
  const id = () => `tag${++n}`;

  test('a name is one tag in any case, and names and counts stay within their limits', () => {
    const a = tags.addTag(newSet(), { name: '  Vacation   2026 ' }, id);
    expect(a.tag.name).toBe('Vacation 2026');
    expect(() => tags.addTag(a.set, { name: 'vacation 2026' }, id)).toThrow('There is already a tag named Vacation 2026.');
    for (const bad of ['', '   ', 7, null, 'x'.repeat(tags.TAG_NAME_MAX + 1), 'tab\u0001']) {
      expect(() => tags.addTag(newSet(), { name: bad }, id)).toThrow(tags.TagError);
    }
    expect(() => tags.addTag(newSet(), { name: 'Work', color: 'chartreuse' }, id)).toThrow('A tag\'s color is one of');
    let full = newSet();
    for (let i = 0; i < tags.MAX_TAGS; i++) full = tags.addTag(full, { name: `t${i}` }, id).set;
    try {
      tags.addTag(full, { name: 'one more' }, id);
      throw new Error('not refused');
    } catch (err: any) {
      expect([err.name, err.status]).toEqual(['TagError', 409]);
    }
  });

  test('a new tag gets the next color unless one is chosen, and a later color reads, shown as the first', () => {
    const one = tags.addTag(newSet(), { name: 'a' }, id);
    const two = tags.addTag(one.set, { name: 'b' }, id);
    expect(one.tag.color).not.toBe(two.tag.color);
    expect(tags.addTag(newSet(), { name: 'c', color: 'pink' }, id).tag.color).toBe('pink');
    expect(tags.shownColor('ultraviolet')).toBe('gray');
  });

  test('renaming checks the name against every other tag, in any case, and finds the tag by id', () => {
    const a = tags.addTag(newSet(), { name: 'Work' }, id);
    const b = tags.addTag(a.set, { name: 'Gift' }, id);
    expect(() => tags.renameTag(b.set, b.tag.id, 'WORK')).toThrow('There is already a tag named Work.');
    expect(tags.renameTag(b.set, a.tag.id, 'WORK').tags[0].name).toBe('WORK');
    try {
      tags.renameTag(b.set, 'gone', 'x');
      throw new Error('not refused');
    } catch (err: any) {
      expect(err.status).toBe(404);
    }
  });

  test('the stored shape: what a later release adds rides along, and ids are never repeated', () => {
    const set = { version: 1, tags: [{ id: 'a', name: 'A', color: 'red', created_at: '2026-10-01T00:00:00.000Z', icon: 'x' }], later: true };
    expect(tags.isTagSet(set)).toBe(true);
    expect(tags.isTagSet({ ...set, tags: [set.tags[0], set.tags[0]] })).toBe(false);
    expect(tags.isTagSet({ ...set, version: 2 })).toBe(false);
    expect(tags.isTagSet({ ...set, deleting: ['a b'] })).toBe(false);
  });

  test('a list that can’t be read is never read as none: an edit is refused, and the display read says so', async () => {
    await fake.set(ctxKey('tags'), 'not-ciphertext-but-long-enough-to-be-tried');
    await expect(tags.readTagSet(ctx)).rejects.toBeInstanceOf(UnreadableValueError);
    await expect(tags.changeTagSet(ctx, (s) => s)).rejects.toBeInstanceOf(UnreadableValueError);
    expect(await fake.get<string>(ctxKey('tags'))).toBe('not-ciphertext-but-long-enough-to-be-tried');
    const shown = await quietly(() => tags.tagsForDisplay(ctx));
    expect(shown).toEqual({ set: null, note: "Your tags couldn't be read, so transactions show without them until they can be." });
  });

  test('that note is for what shows tags: the Activity tab has it, a report’s gaps don’t', async () => {
    await addItem('item_a', 'acct_a', [row('t_a', 'acct_a')]);
    await fake.set(ctxKey('tags'), 'not-ciphertext-but-long-enough-to-be-tried');
    const note = "Your tags couldn't be read, so transactions show without them until they can be.";
    expect((await quietly(() => listed())).notes).toContain(note);
    const { assembleBankRows, finishActivity } = await import('@/lib/activity');
    const bank = await assembleBankRows(ctx, { sync: false, readOnly: true });
    const read = await quietly(() => finishActivity(ctx, bank.payload, bank.hidden));
    expect([read.notes.includes(note), read.tags_note]).toEqual([false, note]);
  });
});

describe('the tags route', () => {
  test('makes, renames, recolors and deletes, answering the tags each time', async () => {
    expect((await route('tags', 'GET')).body).toEqual({ tags: { version: 1, tags: [] }, counts: {} });
    const work = await made('Work', 'blue');
    const r = await tagAction({ action: 'rename', id: work, name: 'Day job' });
    expect(r.status).toBe(200);
    expect(r.body.tags.tags).toEqual([{ id: work, name: 'Day job', color: 'blue', created_at: expect.any(String) }]);
    expect((await tagAction({ action: 'recolor', id: work, color: 'green' })).body.tags.tags[0].color).toBe('green');
    expect((await tagAction({ action: 'delete', id: work })).body.tags).toEqual({ version: 1, tags: [] });
  });

  test('refuses what it can’t do, saying why, with the status the seam’s rules give', async () => {
    const work = await made('Work');
    const cases: [unknown, number, string][] = [
      [{ action: 'add', name: 'work' }, 409, 'There is already a tag named Work.'],
      [{ action: 'add', name: '' }, 400, 'Give the tag a name.'],
      [{ action: 'rename', id: 'nope', name: 'x' }, 404, 'That tag no longer exists. Reload to see your tags as they are.'],
      [{ action: 'delete', id: 'nope' }, 404, 'That tag no longer exists. Reload to see your tags as they are.'],
      [{ action: 'recolor', id: work, color: 'plaid' }, 400, expect.stringContaining('A tag\'s color is one of')],
      [{ action: 'shout' }, 400, 'Invalid request'],
      [[1, 2], 400, 'Invalid request'],
    ] as any;
    for (const [body, status, error] of cases) expect([body, await tagAction(body as any)]).toEqual([body, { status, body: { error } }]);
    expect(await route('tags', 'POST', undefined, 'not json')).toEqual({ status: 400, body: { error: 'Invalid request' } });
    expect((await route('tags', 'POST', undefined, JSON.stringify({ action: 'add', name: 'x'.repeat(5000) }))).status).toBe(413);
  });

  test('stored tags that can’t be read answer 409, flagged, and are left as they are', async () => {
    await fake.set(ctxKey('tags'), 'not-ciphertext-but-long-enough-to-be-tried');
    for (const r of [await quietly(() => route('tags', 'GET')), await quietly(() => tagAction({ action: 'add', name: 'Work' }))]) {
      expect(r.status).toBe(409);
      expect(r.body.unreadable).toBe(true);
    }
    expect(await fake.get<string>(ctxKey('tags'))).toBe('not-ciphertext-but-long-enough-to-be-tried');
  });

  test('a change that keeps losing its compare-and-set answers 409; no container answers 503', async () => {
    const real = fake.eval.bind(fake);
    // Every compare-and-set finds the value changed.
    fake.eval = (async (script: string, keys: string[], args: string[]) => (script.includes('nya:repo-update-value') ? 0 : real(script, keys, args))) as typeof fake.eval;
    try {
      const r = await tagAction({ action: 'add', name: 'Work' });
      expect(r.status).toBe(409);
      expect(r.body.error).toContain('kept changing');
    } finally {
      fake.eval = real;
    }
    fake.reset();
    (await import('@/lib/sessions')).forgetEpochs();
    expect((await quietly(() => route('tags', 'GET'))).status).toBe(503);
  });

  test('each container keeps its own', async () => {
    await made('Work');
    expect(await tags.readTagSet(OTHER)).toBeNull();
  });
});

describe('tags and notes on transactions', () => {
  const ACCOUNT = 'manual_6b1f3e2a-1c4d-4e5f-8a9b-0c1d2e3f4a5b';
  let manualId = '';
  let importedId = '';
  const seed = async () => {
    await addItem('item_a', 'acct_a', [row('t_a', 'acct_a'), row('t_b', 'acct_a', { amount: 9, date: daysAgo(4) })]);
    await saveManualAccount(ctx, { account_id: ACCOUNT, name: 'Cash', institution_name: 'Wallet', type: 'depository', subtype: 'cash', balance: 50 } as any);
    const typed = newManualTxn(ACCOUNT, { date: daysAgo(2), name: 'Farmers market', amount: 20, currency: 'USD', category: null, note: null });
    const imported = { ...newManualTxn(ACCOUNT, { date: daysAgo(2), name: 'POS 1234 BAKERY', amount: 7, currency: 'USD', category: null, note: 'from the file' }), source: 'import:csv', source_id: 'k1' };
    await addManualTxn(ctx, typed);
    await addManualTxn(ctx, imported);
    manualId = typed.id;
    importedId = imported.id;
  };

  test('any row can carry several tags, a tag typed is found or made, and the answer names every tag', async () => {
    await seed();
    const r = await annotate({ transaction_id: 't_a', new_tag: 'Reimbursable' });
    expect(r.status).toBe(200);
    const reimb = r.body.created_tag.id;
    // Typed again in another case: the same tag, not a second one.
    const again = await annotate({ transaction_id: manualId, new_tag: 'reimbursable' });
    expect(again.body.created_tag).toBeUndefined();
    expect(again.body.tags).toEqual([reimb]);
    const work = await made('Work');
    expect((await annotate({ transaction_id: 't_a', add_tags: [work] })).body.tags).toEqual([reimb, work]);
    await annotate({ transaction_id: importedId, add_tags: [work] });

    const body = await listed();
    expect(body.tags.map((t: any) => t.name)).toEqual(['Reimbursable', 'Work']);
    const tagsOf = (id: string) => body.transactions.find((t: any) => t.transaction_id === id)?.tags;
    expect(tagsOf('t_a')).toEqual([reimb, work]);
    expect(tagsOf(manualId)).toEqual([reimb]);
    expect(tagsOf(importedId)).toEqual([work]);
    expect(tagsOf('t_b')).toBeUndefined();
    // Nothing the read assembles with is ever sent.
    for (const t of body.transactions) for (const k of ['account_ref', 'renamed_from', 'carried', 'own_name']) expect(k in t).toBe(false);
  });

  test('a row brought in from SimpleFIN is tagged and noted like a bank’s: the note beside it, the row as the bank gave it', async () => {
    await seed();
    const pulled = { ...newManualTxn(ACCOUNT, { date: daysAgo(1), name: 'SIMPLEFIN ROW', amount: 3, currency: 'USD', category: null, note: null }), source: 'simplefin', source_id: 'sf-1' };
    await addManualTxn(ctx, pulled);
    const r = await annotate({ transaction_id: pulled.id, account_id: ACCOUNT, new_tag: 'Work', note: 'pulled in' });
    expect(r.status).toBe(200);
    expect(r.body.note).toBe('pulled in');
    expect(await rowOf(pulled.id)).toMatchObject({ source: 'simplefin', tags: [r.body.created_tag.id], note: 'pulled in' });
    // Kept beside the row, as a bank row's note is; the row stays the bank's.
    expect((await ann.txnAnnotationStore.get(ctx, pulled.id))!.note).toBe('pulled in');
    expect((await manualTxnStore.get(ctx, ACCOUNT))!.rows.find((x) => x.id === pulled.id)!.note).toBeNull();
    // Cleared, it is gone; and its payee is the bank's, which an edit can't change.
    expect((await annotate({ transaction_id: pulled.id, account_id: ACCOUNT, note: '' })).status).toBe(200);
    expect((await rowOf(pulled.id)).note).toBeNull();
    const renamed = await route('manual-transactions', 'PATCH', { id: pulled.id, account_id: ACCOUNT, name: 'My name for it' });
    expect(renamed.status).toBe(400);
    // A row entered by hand keeps its note on the row, as before.
    expect((await annotate({ transaction_id: manualId, account_id: ACCOUNT, note: 'cash' })).status).toBe(200);
    expect((await manualTxnStore.get(ctx, ACCOUNT))!.rows.find((x) => x.id === manualId)!.note).toBe('cash');
    expect((await ann.txnAnnotationStore.get(ctx, manualId))?.note).toBeUndefined();
  });

  test('tags persist across a resync and a cache clear', async () => {
    await seed();
    const work = await made('Work');
    await annotate({ transaction_id: 't_a', add_tags: [work] });
    expect((await rowOf('t_a')).tags).toEqual([work]);
    await route('transactions', 'GET'); // ?refresh=1: synced again
    const { clearCaches } = await import('@/lib/cache');
    await clearCaches(ctx);
    expect((await rowOf('t_a')).tags).toEqual([work]);
  });

  test('a tag taken off is off, and a deleted one is never shown, filtered or put back', async () => {
    await seed();
    const work = await made('Work');
    await annotate({ transaction_id: 't_a', add_tags: [work] });
    expect((await annotate({ transaction_id: 't_a', remove_tags: [work] })).body).toMatchObject({ tags: [], untagged: [work] });
    expect((await rowOf('t_a')).tags).toBeUndefined();
    await annotate({ transaction_id: 't_a', add_tags: [work] });
    await tagAction({ action: 'delete', id: work });
    expect((await rowOf('t_a')).tags).toBeUndefined();
    // A page loaded before the deletion can't put it back.
    expect(await annotate({ transaction_id: 't_b', add_tags: [work] })).toEqual({
      status: 404,
      body: { error: 'That tag no longer exists. Reload to see your tags as they are.' },
    });
  });

  test('a bank row’s note is kept beside it; a manual or imported row’s is its own, so a row never has two', async () => {
    await seed();
    expect((await annotate({ transaction_id: 't_a', note: '  Team lunch, paid back  ' })).body.note).toBe('Team lunch, paid back');
    expect((await annotate({ transaction_id: importedId, account_id: ACCOUNT, note: 'Birthday cake' })).body.note).toBe('Birthday cake');
    // Written on the row itself, where its edit form, the download and the CSV read it.
    const book = await manualTxnStore.get(ctx, ACCOUNT);
    expect(book!.rows.find((r) => r.id === importedId)!.note).toBe('Birthday cake');
    expect(await ann.txnAnnotationStore.has(ctx, importedId)).toBe(false);
    const body = await listed();
    const noteOf = (id: string) => body.transactions.find((t: any) => t.transaction_id === id)?.note;
    expect([noteOf('t_a'), noteOf(importedId), noteOf(manualId), noteOf('t_b')]).toEqual(['Team lunch, paid back', 'Birthday cake', null, undefined]);
    // Cleared: an empty note is kept for a bank row, and the row shows none.
    await annotate({ transaction_id: 't_a', note: '' });
    expect((await ann.txnAnnotationStore.get(ctx, 't_a'))!.note).toBe('');
    expect((await rowOf('t_a')).note).toBeUndefined();
    await annotate({ transaction_id: importedId, account_id: ACCOUNT, note: '' });
    expect((await rowOf(importedId)).note).toBeNull();
  });

  test('what it is told is checked strictly before anything is saved', async () => {
    await seed();
    const work = await made('Work');
    const cases: [Record<string, unknown>, number, string][] = [
      [{ transaction_id: 't_a' }, 400, 'Say what to change'],
      [{ transaction_id: 'has space', note: 'x' }, 400, 'Invalid transaction id'],
      [{ transaction_id: 'manual-txn:', note: 'x' }, 400, 'Invalid transaction id'],
      [{ transaction_id: 't_a', note: 7 }, 400, 'A note is text.'],
      [{ transaction_id: 't_a', note: 'x'.repeat(501) }, 400, 'A note can be at most 500 characters.'],
      [{ transaction_id: 't_a', note: 'bell\u0007' }, 400, 'A note can’t hold control characters.'],
      [{ transaction_id: 't_a', add_tags: 'Work' }, 400, 'Invalid tags to put on'],
      [{ transaction_id: 't_a', add_tags: ['has space'] }, 400, 'Invalid tags to put on'],
      [{ transaction_id: 't_a', remove_tags: Array(21).fill(work) }, 400, 'Invalid tags to take off'],
      [{ transaction_id: 't_a', new_tag: 3 }, 400, 'Invalid tag name'],
      [{ transaction_id: 't_a', new_tag: '' }, 400, 'Give the tag a name.'],
      [{ transaction_id: 't_a', excluded: 'yes' }, 400, 'Say whether to exclude it'],
      [{ transaction_id: manualId, account_id: 'acct_a', note: 'x' }, 400, 'Invalid account id'],
      [{ transaction_id: 'manual-txn:00000000-0000-4000-8000-0000000000ff', account_id: ACCOUNT, note: 'x' }, 404, 'That transaction was deleted or moved since this page loaded. Reload to see it.'],
    ];
    for (const [body, status, error] of cases) expect([body, await annotate(body)]).toEqual([body, { status, body: { error } }]);
    expect(await ann.txnAnnotationStore.count(ctx)).toBe(0);
    expect((await route('transaction-annotations', 'PATCH', undefined, JSON.stringify({ transaction_id: 't_a', note: 'x'.repeat(9000) }))).status).toBe(413);
  });

  test('a tag taken off that no longer exists changes nothing; one being deleted comes off a record, one this change never saw stays', async () => {
    await seed();
    const [work, home] = [await made('Work'), await made('Home')];
    await annotate({ transaction_id: 't_a', add_tags: [work, home] });
    await annotate({ transaction_id: 't_b', remove_tags: [work] });
    // A record holding a tag being deleted, and one made a moment ago on
    // another device that this request's read of the tags doesn't have.
    await ann.txnAnnotationStore.set(ctx, 't_a', { tags: [work, home, 'gone-tag', 'new-elsewhere'], untagged: ['gone-too'], updated_at: '2026-10-01T00:00:00.000Z' });
    await tags.changeTagSet(ctx, (s) => ({ ...s, deleting: ['gone-tag', 'gone-too'] }));
    const r = await annotate({ transaction_id: 't_a', remove_tags: ['never-a-tag', home] });
    expect(r.status).toBe(200);
    expect([r.body.tags, r.body.untagged]).toEqual([[work, 'new-elsewhere'], [home]]);
    expect((await annotate({ transaction_id: 't_b', remove_tags: ['never-a-tag'] })).status).toBe(200);
    expect((await ann.txnAnnotationStore.get(ctx, 't_b'))!.untagged).toEqual([work]);
  });

  test('two changes to one transaction’s tags at the same moment both land, a tag made for one among them', async () => {
    await seed();
    const [work, home] = [await made('Work'), await made('Home')];
    // Two devices at once, each a compare-and-set on the record: neither loses the other's.
    const both = await Promise.all([annotate({ transaction_id: 't_a', add_tags: [work] }), annotate({ transaction_id: 't_a', add_tags: [home] })]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect([...(await ann.txnAnnotationStore.get(ctx, 't_a'))!.tags!].sort()).toEqual([work, home].sort());
    // One reads the tags; meanwhile the other makes a tag and puts it on; the
    // first lands after. What it read never takes the new tag back off.
    const read = await tags.readTagSet(ctx);
    const made2 = await annotate({ transaction_id: 't_b', new_tag: 'Trip' });
    const trip = made2.body.created_tag.id;
    expect(tags.liveTagIds(read).has(trip)).toBe(false);
    await ann.changeAnnotation(ctx, 't_b', { add: [work], gone: new Set(read?.deleting ?? []) });
    expect((await ann.txnAnnotationStore.get(ctx, 't_b'))!.tags).toEqual([trip, work]);
  });

  test('a record keeps at most so many tags taken off; a deletion that raced a change is taken back off', async () => {
    const ids = Array.from({ length: ann.MAX_UNTAGGED + 1 }, (_, i) => `tag-${i}`);
    const full = { untagged: ids.slice(0, ann.MAX_UNTAGGED), updated_at: '2026-10-01T00:00:00.000Z' };
    expect(() => ann.changedRecord(full, { remove: [`tag-${ann.MAX_UNTAGGED}`] }, new Date())).toThrow(ann.AnnotationError);
    // A tag being deleted makes room.
    expect(ann.changedRecord(full, { remove: [`tag-${ann.MAX_UNTAGGED}`], gone: new Set(['tag-0']) }, new Date()).untagged).toHaveLength(ann.MAX_UNTAGGED);
    await ann.txnAnnotationStore.set(ctx, 't_x', { tags: ['kept', 'raced'], updated_at: '2026-10-01T00:00:00.000Z' });
    expect((await ann.stripTags(ctx, 't_x', ['raced']))!.tags).toEqual(['kept']);
    await ann.txnAnnotationStore.set(ctx, 't_y', { tags: ['raced'], updated_at: '2026-10-01T00:00:00.000Z' });
    expect(await ann.stripTags(ctx, 't_y', ['raced'])).toBeNull();
    expect(await ann.txnAnnotationStore.get(ctx, 't_y')).toBeNull();
  });

  test('at most so many tags by hand on one transaction', async () => {
    await seed();
    const ids: string[] = [];
    for (let i = 0; i < tags.MAX_TAGS_PER_TRANSACTION + 1; i++) ids.push(await made(`t${i}`));
    expect((await annotate({ transaction_id: 't_a', add_tags: ids.slice(0, tags.MAX_TAGS_PER_TRANSACTION) })).status).toBe(200);
    expect(await annotate({ transaction_id: 't_a', add_tags: [ids[tags.MAX_TAGS_PER_TRANSACTION]] })).toEqual({
      status: 400,
      body: { error: `A transaction can carry at most ${tags.MAX_TAGS_PER_TRANSACTION} tags put on by hand.` },
    });
  });

  test('a record that can’t be read is refused, never replaced, and its row is marked, not dropped', async () => {
    await seed();
    await fake.hset(ctxKey('transaction-annotations'), { t_a: 'not-ciphertext-but-long-enough-to-be-tried' });
    const r = await quietly(() => annotate({ transaction_id: 't_a', note: 'x' }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ unreadable: true, unreadable_ids: ['t_a'] });
    expect((await rowOf('t_a')).excluded).toBeNull();
  });

  test('each container keeps its own', async () => {
    await seed();
    await annotate({ transaction_id: 't_a', note: 'mine' });
    expect(await ann.txnAnnotationStore.has(OTHER, 't_a')).toBe(false);
  });
});

describe('what is said about a transaction, applied in layers', () => {
  const set = { version: 1 as const, tags: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase(), color: 'red', created_at: '2026-10-01T00:00:00.000Z' })) };
  const base = (over: Record<string, unknown> = {}): any => ({ transaction_id: 't1', pending: false, name: 'X', amount: 1, ...over });
  const at = '2026-10-01T00:00:00.000Z';

  test('the row’s own record wins field by field over what was carried; tags layer, the person’s last', () => {
    const t = base({ excluded: true, carried: { tags: ['a', 'b'], note: 'carried note' } });
    applyLayers([t], { records: new Map([['t1', { untagged: ['a'], tags: ['c'], updated_at: at }]]), unknown: new Set(), tags: set });
    // The carried exclusion stands (nothing said on the row); a taken off, c put on.
    expect(t).toMatchObject({ excluded: true, tags: ['b', 'c'], note: 'carried note' });
    expect('carried' in t).toBe(false);

    const u = base({ excluded: true, carried: { note: 'carried note' } });
    applyLayers([u], { records: new Map([['t1', { excluded: false, note: '', updated_at: at }]]), unknown: new Set(), tags: set });
    expect(u.excluded).toBeUndefined();
    expect(u.note).toBeUndefined();
  });

  test('a carried include beats nothing said; a record that can’t be read is unknown, never excluded', () => {
    const t = base({ carried: { excluded: false } });
    applyLayers([t], { records: new Map(), unknown: new Set(), tags: set });
    expect(t.excluded).toBeUndefined();
    const u = base({ excluded: true });
    applyLayers([u], { records: new Map(), unknown: new Set(['t1']), tags: set });
    expect(u.excluded).toBeNull();
  });

  test('only tags that exist show, in the order they were made; with no tags readable, none show', () => {
    const t = base();
    applyLayers([t], { records: new Map([['t1', { tags: ['d', 'gone', 'a'], updated_at: at }]]), unknown: new Set(), tags: set });
    expect(t.tags).toEqual(['a', 'd']);
    const u = base();
    applyLayers([u], { records: new Map([['t1', { tags: ['a'], updated_at: at }]]), unknown: new Set(), tags: null });
    expect(u.tags).toBeUndefined();
  });

  test('a manual row’s note is its own; what a bank row’s record says is never put on it', () => {
    const t = base({ source: 'manual', note: 'typed with it' });
    applyLayers([t], { records: new Map([['t1', { note: 'record', updated_at: at }]]), unknown: new Set(), tags: set });
    expect(t.note).toBe('typed with it');
  });
});

describe('deleting a tag', () => {
  test('takes it off every transaction and every carried record; a record left with nothing goes', async () => {
    const work = (await tags.ensureTag(ctx, { name: 'Work' })).tag.id;
    const gift = (await tags.ensureTag(ctx, { name: 'Gift' })).tag.id;
    await ann.changeTags(ctx, 't_a', { add: [work, gift] });
    await ann.changeTags(ctx, 't_b', { add: [work] });
    await ann.setExcluded(ctx, 't_c', true);
    await ann.changeTags(ctx, 't_c', { remove: [work] });
    await ann.carriedAnnotationStore.set(ctx, 'acct_old', { version: 1, rows: { k1: { tags: [work] }, k2: { tags: [work, gift] }, k3: null } });

    const done = await deleteTag(ctx, work);
    expect(done.set.tags.map((t) => t.name)).toEqual(['Gift']);
    expect(done.set.deleting).toBeUndefined();
    expect((await ann.txnAnnotationStore.get(ctx, 't_a'))!.tags).toEqual([gift]);
    expect(await ann.txnAnnotationStore.has(ctx, 't_b')).toBe(false);
    expect(await ann.txnAnnotationStore.get(ctx, 't_c')).toMatchObject({ excluded: true });
    expect((await ann.txnAnnotationStore.get(ctx, 't_c'))!.untagged).toBeUndefined();
    expect((await ann.carriedAnnotationStore.get(ctx, 'acct_old'))!.rows).toEqual({ k2: { tags: [gift] }, k3: null });
  });

  test('cut off part way, nothing shows it meanwhile, and the next change finishes it; a tag made meanwhile is never swept', async () => {
    await addItem('item_a', 'acct_a', [row('t_a', 'acct_a'), row('t_b', 'acct_a', { amount: 9 })]);
    const work = await made('Work');
    await annotate({ transaction_id: 't_a', add_tags: [work] });
    await annotate({ transaction_id: 't_b', add_tags: [work] });
    // The sweep's compare-and-sets fail: the tag is out of the list, noted.
    const real = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.includes('nya:repo-update-entry')) throw new Error('storage went away');
      return real(script, keys, args);
    }) as typeof fake.eval;
    try {
      expect((await quietly(() => tagAction({ action: 'delete', id: work }))).status).toBe(500);
    } finally {
      fake.eval = real;
    }
    expect((await tags.readTagSet(ctx))!.deleting).toEqual([work]);
    // Still on the records, and on no row.
    expect((await ann.txnAnnotationStore.get(ctx, 't_a'))!.tags).toEqual([work]);
    expect((await rowOf('t_a')).tags).toBeUndefined();
    // Another device makes a tag and puts it on a row before the sweep resumes.
    const gift = (await tags.ensureTag(ctx, { name: 'Gift' })).tag.id;
    await ann.changeTags(ctx, 't_b', { add: [gift] });
    // The next change to the tags finishes the deletion first.
    await made('Home');
    expect((await tags.readTagSet(ctx))!.deleting).toBeUndefined();
    expect(await ann.txnAnnotationStore.has(ctx, 't_a')).toBe(false);
    expect((await ann.txnAnnotationStore.get(ctx, 't_b'))!.tags).toEqual([gift]);
    expect((await rowOf('t_b')).tags).toEqual([gift]);
  });

  test('a record that can’t be read is left as it is; nothing finishes what was never begun', async () => {
    const work = (await tags.ensureTag(ctx, { name: 'Work' })).tag.id;
    await fake.hset(ctxKey('transaction-annotations'), { t_x: 'damaged-damaged-damaged-damaged' });
    await deleteTag(ctx, work);
    expect(await fake.hget<string>(ctxKey('transaction-annotations'), 't_x')).toBe('damaged-damaged-damaged-damaged');
    expect((await finishDeleting(ctx)).transactions).toBe(0);
  });
});

describe('gone with its transaction, carried across a re-link', () => {
  test('a sync that saves the bank’s removal of a row takes its tags and note with it', async () => {
    await addItem('item_a', 'acct_a', [row('t_a', 'acct_a'), row('t_b', 'acct_a', { amount: 9 })]);
    await route('transactions', 'GET');
    const work = await made('Work');
    await annotate({ transaction_id: 't_a', add_tags: [work], note: 'gone soon' });
    await annotate({ transaction_id: 't_b', note: 'stays' });
    plaidRemoved['token-item_a'] = ['t_a'];
    await route('transactions', 'GET');
    expect(await ann.txnAnnotationStore.has(ctx, 't_a')).toBe(false);
    expect((await ann.txnAnnotationStore.get(ctx, 't_b'))!.note).toBe('stays');
  });

  const relinked = async (oldRows: any[], newRows: any[]) => {
    await addItem('item_old', 'acct_old', oldRows, Date.now() - DAY);
    await route('transactions', 'GET');
    return async () => {
      expect((await route('disconnect', 'POST', { item_id: 'item_old' })).status).toBe(200);
      await addItem('item_new', 'acct_new', newRows);
      await route('transactions', 'GET');
    };
  };

  test('tags put on and taken off, and a note, carry once the person links the accounts, and unlinking undoes it', async () => {
    const readd = await relinked([row('t_a', 'acct_old'), row('t_b', 'acct_old', { amount: 9 })], [row('n_a', 'acct_new'), row('n_b', 'acct_new', { amount: 9 })]);
    const work = await made('Work');
    const gift = await made('Gift');
    await annotate({ transaction_id: 't_a', add_tags: [work, gift], note: 'Team lunch' });
    await annotate({ transaction_id: 't_a', remove_tags: [gift] });
    await readd();
    // Not the same account until the person says so.
    expect((await rowOf('n_a')).tags).toBeUndefined();
    expect((await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' })).status).toBe(200);
    expect(await rowOf('n_a')).toMatchObject({ tags: [work], note: 'Team lunch' });
    expect((await rowOf('n_b')).tags).toBeUndefined();
    // What the person says on the new row goes on top: a tag put on keeps the carried one.
    await annotate({ transaction_id: 'n_a', add_tags: [gift], note: '' });
    expect(await rowOf('n_a')).toMatchObject({ tags: [work, gift] });
    expect((await rowOf('n_a')).note).toBeUndefined();
    await route('account-links', 'DELETE', { old: 'acct_old' });
    expect((await rowOf('n_a')).tags).toEqual([gift]);
  });

  test('identical rows tagged one way and not the other carry nothing, rather than guess', async () => {
    const readd = await relinked([row('t_a', 'acct_old'), row('t_a2', 'acct_old')], [row('n_a', 'acct_new')]);
    const work = await made('Work');
    await annotate({ transaction_id: 't_a', add_tags: [work] });
    await readd();
    await route('account-links', 'POST', { action: 'link', old: 'acct_old', to: 'acct_new' });
    expect((await rowOf('n_a')).tags).toBeUndefined();
  });
});
