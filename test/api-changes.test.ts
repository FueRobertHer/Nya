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
const { getManualAccount, saveManualAccount } = await import('@/lib/manual');
const { readTagSet } = await import('@/lib/tags');
const { ensureTaxonomy, readTaxonomy } = await import('@/lib/category-store');
const { manualTxnStore, findManualTxn } = await import('@/lib/manual-txns');
const { txnAnnotationStore } = await import('@/lib/txn-annotations');
const { getHiddenAccounts } = await import('@/lib/hidden');
const { recordSnapshot } = await import('@/lib/history');
const { changeStore, claimStore, pruneChanges, tokenRef } = await import('@/lib/api-changes');
const { apiWriteCount, apiWriteDays } = await import('@/lib/api-token-store');
const { snapshotData } = await import('@/lib/snapshot-job');
const { PENDING_MS } = await import('@/lib/api-writes');
const { allocationSettingsStore } = await import('@/lib/allocation-settings');
const { plannedStore } = await import('@/lib/planned-store');
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
    // Nor kept in the record, nor its hint: both are part of the token, and
    // the record is in the download. A ref tells tokens apart.
    const raw = [...fake.hashes.get(ctxKey('api-changes'))!.keys(), ...(await changeStore.getAll(ctx)).values()].map((v) => JSON.stringify(v)).join(' ');
    expect(raw).not.toContain(writerId);
    expect(raw).not.toContain(writerId.slice(0, 8));
    expect((await changeStore.get(ctx, made.body.change_id))!.token).toEqual({ ref: tokenRef(writerId), label: 'Importer' });
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

    expect((await app('api-changes', 'POST', { action: 'forget-token', id: b })).body).toEqual({ forgotten: 2 });
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
    expect((await app('api-changes', 'GET')).body.changes[0]).toMatchObject({ id: made.body.change_id, revoked: true, token: { label: 'Importer' } });
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

  test('one finished by sending its key again is done, without what it made, and never undone from a guess', async () => {
    const made = await send('POST', 'tags', { body: { name: 'Trip' }, headers: { 'idempotency-key': 'k-1' } });
    // As if the first stopped after the tag was made, before it was settled.
    const entry = (await changeStore.get(ctx, made.body.change_id))!;
    const stopped = { ...entry, state: 'pending' as const, at: new Date(NOW - PENDING_MS - 1000).toISOString() };
    delete (stopped as Partial<typeof entry>).before;
    delete (stopped as Partial<typeof entry>).after;
    await changeStore.set(ctx, made.body.change_id, stopped);
    const again = await send('POST', 'tags', { body: { name: 'Trip' }, headers: { 'idempotency-key': 'k-1' } });
    expect([again.status, again.headers.get('idempotent-replayed'), again.body.tag.id]).toEqual([200, 'true', made.body.tag.id]);
    const settled = (await changeStore.get(ctx, made.body.change_id))!;
    expect([settled.state, settled.before, settled.after]).toEqual(['done', undefined, undefined]);
    const refused = await undo(made.body.change_id);
    expect([refused.status, refused.body.error.message]).toEqual([409, 'What this change made wasn’t recorded (it was finished when it was sent again), so it can’t be undone here: change it in the app.']);
    expect((await readTagSet(ctx))!.tags).toHaveLength(1);
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

  test('an account made is not taken out while its past balances are being turned over, and is once that is done', async () => {
    const { signJobStore, finishSignJobs } = await import('@/lib/sign-repair');
    const { SIGN_JOB_PENDING } = await import('@/lib/sign-repair-store');
    const made = await send('POST', 'manual-accounts', { body: { name: 'Jar', institution_name: 'Home', type: 'depository', subtype: 'cash', balance: 12.5 } });
    const id = made.body.account.id as string;
    await recordSnapshot(ctx, 1000, { acc_chk: 987.5, [id]: 12.5 });
    // A repair of it under way (lib/sign-repair.ts), nothing left to turn over.
    await signJobStore.set(ctx, id, { v: 1, kind: 'repair', from: 'depository', to: 'depository', at: new Date(NOW).toISOString(), tag: 'sign-test', plan: {} });
    const refused = await undo(made.body.change_id);
    expect([refused.status, refused.body.error.message]).toEqual([409, `${SIGN_JOB_PENDING} It wasn’t undone.`]);
    expect(await getManualAccount(ctx, id)).not.toBeNull();
    const day = new Date(NOW).toISOString().slice(0, 10);
    expect(Object.keys(JSON.parse(await decrypt(ctx, fake.hashes.get(ctxKey('history:accounts'))!.get(day)!)))).toContain(id);
    await finishSignJobs(ctx);
    expect((await undo(made.body.change_id)).status).toBe(200);
    expect(await getManualAccount(ctx, id)).toBeNull();
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

describe('undo of an account a token made, taken out only as the token left it', () => {
  const jar = { name: 'Cash jar', institution_name: 'Home', type: 'depository', subtype: 'cash', balance: 100 };
  /** An account the writer made, with one row on it the writer added. */
  const made = async () => {
    const account = await send('POST', 'manual-accounts', { body: jar });
    const row = await send('POST', 'transactions', { body: { ...coffee, account_id: account.body.account.id, name: 'Lunch', amount: 12 } });
    return { change: account.body.change_id as string, id: account.body.account.id as string, row: row.body.transaction.id as string };
  };
  const refusedWith = async (change: string, id: string, words: string) => {
    const r = await quietly(() => undo(change));
    expect([r.status, r.body.error.code]).toEqual([409, 'conflict']);
    expect(r.body.error.message).toContain(words);
    expect(await getManualAccount(ctx, id)).not.toBeNull();
    // Refused before anything was written: no undo recorded, still undoable.
    expect((await changeStore.get(ctx, change))!.undone_by).toBeUndefined();
    expect([...(await changeStore.getAll(ctx)).values()].some((c) => c.op === 'undo')).toBe(false);
  };

  test('a row the person edited, excluded, or split since: refused, saying so, and the row kept', async () => {
    const a = await made();
    expect((await app('manual-transactions', 'PATCH', { id: a.row, account_id: a.id, amount: 15, note: 'with Sam, reimbursable' })).status).toBe(200);
    await refusedWith(a.change, a.id, `A transaction on it (${a.row}) was changed since in another way`);
    expect((await findManualTxn(ctx, a.row))!.row.note).toBe('with Sam, reimbursable');

    const b = await made();
    expect((await app('transaction-annotations', 'PATCH', { transaction_id: b.row, excluded: true })).status).toBe(200);
    await refusedWith(b.change, b.id, 'or something was said about it');

    const c = await made();
    const [one, two] = (await readTaxonomy(ctx))!.categories;
    const parts = [{ amount: 5, category_id: one.id }, { amount: 7, category_id: two.id }];
    expect((await app('transaction-splits', 'PUT', { transaction_id: c.row, parts })).status).toBe(200);
    await refusedWith(c.change, c.id, 'was split or put in a group since');
  });

  /** A share of the container's owner, to someone they're connected with,
   *  as stored (lib/sharing.ts). */
  const shareOf = async (share: unknown) => {
    const { ownersKey } = await import('@/lib/owners');
    const { connectionsKey, connectionId } = await import('@/lib/sharing');
    const id = connectionId('user_me', 'user_sam');
    await fake.hset(ownersKey(), { user_me: ctx.container });
    await fake.hset(connectionsKey(), {
      [id]: JSON.stringify({ users: ['user_me', 'user_sam'], status: 'active', created_at: new Date(NOW).toISOString() }),
      [`${id}|share|user_me`]: typeof share === 'string' ? share : JSON.stringify(share),
    });
  };

  test('nothing the person set elsewhere is named for it: shares of others, series on other accounts, settings for others', async () => {
    const a = await made();
    await shareOf({ accounts: { acc_chk: 'balance' }, updated_at: new Date(NOW).toISOString() });
    const { connectionsKey, connectionId } = await import('@/lib/sharing');
    // What the other side shares is theirs, whatever ids it names.
    await fake.hset(connectionsKey(), { [`${connectionId('user_me', 'user_sam')}|share|user_sam`]: JSON.stringify({ accounts: { [a.id]: 'balance' }, updated_at: new Date(NOW).toISOString() }) });
    // A share left without its connection's record counts for nothing.
    await fake.hset(connectionsKey(), { ['0'.repeat(32) + '|share|user_me']: JSON.stringify({ accounts: { [a.id]: 'balance' }, updated_at: new Date(NOW).toISOString() }) });
    await plannedStore.set(ctx, { version: 1, items: [], dismissed: ['bill|Home|Cash jar savings|lunch|USD|1200', 'bill|Elsewhere|Cash jar|lunch|USD|1200', 'no bars here'], threshold: null });
    await allocationSettingsStore.set(ctx, { v: 1, buckets: [{ account_id: 'acc_chk', bucket: 'taxable' }], funds: [], accounts: [], target: null });
    expect((await undo(a.change)).status).toBe(200);
    expect(await getManualAccount(ctx, a.id)).toBeNull();
  });

  test('a series marked not recurring on another account of the same names isn’t this one’s', async () => {
    // The token makes a Wallet under Cash, beside the person's own, and adds a
    // coffee to it; the person marked their own Wallet's market not recurring.
    const twin = await send('POST', 'manual-accounts', { body: { name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 5 } });
    expect((await send('POST', 'transactions', { body: { ...coffee, account_id: twin.body.account.id } })).status).toBe(201);
    await plannedStore.set(ctx, { version: 1, items: [], dismissed: ['bill|Cash|Wallet|farmers market|USD|2500'], threshold: null });
    expect((await undo(twin.body.change_id)).status).toBe(200);
    expect(await getManualAccount(ctx, twin.body.account.id)).toBeNull();
    // One naming a payee on it is its own, whatever the case of its institution.
    const again = await send('POST', 'manual-accounts', { body: { name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 5 } });
    expect((await send('POST', 'transactions', { body: { ...coffee, account_id: again.body.account.id } })).status).toBe(201);
    await plannedStore.set(ctx, { version: 1, items: [], dismissed: ['bill|CASH|Wallet|coffee|USD|450'], threshold: null });
    const refused = await quietly(() => undo(again.body.change_id));
    expect([refused.status, refused.body.error.message]).toEqual([409, 'A recurring series on the account was marked not recurring, so the account wasn’t removed: remove it in the app if you want it gone.']);
  });

  test('a row added in another way, or anything naming the account: refused, saying what', async () => {
    const { setGoals } = await import('@/lib/goals');
    const { linkAccounts } = await import('@/lib/links');
    const { rulesStore } = await import('@/lib/rules');
    const { timelineNotesStore } = await import('@/lib/timeline-notes');
    const { setAccountHidden } = await import('@/lib/hidden');
    const cases: [string, (id: string) => Promise<unknown>, string][] = [
      ['a row added in the app', (id) => app('manual-transactions', 'POST', { ...coffee, account_id: id }), 'was added since in another way'],
      ['hidden', (id) => setAccountHidden(ctx, id, 'depository', true), 'The account was hidden since'],
      ['a goal', (id) => setGoals(ctx, [{ id: 'g1', name: 'Rainy day', target: 1000, account_id: id }]), 'A goal tracks the account'],
      ['a link', (id) => linkAccounts(ctx, 'acc_old', id, {}), 'The account is linked to another'],
      [
        'a rule',
        (id) =>
          rulesStore.set(ctx, {
            version: 1,
            rules: [{ id: '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', enabled: true, priority: 1, conditions: [{ field: 'account', op: 'equals', value: id }], actions: { hide: true }, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() }],
          }),
        'A rule names the account',
      ],
      ['a note', (id) => timelineNotesStore.set(ctx, 'n1', { date: daysAgo(0, NOW), text: 'Opened the jar', kind: 'user', account_id: id, created_at: new Date(NOW).toISOString() }), 'A note on the timeline is about the account'],
      ['a tax bucket', (id) => allocationSettingsStore.set(ctx, { v: 1, buckets: [{ account_id: id, bucket: 'roth' }], funds: [], accounts: [], target: null }), 'A tax bucket or split on the Plan tab is set for the account'],
      ['a split', (id) => allocationSettingsStore.set(ctx, { v: 1, buckets: [], funds: [], accounts: [{ account_id: id, split: { 'us-stocks': 60, bonds: 40 } }], target: null }), 'A tax bucket or split on the Plan tab is set for the account'],
      ['a share', (id) => shareOf({ accounts: { [id]: 'balance' }, updated_at: new Date(NOW).toISOString() }), 'The account is shared with someone you’re connected with'],
      ['a share that ended', (id) => shareOf({ expiring: { [id]: 'exists' }, expires_at: new Date(NOW - 1000).toISOString(), updated_at: new Date(NOW).toISOString() }), 'The account is shared with someone you’re connected with'],
      ['a share that can’t be read', () => shareOf('{not json'), 'The account is shared with someone you’re connected with'],
      ['a series marked not recurring', () => plannedStore.set(ctx, { version: 1, items: [], dismissed: ['bill|home|Cash jar|lunch|USD|1200'], threshold: null }), 'A recurring series on the account was marked not recurring'],
    ];
    for (const [what, touch, words] of cases) {
      fake.reset();
      forgetEpochs();
      await registerTestContainer(fake);
      await seedPerson(fake);
      await ensureTaxonomy(ctx);
      writer = (await createToken(ctx, 'Importer', new Date(NOW), null, 'write')).token;
      const a = await made();
      await touch(a.id);
      expect([what, (await quietly(() => undo(a.change))).body.error?.message?.includes(words)]).toEqual([what, true]);
      expect(await getManualAccount(ctx, a.id)).not.toBeNull();
    }
  });

  test('what the token itself did since is its own: a row it changed, a balance it set, a name it gave', async () => {
    const a = await made();
    const v = (await send('GET', `transactions/${a.row}`)).body.transaction.version;
    expect((await send('PATCH', `transactions/${a.row}`, { body: { amount: 13, note: 'mine' }, headers: { 'if-match': v } })).status).toBe(200);
    expect((await send('POST', `manual-accounts/${a.id}/balance`, { body: { balance: 87 } })).status).toBe(200);
    const av = (await send('GET', `manual-accounts/${a.id}`)).body.account.version;
    expect((await send('PATCH', `manual-accounts/${a.id}`, { body: { name: 'Coins' }, headers: { 'if-match': av } })).status).toBe(200);
    const r = await undo(a.change);
    expect(r.status).toBe(200);
    expect(await getManualAccount(ctx, a.id)).toBeNull();
    expect(await findManualTxn(ctx, a.row)).toBeNull();
  });

  test('checked and taken out under the links lock: while another change to accounts holds it, refused and nothing changed', async () => {
    const a = await made();
    fake.strings.set(ctxKey('account-links:lock'), 'someone-else');
    await refusedWith(a.change, a.id, 'Another change to your accounts is in progress');
    fake.strings.delete(ctxKey('account-links:lock'));
    expect((await undo(a.change)).status).toBe(200);
  });

  test('one cut off part way is finished by the next undo asked, under the same id', async () => {
    const history = await import('@/lib/history');
    const a = await made();
    await recordSnapshot(ctx, 1000, { acc_chk: 900, [a.id]: 100 });
    const day = new Date(NOW).toISOString().slice(0, 10);
    const cut = spyOn(history, 'foldHiddenAccount').mockRejectedValueOnce(new Error('the function was stopped'));
    const first = await quietly(() => undo(a.change));
    cut.mockRestore();
    expect(first.status).toBe(500);
    const original = (await changeStore.get(ctx, a.change))!;
    expect(original.undone_by).toBeUndefined();
    const pending = (await changeStore.get(ctx, original.undoing!))!;
    expect([pending.op, pending.state, pending.progress]).toEqual(['undo', 'failed', 'folding']);
    // Deleted, and hidden with its fold's progress: out of the totals meanwhile.
    expect(await getManualAccount(ctx, a.id)).toBeNull();
    expect((await getHiddenAccounts(ctx)).get(a.id)?.forget_tag).toBeString();

    const second = await undo(a.change);
    expect([second.status, second.body.undo]).toEqual([200, original.undoing]);
    expect((await getHiddenAccounts(ctx)).has(a.id)).toBe(false);
    const balances = JSON.parse(await decrypt(ctx, fake.hashes.get(ctxKey('history:accounts'))!.get(day)!)) as Record<string, number>;
    expect(Object.keys(balances)).not.toContain(a.id);
    expect(Number(await decrypt(ctx, fake.hashes.get(ctxKey('history:net-worth'))!.get(day)!))).toBe(900);
    const settled = (await changeStore.get(ctx, a.change))!;
    expect([settled.undone_by, settled.undoing]).toEqual([original.undoing, undefined]);
    expect((await changeStore.get(ctx, original.undoing!))!).toMatchObject({ state: 'done' });
    expect((await changeStore.get(ctx, original.undoing!))!.progress).toBeUndefined();
  });

  /** An undo of `change` cut off as it folds the account out of past
   *  totals: the undo's id. */
  const cutInFold = async (change: string) => {
    const history = await import('@/lib/history');
    const cut = spyOn(history, 'foldHiddenAccount').mockRejectedValueOnce(new Error('the function was stopped'));
    try {
      expect((await quietly(() => undo(change))).status).toBe(500);
    } finally {
      cut.mockRestore();
    }
    return (await changeStore.get(ctx, change))!.undoing!;
  };

  /** An undo of `change` cut off inside the app's delete, after its rows
   *  went and before the account did: the undo's id. */
  const cutInDelete = async (change: string) => {
    const md = await import('@/lib/manual');
    const cut = spyOn(md, 'removeManualAccount').mockRejectedValueOnce(new Error('the function was stopped'));
    try {
      expect((await quietly(() => undo(change))).status).toBe(500);
    } finally {
      cut.mockRestore();
    }
    return (await changeStore.get(ctx, change))!.undoing!;
  };
  /** The day's recorded net worth, as the chart reads it. */
  const netWorthToday = async () => Number(await decrypt(ctx, fake.hashes.get(ctxKey('history:net-worth'))!.get(new Date(NOW).toISOString().slice(0, 10))!));
  const CUT = 'An earlier undo of it stopped part way through taking it out, so transactions this token added to it may be gone already; that undo is recorded as stopped, and the change can be undone again once nothing else names the account.';

  /** The person keeps the account a cut-off undo left standing: their own
   *  row on it, and a resume refused for it. The undo's id and the row's. */
  const keptByThePerson = async (a: Awaited<ReturnType<typeof made>>) => {
    const undoing = await cutInDelete(a.change);
    expect((await changeStore.get(ctx, undoing))!).toMatchObject({ op: 'undo', state: 'failed', progress: 'deleting', before: { account_id: a.id, name: 'Cash jar' } });
    expect(await findManualTxn(ctx, a.row)).toBeNull();
    expect(await getManualAccount(ctx, a.id)).not.toBeNull();
    expect((await app('manual-transactions', 'POST', { account_id: a.id, date: daysAgo(0, NOW), amount: 3, currency: 'USD', name: 'Mine' })).status).toBe(200);
    const mine = (await manualTxnStore.get(ctx, a.id))!.rows.find((r) => r.name === 'Mine')!;
    const refused = await quietly(() => undo(a.change));
    expect([refused.status, refused.body.error.code, refused.body.error.message]).toEqual([
      409,
      'conflict',
      `A transaction on it (${mine.id}) was added since in another way, so the account wasn’t removed: remove it in the app if you want it gone. ${CUT}`,
    ]);
    return { undoing, mine: mine.id };
  };

  test('one cut off inside its delete, its rows gone: a resume refused while the person keeps the account ends it, recorded, and the change is undone afresh later', async () => {
    const a = await made();
    const { undoing, mine } = await keptByThePerson(a);
    // Ended: recorded as it stopped, and its name off the change.
    expect((await changeStore.get(ctx, undoing))!).toMatchObject({ state: 'failed', progress: 'deleting', error: 'standing' });
    expect((await changeStore.get(ctx, a.change))!.undoing).toBeUndefined();
    expect(await findManualTxn(ctx, mine)).not.toBeNull();
    // Once the person's row is gone, an undo asked again is a new one, and finishes.
    expect((await app('manual-transactions', 'DELETE', { id: mine, account_id: a.id })).status).toBe(200);
    const again = await undo(a.change);
    expect(again.status).toBe(200);
    expect(again.body.undo).not.toBe(undoing);
    expect(await getManualAccount(ctx, a.id)).toBeNull();
    expect((await changeStore.get(ctx, a.change))!.undone_by).toBe(again.body.undo);
    expect((await changeStore.get(ctx, undoing))!.state).toBe('failed');
  });

  test('while the person’s own row is what keeps it, the change can be forgotten', async () => {
    const a = await made();
    await keptByThePerson(a);
    expect((await app('api-changes', 'POST', { action: 'forget', id: a.change })).status).toBe(200);
    expect((await changeStore.get(ctx, a.change))!.forgotten_at).toBeString();
    expect(await getManualAccount(ctx, a.id)).not.toBeNull();
  });

  test('never folds days it didn’t take out: the account deleted in the app after a refused resume, or before any', async () => {
    // After a resume refused while the person kept it: a later undo finds
    // the account gone by their hand, and leaves past totals alone.
    const a = await made();
    await recordSnapshot(ctx, 1000, { acc_chk: 900, [a.id]: 100 });
    await keptByThePerson(a);
    expect((await app('manual-accounts', 'DELETE', { account_id: a.id })).status).toBe(200);
    const later = await quietly(() => undo(a.change));
    expect([later.status, later.body.error.message]).toEqual([409, 'The account no longer exists.']);
    expect(await netWorthToday()).toBe(1000);

    // Cut off inside its delete, then deleted in the app before any resume:
    // it can't tell who took the account out, so it folds nothing, ends, and
    // the change can be forgotten.
    const b = await made();
    await recordSnapshot(ctx, 1500, { acc_chk: 900, [b.id]: 600 });
    const undoing = await cutInDelete(b.change);
    expect((await app('manual-accounts', 'DELETE', { account_id: b.id })).status).toBe(200);
    const gone = await quietly(() => undo(b.change));
    expect([gone.status, gone.body.error.code, gone.body.error.message]).toEqual([
      409,
      'conflict',
      'The account is gone, but an earlier undo stopped part way through taking it out and can’t tell whether it was deleted in the app since, so past totals are left as they are, as the app’s own delete leaves them.',
    ]);
    expect(await netWorthToday()).toBe(1500);
    expect((await changeStore.get(ctx, undoing))!).toMatchObject({ state: 'failed', progress: 'deleting', error: 'removed' });
    expect((await changeStore.get(ctx, b.change))!.undoing).toBeUndefined();
    expect((await app('api-changes', 'POST', { action: 'forget', id: b.change })).status).toBe(200);
  });

  test('two undos at once: one is named on the change and runs, the other is told so, or answered as it once done, and leaves nothing', async () => {
    const a = await made();
    // Each undo held after its first write until both have made theirs, so
    // both have read the change before either names itself on it.
    const changes = await import('@/lib/api-changes');
    const real = changes.beginChange;
    let begun = 0;
    let release = () => {};
    const both = new Promise<void>((r) => (release = r));
    const slow = spyOn(changes, 'beginChange').mockImplementation(async (c, id, change) => {
      await real(c, id, change);
      if (change.op !== 'undo') return;
      if (++begun === 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, 2000))]);
    });
    let answers: Sent[];
    try {
      answers = await Promise.all([undo(a.change), undo(a.change)]);
    } finally {
      slow.mockRestore();
    }
    const won = answers.find((r) => r.status === 200)!;
    const lost = answers.find((r) => r !== won)!;
    expect([200, 409]).toContain(lost.status);
    if (lost.status === 409) expect(lost.body.error.message).toBe('An undo of this change is under way. Ask again in a moment.');
    else expect(lost.body.undo).toBe(won.body.undo);
    expect(await getManualAccount(ctx, a.id)).toBeNull();
    const undos = [...(await changeStore.getAll(ctx)).entries()].filter(([, c]) => c.op === 'undo');
    expect(undos.map(([id, c]) => [id, c.state])).toEqual([[won.body.undo, 'done']]);
    expect((await changeStore.get(ctx, a.change))!.undone_by).toBe(won.body.undo);
    expect(begun).toBe(2);
  });

  test('a resume refused never takes the name of the undo under way off the change, and one still pending isn’t run beside', async () => {
    const a = await made();
    const undoing = await cutInFold(a.change);
    // Refused at the lock (another change to accounts holds it): untouched.
    fake.strings.set(ctxKey('account-links:lock'), 'someone-else');
    const locked = await quietly(() => undo(a.change));
    fake.strings.delete(ctxKey('account-links:lock'));
    expect([locked.status, locked.body.error.message]).toEqual([409, 'Another change to your accounts is in progress. Try again in a moment.']);
    expect((await changeStore.get(ctx, a.change))!.undoing).toBe(undoing);
    expect((await changeStore.get(ctx, undoing))!).toMatchObject({ state: 'failed', progress: 'folding' });
    // As if its function were stopped outright, never settled: pending, and
    // may still be running until every route that could run it has stopped.
    await changeStore.update(ctx, undoing, (c) => (c ? { ...c, state: 'pending' } : null));
    const soon = await undo(a.change);
    expect([soon.status, soon.body.error.message]).toEqual([409, 'An undo of this change is under way. Ask again in a moment.']);
    expect((await changeStore.get(ctx, undoing))!).toMatchObject({ state: 'pending', progress: 'folding' });
    setSystemTime(new Date(NOW + PENDING_MS + 1000));
    const later = await undo(a.change);
    expect([later.status, later.body.undo]).toEqual([200, undoing]);
    expect((await getHiddenAccounts(ctx)).has(a.id)).toBe(false);
  });

  test('forget is refused while an undo of the change is under way or cut off, which needs what it kept; once finished, it forgets', async () => {
    const a = await made();
    const undoing = await cutInFold(a.change);
    const one = 'An undo of this change is under way, or stopped part way, and needs what the change kept to finish: undo the change again, then forget it.';
    const all = 'An undo of one of this token’s changes is under way, or stopped part way, and needs what that change kept to finish: undo it again, then forget them.';
    for (const [body, words] of [
      [{ action: 'forget', id: a.change }, one],
      [{ action: 'forget', id: undoing }, one],
      [{ action: 'forget-token', id: a.change }, all],
    ] as const) {
      const r = await app('api-changes', 'POST', body);
      expect([body.action, body.id, r.status, r.body.error]).toEqual([body.action, body.id, 409, words]);
    }
    expect([...(await changeStore.getAll(ctx)).values()].some((c) => c.forgotten_at)).toBe(false);
    expect((await undo(a.change)).status).toBe(200);
    expect((await app('api-changes', 'POST', { action: 'forget-token', id: a.change })).status).toBe(200);
    expect((await changeStore.get(ctx, a.change))!.forgotten_at).toBeString();
  });
});

describe('recorded as it happened', () => {
  test('an undo of a delete refused before it wrote anything: what was said about the row since blocks it, first', async () => {
    const { changeAnnotation } = await import('@/lib/txn-annotations');
    await changeAnnotation(ctx, MARKET, { excluded: true });
    const del = await send('DELETE', `transactions/${MARKET}`, { headers: { 'if-match': await versionOf(`transactions/${MARKET}`) } });
    expect(del.status).toBe(200);
    // A page left open says something about it after it went.
    await changeAnnotation(ctx, MARKET, { excluded: false });
    const r = await app('api-changes', 'POST', { action: 'undo', id: del.body.change_id });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('What was said about it changed since this change was made, so it wasn’t undone. Change it back yourself if you want it as it was.');
    expect(await findManualTxn(ctx, MARKET)).toBeNull();
    expect([...(await changeStore.getAll(ctx)).values()].map((c) => c.op)).toEqual(['transaction.delete']);
  });

  test('an undo refused after it wrote is recorded as failed, never taken out', async () => {
    const annotations = await import('@/lib/txn-annotations');
    await annotations.changeAnnotation(ctx, MARKET, { excluded: true });
    const del = await send('DELETE', `transactions/${MARKET}`, { headers: { 'if-match': await versionOf(`transactions/${MARKET}`) } });
    const { ApiFailure } = await import('@/lib/api-spec');
    const racing = spyOn(annotations, 'restoreAnnotation').mockRejectedValueOnce(new ApiFailure(409, 'conflict', 'What was said about it changed.'));
    const r = await app('api-changes', 'POST', { action: 'undo', id: del.body.change_id });
    racing.mockRestore();
    expect(r.status).toBe(409);
    // The row is back: the undo says it failed part way.
    expect(await findManualTxn(ctx, MARKET)).not.toBeNull();
    const undo = [...(await changeStore.getAll(ctx)).values()].find((c) => c.op === 'undo')!;
    expect([undo.state, undo.error]).toEqual(['failed', 'conflict']);
  });

  test('a change whose write landed before storage failed is recorded as failed, never taken out', async () => {
    const writes = await import('@/lib/manual-txn-writes');
    const { StoredDataUnreadableError } = await import('@/lib/repo');
    const real = writes.changeManualTransaction;
    const version = await versionOf(`transactions/${MARKET}`);
    const after = spyOn(writes, 'changeManualTransaction').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await real(...args);
      throw new StoredDataUnreadableError('manual accounts');
    });
    const r = await quietly(() => send('PATCH', `transactions/${MARKET}`, { body: { amount: 31 }, headers: { 'if-match': version } }));
    after.mockRestore();
    expect(r.status).toBe(409);
    expect((await findManualTxn(ctx, MARKET))!.row.amount).toBe(31);
    const [line] = [...(await changeStore.getAll(ctx)).values()];
    expect([line.op, line.state, line.error]).toEqual(['transaction.update', 'failed', 'unreadable']);
  });
});

