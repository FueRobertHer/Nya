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
const lifecycleRoute = await import('@/app/api/account-lifecycle/route');
const { snapshotData } = await import('@/lib/snapshot-job');
const { lifecycleStore, markStillOpen, markEnded } = await import('@/lib/lifecycle');
const { timelineNotesStore, autoNoteId, isMissedNoteId } = await import('@/lib/timeline-notes');
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

/** A change through the route the app uses (app/api/account-lifecycle). */
async function post(body: unknown) {
  const res = await lifecycleRoute.POST(new Request('http://x/api/account-lifecycle', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
  return { status: res.status, body: await res.json() };
}

/** The bank's stored transactions for Ally, as a sync leaves them. */
async function storedTxns(rows: { account_id: string; date: string }[]) {
  const { encodeJsonBlob } = await import('@/lib/blob');
  const txns = Object.fromEntries(
    rows.map((r, i) => [
      `t${i}`,
      { transaction_id: `t${i}`, account_id: r.account_id, date: r.date, amount: 5, pending: false, name: 'x', merchant_name: null, iso_currency_code: 'USD' },
    ])
  );
  await fake.set(ctxKey('txns:item_ally'), await encodeJsonBlob(TEST_CTX, { schema_version: 2, cursor: 'c', accounts: {}, txns, synced_at: null }));
}

const points = (body: any) => body.history.map((p: any) => [p.date, p.value, !!p.estimated]);

/** A row imported into a linked account from a file (#52): the person's own
 *  history, never the bank's word on the account. */
async function importedRow(account_id: string, date: string) {
  const { importedTxnStore } = await import('@/lib/history-import/store');
  await importedTxnStore.set(ctx, account_id, {
    version: 1,
    rows: [
      {
        id: `imported-txn:${account_id}-0000-0000`,
        account_id,
        date,
        amount: 5,
        currency: 'USD',
        name: 'FROM A FILE',
        category: null,
        note: null,
        source: 'import:csv',
        source_id: 'x',
        import_id: 'history-import:a1b2c3d4',
        created_at: '2026-03-01T00:00:00.000Z',
      },
    ],
  });
}

beforeEach(async () => {
  setSystemTime();
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_ally', institution_name: 'Ally', encrypted_access_token: await encrypt(TEST_CTX, 'tok') });
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
    // Every day it was measured keeps it; no measurement of it is removed. The
    // step falls on its own day, drawn as an estimate across the days held.
    expect(body.history.map((p: any) => [p.date, p.value, !!p.estimated])).toEqual([
      ['2026-03-12', 10_500, false],
      ['2026-03-13', 500, true],
      ['2026-03-16', 500, false],
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
    // Still open, said again a week before: it holds two weeks from each answer.
    setSystemTime(new Date('2026-04-24T12:00:00Z'));
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
    // Assumed, with its currency from the record its institution kept of it
    // while it was held, so a reader listing it later can price it.
    expect(await lifecycleStore.get(ctx, 'sav')).toMatchObject({ assumed: true, currency: 'USD' });

    plaid.accounts = [SAV, CHK];
    const { body } = await load('2026-03-20');
    // Open again, with the days saved without it kept as a missing window.
    const lifted = await lifecycleStore.get(ctx, 'sav');
    expect(lifted).toMatchObject({ lifecycle: { state: 'active' }, currency: 'USD', missed: [{ from: '2026-03-13', to: '2026-03-19' }] });
    expect(await timelineNotesStore.has(ctx, autoNoteId('sav'))).toBe(false);
    expect(isMissedNoteId(lifted!.missed![0].note)).toBe(true);
    expect(await timelineNotesStore.get(ctx, lifted!.missed![0].note!)).toMatchObject({
      text: 'Savings ••4821 was missing at Ally from Mar 13 to Mar 19, so the totals saved then, short of it, are left out',
    });
    expect(body.lifecycle).toEqual([]);
    expect(accountRow(body, 'sav')).toMatchObject({ balance: 10_000 });
    expect(body.netWorth).toBe(10_500);
    // The total saved on 03-16 without it is left out of the chart, never drawn as a dip.
    expect(await recordedTotals()).toEqual(['2026-03-12', '2026-03-16', '2026-03-20']);
    expect(body.history.map((p: any) => [p.date, p.value])).toEqual([
      ['2026-03-12', 10_500],
      ['2026-03-20', 10_500],
    ]);
  });

  test('a window from before windows kept their notes’ ids gets one on the next load, its note moved there', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    const at = '2026-03-20T12:00:00.000Z';
    await lifecycleStore.set(ctx, 'sav', {
      lifecycle: { state: 'active' },
      type: 'depository',
      label: { name: 'Savings', institution: 'Ally', mask: '4821' },
      item_id: 'item_ally',
      set_at: at,
      missed: [{ from: '2026-03-13', to: '2026-03-19' }],
    });
    const old = { date: '2026-03-13', text: 'Savings ••4821 was missing at Ally from Mar 13 to Mar 19, so the totals saved then, short of it, are left out', kind: 'auto' as const, account_id: 'sav', created_at: at };
    await timelineNotesStore.set(ctx, 'missed.sav.2026-03-13', old);
    await load('2026-03-21');
    const note = (await lifecycleStore.get(ctx, 'sav'))!.missed![0].note!;
    expect(isMissedNoteId(note)).toBe(true);
    expect(await timelineNotesStore.get(ctx, note)).toEqual(old);
    expect(await timelineNotesStore.has(ctx, 'missed.sav.2026-03-13')).toBe(false);
  });

  test('a confirmed closure stays closed when the account is still reported', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    await markEnded(ctx, 'sav', { state: 'left', on: '2026-03-13', note: 'Divided' }, { type: 'depository', label: { name: 'Savings', institution: 'Ally', mask: '4821' }, item_id: 'item_ally' });
    const { body } = await load('2026-03-14');
    expect(accountRow(body, 'sav')).toBeUndefined();
    expect(body.netWorth).toBe(500);
    expect(body.lifecycle.map((l: any) => l.lifecycle)).toEqual([{ state: 'left', on: '2026-03-13', note: 'Divided' }]);
    // Recorded as measured (the true total), applied on read; the step on its day.
    expect(await recordedTotals()).toEqual(['2026-03-12', '2026-03-14']);
    expect(body.history.map((p: any) => [p.date, p.value])).toEqual([
      ['2026-03-12', 10_500],
      ['2026-03-13', 500],
      ['2026-03-14', 500],
    ]);
    // Left, and moving as it always did: no transaction after its end, so
    // nothing asks.
    expect(body.institutions[0].ended_reported).toBeUndefined();
  });
});

