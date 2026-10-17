import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The review queue's stores (lib/review-store.ts): approvals by transaction
// id, closed in shape, read strictly by every write and with a report by the
// display read, which never takes one it can't read for "not approved"; the
// prune and the carry a pending transaction's approval makes to its posted
// one; only damaged records ever removed, once asked; the settings; what a
// request may ask; and one container never seeing another's.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const store = await import('@/lib/review-store');
const { approvalStore, reviewSettingsStore } = store;
const { encrypt } = await import('@/lib/crypto');
const { UnreadableEntriesError, UnreadableValueError } = await import('@/lib/repo');

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const DAMAGED = 'not-ciphertext-but-long-enough-to-be-tried';
const input = (transaction_id: string, over: Partial<{ amount: number; currency: string | null; category_id: string | null; name: string; pending: boolean }> = {}) => ({
  transaction_id,
  amount: 54.2,
  currency: 'USD',
  category_id: 'c-groceries',
  name: 'Costco',
  pending: false,
  ...over,
});
const NOW = new Date('2026-10-17T12:00:00.000Z');

beforeEach(async () => {
  fake.reset();
  await registerTestContainer(fake);
});

describe('approvals', () => {
  test('approved as shown, and undone back to what each had before', async () => {
    const first = await store.approve(ctx, [input('t1'), input('t2', { pending: true })], NOW);
    expect(first.approved_at).toBe(NOW.toISOString());
    expect([...first.previous]).toEqual([
      ['t1', null],
      ['t2', null],
    ]);
    expect(await approvalStore.get(ctx, 't2')).toEqual({ version: 1, approved_at: NOW.toISOString(), amount: 54.2, currency: 'USD', category_id: 'c-groceries', name: 'Costco', pending: true });
    // Approved again, as it shows now: what it had is what an undo puts back.
    const later = new Date('2026-10-18T12:00:00.000Z');
    const second = await store.approve(ctx, [input('t1', { category_id: 'c-household' })], later);
    expect(second.previous.get('t1')).toMatchObject({ category_id: 'c-groceries', approved_at: NOW.toISOString() });
    expect(await store.undoApprovals(ctx, [{ transaction_id: 't1', approved_at: second.approved_at, previous: second.previous.get('t1')! }])).toBe(1);
    expect((await approvalStore.get(ctx, 't1'))!.category_id).toBe('c-groceries');
    // An undo of one approved again since leaves it; one of none removes it.
    expect(await store.undoApprovals(ctx, [{ transaction_id: 't1', approved_at: second.approved_at, previous: null }])).toBe(0);
    expect(await store.undoApprovals(ctx, [{ transaction_id: 't2', approved_at: first.approved_at, previous: null }])).toBe(1);
    expect(await approvalStore.get(ctx, 't2')).toBeNull();
    expect(await approvalStore.get(ctx, 't1')).not.toBeNull();
  });

  test('one that can’t be read refuses the whole approve and undo, writing nothing over it', async () => {
    await fake.hset(ctxKey('transaction-approvals'), { t1: DAMAGED });
    const refused = await store.approve(ctx, [input('t1'), input('t2')]).catch((e) => e);
    expect(refused).toBeInstanceOf(UnreadableEntriesError);
    expect(refused.unreadable).toEqual(['t1']);
    expect(await approvalStore.has(ctx, 't2')).toBe(false);
    await expect(store.undoApprovals(ctx, [{ transaction_id: 't1', approved_at: NOW.toISOString(), previous: null }])).rejects.toBeInstanceOf(UnreadableEntriesError);
    expect(fake.hashes.get(ctxKey('transaction-approvals'))!.get('t1')).toBe(DAMAGED);
  });

  test('the display read names what it can’t use and returns the rest: never empty for it', async () => {
    await store.approve(ctx, [input('t1'), input('t2')], NOW);
    const later = { ...(await approvalStore.get(ctx, 't2')), weight: 1 };
    await fake.hset(ctxKey('transaction-approvals'), { t2: await encrypt(ctx, JSON.stringify(later)), t3: DAMAGED });
    const read = await store.readApprovalsForDisplay(ctx, ['t1', 't2', 't3', 't4', 'split:p1', 'group:g1']);
    expect([...read.approvals.keys()]).toEqual(['t1']);
    expect([...read.unknown].sort()).toEqual(['t2', 't3']);
    // A part's or a group's row is never an approval's id.
    expect(store.isApprovalId('split:p1')).toBe(false);
    expect(store.isApprovalId('split-rest:t1')).toBe(false);
    expect(store.isApprovalId('group:g1')).toBe(false);
  });

  test('closed in shape: a field this release doesn’t know makes it unrecognised', () => {
    const ok = { version: 1, approved_at: NOW.toISOString(), amount: 1, currency: null, category_id: null, name: '' };
    expect(store.isApproval(ok)).toBe(true);
    expect(store.isApproval({ ...ok, parts: ['p1'] })).toBe(false);
    expect(store.isApproval({ ...ok, version: 2 })).toBe(false);
    expect(store.isApproval({ ...ok, pending: false })).toBe(false);
    expect(store.isApproval({ ...ok, amount: Number.NaN })).toBe(false);
  });

  test('a repair removes only damaged ones, and the settings only when theirs are', async () => {
    await store.approve(ctx, [input('t1')], NOW);
    const later = { ...(await approvalStore.get(ctx, 't1')), weight: 1 };
    await fake.hset(ctxKey('transaction-approvals'), { t2: DAMAGED, t3: await encrypt(ctx, JSON.stringify(later)) });
    await fake.set(ctxKey('review-settings'), DAMAGED);
    expect(await store.repairReview(ctx)).toEqual({ removed: 1, settings: true, unrecognised: 1 });
    expect([...fake.hashes.get(ctxKey('transaction-approvals'))!.keys()].sort()).toEqual(['t1', 't3']);
    expect(fake.strings.has(ctxKey('review-settings'))).toBe(false);
  });

  test('a person’s own category on an approved transaction is what its approval holds', async () => {
    await store.approve(ctx, [input('t1')], NOW);
    await store.noteRecategorized(ctx, 't1', 'c-household');
    expect((await approvalStore.get(ctx, 't1'))!.category_id).toBe('c-household');
    // Nothing for one not approved.
    await store.noteRecategorized(ctx, 't9', 'c-household');
    expect(await approvalStore.has(ctx, 't9')).toBe(false);
  });

  test('past the most kept, new approvals are refused whole; changing one there already never is', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < store.MAX_APPROVALS; i++) many[`x${i}`] = 'v';
    await fake.hset(ctxKey('transaction-approvals'), many);
    await expect(store.approve(ctx, [input('t_new')])).rejects.toMatchObject({ status: 409 });
    expect(await approvalStore.has(ctx, 't_new')).toBe(false);
  });

  test('the refusal says truly what makes room, and making room forgets the oldest, by when they were made', async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));
    await store.approve(ctx, [input('t_old')], day(1));
    await store.approve(ctx, [input('t_mid')], day(2));
    await store.approve(ctx, [input('t_new')], day(3));
    // Changing one already kept is never refused; a new one past the bound is.
    await store.approve(ctx, [input('t_mid', { category_id: 'c-household' })], day(4), 3);
    const refused = await store.approve(ctx, [input('t_more')], day(4), 3).catch((e) => e);
    expect(refused).toMatchObject({ status: 409 });
    expect(refused.message).toContain('To make room, forget your 10,000 oldest on the Review queue card under Manage: those transactions stay, filed as ones you never approved are');
    expect(refused.message).not.toContain('off and on');
    // The oldest by when they were made: t_mid was made again on day 4.
    expect(await store.makeRoom(ctx, 2)).toEqual({ removed: 2, through: day(3).toISOString() });
    expect([...fake.hashes.get(ctxKey('transaction-approvals'))!.keys()]).toEqual(['t_mid']);
    expect(await store.makeRoom(ctx)).toEqual({ removed: 1, through: day(4).toISOString() });
    expect(await store.makeRoom(ctx)).toEqual({ removed: 0, through: null });
  });

  test('the person’s own edit of a row’s amount or currency is what its approval holds; nothing for one not approved', async () => {
    const id = 'manual-txn:6b1f3e2a-1c4d-4e5f-8a9b-0c1d2e3f4a5b';
    await store.approve(ctx, [input(id, { amount: 64.5 })], NOW);
    await store.followEdit(ctx, id, { amount: 46.5, currency: 'USD' });
    expect(await approvalStore.get(ctx, id)).toMatchObject({ amount: 46.5, currency: 'USD', approved_at: NOW.toISOString() });
    await store.followEdit(ctx, 'manual-txn:00000000-0000-4000-8000-000000000000', { amount: 1, currency: 'USD' });
    expect(await approvalStore.count(ctx)).toBe(1);
  });
});

