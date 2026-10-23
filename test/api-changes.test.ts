import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime, spyOn } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The record of changes made with API tokens (lib/api-changes.ts) and undo
// (lib/api-undo.ts): each write recorded, a token reading its own alone, the
// app's list of every token's, forgetting, the 30 days it is kept, and each
// kind of change undone, or refused when what it changed moved since.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy({}, { get: () => async () => { throw new Error('Plaid must not be called'); } }),
}));
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, daysAgo, seedPerson } = await import('./api-fixture');
const { createToken, revokeToken } = await import('@/lib/api-tokens');
const { forgetEpochs } = await import('@/lib/sessions');
const { decrypt } = await import('@/lib/crypto');
const { getManualAccount } = await import('@/lib/manual');
const { readTagSet } = await import('@/lib/tags');
const { ensureTaxonomy, readTaxonomy } = await import('@/lib/category-store');
const { manualTxnStore, findManualTxn } = await import('@/lib/manual-txns');
const { txnAnnotationStore } = await import('@/lib/txn-annotations');
const { getHiddenAccounts } = await import('@/lib/hidden');
const { recordSnapshot } = await import('@/lib/history');
const { changeStore, claimStore, pruneChanges } = await import('@/lib/api-changes');
const { apiWriteCount, apiWriteDays } = await import('@/lib/api-token-store');
const { snapshotData } = await import('@/lib/snapshot-job');
const txnWrites = await import('@/lib/manual-txn-writes');

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const DAY = 86_400_000;
const WALLET = 'manual_wallet';
const MARKET = 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

let writer = '';
let writerId = '';
let other = '';
let reader = '';
let balancer = '';
const saved = { ...process.env };
beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  process.env.API_WRITES_ENABLED = '1';
  await registerTestContainer(fake);
  await seedPerson(fake);
  await ensureTaxonomy(ctx);
  const made = await createToken(ctx, 'Importer', new Date(NOW), null, 'write');
  writer = made.token;
  writerId = made.info.id;
  other = (await createToken(ctx, 'Sorter', new Date(NOW), null, 'write')).token;
  reader = (await createToken(ctx, 'Dashboard', new Date(NOW))).token;
  balancer = (await createToken(ctx, 'Home Assistant', new Date(NOW), null, 'balances')).token;
});
afterEach(() => {
  process.env = { ...saved };
  setSystemTime();
});

type Sent = { status: number; body: any; headers: Headers };

