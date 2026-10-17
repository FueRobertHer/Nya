import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The routes for account lifecycle and timeline notes (#50): every field
// checked, the seam's errors answered by its rules (409 unreadable with the
// ids, 409 or 413 refused, 503 without a container, 500 otherwise), and the
// prompt to remove a connection whose last open account ended.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { rememberAccounts } = await import('@/lib/last-known');
const { saveManualAccount } = await import('@/lib/manual');
const { setAccountHidden } = await import('@/lib/hidden');
const { linkAccounts, recordDirectory } = await import('@/lib/links');
const { lifecycleStore, markEnded } = await import('@/lib/lifecycle');
const { timelineNotesStore, autoNoteId, writeAutoNote } = await import('@/lib/timeline-notes');
const lifecycleRoute = await import('@/app/api/account-lifecycle/route');
const notesRoute = await import('@/app/api/timeline-notes/route');

const today = () => new Date().toISOString().slice(0, 10);
const daysFromToday = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function call(mod: any, method: string, body?: unknown, raw?: string) {
  const res = await mod[method](
    new Request('http://x/api/route', { method, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), headers: { 'content-type': 'application/json' } })
  );
  return { status: res.status as number, body: await res.json() };
}
const lifecycle = (body?: unknown, raw?: string) => call(lifecycleRoute, 'POST', body, raw);

const MANUAL = { account_id: 'manual_6a3c1f0e-1111-4222-8333-944455556666', name: 'Cash jar', institution_name: 'Home', type: 'depository' as const, subtype: 'cash', balance: 0, updated_at: '2026-01-01T00:00:00Z' };

/** A Plaid connection as a load leaves it: stored, remembered, in the directory. */
async function connect(item_id: string, institution_name: string, accounts: { account_id: string; type: string; name: string }[]) {
  await saveItem(ctx, { item_id, institution_name, encrypted_access_token: await encrypt(TEST_CTX, 'tok') });
  const inst = { item_id, institution_name, error: null, accounts: accounts.map((a) => ({ ...a, mask: '1111', official_name: null, subtype: null, balance: 10, currency: 'USD' })) };
  await rememberAccounts(ctx, [inst as any]);
  await recordDirectory(ctx, [inst as any]);
}

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
});