describe('gone with the transaction', () => {
  test('what a prune may forget: bank ids only, the removed ones by id, damaged ones too, never one a later release wrote', async () => {
    await store.approve(ctx, [input('t1'), input('t2'), input('manual-txn:6b1f3e2a-1c4d'), input('imported-txn:abc')], NOW);
    const later = { ...(await approvalStore.get(ctx, 't2')), weight: 1 };
    await fake.hset(ctxKey('transaction-approvals'), { t2: await encrypt(ctx, JSON.stringify(later)), t3: DAMAGED });
    expect((await store.approvalsToPrune(ctx)).sort()).toEqual(['t1', 't3']);
    expect((await store.approvalsToPrune(ctx, new Set(['t2', 't3', 't9', 'manual-txn:6b1f3e2a-1c4d']))).sort()).toEqual(['t3']);
    expect(await store.approvalsToPrune(ctx, new Set(['t1']))).toEqual(['t1']);
    await store.forgetApprovals(ctx, ['t1', 'manual-txn:6b1f3e2a-1c4d', 'split:p1']);
    expect([...fake.hashes.get(ctxKey('transaction-approvals'))!.keys()].sort()).toEqual(['imported-txn:abc', 't2', 't3']);
  });

  test('a disconnect’s prune forgets bank transactions no Item holds, never while a store can’t be read; a manual row’s goes with the row', async () => {
    const { pruneSplitsAndGroups, forgetSplitsAndGroups } = await import('@/lib/split-gone');
    await store.approve(ctx, [input('t_kept'), input('t_gone'), input('manual-txn:6b1f3e2a-1c4d'), input('imported-txn:abc')], NOW);
    // A store that can't be read: nothing goes.
    await pruneSplitsAndGroups(ctx, async () => null);
    expect(await approvalStore.count(ctx)).toBe(4);
    await pruneSplitsAndGroups(ctx, async () => new Set(['t_kept']));
    expect([...fake.hashes.get(ctxKey('transaction-approvals'))!.keys()].sort()).toEqual(['imported-txn:abc', 'manual-txn:6b1f3e2a-1c4d', 't_kept']);
    // Deleted with its row: a manual row's, or an undone import's.
    await forgetSplitsAndGroups(ctx, ['manual-txn:6b1f3e2a-1c4d', 'imported-txn:abc']);
    expect([...fake.hashes.get(ctxKey('transaction-approvals'))!.keys()]).toEqual(['t_kept']);
  });

  test('nothing ever approved reads nothing more than a count', async () => {
    fake.ops = 0;
    expect(await store.readApprovalsForDisplay(ctx, ['t1', 't2'])).toEqual({ approvals: new Map(), unknown: new Set() });
    expect(fake.ops).toBe(1);
  });

  test('a pending transaction’s approval moves to the posted one that replaced it, unless that has its own', async () => {
    await store.approve(ctx, [input('p1', { pending: true }), input('p2', { pending: true }), input('q2', { name: 'Own' }), input('p3', { pending: true })], NOW);
    await fake.hset(ctxKey('transaction-approvals'), { q3: DAMAGED });
    const rows = [
      { transaction_id: 'q1', pending_transaction_id: 'p1', pending: false },
      { transaction_id: 'q2', pending_transaction_id: 'p2', pending: false },
      { transaction_id: 'q3', pending_transaction_id: 'p3', pending: false },
      { transaction_id: 'still', pending_transaction_id: null, pending: true },
    ];
    expect(await store.carryApprovalsToPosted(ctx, new Set(['p1', 'p2', 'p3']), rows)).toBe(2);
    expect(await approvalStore.get(ctx, 'q1')).toMatchObject({ pending: true, amount: 54.2 });
    expect(await approvalStore.has(ctx, 'p1')).toBe(false);
    expect((await approvalStore.get(ctx, 'q2'))!.name).toBe('Own');
    expect(await approvalStore.has(ctx, 'p2')).toBe(false);
    // The posted one's can't be read: nothing moves over it.
    expect(await approvalStore.has(ctx, 'p3')).toBe(true);
    expect(fake.hashes.get(ctxKey('transaction-approvals'))!.get('q3')).toBe(DAMAGED);
  });
});