/** One request to an /api/v1 path, as the router would hand it over. */
async function send(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Sent> {
  const [route, query] = path.split('?');
  const parts = route.split('/');
  const dir = parts.length === 1 ? parts[0] : parts.length === 2 ? `${parts[0]}/[id]` : `${parts[0]}/[id]/${parts[2]}`;
  const mod: any = await import(`@/app/api/v1/${dir}/route`);
  const withBody = opts.body !== undefined;
  const res: Response = await mod[method](
    new Request(`https://nya.test/api/v1/${route}${query ? `?${query}` : ''}`, {
      method,
      headers: { authorization: `Bearer ${opts.token ?? writer}`, ...(withBody ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      ...(withBody ? { body: JSON.stringify(opts.body) } : {}),
    }),
    { params: Promise.resolve({ id: parts[1] }) }
  );
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

/** The app's own routes, as the page calls them. */
async function app(path: string, method: string, body?: unknown, query = ''): Promise<{ status: number; body: any }> {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res: Response = await mod[method](
    new Request(`https://nya.test/api/${path}${query}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  );
  return { status: res.status, body: await res.json() };
}

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};

const versionOf = async (path: string) => {
  const body = (await send('GET', path)).body;
  return (Object.values(body)[0] as { version: string }).version;
};
const undo = (id: string, token = writer) => send('POST', `changes/${id}/undo`, { token });
const own = async (token = writer) => (await send('GET', 'changes', { token })).body.changes as any[];
const coffee = { account_id: WALLET, date: daysAgo(0, NOW), amount: 4.5, name: 'Coffee' };
const changeCount = () => changeStore.count(ctx);

describe('the record', () => {
  test('each write is recorded done with what it changed, and a token reads its own alone', async () => {
    const made = await send('POST', 'transactions', { body: coffee });
    expect(made.status).toBe(201);
    const tag = await send('POST', 'tags', { token: other, body: { name: 'Trip' } });
    expect(tag.status).toBe(201);

    const mine = await own();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id: made.body.change_id,
      via: 'api',
      token: { label: 'Importer' },
      op: 'transaction.create',
      target: { kind: 'transaction', id: made.body.transaction.id, account_id: WALLET },
      state: 'done',
      before: null,
      after: { row: { id: made.body.transaction.id, amount: 4.5, name: 'Coffee' }, said: null },
      undoes: null,
      undone_by: null,
      forgotten: false,
    });
    // The token's id is never served: its hint and name alone.
    expect(Object.keys(mine[0].token).sort()).toEqual(['hint', 'label']);
    expect((await own(other)).map((c) => c.op)).toEqual(['tag.create']);

    // A token that can't write reads none, and counts nothing.
    for (const token of [reader, balancer]) {
      const r = await send('GET', 'changes', { token });
      expect([r.status, r.body.error.code]).toEqual([403, 'insufficient_scope']);
    }
  });

  test('a write the app refused leaves no line; one that stopped part way says so', async () => {
    const group = (await readTaxonomy(ctx))!.groups[0].id;
    expect((await send('POST', 'categories', { body: { name: 'Pets', group_id: group } })).status).toBe(201);
    const count = await changeCount();
    const again = await send('POST', 'categories', { body: { name: 'Pets', group_id: group } });
    expect(again.status).toBe(409);
    expect(await changeCount()).toBe(count);

    // The row's own write fails: the change can't tell what landed.
    setSystemTime(new Date(NOW + 1000));
    const failing = spyOn(txnWrites, 'addRow').mockRejectedValueOnce(new Error('connection reset'));
    const r = await quietly(() => send('POST', 'transactions', { body: coffee }));
    failing.mockRestore();
    expect(r.status).toBe(500);
    const [latest] = await own();
    expect([latest.op, latest.state]).toEqual(['transaction.create', 'failed']);
  });

  test('the app lists every token’s changes, newest first, a page at a time', async () => {
    for (let i = 0; i < 26; i++) {
      setSystemTime(new Date(NOW + i * 1000));
      expect((await send('POST', 'tags', { token: i % 2 ? other : writer, body: { name: `Tag ${i}` } })).status).toBe(201);
    }
    const first = await app('api-changes', 'GET');
    expect(first.status).toBe(200);
    expect(first.body.changes).toHaveLength(25);
    expect(first.body.changes[0].after.tag.name).toBe('Tag 25');
    expect(new Set(first.body.changes.map((c: any) => c.token.label))).toEqual(new Set(['Importer', 'Sorter']));
    expect(first.body.writes).toBe(true);
    // The manual accounts there are now, for a balance change's sentence.
    expect(first.body.accounts[WALLET]).toEqual({ name: 'Wallet', currency: 'USD' });
    const second = await app('api-changes', 'GET', undefined, `?cursor=${first.body.next}`);
    expect(second.body.changes.map((c: any) => c.after.tag.name)).toEqual(['Tag 0']);
    expect(second.body.next).toBeNull();
    expect((await app('api-changes', 'GET', undefined, '?cursor=not%20one')).status).toBe(400);

    // A token pages its own the same way.
    const page = await send('GET', 'changes?limit=5');
    expect([page.body.changes.length, page.body.has_more]).toEqual([5, true]);
    const rest = await send('GET', `changes?limit=50&cursor=${page.body.next_cursor}`);
    expect([rest.body.changes.length, rest.body.has_more]).toEqual([8, false]);
  });

  test('a damaged change is named in the app’s list, and only a damaged one can be removed', async () => {
    const made = await send('POST', 'transactions', { body: coffee });
    const id = made.body.change_id as string;
    expect((await app('api-changes', 'DELETE', { id })).status).toBe(409);
    const broken = `${id.slice(0, -12)}ffffffffffff`;
    fake.hashes.get(ctxKey('api-changes'))!.set(broken, 'not a stored value');
    const listed = await quietly(() => app('api-changes', 'GET'));
    expect(listed.body.unreadable).toEqual([broken]);
    expect(listed.body.changes.map((c: any) => c.id)).toEqual([id]);
    // A token's own list is strict: it can't tell what the damaged one was.
    expect((await quietly(() => send('GET', 'changes'))).status).toBe(409);
    expect((await quietly(() => app('api-changes', 'DELETE', { id: broken }))).body).toEqual({ removed: true });
    expect((await own()).map((c) => c.id)).toEqual([id]);
  });

  test('forgetting one, or a token’s all: the line stays, what it changed goes, and it can’t be undone', async () => {
    const a = (await send('POST', 'transactions', { body: coffee })).body.change_id;
    const b = (await send('POST', 'tags', { body: { name: 'Trip' } })).body.change_id;
    const c = (await send('POST', 'tags', { token: other, body: { name: 'Home' } })).body.change_id;

    expect((await app('api-changes', 'POST', { action: 'forget', id: a })).body).toEqual({ forgotten: 1 });
    const forgotten = (await own()).find((c) => c.id === a);
    expect(forgotten).toMatchObject({ id: a, op: 'transaction.create', state: 'done', before: null, after: null, forgotten: true });
    const stored = await changeStore.get(ctx, a);
    expect([stored!.before, stored!.after, typeof stored!.forgotten_at]).toEqual([undefined, undefined, 'string']);
    const refused = await undo(a);
    expect([refused.status, refused.body.error.code]).toEqual([409, 'conflict']);
    expect(refused.body.error.message).toContain('forgotten');

    expect((await app('api-changes', 'POST', { action: 'forget-token', token_id: writerId })).body).toEqual({ forgotten: 2 });
    expect((await changeStore.get(ctx, b))!.forgotten_at).toBeString();
    expect((await changeStore.get(ctx, c))!.after).toBeDefined();
    expect((await app('api-changes', 'POST', { action: 'forget', id: 'nope' })).status).toBe(400);
    expect((await app('api-changes', 'POST', { action: 'forget', id: '20261020.app.000000000000' })).status).toBe(404);
  });

  test('kept 30 days: older ones read as none, and the nightly prune drops them, and keys past a day', async () => {
    setSystemTime(new Date(NOW - 30 * DAY));
    const old = (await send('POST', 'transactions', { body: { ...coffee, date: daysAgo(0, NOW - 30 * DAY) }, headers: { 'idempotency-key': 'old' } })).body.change_id;
    setSystemTime(new Date(NOW - 29 * DAY));
    const kept = (await send('POST', 'tags', { body: { name: 'Trip' } })).body.change_id;
    setSystemTime(new Date(NOW));
    const fresh = (await send('POST', 'tags', { body: { name: 'Home' }, headers: { 'idempotency-key': 'new' } })).body.change_id;

    expect((await own()).map((c) => c.id)).toEqual([fresh, kept]);
    expect((await undo(old)).status).toBe(404);
    expect((await changeStore.ids(ctx)).sort()).toEqual([old, kept, fresh].sort());
    await pruneChanges(ctx, NOW);
    expect((await changeStore.ids(ctx)).sort()).toEqual([kept, fresh].sort());
    expect((await claimStore.get(ctx, writerId))!.claims.map((c) => c.change)).toEqual([fresh]);
    // A day later the key's claim goes too, and its token's entry with it.
    await pruneChanges(ctx, NOW + DAY + 1);
    expect(await claimStore.get(ctx, writerId)).toBeNull();
  });

  test('the nightly snapshot prunes the record', async () => {
    setSystemTime(new Date(NOW - 31 * DAY));
    const old = (await send('POST', 'tags', { body: { name: 'Trip' } })).body.change_id;
    setSystemTime(new Date(NOW));
    expect(await changeStore.ids(ctx)).toEqual([old]);
    await quietly(() => snapshotData(ctx, []));
    expect(await changeStore.ids(ctx)).toEqual([]);
  });

  test('a revoked token’s keys go with it; what it changed stays recorded', async () => {
    const made = await send('POST', 'tags', { body: { name: 'Trip' }, headers: { 'idempotency-key': 'k' } });
    expect(await claimStore.get(ctx, writerId)).not.toBeNull();
    expect(await revokeToken(ctx, writerId)).toBe(true);
    expect(await claimStore.get(ctx, writerId)).toBeNull();
    // Its windows are gone: the next count starts one.
    expect((await apiWriteDays.take(ctx, writerId)).count).toBe(1);
    expect((await apiWriteCount.take(ctx, writerId)).count).toBe(1);
    expect((await changeStore.get(ctx, made.body.change_id))!.state).toBe('done');
    // The person still undoes it in the app.
    const undone = await app('api-changes', 'POST', { action: 'undo', id: made.body.change_id });
    expect(undone.status).toBe(200);
    expect((await readTagSet(ctx))!.tags).toEqual([]);
  });
});

describe('undo', () => {
  test('a transaction made is deleted; asked again, the same undo answers', async () => {
    const made = await send('POST', 'transactions', { body: coffee });
    const id = made.body.transaction.id;
    const first = await undo(made.body.change_id);
    expect(first.status).toBe(200);
    expect(first.body.change).toMatchObject({ id: made.body.change_id, undone_by: first.body.undo });
    expect(await findManualTxn(ctx, id)).toBeNull();
    const again = await undo(made.body.change_id);
    expect([again.status, again.body.undo]).toEqual([200, first.body.undo]);
    const line = (await own()).find((c) => c.id === first.body.undo);
    expect(line).toMatchObject({ id: first.body.undo, op: 'undo', target: { kind: 'change', id: made.body.change_id }, undoes: made.body.change_id, state: 'done', after: null });
    // An undo isn't undone.
    const twice = await undo(first.body.undo);
    expect([twice.status, twice.body.error.message]).toEqual([409, 'An undo isn’t undone: make the change again.']);
  });

  test('a transaction changed is set back, its row or what is said beside it; deleted, it is added back as it was', async () => {
    const before = (await findManualTxn(ctx, MARKET))!.row;
    const changed = await send('PATCH', `transactions/${MARKET}`, { body: { amount: 30, name: 'Market', note: null }, headers: { 'if-match': await versionOf(`transactions/${MARKET}`) } });
    expect(changed.status).toBe(200);
    expect((await undo(changed.body.change_id)).status).toBe(200);
    const back = (await findManualTxn(ctx, MARKET))!.row;
    expect({ ...back, updated_at: before.updated_at }).toEqual(before);

    const tag = (await send('POST', 'tags', { body: { name: 'Trip' } })).body.tag.id;
    const said = await send('PATCH', `transactions/${MARKET}`, { body: { excluded: true, add_tag_ids: [tag] }, headers: { 'if-match': await versionOf(`transactions/${MARKET}`) } });
    expect(said.status).toBe(200);
    expect(await txnAnnotationStore.get(ctx, MARKET)).toMatchObject({ excluded: true, tags: [tag] });
    expect((await undo(said.body.change_id)).status).toBe(200);
    expect(await txnAnnotationStore.get(ctx, MARKET)).toBeNull();

    // Deleted with something said about it: back with the same id and that.
    await send('PATCH', `transactions/${MARKET}`, { body: { excluded: true }, headers: { 'if-match': await versionOf(`transactions/${MARKET}`) } });
    const keptSaid = await txnAnnotationStore.get(ctx, MARKET);
    const row = (await findManualTxn(ctx, MARKET))!.row;
    const gone = await send('DELETE', `transactions/${MARKET}`, { headers: { 'if-match': await versionOf(`transactions/${MARKET}`) } });
    expect(gone.status).toBe(200);
    expect(await findManualTxn(ctx, MARKET)).toBeNull();
    expect((await undo(gone.body.change_id)).status).toBe(200);
    expect((await findManualTxn(ctx, MARKET))!.row).toEqual(row);
    expect(await txnAnnotationStore.get(ctx, MARKET)).toEqual(keptSaid);
  });

  test('refused when what it changed moved since, naming it, and nothing is undone or recorded', async () => {
    const changed = await send('PATCH', `transactions/${MARKET}`, { body: { amount: 30 }, headers: { 'if-match': await versionOf(`transactions/${MARKET}`) } });
    expect((await app('manual-transactions', 'PATCH', { id: MARKET, account_id: WALLET, amount: 31 })).status).toBe(200);
    const count = await changeCount();
    const refused = await undo(changed.body.change_id);
    expect([refused.status, refused.body.error.code]).toEqual([409, 'conflict']);
    expect(refused.body.error.message).toBe('The transaction changed since this change was made, so it wasn’t undone. Change it back yourself if you want it as it was.');
    expect((await findManualTxn(ctx, MARKET))!.row.amount).toBe(31);
    expect(await changeCount()).toBe(count);
    expect((await changeStore.get(ctx, changed.body.change_id))!.undone_by).toBeUndefined();

    // Made, then split since: not deleted.
    const made = await send('POST', 'transactions', { body: coffee });
    const [one, two] = (await readTaxonomy(ctx))!.categories;
    const parts = [{ amount: 2, category_id: one.id }, { amount: 2.5, category_id: two.id }];
    expect((await app('transaction-splits', 'PUT', { transaction_id: made.body.transaction.id, parts })).status).toBe(200);
    expect((await undo(made.body.change_id)).status).toBe(409);
    expect(await findManualTxn(ctx, made.body.transaction.id)).not.toBeNull();
  });

  test('an account’s details and its balance set back; a balance changed since is not', async () => {
    const before = (await getManualAccount(ctx, WALLET))!;
    const details = await send('PATCH', `manual-accounts/${WALLET}`, { body: { name: 'Purse', type: 'other', subtype: null }, headers: { 'if-match': await versionOf(`manual-accounts/${WALLET}`) } });
    expect(details.status).toBe(200);
    expect((await undo(details.body.change_id)).status).toBe(200);
    expect(await getManualAccount(ctx, WALLET)).toMatchObject({ name: before.name, type: before.type, subtype: before.subtype, balance: before.balance });

    const set = await send('POST', `manual-accounts/${WALLET}/balance`, { body: { balance: 75.25 } });
    expect(set.status).toBe(200);
    expect((await undo(set.body.change_id)).status).toBe(200);
    expect((await getManualAccount(ctx, WALLET))!.balance).toBe(40);

    const again = await send('POST', `manual-accounts/${WALLET}/balance`, { body: { balance: 80 } });
    expect((await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance: 90 } })).status).toBe(200);
    expect((await undo(again.body.change_id)).status).toBe(409);
    expect((await getManualAccount(ctx, WALLET))!.balance).toBe(90);
  });

  test('an account made is taken out whole: its rows, and its balance on every day recorded since', async () => {
    const made = await send('POST', 'manual-accounts', { body: { name: 'Jar', institution_name: 'Home', type: 'depository', subtype: 'cash', balance: 12.5 } });
    expect(made.status).toBe(201);
    const id = made.body.account.id as string;
    const row = await send('POST', 'transactions', { body: { ...coffee, account_id: id } });
    expect(row.status).toBe(201);
    await recordSnapshot(ctx, 1000, { acc_chk: 987.5, [id]: 12.5 });
    const day = new Date(NOW).toISOString().slice(0, 10);
    const balancesOn = async () => JSON.parse(await decrypt(ctx, fake.hashes.get(ctxKey('history:accounts'))!.get(day)!)) as Record<string, number>;
    expect(Object.keys(await balancesOn())).toContain(id);

    const undone = await undo(made.body.change_id);
    expect(undone.status).toBe(200);
    expect(await getManualAccount(ctx, id)).toBeNull();
    expect(await manualTxnStore.get(ctx, id)).toBeNull();
    expect(Object.keys(await balancesOn())).not.toContain(id);
    // The day's total as though it never was.
    expect(Number(await decrypt(ctx, fake.hashes.get(ctxKey('history:net-worth'))!.get(day)!))).toBe(987.5);
    expect((await getHiddenAccounts(ctx)).has(id)).toBe(false);
  });

  test('an account made is not taken out once anything else touched it', async () => {
    const made = await send('POST', 'manual-accounts', { body: { name: 'Jar', institution_name: 'Home', type: 'depository', subtype: 'cash', balance: 12.5 } });
    const id = made.body.account.id as string;
    expect((await app('manual-transactions', 'POST', { ...coffee, account_id: id })).status).toBe(200);
    const refused = await undo(made.body.change_id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('remove it in the app');
    expect(await getManualAccount(ctx, id)).not.toBeNull();

    const renamed = await send('POST', 'manual-accounts', { body: { name: 'Tin', institution_name: 'Home', type: 'depository', subtype: 'cash', balance: 1 } });
    expect((await app('manual-accounts', 'PATCH', { account_id: renamed.body.account.id, name: 'Box', institution_name: 'Home', type: 'depository', subtype: 'cash', balance: 1 })).status).toBe(200);
    expect((await undo(renamed.body.change_id)).status).toBe(409);
  });

  test('categories and groups made are deleted while unused, and changes set back', async () => {
    const groupId = (await readTaxonomy(ctx))!.groups[0].id;
    const made = await send('POST', 'categories', { body: { name: 'Pets', group_id: groupId, icon: '🐶' } });
    const id = made.body.category.id;
    const changed = await send('PATCH', `categories/${id}`, { body: { name: 'Animals', archived: true }, headers: { 'if-match': await versionOf(`categories/${id}`) } });
    expect((await undo(changed.body.change_id)).status).toBe(200);
    expect((await readTaxonomy(ctx))!.categories.find((c) => c.id === id)).toMatchObject({ name: 'Pets', icon: '🐶' });
    expect((await readTaxonomy(ctx))!.categories.find((c) => c.id === id)!.archived).toBeFalsy();
    // Set back, it is as it was made again, so that can be undone too.
    expect((await undo(made.body.change_id)).status).toBe(200);
    expect((await readTaxonomy(ctx))!.categories.some((c) => c.id === id)).toBe(false);

    const unused = await send('POST', 'categories', { body: { name: 'Hobbies', group_id: groupId } });
    expect((await undo(unused.body.change_id)).status).toBe(200);
    expect((await readTaxonomy(ctx))!.categories.some((c) => c.id === unused.body.category.id)).toBe(false);

    const used = await send('POST', 'categories', { body: { name: 'Garden', group_id: groupId } });
    expect((await send('POST', 'transactions', { body: { ...coffee, category_id: used.body.category.id } })).status).toBe(201);
    const refused = await undo(used.body.change_id);
    expect([refused.status, refused.body.error.code]).toEqual([409, 'conflict']);

    const group = await send('POST', 'category-groups', { body: { name: 'Side', kind: 'expense' } });
    const renamed = await send('PATCH', `category-groups/${group.body.group.id}`, { body: { name: 'Side jobs' }, headers: { 'if-match': await versionOf(`category-groups/${group.body.group.id}`) } });
    expect((await undo(renamed.body.change_id)).status).toBe(200);
    expect((await readTaxonomy(ctx))!.groups.find((g) => g.id === group.body.group.id)!.name).toBe('Side');
  });

  test('a tag made is deleted while nothing carries it, and a change set back', async () => {
    const made = await send('POST', 'tags', { body: { name: 'Trip', color: 'blue' } });
    const id = made.body.tag.id;
    const changed = await send('PATCH', `tags/${id}`, { body: { name: 'Travel', color: 'red' }, headers: { 'if-match': await versionOf(`tags/${id}`) } });
    expect((await undo(changed.body.change_id)).status).toBe(200);
    expect((await readTagSet(ctx))!.tags.find((t) => t.id === id)).toMatchObject({ name: 'Trip', color: 'blue' });

    const carried = await send('POST', 'tags', { body: { name: 'Work' } });
    await send('PATCH', `transactions/${MARKET}`, { body: { add_tag_ids: [carried.body.tag.id] }, headers: { 'if-match': await versionOf(`transactions/${MARKET}`) } });
    const refused = await undo(carried.body.change_id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('on a transaction or in a rule');

    const plain = await send('POST', 'tags', { body: { name: 'Gift' } });
    expect((await undo(plain.body.change_id)).status).toBe(200);
    expect((await readTagSet(ctx))!.tags.some((t) => t.id === plain.body.tag.id)).toBe(false);
  });

  test('a token undoes its own alone; the app any; and an undo counts as a write', async () => {
    const theirs = await send('POST', 'tags', { token: other, body: { name: 'Trip' } });
    const refused = await undo(theirs.body.change_id);
    expect([refused.status, refused.body.error.code]).toEqual([404, 'not_found']);
    expect((await undo(theirs.body.change_id, reader)).status).toBe(403);
    expect((await readTagSet(ctx))!.tags).toHaveLength(1);

    const mine = await send('POST', 'tags', { body: { name: 'Home' } });
    // Counted by taking one before and after: the undo is the one between.
    const minuteBefore = (await apiWriteCount.take(ctx, writerId)).count;
    const dayBefore = (await apiWriteDays.take(ctx, writerId)).count;
    expect((await undo(mine.body.change_id)).status).toBe(200);
    expect((await apiWriteCount.take(ctx, writerId)).count).toBe(minuteBefore + 2);
    expect((await apiWriteDays.take(ctx, writerId)).count).toBe(dayBefore + 2);

    const app_ = await app('api-changes', 'POST', { action: 'undo', id: theirs.body.change_id });
    expect(app_.status).toBe(200);
    const line = await changeStore.get(ctx, app_.body.undo);
    expect([line!.via, line!.token]).toEqual(['app', null]);
    expect(app_.body.undo).toStartWith(`${new Date(NOW).toISOString().slice(0, 10).replaceAll('-', '')}.app.`);
    expect((await readTagSet(ctx))!.tags).toEqual([]);
  });

  test('turned off, the app still undoes; the API answers as before writing', async () => {
    const made = await send('POST', 'tags', { body: { name: 'Trip' } });
    process.env.API_WRITES_ENABLED = '0';
    const r = await undo(made.body.change_id);
    expect(r.status).toBe(404);
    const listed = await app('api-changes', 'GET');
    expect(listed.body.writes).toBe(false);
    expect((await app('api-changes', 'POST', { action: 'undo', id: made.body.change_id })).status).toBe(200);
  });
});