describe('an answer that doesn’t settle a missing account', () => {
  test('Still open about a zero balance says nothing about it going missing: after the window it is assumed closed, never dropped silently', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    // Weeks before, it sat at zero and the person said it was still open.
    expect((await post({ account_id: 'sav', state: 'active', answer: 'zero', since: '2026-01-02' })).status).toBe(200);
    plaid.accounts = [CHK];
    expect((await load('2026-03-13')).body.institutions[0].unconfirmed_missing).toBe(1);
    const { body } = await load('2026-03-16', 13);
    expect(await lifecycleStore.get(ctx, 'sav')).toMatchObject({ lifecycle: { state: 'closed', on: '2026-03-13' }, assumed: true });
    expect(body.lifecycle.map((l: any) => [l.account_id, l.assumed])).toEqual([['sav', true]]);
    expect(await timelineNotesStore.get(ctx, autoNoteId('sav'))).toMatchObject({ date: '2026-03-13' });
    // Shown as a closure on its day, with its note: the drop is explained.
    expect(points(body)).toEqual([
      ['2026-03-12', 10_500, false],
      ['2026-03-13', 500, true],
      ['2026-03-16', 500, false],
    ]);
  });

  test('Still open holds two weeks from the answer; then Nya asks again, and unanswered, assumes it closed', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    plaid.accounts = [CHK];
    await load('2026-03-13');
    expect((await post({ account_id: 'sav', state: 'active', answer: 'missing', since: '2026-03-12' })).status).toBe(200);
    expect(accountRow((await load('2026-03-26')).body, 'sav')?.question).toMatchObject({ kind: 'missing', still_open: true });
    // Lapsed on 03-27: asked again, still held, nothing saved.
    const asked = (await load('2026-03-28')).body;
    expect(accountRow(asked, 'sav')?.question).toMatchObject({ kind: 'missing', again: true });
    expect(accountRow(asked, 'sav')?.question?.still_open).toBeUndefined();
    expect(asked.institutions[0].unconfirmed_missing).toBe(1);
    expect(await recordedTotals()).toEqual(['2026-03-12']);
    // Three days on with no answer: assumed closed, and totals are saved again.
    const after = (await load('2026-03-31')).body;
    expect(await lifecycleStore.get(ctx, 'sav')).toMatchObject({ lifecycle: { state: 'closed', on: '2026-03-13' }, assumed: true });
    expect(after.institutions[0].unconfirmed_missing).toBeUndefined();
    expect(await recordedTotals()).toEqual(['2026-03-12', '2026-03-31']);
  });
});

