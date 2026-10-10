import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Detection (#50, lib/lifecycle-questions.ts): an account missing from a
// healthy answer, and a balance at zero for weeks, raise a question. Until a
// missing account's is answered it is held at its last known balance and no
// total is recorded; if nobody answers, the grace window ends in an assumed
// closure the person can correct. Driven through the dashboard's own load
// (app/api/net-worth) and the nightly snapshot, with Plaid stubbed.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const plaid = { accounts: [] as any[] };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async () => ({ data: { item: { institution_id: 'ins_1' }, accounts: plaid.accounts } }),
    investmentsHoldingsGet: async () => ({ data: { accounts: [], holdings: [], securities: [] } }),
    liabilitiesGet: async () => ({ data: { liabilities: {} } }),
    itemRemove: async () => ({ data: {} }),
  },
}));

const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const netWorthRoute = await import('@/app/api/net-worth/route');
const { snapshotData } = await import('@/lib/snapshot-job');
const { lifecycleStore, markStillOpen, markEnded } = await import('@/lib/lifecycle');
const { timelineNotesStore, autoNoteId } = await import('@/lib/timeline-notes');
const { zeroRun, ZERO_DAYS } = await import('@/lib/lifecycle-questions');
const { readMeasuredBalances } = await import('@/lib/history');

const plaidAccount = (account_id: string, type: string, current: number, extra: Record<string, unknown> = {}) => ({
  account_id,
  name: { sav: 'Savings', chk: 'Checking', card: 'Freedom', empty: 'Old Savings' }[account_id] ?? account_id,
  official_name: null,
  type,
  subtype: type === 'credit' ? 'credit card' : 'savings',
  mask: account_id === 'sav' ? '4821' : '0001',
  balances: { available: null, current, limit: null, iso_currency_code: 'USD' },
  ...extra,
});

const SAV = plaidAccount('sav', 'depository', 10_000);
const CHK = plaidAccount('chk', 'depository', 500);
const CARD = plaidAccount('card', 'credit', 2_000);