describe('account lifecycle: what is refused', () => {
  const cases: [string, unknown, RegExp][] = [
    ['an array', [], /JSON/],
    ['no account', { state: 'closed', on: '2026-03-12' }, /account id/],
    ['an id that is not one', { account_id: 'has space', state: 'closed', on: '2026-03-12' }, /account id/],
    ['__proto__', { account_id: '__proto__', state: 'closed', on: '2026-03-12' }, /account id/],
    ['an unknown state', { account_id: 'a', state: 'sold', on: '2026-03-12' }, /closed, left, untracked or active/],
    ['a field the state does not take', { account_id: 'a', state: 'untracked', on: '2026-03-12' }, /on isn't part of/],
    ['an extra field', { account_id: 'a', state: 'closed', on: '2026-03-12', admin: true }, /admin isn't part of/],
    ['no day', { account_id: 'a', state: 'closed' }, /YYYY-MM-DD/],
    ['a day that is not one', { account_id: 'a', state: 'left', on: '2026-02-30' }, /YYYY-MM-DD/],
    ['a day before 1970', { account_id: 'a', state: 'closed', on: '1969-12-31' }, /from 1970/],
    ['a note that is not text', { account_id: 'a', state: 'closed', on: '2026-03-12', note: 5 }, /text/],
    ['a note too long', { account_id: 'a', state: 'closed', on: '2026-03-12', note: 'x'.repeat(201) }, /200 characters/],
    ['a balance that is not a number', { account_id: 'a', state: 'closed', on: '2026-03-12', balance: '310' }, /balance/],
    ['a balance past any', { account_id: 'a', state: 'left', on: '2026-03-12', balance: 1e300 }, /balance/],
    ['a balance on a reopen', { account_id: 'a', state: 'active', balance: 10 }, /balance isn't part of reopening/],
    ['an answer without its day', { account_id: 'a', state: 'active', answer: 'zero' }, /YYYY-MM-DD/],
    ['an answer to no question', { account_id: 'a', state: 'active', answer: 'maybe', since: '2026-03-12' }, /question/],
    ['a repair without confirmation', { action: 'repair' }, /confirmation/],
    ['an unknown action', { action: 'delete-everything', confirm: true }, /Unknown action/],
  ];
  for (const [name, body, message] of cases) {
    test(name, async () => {
      const { status, body: res } = await lifecycle(body);
      expect(status).toBe(400);
      expect(res.error).toMatch(message);
      expect(await lifecycleStore.count(ctx)).toBe(0);
    });
  }

  test('a body that is not JSON', async () => {
    expect((await lifecycle(undefined, '{not json')).status).toBe(400);
  });

  test('a note is one line: control characters become spaces, never a 500 from storage', async () => {
    await saveManualAccount(ctx, MANUAL);
    const { status } = await lifecycle({ account_id: MANUAL.account_id, state: 'closed', on: '2026-03-12', note: 'Moved\u0001 to\tChase\n' });
    expect(status).toBe(200);
    expect((await lifecycleStore.get(ctx, MANUAL.account_id))?.lifecycle).toEqual({ state: 'closed', on: '2026-03-12', note: 'Moved to Chase' });
  });

  test('a day in the future, beyond the person’s today', async () => {
    await saveManualAccount(ctx, MANUAL);
    expect((await lifecycle({ account_id: MANUAL.account_id, state: 'closed', on: daysFromToday(2) })).body.error).toMatch(/future/);
    // Today east of Greenwich can be tomorrow in UTC: allowed.
    expect((await lifecycle({ account_id: MANUAL.account_id, state: 'closed', on: daysFromToday(1) })).status).toBe(200);
  });

  test('an account Nya doesn’t know is a 404, and nothing is written', async () => {
    const { status } = await lifecycle({ account_id: 'acct_nobody', state: 'closed', on: '2026-03-12' });
    expect(status).toBe(404);
    expect(await lifecycleStore.count(ctx)).toBe(0);
  });
});

describe('account lifecycle: what it does', () => {
  test('closes a manual account (a paid-off loan, an emptied cash jar), with a note on the timeline', async () => {
    await saveManualAccount(ctx, MANUAL);
    await fake.set(ctxKey('cache:net-worth'), 'cached');
    const { status, body } = await lifecycle({ account_id: MANUAL.account_id, state: 'closed', on: '2026-03-12', note: '  Spent  it  ' });
    expect(status).toBe(200);
    expect(body).toEqual({ account_id: MANUAL.account_id, lifecycle: { state: 'closed', on: '2026-03-12', note: 'Spent it' } });
    // A manual account's balance is kept in US dollars, and its end says so.
    expect(await lifecycleStore.get(ctx, MANUAL.account_id)).toMatchObject({ type: 'depository', label: { name: 'Cash jar', institution: 'Home', mask: null }, item_id: null, currency: 'USD' });
    expect((await timelineNotesStore.get(ctx, autoNoteId(MANUAL.account_id)))?.text).toBe('Cash jar closed: Spent it');
    // The cached payload leaves the account in: it goes.
    expect(await fake.get(ctxKey('cache:net-worth'))).toBeNull();
  });

  test('a linked account is named from its institution’s remembered accounts', async () => {
    await connect('item_ally', 'Ally', [
      { account_id: 'sav', type: 'depository', name: 'Savings' },
      { account_id: 'chk', type: 'depository', name: 'Checking' },
    ]);
    const { body } = await lifecycle({ account_id: 'sav', state: 'untracked', from: '2026-03-12' });
    expect(body).toEqual({ account_id: 'sav', lifecycle: { state: 'untracked', from: '2026-03-12' } });
    // With its currency, as its institution reported it.
    expect(await lifecycleStore.get(ctx, 'sav')).toMatchObject({ type: 'depository', label: { name: 'Savings', institution: 'Ally', mask: '1111' }, item_id: 'item_ally', currency: 'USD' });
  });

  test('ending the last open account of a connection asks to remove the connection; not before', async () => {
    await connect('item_ally', 'Ally', [
      { account_id: 'sav', type: 'depository', name: 'Savings' },
      { account_id: 'chk', type: 'depository', name: 'Checking' },
    ]);
    expect((await lifecycle({ account_id: 'sav', state: 'closed', on: '2026-03-12' })).body.remove_connection).toBeUndefined();
    expect((await lifecycle({ account_id: 'chk', state: 'left', on: '2026-03-13' })).body.remove_connection).toEqual({ item_id: 'item_ally', institution_name: 'Ally' });
  });

  test('a hidden account still syncs, so it keeps the connection open', async () => {
    await connect('item_ally', 'Ally', [
      { account_id: 'sav', type: 'depository', name: 'Savings' },
      { account_id: 'chk', type: 'depository', name: 'Checking' },
    ]);
    await setAccountHidden(ctx, 'chk', 'depository', true);
    expect((await lifecycle({ account_id: 'sav', state: 'closed', on: '2026-03-12' })).body.remove_connection).toBeUndefined();
  });

  test('a disconnected institution’s account is named from the directory', async () => {
    await connect('item_old', 'Chase', [{ account_id: 'old', type: 'credit', name: 'Freedom' }]);
    await fake.hdel(ctxKey('plaid:items'), 'item_old');
    await fake.hdel(ctxKey('accounts:meta'), 'item_old');
    const { status } = await lifecycle({ account_id: 'old', state: 'closed', on: '2026-03-12' });
    expect(status).toBe(200);
    expect(await lifecycleStore.get(ctx, 'old')).toMatchObject({ type: 'credit', label: { name: 'Freedom', institution: 'Chase' } });
    // The directory keeps no currency: none is made up.
    expect((await lifecycleStore.get(ctx, 'old'))?.currency).toBeUndefined();
  });

  test('reopening clears every id the account has had, and its note', async () => {
    await connect('item_ally', 'Ally', [{ account_id: 'new_sav', type: 'depository', name: 'Savings' }]);
    await markEnded(ctx, 'old_sav', { state: 'closed', on: '2026-03-12' }, { type: 'depository', label: { name: 'Savings', institution: 'Ally', mask: null }, item_id: 'item_gone' });
    await linkAccounts(ctx, 'old_sav', 'new_sav', {});
    const { status, body } = await lifecycle({ account_id: 'new_sav', state: 'active' });
    expect(status).toBe(200);
    expect(body).toEqual({ account_id: 'new_sav', lifecycle: { state: 'active' }, reopened: true });
    expect(await lifecycleStore.count(ctx)).toBe(0);
    expect(await timelineNotesStore.count(ctx)).toBe(0);
  });

  test('Still open records the answer to the question it answers', async () => {
    await connect('item_ally', 'Ally', [{ account_id: 'sav', type: 'depository', name: 'Savings' }]);
    const { body } = await lifecycle({ account_id: 'sav', state: 'active', answer: 'zero', since: '2026-02-01' });
    expect(body.lifecycle).toEqual({ state: 'active' });
    expect((await lifecycleStore.get(ctx, 'sav'))?.answered).toEqual({ kind: 'zero', since: '2026-02-01' });
  });
});

describe('account lifecycle: errors by the seam’s rules', () => {
  test('an entry that can’t be read is a 409 with its id, and is left as it is', async () => {
    await saveManualAccount(ctx, MANUAL);
    await fake.hset(ctxKey('account-lifecycle'), { [MANUAL.account_id]: 'damaged-bytes-damaged-bytes-damaged' });
    const { status, body } = await lifecycle({ account_id: MANUAL.account_id, state: 'closed', on: '2026-03-12' });
    expect(status).toBe(409);
    expect(body).toMatchObject({ unreadable: true, unreadable_ids: [MANUAL.account_id], unrecognised_ids: [] });
    expect(await fake.hget<string>(ctxKey('account-lifecycle'), MANUAL.account_id)).toBe('damaged-bytes-damaged-bytes-damaged');
  });

  test('the repair removes only damaged entries, once confirmed', async () => {
    await fake.hset(ctxKey('account-lifecycle'), {
      broken: 'damaged-bytes-damaged-bytes-damaged',
      later: await encrypt(TEST_CTX, JSON.stringify({ lifecycle: { state: 'sold', on: '2026-03-01' }, type: null, label: { name: 'x', institution: 'y', mask: null }, item_id: null, set_at: '2026-03-01T00:00:00Z' })),
    });
    const { status, body } = await lifecycle({ action: 'repair', confirm: true });
    expect(status).toBe(200);
    expect(body).toEqual({ removed: 1, unrecognised_ids: ['later'] });
    expect(await lifecycleStore.has(ctx, 'broken')).toBe(false);
    expect(await lifecycleStore.has(ctx, 'later')).toBe(true);
  });

  test('a write too large for the ceiling is a 413, and nothing is written', async () => {
    await saveManualAccount(ctx, MANUAL);
    const before = process.env.MAX_TXN_BLOB_CHARS;
    process.env.MAX_TXN_BLOB_CHARS = '100';
    try {
      const { status, body } = await lifecycle({ account_id: MANUAL.account_id, state: 'closed', on: '2026-03-12' });
      expect(status).toBe(413);
      expect(body.error).toMatch(/too large/);
    } finally {
      if (before === undefined) delete process.env.MAX_TXN_BLOB_CHARS;
      else process.env.MAX_TXN_BLOB_CHARS = before;
    }
    expect(await lifecycleStore.count(ctx)).toBe(0);
  });

  test('another change to the accounts under way is a 409', async () => {
    await saveManualAccount(ctx, MANUAL);
    await fake.set(ctxKey('account-links:lock'), 'someone-else');
    const { status, body } = await lifecycle({ account_id: MANUAL.account_id, state: 'closed', on: '2026-03-12' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/in progress/);
  });

  test('storage failing is a 500 that says nothing stored', async () => {
    await saveManualAccount(ctx, MANUAL);
    fake.failNext('eval', 3);
    const { status, body } = await lifecycle({ account_id: MANUAL.account_id, state: 'closed', on: '2026-03-12' });
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to save that account’s change' });
  });

  test('no container is a 503', async () => {
    fake.reset();
    forgetEpochs();
    expect((await lifecycle({ account_id: 'a', state: 'closed', on: '2026-03-12' })).status).toBe(503);
    expect((await call(notesRoute, 'GET')).status).toBe(503);
  });
});

describe('timeline notes route', () => {
  test('add, list, edit and remove the person’s own', async () => {
    const added = await call(notesRoute, 'POST', { date: '2026-03-12', text: '  Bought   the house ' });
    expect(added.status).toBe(200);
    expect(added.body.note).toMatchObject({ date: '2026-03-12', text: 'Bought the house', kind: 'user' });
    const id = added.body.id;
    expect((await call(notesRoute, 'GET')).body).toEqual({ notes: [expect.objectContaining({ id, text: 'Bought the house' })], unreadable_ids: [], unrecognised_ids: [] });
    expect((await call(notesRoute, 'PATCH', { id, text: 'Closed on the house', date: '2026-03-13' })).body.note).toMatchObject({ text: 'Closed on the house', date: '2026-03-13' });
    expect((await call(notesRoute, 'DELETE', { id })).body).toEqual({ id, removed: true });
    expect((await call(notesRoute, 'DELETE', { id })).status).toBe(404);
    expect((await call(notesRoute, 'PATCH', { id, text: 'x' })).status).toBe(404);
  });

  test('what is refused', async () => {
    const refused: [string, unknown][] = [
      ['POST', { date: '2026-03-12' }],
      ['POST', { date: '2026-03-12', text: '' }],
      ['POST', { date: '2026-03-12', text: 'x'.repeat(201) }],
      ['POST', { date: '2026-02-30', text: 'x' }],
      ['POST', { date: daysFromToday(2), text: 'x' }],
      ['POST', { date: '2026-03-12', text: 'x', kind: 'auto' }],
      ['POST', { date: '2026-03-12', text: 'x', account_id: 'has space' }],
      ['PATCH', { id: 'n1' }],
      ['PATCH', { id: 'has space', text: 'x' }],
      ['PATCH', { id: 'n1', text: 'x', kind: 'auto' }],
      ['DELETE', {}],
      ['DELETE', { id: 'n1', also: 1 }],
    ];
    for (const [method, body] of refused) expect([method, (await call(notesRoute, method, body)).status]).toEqual([method, 400]);
    expect(await timelineNotesStore.count(ctx)).toBe(0);
  });

  test('a note Nya wrote for an account’s change can’t be edited or removed here', async () => {
    await writeAutoNote(ctx, 'sav', '2026-03-12', 'Savings closed');
    expect((await call(notesRoute, 'PATCH', { id: autoNoteId('sav'), text: 'mine' })).status).toBe(409);
    expect((await call(notesRoute, 'DELETE', { id: autoNoteId('sav') })).status).toBe(409);
  });

  test('what can’t be read is named in the list, and a 409 for the note itself', async () => {
    await fake.hset(ctxKey('timeline-notes'), { broken: 'damaged-bytes-damaged-bytes-damaged' });
    expect((await call(notesRoute, 'GET')).body).toEqual({ notes: [], unreadable_ids: ['broken'], unrecognised_ids: [] });
    const { status, body } = await call(notesRoute, 'PATCH', { id: 'broken', text: 'x' });
    expect(status).toBe(409);
    expect(body).toMatchObject({ unreadable: true, unreadable_ids: ['broken'] });
  });

  test('a note too large for the ceiling is a 413', async () => {
    const before = process.env.MAX_TXN_BLOB_CHARS;
    process.env.MAX_TXN_BLOB_CHARS = '60';
    try {
      expect((await call(notesRoute, 'POST', { date: '2026-03-12', text: 'A note' })).status).toBe(413);
    } finally {
      if (before === undefined) delete process.env.MAX_TXN_BLOB_CHARS;
      else process.env.MAX_TXN_BLOB_CHARS = before;
    }
  });

  test('storage failing is a 500', async () => {
    fake.failNext('hgetall');
    expect((await call(notesRoute, 'GET')).status).toBe(500);
  });

  test('today is a day a note can be on', async () => {
    expect((await call(notesRoute, 'POST', { date: today(), text: 'Today' })).status).toBe(200);
  });
});