describe('an undo of a balance', () => {
  test('set back to a balance the type now refuses: a conflict, never a failure', async () => {
    const neg = await send('POST', `manual-accounts/${WALLET}/balance`, { body: { balance: -50 } });
    setSystemTime(new Date(NOW + 1000));
    const up = await send('POST', `manual-accounts/${WALLET}/balance`, { body: { balance: 100 } });
    expect([neg.status, up.status]).toEqual([200, 200]);
    // Made a card since, as the release before could (the app refuses it now).
    await saveManualAccount(ctx, { ...(await getManualAccount(ctx, WALLET))!, type: 'credit' });
    const r = await undo(up.body.change_id);
    expect([r.status, r.body.error.code]).toEqual([409, 'conflict']);
    expect(r.body.error.message).toBe('Credit and loan balances are the amount owed, so they cannot be negative, so it wasn’t undone.');
    expect((await getManualAccount(ctx, WALLET))!.balance).toBe(100);
    expect([...(await changeStore.getAll(ctx)).values()].some((c) => c.op === 'undo')).toBe(false);
  });
});

describe('forgetting takes what the undo kept too', () => {
  test('a token’s changes forgotten: the undo of one of them keeps nothing of what it changed', async () => {
    const made = await send('POST', 'transactions', { body: { ...coffee, name: 'Private thing', note: 'secret note' } });
    expect((await app('api-changes', 'POST', { action: 'undo', id: made.body.change_id })).status).toBe(200);
    expect((await app('api-changes', 'POST', { action: 'forget-token', id: made.body.change_id })).status).toBe(200);
    const raw = [...(await changeStore.getAll(ctx)).values()];
    expect(raw).toHaveLength(2);
    expect(JSON.stringify(raw)).not.toContain('secret note');
    expect(raw.every((c) => c.forgotten_at && c.before === undefined && c.after === undefined)).toBe(true);
  });

  test('forgetting an undo forgets the change it undid, and the other way round', async () => {
    const made = await send('POST', 'tags', { body: { name: 'Trip' } });
    const u = await app('api-changes', 'POST', { action: 'undo', id: made.body.change_id });
    expect((await app('api-changes', 'POST', { action: 'forget', id: u.body.undo })).status).toBe(200);
    expect((await changeStore.get(ctx, made.body.change_id))!.forgotten_at).toBeString();
  });
});