async function load(day: string, hour = 12) {
  setSystemTime(new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`));
  const res = await netWorthRoute.GET(new Request('http://x/api/net-worth?refresh=1'));
  return { status: res.status, body: await res.json() };
}

const recordedTotals = async () => {
  const raw = (await fake.hgetall<Record<string, string>>(ctxKey('history:net-worth'))) ?? {};
  return Object.keys(raw).sort();
};

const accountRow = (body: any, id: string) => body.institutions.flatMap((i: any) => i.accounts).find((a: any) => a.account_id === id);

beforeEach(async () => {
  setSystemTime();
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_ally', institution_name: 'Ally', encrypted_access_token: await encrypt('tok') });
});

afterEach(() => setSystemTime());

describe('an account missing from a healthy answer', () => {
  test('is held at its last known balance, with its question, and no total is recorded', async () => {
    plaid.accounts = [SAV, CHK];
    expect((await load('2026-03-12')).body.netWorth).toBe(10_500);
    expect(await recordedTotals()).toEqual(['2026-03-12']);

    plaid.accounts = [CHK];
    const { status, body } = await load('2026-03-13');
    expect(status).toBe(200);
    // Not silently dropped: the total holds it.
    expect(body.netWorth).toBe(10_500);
    const held = accountRow(body, 'sav');
    expect(held).toMatchObject({
      name: 'Savings',
      mask: '4821',
      balance: 10_000,
      currency: 'USD',
      stale: true,
      held: { as_of: '2026-03-12' },
      question: { kind: 'missing', since: '2026-03-12', end: '2026-03-13' },
    });
    // Exactly as a fetch error: the gate is closed, so no total for the 13th.
    expect(await recordedTotals()).toEqual(['2026-03-12']);
    const inst = body.institutions.find((i: any) => i.item_id === 'item_ally');
    expect(inst.unconfirmed_missing).toBe(1);
    expect(inst.health.state).toBe('partial');
    // The ids stay on the server; the held row says the same.
    expect('missing_ids' in inst).toBe(false);
    // The account that did answer is still recorded for its own chart.
    const measured = await readMeasuredBalances(ctx, ['2026-03-13']);
    expect(measured.balances.get('2026-03-13')).toEqual({ chk: 500 });
    // And nothing so short is cached.
    expect(await fake.get(ctxKey('cache:net-worth'))).toBeNull();
  });

  test('a closed card raises no false "net worth improved": it is held, not dropped', async () => {
    plaid.accounts = [CHK, CARD];
    expect((await load('2026-03-12')).body.netWorth).toBe(-1_500);
    plaid.accounts = [CHK];
    const { body } = await load('2026-03-13');
    expect(body.netWorth).toBe(-1_500);
    expect(accountRow(body, 'card')).toMatchObject({ type: 'credit', balance: 2_000, stale: true });
    // The chart has no point saying otherwise.
    expect(body.history.map((p: any) => [p.date, p.value])).toEqual([['2026-03-12', -1_500]]);
  });

  test('if nobody answers, the window ends in an assumed closure: shown as such, with its note, and the gate reopens', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    plaid.accounts = [CHK];
    await load('2026-03-13');
    await load('2026-03-15');
    expect(await recordedTotals()).toEqual(['2026-03-12']);

    const { body } = await load('2026-03-16', 13);
    expect(await recordedTotals()).toEqual(['2026-03-12', '2026-03-16']);
    expect(await lifecycleStore.get(ctx, 'sav')).toMatchObject({ lifecycle: { state: 'closed', on: '2026-03-13' }, assumed: true, type: 'depository' });
    expect(body.lifecycle).toEqual([
      expect.objectContaining({ account_id: 'sav', lifecycle: { state: 'closed', on: '2026-03-13' }, assumed: true, label: { name: 'Savings', institution: 'Ally', mask: '4821' } }),
    ]);
    expect(accountRow(body, 'sav')).toBeUndefined();
    expect(body.netWorth).toBe(500);
    // Every day it was measured keeps it; no measurement of it is removed.
    expect(body.history.map((p: any) => [p.date, p.value])).toEqual([
      ['2026-03-12', 10_500],
      ['2026-03-16', 500],
    ]);
    expect(await timelineNotesStore.get(ctx, autoNoteId('sav'))).toMatchObject({ date: '2026-03-13', kind: 'auto', text: 'Savings ••4821 assumed closed: it stopped appearing at Ally' });
  });

  test('an answer of Closed within the window settles it: the gate reopens at once', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    plaid.accounts = [CHK];
    await load('2026-03-13');
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-13' }, { type: 'depository', label: { name: 'Savings', institution: 'Ally', mask: '4821' }, item_id: 'item_ally' });
    const { body } = await load('2026-03-14');
    expect(body.institutions[0].unconfirmed_missing).toBeUndefined();
    expect(await recordedTotals()).toEqual(['2026-03-12', '2026-03-14']);
    expect(body.netWorth).toBe(500);
  });

  test('Still open holds it past the window, and it is never assumed closed', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    plaid.accounts = [CHK];
    await load('2026-03-13');
    await markStillOpen(ctx, 'sav', { kind: 'missing', since: '2026-03-12' }, { type: 'depository', label: { name: 'Savings', institution: 'Ally', mask: '4821' }, item_id: 'item_ally' });
    const { body } = await load('2026-03-25');
    expect(accountRow(body, 'sav')).toMatchObject({ balance: 10_000, question: { kind: 'missing', still_open: true } });
    expect(body.netWorth).toBe(10_500);
    expect(await recordedTotals()).toEqual(['2026-03-12']);
    expect((await lifecycleStore.get(ctx, 'sav'))?.lifecycle).toEqual({ state: 'active' });
  });

  test('a balance older than the recovery limit is held without counting it', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    plaid.accounts = [CHK];
    await load('2026-03-13');
    await markStillOpen(ctx, 'sav', { kind: 'missing', since: '2026-03-12' }, { type: 'depository', label: { name: 'Savings', institution: 'Ally', mask: '4821' }, item_id: 'item_ally' });
    const { body } = await load('2026-05-01');
    expect(accountRow(body, 'sav')).toMatchObject({ balance: null, held: { as_of: null, too_old: '2026-03-12' } });
    expect(body.netWorth).toBe(500);
  });

  test('an assumed closure is lifted when the account comes back, and it counts again', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    plaid.accounts = [CHK];
    await load('2026-03-13');
    await load('2026-03-16', 13);
    expect((await lifecycleStore.get(ctx, 'sav'))?.assumed).toBe(true);

    plaid.accounts = [SAV, CHK];
    const { body } = await load('2026-03-20');
    expect(await lifecycleStore.has(ctx, 'sav')).toBe(false);
    expect(await timelineNotesStore.has(ctx, autoNoteId('sav'))).toBe(false);
    expect(body.lifecycle).toEqual([]);
    expect(accountRow(body, 'sav')).toMatchObject({ balance: 10_000 });
    expect(body.netWorth).toBe(10_500);
  });

  test('a confirmed closure stays closed when the account is still reported', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    await markEnded(ctx, 'sav', { state: 'left', on: '2026-03-13', note: 'Divided' }, { type: 'depository', label: { name: 'Savings', institution: 'Ally', mask: '4821' }, item_id: 'item_ally' });
    const { body } = await load('2026-03-14');
    expect(accountRow(body, 'sav')).toBeUndefined();
    expect(body.netWorth).toBe(500);
    expect(body.lifecycle.map((l: any) => l.lifecycle)).toEqual([{ state: 'left', on: '2026-03-13', note: 'Divided' }]);
    // Recorded as measured (the true total), applied on read.
    expect(await recordedTotals()).toEqual(['2026-03-12', '2026-03-14']);
    expect(body.history.map((p: any) => [p.date, p.value])).toEqual([
      ['2026-03-12', 10_500],
      ['2026-03-14', 500],
    ]);
  });
});

describe('the nightly snapshot', () => {
  test('holds the total while a missing account is unanswered, and records it once an assumed closure is', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    plaid.accounts = [CHK];
    setSystemTime(new Date('2026-03-13T13:00:00Z'));
    expect((await snapshotData(ctx)).status).toBe('unclean');
    setSystemTime(new Date('2026-03-16T13:00:00Z'));
    expect((await snapshotData(ctx)).status).toBe('recorded');
    expect((await lifecycleStore.get(ctx, 'sav'))?.assumed).toBe(true);
  });

  test('answers that can’t be read assume nothing: the account stays held', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    plaid.accounts = [CHK];
    setSystemTime(new Date('2026-03-13T13:00:00Z'));
    await snapshotData(ctx);
    await fake.hset(ctxKey('account-lifecycle'), { other: 'damaged-bytes-damaged-bytes-damaged' });
    setSystemTime(new Date('2026-03-16T13:00:00Z'));
    expect((await snapshotData(ctx)).status).toBe('unclean');
    expect(await lifecycleStore.getMany(ctx, ['sav'])).toEqual(new Map());
  });
});

describe('the dashboard fails loudly rather than count a closed account', () => {
  test('a damaged closure is a 409 naming it, never a total with the account back in', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    await fake.hset(ctxKey('account-lifecycle'), { sav: 'damaged-bytes-damaged-bytes-damaged' });
    const { status, body } = await load('2026-03-13');
    expect(status).toBe(409);
    // Named as closures, so the Accounts tab may offer to remove the damaged one.
    expect(body).toMatchObject({ unreadable: true, unreadable_ids: ['sav'], unrecognised_ids: [], repair: 'account-lifecycle' });
    expect(body.error).toMatch(/account closures could not be read/);
  });

  test('so does one this release doesn’t recognise, which is never offered for removal', async () => {
    plaid.accounts = [SAV, CHK];
    await fake.hset(ctxKey('account-lifecycle'), {
      sav: await encrypt(JSON.stringify({ lifecycle: { state: 'sold', on: '2026-03-01' }, type: 'depository', label: { name: 'S', institution: 'A', mask: null }, item_id: null, set_at: '2026-03-01T00:00:00Z' })),
    });
    const { status, body } = await load('2026-03-13');
    expect(status).toBe(409);
    expect(body).toMatchObject({ unreadable_ids: [], unrecognised_ids: ['sav'] });
  });
});

describe('a balance at zero for weeks', () => {
  const EMPTY = plaidAccount('empty', 'depository', 0);

  /** Days of measured balances, as the snapshot records them. */
  async function measuredDays(from: string, days: number, balances: Record<string, number>) {
    const start = Date.parse(`${from}T00:00:00Z`);
    for (let i = 0; i < days; i++) {
      const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      await fake.hset(ctxKey('history:accounts'), { [date]: await encrypt(JSON.stringify(balances)) });
      await fake.hset(ctxKey('history:net-worth'), { [date]: await encrypt('500') });
    }
  }

  async function withTxns(rows: { account_id: string; date: string }[]) {
    const { encodeJsonBlob } = await import('@/lib/blob');
    const txns = Object.fromEntries(
      rows.map((r, i) => [
        `t${i}`,
        { transaction_id: `t${i}`, account_id: r.account_id, date: r.date, amount: 5, pending: false, name: 'x', merchant_name: null, iso_currency_code: 'USD' },
      ])
    );
    await fake.set(ctxKey('txns:item_ally'), await encodeJsonBlob({ schema_version: 2, cursor: 'c', accounts: {}, txns, synced_at: null }));
  }

  test('asks, with the first day of the zeros prefilled, and holds nothing', async () => {
    await measuredDays('2026-02-01', 40, { chk: 500, empty: 0 });
    plaid.accounts = [CHK, EMPTY];
    const { body } = await load('2026-03-13');
    expect(accountRow(body, 'empty').question).toEqual({ kind: 'zero', end: '2026-02-01', since: '2026-02-01' });
    // A zero can't move net worth whichever way it is answered: the day is recorded.
    expect(body.institutions[0].unconfirmed_missing).toBeUndefined();
    expect((await recordedTotals()).includes('2026-03-13')).toBe(true);
  });

  test('not before it has been zero for four weeks of measured days', async () => {
    await measuredDays('2026-02-20', 20, { chk: 500, empty: 0 });
    plaid.accounts = [CHK, EMPTY];
    expect(accountRow((await load('2026-03-13')).body, 'empty').question).toBeUndefined();
  });

  test('not when it had a balance within the weeks', async () => {
    await measuredDays('2026-02-01', 40, { chk: 500, empty: 0 });
    await fake.hset(ctxKey('history:accounts'), { '2026-03-01': await encrypt(JSON.stringify({ chk: 500, empty: 12 })) });
    plaid.accounts = [CHK, EMPTY];
    expect(accountRow((await load('2026-03-13')).body, 'empty').question).toBeUndefined();
  });

  test('not when a transaction moved through it since the zeros began', async () => {
    await measuredDays('2026-02-01', 40, { chk: 500, empty: 0 });
    await withTxns([{ account_id: 'empty', date: '2026-03-02' }]);
    plaid.accounts = [CHK, EMPTY];
    expect(accountRow((await load('2026-03-13')).body, 'empty').question).toBeUndefined();
  });

  test('a transaction before the zeros doesn’t count against it', async () => {
    await measuredDays('2026-02-01', 40, { chk: 500, empty: 0 });
    await withTxns([{ account_id: 'empty', date: '2026-01-15' }]);
    plaid.accounts = [CHK, EMPTY];
    expect(accountRow((await load('2026-03-13')).body, 'empty').question?.kind).toBe('zero');
  });

  test('not again once answered Still open, until a new run of zeros starts', async () => {
    await measuredDays('2026-02-01', 40, { chk: 500, empty: 0 });
    await markStillOpen(ctx, 'empty', { kind: 'zero', since: '2026-02-01' }, { type: 'depository', label: { name: 'Old Savings', institution: 'Ally', mask: '0001' }, item_id: 'item_ally' });
    plaid.accounts = [CHK, EMPTY];
    expect(accountRow((await load('2026-03-13')).body, 'empty').question).toBeUndefined();
    // Long after, the window no longer reaches the start: the same zeros, not asked again.
    await measuredDays('2026-03-13', 60, { chk: 500, empty: 0 });
    expect(accountRow((await load('2026-05-12')).body, 'empty').question).toBeUndefined();
  });

  test('a hidden account, or one already ended, is not asked about', async () => {
    await measuredDays('2026-02-01', 40, { chk: 500, empty: 0 });
    const { setAccountHidden } = await import('@/lib/hidden');
    await setAccountHidden(ctx, 'empty', 'depository', true);
    plaid.accounts = [CHK, EMPTY];
    expect(accountRow((await load('2026-03-13')).body, 'empty').question).toBeUndefined();
  });

  test('the run of zeros, read from the days measured', () => {
    const m = (pairs: [string, number][]) => new Map(pairs);
    expect(zeroRun(m([['2026-03-01', 0], ['2026-03-02', 0]]), '2026-02-01')).toEqual({ start: '2026-03-01', days: 2, clamped: true });
    expect(zeroRun(m([['2026-03-01', 5], ['2026-03-02', 0], ['2026-03-03', 0]]), '2026-02-01')).toEqual({ start: '2026-03-02', days: 2, clamped: false });
    expect(zeroRun(m([['2026-03-01', 0], ['2026-03-02', 4]]), '2026-02-01')).toBeNull();
    expect(zeroRun(m([]), '2026-02-01')).toBeNull();
    expect(ZERO_DAYS).toBe(28);
  });
});