describe('reopening an account its bank no longer returns', () => {
  test('after its closure settled, Reopen holds it at its last known balance and asks, and no total is saved without it', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    plaid.accounts = [CHK];
    await load('2026-03-13');
    expect((await post({ account_id: 'sav', state: 'closed', on: '2026-03-13' })).status).toBe(200);
    await load('2026-03-14');
    await load('2026-03-15');
    const reopened = await post({ account_id: 'sav', state: 'active' });
    expect(reopened).toMatchObject({ status: 200, body: { reopened: true, held: true } });
    const { body } = await load('2026-03-16');
    expect(accountRow(body, 'sav')).toMatchObject({ balance: 10_000, held: { as_of: '2026-03-12' }, question: { kind: 'missing', still_open: true } });
    expect(body.lifecycle).toEqual([]);
    expect(body.netWorth).toBe(10_500);
    expect(body.institutions[0].unconfirmed_missing).toBe(1);
    expect(await recordedTotals()).toEqual(['2026-03-12', '2026-03-14', '2026-03-15']);
  });

  test('the same from an assumed closure', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    plaid.accounts = [CHK];
    await load('2026-03-13');
    await load('2026-03-16', 13);
    await load('2026-03-17');
    expect((await lifecycleStore.get(ctx, 'sav'))?.assumed).toBe(true);
    expect((await post({ account_id: 'sav', state: 'active' })).body).toMatchObject({ held: true });
    const { body } = await load('2026-03-18');
    expect(accountRow(body, 'sav')).toMatchObject({ question: { kind: 'missing', still_open: true } });
    expect(body.netWorth).toBe(10_500);
  });

  test('one its bank still returns simply counts again', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    await post({ account_id: 'sav', state: 'left', on: '2026-03-12' });
    expect((await post({ account_id: 'sav', state: 'active' })).body).toEqual({ account_id: 'sav', lifecycle: { state: 'active' }, reopened: true });
    expect(await lifecycleStore.has(ctx, 'sav')).toBe(false);
    expect((await load('2026-03-13')).body.netWorth).toBe(10_500);
  });
});

describe('an account that ended and that its bank still returns', () => {
  const card = (owed: number) => plaidAccount('card', 'credit', owed);

  test('a card closed at zero that comes to owe is asked about, and counts in nothing meanwhile; Still closed holds until it moves again', async () => {
    plaid.accounts = [CHK, card(0)];
    await load('2026-03-12');
    expect((await post({ account_id: 'card', state: 'closed', on: '2026-03-13' })).status).toBe(200);
    plaid.accounts = [CHK, card(450)];
    const { body } = await load('2026-04-20');
    const inst = body.institutions[0];
    expect(body.netWorth).toBe(500);
    expect(accountRow(body, 'card')).toBeUndefined();
    expect(inst.ended_reported).toEqual([
      expect.objectContaining({ account_id: 'card', balance: 450, question: { kind: 'reported', end: '2026-03-13', since: null, ended: { state: 'closed', on: '2026-03-13' } } }),
    ]);
    // Still closed, as it shows now: asked no more while it stays there.
    expect((await post({ account_id: 'card', state: 'closed', on: '2026-03-13', balance: 450 })).status).toBe(200);
    expect((await lifecycleStore.get(ctx, 'card'))?.seen).toEqual({ balance: 450, through: '2026-04-20' });
    expect((await load('2026-04-21')).body.institutions[0].ended_reported).toBeUndefined();
    plaid.accounts = [CHK, card(600)];
    expect((await load('2026-04-22')).body.institutions[0].ended_reported).toHaveLength(1);
  });

  test('closed with the balance it showed, it is asked about only when that moves', async () => {
    plaid.accounts = [CHK, card(310)];
    await load('2026-03-12');
    await post({ account_id: 'card', state: 'closed', on: '2026-03-12', balance: 310 });
    expect((await load('2026-03-13')).body.institutions[0].ended_reported).toBeUndefined();
  });

  test('its transactions are read at most once a day: one that lands after the day’s read is asked about the next day', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    await post({ account_id: 'sav', state: 'left', on: '2026-03-13' });
    await storedTxns([]);
    expect((await load('2026-03-21')).body.institutions[0].ended_reported).toBeUndefined();
    expect((await lifecycleStore.get(ctx, 'sav'))?.seen).toEqual({ balance: null, through: '2026-03-12', checked: '2026-03-21' });
    // One lands the same day: not read again until the next.
    await storedTxns([{ account_id: 'sav', date: '2026-03-21' }]);
    expect((await load('2026-03-21', 18)).body.institutions[0].ended_reported).toBeUndefined();
    const asked = (await load('2026-03-22')).body.institutions[0].ended_reported;
    expect(asked).toEqual([expect.objectContaining({ account_id: 'sav', question: expect.objectContaining({ kind: 'reported', since: '2026-03-21' }) })]);
    expect((await lifecycleStore.get(ctx, 'sav'))?.seen).toEqual({ balance: null, through: '2026-03-12', checked: '2026-03-22', txn: '2026-03-21' });
    // Asked again that day from what the read found, without reading again.
    await storedTxns([]);
    expect((await load('2026-03-22', 20)).body.institutions[0].ended_reported).toHaveLength(1);
    // The person's answer drops the check: read again at once.
    await post({ account_id: 'sav', state: 'left', on: '2026-03-13', balance: 10_000 });
    expect((await lifecycleStore.get(ctx, 'sav'))?.seen).toEqual({ balance: 10_000, through: '2026-03-22' });
  });

  test('a row imported from a file dated after its end is no word from its bank: not asked about', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    await post({ account_id: 'sav', state: 'left', on: '2026-03-13' });
    await storedTxns([]);
    await importedRow('sav', '2026-03-20');
    expect((await load('2026-03-21')).body.institutions[0].ended_reported).toBeUndefined();
  });

  test('a transaction after its end asks about a left account; an untracked one is expected to move, and never is', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    await post({ account_id: 'sav', state: 'left', on: '2026-03-13' });
    await storedTxns([{ account_id: 'sav', date: '2026-03-20' }]);
    const asked = (await load('2026-03-21')).body.institutions[0].ended_reported;
    expect(asked).toEqual([expect.objectContaining({ account_id: 'sav', question: expect.objectContaining({ kind: 'reported', since: '2026-03-20', ended: { state: 'left', on: '2026-03-13' } }) })]);
    await post({ account_id: 'sav', state: 'untracked', from: '2026-03-13' });
    expect((await load('2026-03-22')).body.institutions[0].ended_reported).toBeUndefined();
  });
});