describe('the queue’s settings', () => {
  test('on from a day, off with every approval kept, on again from a new day', async () => {
    expect(await store.readReviewSettings(ctx)).toEqual({ settings: null, unreadable: false, unrecognised: false });
    expect(await store.stopReview(ctx)).toBeNull();
    const on = await store.startReview(ctx, '2026-10-17', NOW);
    expect(on).toMatchObject({ on: true, since: '2026-10-17' });
    await store.approve(ctx, [input('t1')], NOW);
    expect(await store.stopReview(ctx, NOW)).toMatchObject({ on: false, since: '2026-10-17' });
    expect(await approvalStore.has(ctx, 't1')).toBe(true);
    expect(await store.startReview(ctx, '2026-10-20', NOW)).toMatchObject({ on: true, since: '2026-10-20' });
  });

  test('settings that can’t be read are never saved over', async () => {
    await fake.set(ctxKey('review-settings'), DAMAGED);
    expect(await store.readReviewSettings(ctx)).toEqual({ settings: null, unreadable: true, unrecognised: false });
    await expect(store.startReview(ctx, '2026-10-17')).rejects.toBeInstanceOf(UnreadableValueError);
    await expect(store.stopReview(ctx)).rejects.toBeInstanceOf(UnreadableValueError);
    expect(fake.strings.get(ctxKey('review-settings'))).toBe(DAMAGED);
  });

  test('one container never sees another’s', async () => {
    await store.startReview(ctx, '2026-10-17');
    await store.approve(ctx, [input('t1')]);
    expect((await store.readReviewSettings(OTHER)).settings).toBeNull();
    expect((await store.readApprovalsForDisplay(OTHER, ['t1'])).approvals.size).toBe(0);
  });
});