describe('the chart across a hold', () => {
  test('Still open, then Closed on the prefilled day: the step falls on that day, with its note there, never a slope across the hold', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12');
    plaid.accounts = [CHK];
    await load('2026-03-13');
    await post({ account_id: 'sav', state: 'active', answer: 'missing', since: '2026-03-12' });
    await load('2026-03-20');
    setSystemTime(new Date('2026-03-25T12:00:00Z'));
    await post({ account_id: 'sav', state: 'closed', on: '2026-03-13' });
    const { body } = await load('2026-03-26');
    expect(points(body)).toEqual([
      ['2026-03-12', 10_500, false],
      ['2026-03-13', 500, true],
      ['2026-03-26', 500, false],
    ]);
    expect(await timelineNotesStore.get(ctx, autoNoteId('sav'))).toMatchObject({ date: '2026-03-13' });
  });
});

describe('an end on the person’s today, a day ahead of UTC', () => {
  test('leaves the live total at once, while today’s point, a UTC day before it, still counts it as the day will read once recorded', async () => {
    plaid.accounts = [SAV, CHK];
    await load('2026-03-12', 23);
    expect((await post({ account_id: 'sav', state: 'closed', on: '2026-03-13' })).status).toBe(200);
    const { body } = await load('2026-03-12', 23);
    expect(body.netWorth).toBe(500);
    expect(points(body)).toEqual([['2026-03-12', 10_500, false]]);
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
      sav: await encrypt(TEST_CTX, JSON.stringify({ lifecycle: { state: 'sold', on: '2026-03-01' }, type: 'depository', label: { name: 'S', institution: 'A', mask: null }, item_id: null, set_at: '2026-03-01T00:00:00Z' })),
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
      await fake.hset(ctxKey('history:accounts'), { [date]: await encrypt(TEST_CTX, JSON.stringify(balances)) });
      await fake.hset(ctxKey('history:net-worth'), { [date]: await encrypt(TEST_CTX, '500') });
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
    await fake.set(ctxKey('txns:item_ally'), await encodeJsonBlob(TEST_CTX, { schema_version: 2, cursor: 'c', accounts: {}, txns, synced_at: null }));
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
    await fake.hset(ctxKey('history:accounts'), { '2026-03-01': await encrypt(TEST_CTX, JSON.stringify({ chk: 500, empty: 12 })) });
    plaid.accounts = [CHK, EMPTY];
    expect(accountRow((await load('2026-03-13')).body, 'empty').question).toBeUndefined();
  });

  test('not when a transaction moved through it since the zeros began', async () => {
    await measuredDays('2026-02-01', 40, { chk: 500, empty: 0 });
    await withTxns([{ account_id: 'empty', date: '2026-03-02' }]);
    plaid.accounts = [CHK, EMPTY];
    expect(accountRow((await load('2026-03-13')).body, 'empty').question).toBeUndefined();
  });

  test('a row imported from a file since the zeros began is no word from the bank: still asked', async () => {
    await measuredDays('2026-02-01', 40, { chk: 500, empty: 0 });
    await importedRow('empty', '2026-03-02');
    plaid.accounts = [CHK, EMPTY];
    expect(accountRow((await load('2026-03-13')).body, 'empty').question?.kind).toBe('zero');
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