describe('what a request may ask', () => {
  test('today is a day some time zone is in now; the queue starts from it, at most a month back, never after', () => {
    const now = Date.parse('2026-10-17T03:00:00Z');
    expect(store.currentDays(now)).toEqual(['2026-10-16', '2026-10-17']);
    expect(store.todayOf('2026-10-16', now)).toBe('2026-10-16');
    expect(store.todayOf('2026-10-10', now)).toBe('2026-10-17');
    expect(store.todayOf(undefined, now)).toBe('2026-10-17');
    expect(store.startDay(undefined, '2026-10-17')).toBe('2026-10-17');
    expect(store.startDay('2026-09-16', '2026-10-17')).toBe('2026-09-16');
    expect(() => store.startDay('2026-09-15', '2026-10-17')).toThrow('at most 31 days back');
    expect(() => store.startDay('2026-10-18', '2026-10-17')).toThrow('after today');
    expect(() => store.startDay('2026-02-30', '2026-10-17')).toThrow('a date');
    expect(() => store.startDay('2019-01-01', '2026-10-17')).toThrow('years of history');
  });

  test('an approval is exactly the transaction as shown; anything else is refused, never guessed', () => {
    expect(store.parseApprovals([input('t1', { category_id: 'new:abc' })])).toEqual([{ ...input('t1'), category_id: null }]);
    const refused = (items: unknown) => {
      try {
        store.parseApprovals(items);
        return null;
      } catch (err) {
        return err instanceof store.ApprovalError ? err.message : String(err);
      }
    };
    expect(refused([])).toBe('Say which transactions to approve.');
    expect(refused({})).toBe('Say which transactions to approve.');
    expect(refused(Array.from({ length: 501 }, (_, i) => input(`t${i}`)))).toBe('At most 500 transactions to approve at a time.');
    expect(refused(['t1'])).toBe('Each of the transactions to approve is an object.');
    expect(refused([{ ...input('t1'), note: 'x' }])).toBe('note isn’t part of an approval.');
    expect(refused([{ ...input('t1'), amount: '54.20' }])).toBe('Each approval needs the amount it was shown with.');
    expect(refused([{ ...input('t1'), amount: Number.POSITIVE_INFINITY }])).toBe('Each approval needs the amount it was shown with.');
    expect(refused([{ ...input('t1'), currency: 'usd' }])).toBe('A currency is a code, or null.');
    expect(refused([{ ...input('t1'), category_id: 'has space' }])).toBe('Invalid category id');
    expect(refused([{ ...input('t1'), name: 'x'.repeat(301) }])).toBe('A name is text, at most 300 characters.');
    expect(refused([{ ...input('t1'), pending: 'no' }])).toBe('Say whether it is pending.');
    expect(refused([input('split:p1')])).toBe('Invalid transaction id');
    expect(refused([input('group:g1')])).toBe('Invalid transaction id');
    expect(refused([input('has space')])).toBe('Invalid transaction id');
    expect(refused([input('manual-txn:')])).toBe('Invalid transaction id');
    const { transaction_id: _, ...withoutId } = input('t1');
    expect(refused([withoutId])).toBe('Invalid transaction id');
  });

  test('an undo names the transaction, when it was approved, and an approval or none it had', () => {
    const ok = { transaction_id: 't1', approved_at: NOW.toISOString(), previous: null };
    expect(store.parseUndo([ok])).toEqual([ok]);
    expect(() => store.parseUndo([{ ...ok, approved_at: 'yesterday' }])).toThrow('when the approval');
    expect(() => store.parseUndo([{ ...ok, previous: { version: 1 } }])).toThrow('isn’t an approval');
    expect(() => store.parseUndo([{ ...ok, extra: 1 }])).toThrow('An undo names');
  });
});
