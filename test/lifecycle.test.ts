import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, unscopedDataKeys } from './fake-redis';

// The account lifecycle (#50): the store, the model, and the math applied on
// read. Real AES-256-GCM, so a round-trip bug looks like what it is.
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const ctx = TEST_CTX;
const OTHER = { container: '1c7e6b63-4d2e-4f3a-9bac-2d3e4f5a6b7c' } as { container: any };

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const {
  lifecycleStore,
  isLifecycleEntry,
  isAccountLifecycle,
  effectiveLifecycle,
  getEffectiveLifecycle,
  markEnded,
  markStillOpen,
  reopenAccount,
  recordAssumedClosures,
  liftAssumedClosures,
  removeUnreadable,
  endedNow,
  endedNowIds,
  countsOn,
  lastEndDay,
  answersFrom,
  lifecycleForClient,
  autoNoteText,
  shortDays,
  EMPTY_VIEW,
  adoptMissedNotes,
  hasUnkeyedWindows,
  readLifecycleEntries,
  MAX_MISSED,
} = await import('@/lib/lifecycle');
const { getHistory, getHistoryWithBreaks, recordSnapshot, replaceEstimated, replaceEstimatedAccounts, replaceEstimatedFlat, bridgeInteriorEstimates, endBreaks } = await import('@/lib/history');
const { UnreadableEntriesError } = await import('@/lib/repo');
const { recordDirectory, forgetEarlierAccount, ForgetRefused } = await import('@/lib/links');
const { timelineNotesStore, autoNoteId, newMissedNoteId, isMissedNoteId, legacyMissedNoteId, writeMissedNote, addUserNote } = await import('@/lib/timeline-notes');
type Link = { to: string; linked_at: string; evidence: Record<string, unknown> };

const ABOUT = { type: 'depository', label: { name: 'Ally Savings', institution: 'Ally', mask: '1234' }, item_id: 'item_ally' };
const CARD = { type: 'credit', label: { name: 'Chase Freedom', institution: 'Chase', mask: '9999' }, item_id: 'item_chase' };
const NOW = Date.parse('2026-06-15T12:00:00.000Z');

/** A recorded day: its total and the per-account map recorded beside it. */
async function recordDay(date: string, balances: Record<string, number>, types: Record<string, string>) {
  const total = Object.entries(balances).reduce((n, [id, b]) => n + (types[id] === 'credit' ? -b : b), 0);
  await fake.hset(ctxKey('history:net-worth'), { [date]: await encrypt(String(total)) });
  await fake.hset(ctxKey('history:accounts'), { [date]: await encrypt(JSON.stringify(balances)) });
}

const byDate = (points: { date: string; value: number }[]) => Object.fromEntries(points.map((p) => [p.date, p.value]));

/** Every field of the real layer, as stored: the bytes a closure must never touch. */
async function realLayer() {
  return {
    totals: { ...((await fake.hgetall<Record<string, string>>(ctxKey('history:net-worth'))) ?? {}) },
    accounts: { ...((await fake.hgetall<Record<string, string>>(ctxKey('history:accounts'))) ?? {}) },
    partial: { ...((await fake.hgetall<Record<string, string>>(ctxKey('history:accounts:partial'))) ?? {}) },
  };
}

const TYPES = { sav: 'depository', chk: 'depository', card: 'credit' };

async function seedThreeDays() {
  await recordDay('2026-03-10', { sav: 1000, chk: 500, card: 200 }, TYPES);
  await recordDay('2026-03-11', { sav: 1000, chk: 500, card: 200 }, TYPES);
  await recordDay('2026-03-12', { sav: 1000, chk: 500, card: 200 }, TYPES);
}

beforeEach(() => fake.reset());

describe('the stored shape', () => {
  const good = { lifecycle: { state: 'closed', on: '2026-03-12' }, type: 'depository', label: ABOUT.label, item_id: 'item_ally', set_at: '2026-03-12T10:00:00.000Z' };

  test('each state carries exactly its own fields', () => {
    expect(isAccountLifecycle({ state: 'active' })).toBe(true);
    expect(isAccountLifecycle({ state: 'closed', on: '2026-03-12', note: 'Moved to Chase' })).toBe(true);
    expect(isAccountLifecycle({ state: 'left', on: '2026-03-12' })).toBe(true);
    expect(isAccountLifecycle({ state: 'untracked', from: '2026-03-12' })).toBe(true);
    // The wrong date field for the state, or none, or a day that isn't one.
    expect(isAccountLifecycle({ state: 'untracked', on: '2026-03-12' })).toBe(false);
    expect(isAccountLifecycle({ state: 'closed', from: '2026-03-12' })).toBe(false);
    expect(isAccountLifecycle({ state: 'closed' })).toBe(false);
    expect(isAccountLifecycle({ state: 'closed', on: '2026-02-30' })).toBe(false);
    expect(isAccountLifecycle({ state: 'closed', on: '1969-12-31' })).toBe(false);
    expect(isAccountLifecycle({ state: 'active', on: '2026-03-12' })).toBe(false);
    expect(isAccountLifecycle({ state: 'untracked', from: '2026-03-12', note: 'x' })).toBe(false);
    expect(isAccountLifecycle({ state: 'transferred', on: '2026-03-12' })).toBe(false);
    // A note is one trimmed line of at most 200 characters.
    expect(isAccountLifecycle({ state: 'closed', on: '2026-03-12', note: ' padded' })).toBe(false);
    expect(isAccountLifecycle({ state: 'closed', on: '2026-03-12', note: 'two\nlines' })).toBe(false);
    expect(isAccountLifecycle({ state: 'closed', on: '2026-03-12', note: 'x'.repeat(201) })).toBe(false);
    expect(isAccountLifecycle({ state: 'closed', on: '2026-03-12', note: '' })).toBe(false);
  });

  test('closed: a field this release does not know makes the entry unrecognised', () => {
    expect(isLifecycleEntry(good)).toBe(true);
    expect(isLifecycleEntry({ ...good, later: true })).toBe(false);
    expect(isLifecycleEntry({ ...good, label: { ...good.label, extra: 1 } })).toBe(false);
    // assumed only on a closure; answered only on active.
    expect(isLifecycleEntry({ ...good, assumed: true })).toBe(true);
    expect(isLifecycleEntry({ ...good, lifecycle: { state: 'left', on: '2026-03-12' }, assumed: true })).toBe(false);
    expect(isLifecycleEntry({ ...good, answered: { kind: 'zero', since: '2026-02-01' } })).toBe(false);
    expect(isLifecycleEntry({ ...good, lifecycle: { state: 'active' }, answered: { kind: 'zero', since: '2026-02-01' } })).toBe(true);
    expect(isLifecycleEntry({ ...good, lifecycle: { state: 'active' }, answered: { kind: 'later', since: '2026-02-01' } })).toBe(false);
    expect(isLifecycleEntry({ ...good, type: null })).toBe(true);
    expect(isLifecycleEntry({ ...good, type: 'Credit Card!' })).toBe(false);
    expect(isLifecycleEntry({ ...good, item_id: 'has space' })).toBe(false);
    // Its currency where the write knew it: an ISO code, or Plaid's unofficial one.
    expect(isLifecycleEntry({ ...good, currency: 'CAD' })).toBe(true);
    expect(isLifecycleEntry({ ...good, currency: 'DOGE' })).toBe(true);
    expect(isLifecycleEntry({ ...good, currency: 'not a currency' })).toBe(false);
    expect(isLifecycleEntry({ ...good, currency: null })).toBe(false);
  });

  test('a write keeps the currency it is told, else the one the entry had; one that isn’t a currency is left out', async () => {
    await markStillOpen(ctx, 'sav', { kind: 'zero', since: '2026-02-01' }, { ...ABOUT, currency: 'CAD' }, NOW);
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    expect((await lifecycleStore.get(ctx, 'sav'))?.currency).toBe('CAD');
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-12' }, { ...ABOUT, currency: 'USD' }, NOW);
    expect((await lifecycleStore.get(ctx, 'sav'))?.currency).toBe('USD');
    await markEnded(ctx, 'chk', { state: 'closed', on: '2026-03-12' }, { ...ABOUT, currency: '<b>' }, NOW);
    expect((await lifecycleStore.get(ctx, 'chk'))?.currency).toBeUndefined();
  });
});

describe('the store', () => {
  test('never saved reads as empty, and round-trips', async () => {
    expect((await getEffectiveLifecycle(ctx, new Map())).ended.size).toBe(0);
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-12', note: 'Moved to Chase' }, ABOUT, NOW);
    const entry = await lifecycleStore.get(ctx, 'sav');
    expect(entry).toEqual({ lifecycle: { state: 'closed', on: '2026-03-12', note: 'Moved to Chase' }, ...ABOUT, set_at: new Date(NOW).toISOString() });
  });

  test('is encrypted at rest: neither the name nor the date is in the stored bytes', async () => {
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    const raw = JSON.stringify(await fake.hgetall(ctxKey('account-lifecycle')));
    expect(raw).not.toContain('Ally');
    expect(raw).not.toContain('2026-03-12');
  });

  test('an unreadable entry fails the read loudly, never read as "not closed"', async () => {
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    await fake.hset(ctxKey('account-lifecycle'), { chk: 'not-ciphertext-at-all-but-long-enough-to-try' });
    const err = await getEffectiveLifecycle(ctx, new Map()).catch((e) => e);
    expect(err).toBeInstanceOf(UnreadableEntriesError);
    expect(err.unreadable).toEqual(['chk']);
  });

  test('an entry a later release wrote is unrecognised, and is never offered for removal', async () => {
    await fake.hset(ctxKey('account-lifecycle'), {
      sav: await encrypt(JSON.stringify({ lifecycle: { state: 'transferred', on: '2026-03-12' }, type: 'depository', label: ABOUT.label, item_id: null, set_at: '2026-03-12T00:00:00Z' })),
      chk: 'damaged-bytes-damaged-bytes-damaged-bytes',
    });
    const err = await getEffectiveLifecycle(ctx, new Map()).catch((e) => e);
    expect(err.unrecognised).toEqual(['sav']);
    // Only the damaged one goes, and only through the confirmed repair.
    const { removed, unrecognised } = await removeUnreadable(ctx);
    expect(removed).toEqual(['chk']);
    expect(unrecognised).toEqual(['sav']);
    expect(await lifecycleStore.has(ctx, 'chk')).toBe(false);
    expect(await lifecycleStore.has(ctx, 'sav')).toBe(true);
  });

  test('a Redis failure is an error, never "nothing closed"', async () => {
    fake.failNext('hgetall');
    await expect(getEffectiveLifecycle(ctx, new Map())).rejects.toThrow(/armed failure/);
  });

  test('links that could not be read fail the read when something has an end', async () => {
    expect(await getEffectiveLifecycle(ctx, null)).toBe(EMPTY_VIEW); // nothing stored: links don't matter
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    await expect(getEffectiveLifecycle(ctx, null)).rejects.toThrow(/links/);
  });

  test('one container never sees another’s closures', async () => {
    await markEnded(OTHER, 'sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    expect((await getEffectiveLifecycle(ctx, new Map())).ended.size).toBe(0);
    expect((await getEffectiveLifecycle(OTHER, new Map())).ended.has('sav')).toBe(true);
  });
});

describe('when an end counts', () => {
  test('every day before the end counts, the end day and after do not', () => {
    const closed = { state: 'closed' as const, on: '2026-03-12' };
    expect(countsOn(closed, '2026-03-11')).toBe(true);
    expect(countsOn(closed, '2026-03-12')).toBe(false);
    expect(countsOn(closed, '2027-01-01')).toBe(false);
    expect(countsOn({ state: 'active' }, '2030-01-01')).toBe(true);
    expect(countsOn({ state: 'untracked', from: '2026-03-12' }, '2026-03-11')).toBe(true);
  });

  test('the live total leaves an account out as soon as its end is set, a day ahead of UTC included', () => {
    // 23:00 UTC on the 14th is already the 15th east of Greenwich.
    const late = Date.parse('2026-06-14T23:00:00.000Z');
    expect(lastEndDay(late)).toBe('2026-06-15');
    expect(endedNow({ state: 'closed', on: '2026-06-15' }, late)).toBe(true);
    expect(endedNow({ state: 'closed', on: '2026-06-16' }, late)).toBe(false);
    expect(endedNow({ state: 'active' }, late)).toBe(false);
  });
});

describe('links: an end survives a re-link', () => {
  const link = (to: string, old_type?: string): Link => ({ to, linked_at: '2026-04-01T00:00:00Z', evidence: old_type ? { old_type } : {} });

  test('an end set on the earlier id carries to the account it was linked to', () => {
    const entries = new Map([['old_sav', { lifecycle: { state: 'untracked' as const, from: '2026-03-12' }, ...ABOUT, set_at: '2026-03-12T00:00:00Z' }]]);
    const view = effectiveLifecycle(entries, new Map([['old_sav', link('new_sav')]]));
    expect([...view.ended.keys()].sort()).toEqual(['new_sav', 'old_sav']);
    expect(endedNowIds(view, NOW)).toEqual(new Set(['new_sav', 'old_sav']));
    expect(lifecycleForClient(view).map((c) => c.account_id)).toEqual(['new_sav']);
  });

  test('an end set on the current id reaches history recorded under the earlier one, each id with its own kind', () => {
    const entries = new Map([['new_card', { lifecycle: { state: 'closed' as const, on: '2026-03-12' }, ...CARD, set_at: '2026-03-12T00:00:00Z' }]]);
    const view = effectiveLifecycle(entries, new Map([['old_card', link('new_card', 'credit')]]));
    expect(view.ended.get('old_card')).toEqual({ type: 'credit', from: '2026-03-12' });
    expect(view.ended.get('new_card')).toEqual({ type: 'credit', from: '2026-03-12' });
  });

  test('the current id’s own entry wins over an earlier id’s, then the newest', () => {
    const closed = { lifecycle: { state: 'closed' as const, on: '2026-01-01' }, ...ABOUT, set_at: '2026-05-01T00:00:00Z' };
    const untracked = { lifecycle: { state: 'untracked' as const, from: '2026-02-01' }, ...ABOUT, set_at: '2026-01-01T00:00:00Z' };
    const links = new Map([['old', link('new')]]);
    // The current id's, though older.
    type E = Parameters<typeof effectiveLifecycle>[0] extends ReadonlyMap<string, infer V> ? V : never;
    let view = effectiveLifecycle(new Map<string, E>([['old', closed], ['new', untracked]]), links);
    expect(view.ended.get('old')?.from).toBe('2026-02-01');
    // Two earlier ids: the newest.
    const chain = new Map([['a', link('b')], ['b', link('c')]]);
    view = effectiveLifecycle(new Map<string, E>([['a', closed], ['b', untracked]]), chain);
    expect(view.ended.get('c')?.from).toBe('2026-01-01');
  });

  test('a paused link (the earlier id is live again) is not given to it: the caller passes only links that apply', () => {
    const entries = new Map([['old', { lifecycle: { state: 'closed' as const, on: '2026-03-12' }, ...ABOUT, set_at: '2026-03-12T00:00:00Z' }]]);
    const view = effectiveLifecycle(entries, new Map());
    expect([...view.ended.keys()]).toEqual(['old']);
  });
});

describe('the math, applied on read', () => {
  async function view() {
    return getEffectiveLifecycle(ctx, new Map());
  }

  test('every day before the end is unchanged; from it on the account does not count', async () => {
    await seedThreeDays();
    const before = byDate(await getHistory(ctx));
    expect(before).toEqual({ '2026-03-10': 1300, '2026-03-11': 1300, '2026-03-12': 1300 });

    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-11' }, ABOUT, NOW);
    const after = byDate(await getHistory(ctx, undefined, (await view()).ended));
    expect(after).toEqual({ '2026-03-10': 1300, '2026-03-11': 300, '2026-03-12': 300 });
  });

  test('marking an account closed never writes to the real history layer (byte-identical)', async () => {
    await seedThreeDays();
    await recordSnapshot(ctx, 1300, { sav: 1000, chk: 500, card: 200 });
    const before = await realLayer();
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-11' }, ABOUT, NOW);
    await getHistory(ctx, undefined, (await view()).ended);
    await markEnded(ctx, 'sav', { state: 'left', on: '2026-03-10', note: 'Divided' }, ABOUT, NOW);
    await reopenAccount(ctx, 'sav', new Map(), NOW);
    expect(await realLayer()).toEqual(before);
  });

  test('a closed card raises no false "net worth improved": only from its end, never before', async () => {
    await seedThreeDays();
    await markEnded(ctx, 'card', { state: 'closed', on: '2026-03-12' }, CARD, NOW);
    const points = byDate(await getHistory(ctx, undefined, (await view()).ended));
    // The days it was owed still owe it; only from its end does it stop
    // counting (a debt that ended raises the total from that day, explained
    // by its note on the timeline, never silently and never before).
    expect(points['2026-03-10']).toBe(1300);
    expect(points['2026-03-11']).toBe(1300);
    expect(points['2026-03-12']).toBe(1500);
  });

  test('closed, left and untracked are the same to the math', async () => {
    await seedThreeDays();
    const results: Record<string, number>[] = [];
    for (const lifecycle of [
      { state: 'closed' as const, on: '2026-03-11' },
      { state: 'left' as const, on: '2026-03-11' },
      { state: 'untracked' as const, from: '2026-03-11' },
    ]) {
      await markEnded(ctx, 'sav', lifecycle, ABOUT, NOW);
      results.push(byDate(await getHistory(ctx, undefined, (await view()).ended)));
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  test('an end date further in the past recomputes the later points, on read only', async () => {
    await seedThreeDays();
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    expect(byDate(await getHistory(ctx, undefined, (await view()).ended))['2026-03-11']).toBe(1300);
    const stored = await realLayer();
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-10' }, ABOUT, NOW);
    expect(byDate(await getHistory(ctx, undefined, (await view()).ended))).toEqual({ '2026-03-10': 300, '2026-03-11': 300, '2026-03-12': 300 });
    expect(await realLayer()).toEqual(stored);
  });

  test('reopening restores every point exactly', async () => {
    await seedThreeDays();
    const before = await getHistory(ctx);
    await markEnded(ctx, 'sav', { state: 'untracked', from: '2026-03-11' }, ABOUT, NOW);
    expect(await getHistory(ctx, undefined, (await view()).ended)).not.toEqual(before);
    await reopenAccount(ctx, 'sav', new Map(), NOW);
    expect(await getHistory(ctx, undefined, (await view()).ended)).toEqual(before);
    expect(await lifecycleStore.count(ctx)).toBe(0);
  });

  test('reopening clears every id the account has had, so an earlier id’s end can’t keep it closed', async () => {
    await markEnded(ctx, 'old_sav', { state: 'closed', on: '2026-03-11' }, ABOUT, NOW);
    await markEnded(ctx, 'new_sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    const links = new Map([['old_sav', { to: 'new_sav', linked_at: '2026-04-01T00:00:00Z', evidence: {} }]]);
    expect((await reopenAccount(ctx, 'new_sav', links, NOW)).sort()).toEqual(['new_sav', 'old_sav']);
    expect((await getEffectiveLifecycle(ctx, links)).ended.size).toBe(0);
  });

  test('a re-link carries the state into the chart: the earlier id’s history stops counting too', async () => {
    // The account was "old_sav" until a reconnect gave it "new_sav".
    await recordDay('2026-03-10', { old_sav: 1000, chk: 500 }, TYPES);
    await recordDay('2026-03-11', { old_sav: 1000, chk: 500 }, TYPES);
    await recordDay('2026-03-12', { new_sav: 1000, chk: 500 }, TYPES);
    await markEnded(ctx, 'new_sav', { state: 'untracked', from: '2026-03-11' }, ABOUT, NOW);
    const links = new Map([['old_sav', { to: 'new_sav', linked_at: '2026-03-12T00:00:00Z', evidence: { old_type: 'depository' } }]]);
    const points = byDate(await getHistory(ctx, undefined, (await getEffectiveLifecycle(ctx, links)).ended));
    expect(points).toEqual({ '2026-03-10': 1500, '2026-03-11': 500, '2026-03-12': 500 });
  });

  test('a hidden account that also ended is subtracted once', async () => {
    await seedThreeDays();
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-11' }, ABOUT, NOW);
    const hidden = new Map([['sav', { type: 'depository', hidden_at: '2026-01-01' }]]);
    expect(byDate(await getHistory(ctx, hidden, (await view()).ended))).toEqual({ '2026-03-10': 300, '2026-03-11': 300, '2026-03-12': 300 });
  });

  test('the estimated layer is subtracted from the end on too, walked and flat alike', async () => {
    const dates = ['2026-02-01', '2026-02-02', '2026-02-03'];
    await replaceEstimated(ctx, dates.map((date) => ({ date, value: 5000 })));
    await replaceEstimatedAccounts(ctx, dates.map((date) => ({ date, balances: { sav: 1000, chk: 500 } })));
    await replaceEstimatedFlat(ctx, dates.map((date) => ({ date, balances: { brokerage: 3500 } })));
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-02-02' }, ABOUT, NOW);
    await markEnded(ctx, 'brokerage', { state: 'left', on: '2026-02-03' }, { ...ABOUT, type: 'investment' }, NOW);
    const points = await getHistory(ctx, undefined, (await view()).ended);
    expect(byDate(points)).toEqual({ '2026-02-01': 5000, '2026-02-02': 4000, '2026-02-03': 500 });
    expect(points.every((p) => p.estimated)).toBe(true);
  });

  test('an account of unknown kind with a balance on a day after its end can’t be signed: that day is left out, never guessed', async () => {
    await seedThreeDays();
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-12' }, { ...ABOUT, type: null }, NOW);
    const points = byDate(await getHistory(ctx, undefined, (await view()).ended));
    expect(points['2026-03-11']).toBe(1300);
    expect(points['2026-03-12']).toBeUndefined();
  });

  test('an account absent from the days after its end subtracts nothing there', async () => {
    await recordDay('2026-03-10', { sav: 1000, chk: 500 }, TYPES);
    await recordDay('2026-03-11', { chk: 500 }, TYPES); // the bank stopped returning it
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-11' }, ABOUT, NOW);
    expect(byDate(await getHistory(ctx, undefined, (await view()).ended))).toEqual({ '2026-03-10': 1500, '2026-03-11': 500 });
  });
});

describe('forgetting an account that ended', () => {
  // Known from an institution since disconnected (no stored Item): an earlier
  // account that can be forgotten.
  async function disconnected(id: string) {
    await recordDirectory(ctx, [{ item_id: 'item_gone', institution_name: 'Ally', error: null, accounts: [{ account_id: id, type: 'depository', subtype: 'savings' }] }] as any);
  }

  test('is refused while its balances after its end keep it out of the totals, which stay as they were', async () => {
    await seedThreeDays();
    await disconnected('sav');
    await markEnded(ctx, 'sav', { state: 'left', on: '2026-03-11' }, ABOUT, NOW);
    const shown = await getHistory(ctx, undefined, (await getEffectiveLifecycle(ctx, new Map())).ended);
    const err = await forgetEarlierAccount(ctx, 'sav').catch((e) => e);
    expect(err).toBeInstanceOf(ForgetRefused);
    expect(err.message).toContain('It stopped counting on 2026-03-11');
    expect(await getHistory(ctx, undefined, (await getEffectiveLifecycle(ctx, new Map())).ended)).toEqual(shown);
  });

  test('one not reported after its end, the usual closure, is forgotten as any other', async () => {
    await recordDay('2026-03-10', { sav: 1000, chk: 500 }, TYPES);
    await recordDay('2026-03-11', { chk: 500 }, TYPES);
    await disconnected('sav');
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-11' }, ABOUT, NOW);
    const before = await getHistory(ctx);
    expect(await timelineNotesStore.get(ctx, autoNoteId('sav'))).not.toBeNull();
    const missedNote = newMissedNoteId();
    await writeMissedNote(ctx, missedNote, 'sav', '2026-02-01', 'Ally Savings was missing on Feb 1', NOW);
    const mine = await addUserNote(ctx, { date: '2026-03-11', text: 'Moved the savings', account_id: 'sav' }, NOW);
    await forgetEarlierAccount(ctx, 'sav');
    expect(await getHistory(ctx)).toEqual(before);
    // Its closure and Nya's notes named it: they go with the rest of it. The
    // person's own note stays: its words are theirs.
    expect(await lifecycleStore.get(ctx, 'sav')).toBeNull();
    expect(await timelineNotesStore.get(ctx, autoNoteId('sav'))).toBeNull();
    expect(await timelineNotesStore.get(ctx, missedNote)).toBeNull();
    expect(await timelineNotesStore.get(ctx, mine.id)).not.toBeNull();
  });
});

describe('the cliff is kept, never smoothed', () => {
  test('a stretch with nothing recorded across an end steps on the end day instead of drawing a line', () => {
    const points = [
      { date: '2026-03-01', value: 1000 },
      { date: '2026-03-02', value: 999, estimated: true },
      { date: '2026-03-03', value: 998, estimated: true },
      { date: '2026-03-04', value: 997, estimated: true },
      { date: '2026-03-05', value: 600 },
    ];
    const line = bridgeInteriorEstimates(points);
    expect(line.map((p) => p.value)).toEqual([1000, 900, 800, 700, 600]);
    const stepped = bridgeInteriorEstimates(points, ['2026-03-03']);
    expect(stepped.map((p) => p.value)).toEqual([1000, 1000, 600, 600, 600]);
    expect(stepped.slice(1, 4).every((p) => p.estimated)).toBe(true);
    // A break outside the hole changes nothing.
    expect(bridgeInteriorEstimates(points, ['2026-03-01', '2026-04-01']).map((p) => p.value)).toEqual([1000, 900, 800, 700, 600]);
  });

  test('getHistory breaks the bridge on each end day', async () => {
    await recordDay('2026-03-01', { sav: 1000, chk: 500 }, TYPES);
    await replaceEstimated(ctx, ['2026-03-02', '2026-03-03', '2026-03-04'].map((date) => ({ date, value: 1500 })));
    await replaceEstimatedAccounts(ctx, ['2026-03-02', '2026-03-03', '2026-03-04'].map((date) => ({ date, balances: { sav: 1000, chk: 500 } })));
    await replaceEstimatedFlat(ctx, ['2026-03-02', '2026-03-03', '2026-03-04'].map((date) => ({ date, balances: {} })));
    await recordDay('2026-03-05', { chk: 500 }, TYPES);
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-03' }, ABOUT, NOW);
    const view = await getEffectiveLifecycle(ctx, new Map());
    expect(endBreaks(view.ended)).toEqual(['2026-03-03']);
    expect((await getHistory(ctx, undefined, view.ended)).map((p) => p.value)).toEqual([1500, 1500, 500, 500, 500]);
  });

  test('across a stretch with no point at all, the step is put on its own day, the day before it at the earlier value', () => {
    const points = [
      { date: '2026-03-12', value: 10_500 },
      { date: '2026-04-03', value: 500 },
    ];
    expect(bridgeInteriorEstimates(points, ['2026-03-13'])).toEqual([
      { date: '2026-03-12', value: 10_500 },
      { date: '2026-03-13', value: 500, estimated: true },
      { date: '2026-04-03', value: 500 },
    ]);
    expect(bridgeInteriorEstimates(points, ['2026-03-20'])).toEqual([
      { date: '2026-03-12', value: 10_500 },
      { date: '2026-03-19', value: 10_500, estimated: true },
      { date: '2026-03-20', value: 500, estimated: true },
      { date: '2026-04-03', value: 500 },
    ]);
    // On the later point's own day, it is the step already.
    expect(bridgeInteriorEstimates(points, ['2026-04-03'])).toEqual([
      { date: '2026-03-12', value: 10_500 },
      { date: '2026-04-02', value: 10_500, estimated: true },
      { date: '2026-04-03', value: 500 },
    ]);
    // With no break, nothing is added.
    expect(bridgeInteriorEstimates(points)).toEqual(points);
  });

  test('an end that moved nothing (closed at zero) is no step: the stretch around it is bridged as any other', async () => {
    await recordDay('2026-03-01', { sav: 0, chk: 1000 }, TYPES);
    await recordDay('2026-03-10', { chk: 500 }, TYPES);
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-03' }, ABOUT, NOW);
    const view = await getEffectiveLifecycle(ctx, new Map());
    const { breaks, points } = await getHistoryWithBreaks(ctx, undefined, view.ended);
    expect(breaks).toEqual([]);
    expect(points.map((p) => [p.date, p.value])).toEqual([
      ['2026-03-01', 1000],
      ['2026-03-10', 500],
    ]);
  });
});

describe('answers the guard reads', () => {
  test('ends, still-open answers per connection, and assumed closures by every id', () => {
    const at = '2026-03-12T00:00:00Z';
    const entries = new Map([
      ['a', { lifecycle: { state: 'closed' as const, on: '2026-03-12' }, ...ABOUT, set_at: at, assumed: true as const }],
      ['b', { lifecycle: { state: 'active' as const }, ...ABOUT, set_at: at, answered: { kind: 'missing' as const, since: '2026-03-12' } }],
      ['c', { lifecycle: { state: 'active' as const }, ...ABOUT, set_at: at, answered: { kind: 'zero' as const, since: '2026-02-01' } }],
      ['d', { lifecycle: { state: 'left' as const, on: '2026-03-01' }, ...ABOUT, set_at: at }],
    ]);
    const view = effectiveLifecycle(entries, new Map([['a0', { to: 'a', linked_at: at, evidence: {} }]]));
    const answers = answersFrom(view, Date.parse('2026-03-20T00:00:00Z'));
    expect([...answers.ended].sort()).toEqual(['a', 'a0', 'd']);
    expect(answers.stillOpen).toEqual(new Map([['item_ally', new Set(['b'])]]));
    expect(answers.reaskFrom).toEqual(new Map());
    expect(answers.assumed).toEqual(new Map([['a', 'a'], ['a0', 'a']]));
    // Still open holds for two weeks from the answer, then lapses and is asked again.
    const lapsed = answersFrom(view, Date.parse('2026-03-26T00:00:00Z'));
    expect(lapsed.stillOpen).toEqual(new Map());
    expect(lapsed.reaskFrom).toEqual(new Map([['b', '2026-03-26T00:00:00.000Z']]));
  });
});

describe('assumed closures', () => {
  test('are written only where nothing settles the account: an end stands, a Still open that holds keeps it held', async () => {
    await markStillOpen(ctx, 'b', { kind: 'missing', since: '2026-03-12' }, ABOUT, NOW);
    await markEnded(ctx, 'c', { state: 'left', on: '2026-03-01' }, ABOUT, NOW);
    const answered = await recordAssumedClosures(ctx, [
      { account_id: 'a', on: '2026-03-12', about: ABOUT },
      { account_id: 'b', on: '2026-03-12', about: ABOUT },
      { account_id: 'c', on: '2026-03-12', about: ABOUT },
    ], NOW);
    // a is assumed, c has its end: both settled. b stays held: not accepted.
    expect(answered).toEqual(new Set(['a', 'c']));
    expect((await lifecycleStore.get(ctx, 'a'))?.assumed).toBe(true);
    // The person's answers stand.
    expect((await lifecycleStore.get(ctx, 'b'))?.lifecycle).toEqual({ state: 'active' });
    expect((await lifecycleStore.get(ctx, 'c'))?.lifecycle).toEqual({ state: 'left', on: '2026-03-01' });
    expect((await timelineNotesStore.get(ctx, autoNoteId('a')))?.text).toBe('Ally Savings ••1234 assumed closed: it stopped appearing at Ally');
  });

  test('replace what doesn’t settle a missing account: a Still open about a zero, a lapsed one, a repair’s placeholder', async () => {
    await markStillOpen(ctx, 'z', { kind: 'zero', since: '2026-01-02' }, ABOUT, NOW);
    // Answered three weeks before: lapsed (STILL_OPEN_HOLD_DAYS).
    await markStillOpen(ctx, 'old', { kind: 'missing', since: '2026-03-12' }, ABOUT, NOW - 21 * 86_400_000);
    await lifecycleStore.set(ctx, 'p', { lifecycle: { state: 'active' }, type: null, label: { name: '', institution: '', mask: null }, item_id: null, set_at: new Date(0).toISOString() });
    const answered = await recordAssumedClosures(ctx, ['z', 'old', 'p'].map((account_id) => ({ account_id, on: '2026-03-12', about: ABOUT })), NOW);
    expect(answered).toEqual(new Set(['z', 'old', 'p']));
    for (const id of ['z', 'old', 'p']) {
      expect(await lifecycleStore.get(ctx, id)).toMatchObject({ lifecycle: { state: 'closed', on: '2026-03-12' }, assumed: true });
      expect(await timelineNotesStore.has(ctx, autoNoteId(id))).toBe(true);
    }
  });

  test('one that can’t be recorded is left out, so it stays held', async () => {
    fake.failNext('eval', 1);
    expect(await recordAssumedClosures(ctx, [{ account_id: 'a', on: '2026-03-12', about: ABOUT }], NOW)).toEqual(new Set());
    expect(await lifecycleStore.has(ctx, 'a')).toBe(false);
  });

  test('are lifted when the account comes back, a confirmed closure is not', async () => {
    await recordAssumedClosures(ctx, [{ account_id: 'a', on: '2026-03-12', about: ABOUT }], NOW);
    await markEnded(ctx, 'c', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    // Back on the day it was assumed gone from: no day was saved short.
    const sameDay = Date.parse('2026-03-12T15:00:00Z');
    expect(await liftAssumedClosures(ctx, ['a', 'c'], sameDay)).toEqual(['a']);
    expect(await lifecycleStore.has(ctx, 'a')).toBe(false);
    expect(await lifecycleStore.has(ctx, 'c')).toBe(true);
    expect(await timelineNotesStore.has(ctx, autoNoteId('a'))).toBe(false);
  });

  test('lifted later, the days saved without it are kept as a missing window, with a note, and left out of the chart', async () => {
    await recordDay('2026-03-11', { sav: 1000, chk: 500 }, TYPES);
    // Missing from 03-12; assumed closed; totals saved without it 03-15 to 03-17.
    for (const day of ['2026-03-15', '2026-03-16', '2026-03-17']) await recordDay(day, { chk: 500 }, TYPES);
    await recordAssumedClosures(ctx, [{ account_id: 'sav', on: '2026-03-12', about: ABOUT }], NOW);
    expect(await liftAssumedClosures(ctx, ['sav'], Date.parse('2026-03-18T12:00:00Z'))).toEqual(['sav']);
    await recordDay('2026-03-18', { sav: 1000, chk: 500 }, TYPES);
    const entry = await lifecycleStore.get(ctx, 'sav');
    expect(entry).toMatchObject({ lifecycle: { state: 'active' }, missed: [{ from: '2026-03-12', to: '2026-03-17' }] });
    expect(entry?.assumed).toBeUndefined();
    expect(await timelineNotesStore.has(ctx, autoNoteId('sav'))).toBe(false);
    // Its note is under a random id the window keeps: never the account's id
    // and a day in a field name.
    const noteId = entry!.missed![0].note!;
    expect(isMissedNoteId(noteId)).toBe(true);
    expect(noteId).not.toContain('sav');
    expect(noteId).not.toContain('2026');
    expect(await timelineNotesStore.get(ctx, noteId)).toMatchObject({
      date: '2026-03-12',
      kind: 'auto',
      account_id: 'sav',
      text: 'Ally Savings ••1234 was missing at Ally from Mar 12 to Mar 17, so the totals saved then, short of it, are left out',
    });
    // The chart leaves the short days out, so no dip is drawn; the real layer keeps them.
    const view = await getEffectiveLifecycle(ctx, new Map());
    expect(byDate(await getHistory(ctx, undefined, view.ended, shortDays(view, new Map())))).toEqual({ '2026-03-11': 1500, '2026-03-18': 1500 });
    expect(byDate(await getHistory(ctx))).toMatchObject({ '2026-03-15': 500 });
    // Hidden, it counts in no total: nothing is left out for it.
    expect(shortDays(view, new Map([['sav', { type: 'depository' }]]))).toEqual(new Set());
    // Kept through a later change, and only the days it still counts on.
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-16' }, ABOUT, NOW);
    const later = await getEffectiveLifecycle(ctx, new Map());
    expect([...shortDays(later, new Map())].sort()).toEqual(['2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15']);
    await reopenAccount(ctx, 'sav', new Map(), NOW);
    expect((await lifecycleStore.get(ctx, 'sav'))?.missed).toEqual([{ from: '2026-03-12', to: '2026-03-17', note: noteId }]);
  });

  test('a window recorded before windows kept their notes’ ids is given one, and its note moved there, once', async () => {
    // As this branch first wrote them: the window without an id, its note
    // under the account's id and the window's first day.
    const at = new Date(NOW).toISOString();
    await lifecycleStore.set(ctx, 'sav', { lifecycle: { state: 'active' }, ...ABOUT, set_at: at, missed: [{ from: '2026-03-12', to: '2026-03-17' }, { from: '2026-04-02', to: '2026-04-03' }] });
    const old = { date: '2026-03-12', text: 'Ally Savings ••1234 was missing at Ally from Mar 12 to Mar 17, so the totals saved then, short of it, are left out', kind: 'auto' as const, account_id: 'sav', created_at: at };
    await timelineNotesStore.set(ctx, legacyMissedNoteId('sav', '2026-03-12'), old);
    expect(await adoptMissedNotes(ctx, await readLifecycleEntries(ctx), NOW)).toBe(2);
    const [first, second] = (await lifecycleStore.get(ctx, 'sav'))!.missed!;
    expect([isMissedNoteId(first.note), isMissedNoteId(second.note)]).toEqual([true, true]);
    // Moved as it was written; the old id is gone.
    expect(await timelineNotesStore.get(ctx, first.note!)).toEqual(old);
    expect(await timelineNotesStore.has(ctx, legacyMissedNoteId('sav', '2026-03-12'))).toBe(false);
    // The window whose note was never written gets one.
    expect(await timelineNotesStore.get(ctx, second.note!)).toMatchObject({ date: '2026-04-02', kind: 'auto', account_id: 'sav', text: 'Ally Savings ••1234 was missing at Ally from Apr 2 to Apr 3, so the totals saved then, short of it, are left out' });
    // Once each has its id, nothing to do.
    const entries = await readLifecycleEntries(ctx);
    expect(hasUnkeyedWindows(entries)).toBe(false);
    expect(await adoptMissedNotes(ctx, entries, NOW)).toBe(0);
    // No field name holds a day.
    expect(Object.keys((await fake.hgetall<Record<string, string>>(ctxKey('timeline-notes'))) ?? {}).filter((id) => /\d{4}-\d{2}-\d{2}/.test(id))).toEqual([]);
    // A window id of another shape is not one this release wrote.
    expect(isLifecycleEntry({ lifecycle: { state: 'active' }, ...ABOUT, set_at: at, missed: [{ from: '2026-03-12', to: '2026-03-17', note: 'missed.sav.2026-03-12' }] })).toBe(false);
  });

  test('a window past the most kept goes, and so does its note, which would say days are left out that no longer are', async () => {
    const at = new Date(NOW).toISOString();
    const windows = Array.from({ length: MAX_MISSED }, (_, i) => {
      const day = `2025-${String(1 + Math.floor(i / 2)).padStart(2, '0')}-${i % 2 === 0 ? '05' : '20'}`;
      return { from: day, to: day, note: newMissedNoteId() };
    });
    await lifecycleStore.set(ctx, 'sav', { lifecycle: { state: 'active' }, ...ABOUT, set_at: at, missed: windows });
    for (const w of windows) await writeMissedNote(ctx, w.note, 'sav', w.from, 'A missing day', NOW);
    await recordAssumedClosures(ctx, [{ account_id: 'sav', on: '2026-03-12', about: ABOUT }], NOW);
    await liftAssumedClosures(ctx, ['sav'], Date.parse('2026-03-18T12:00:00Z'));
    const kept = (await lifecycleStore.get(ctx, 'sav'))!.missed!;
    expect(kept).toHaveLength(MAX_MISSED);
    expect(kept[0]).toEqual(windows[1]);
    expect(kept.at(-1)).toMatchObject({ from: '2026-03-12', to: '2026-03-17' });
    expect(await timelineNotesStore.has(ctx, windows[0].note)).toBe(false);
    expect(await timelineNotesStore.has(ctx, windows[1].note)).toBe(true);
    expect(await timelineNotesStore.has(ctx, kept.at(-1)!.note!)).toBe(true);
  });

  test('a confirmed answer replaces the assumption', async () => {
    await recordAssumedClosures(ctx, [{ account_id: 'a', on: '2026-03-12', about: ABOUT }], NOW);
    await markEnded(ctx, 'a', { state: 'closed', on: '2026-03-10', note: 'Moved to Chase' }, ABOUT, NOW);
    const entry = await lifecycleStore.get(ctx, 'a');
    expect(entry?.assumed).toBeUndefined();
    const note = await timelineNotesStore.get(ctx, autoNoteId('a'));
    expect(note).toMatchObject({ date: '2026-03-10', text: 'Ally Savings ••1234 closed: Moved to Chase', kind: 'auto', account_id: 'a' });
  });
});

describe('auto notes', () => {
  test('follow the account: written on its end day, moved with it, gone when it reopens', async () => {
    await markEnded(ctx, 'sav', { state: 'left', on: '2026-03-12', note: 'Sold' }, ABOUT, NOW);
    expect(await timelineNotesStore.get(ctx, autoNoteId('sav'))).toMatchObject({ date: '2026-03-12', text: 'Ally Savings ••1234 no longer yours: Sold' });
    await markEnded(ctx, 'sav', { state: 'untracked', from: '2026-04-01' }, ABOUT, NOW);
    expect(await timelineNotesStore.get(ctx, autoNoteId('sav'))).toMatchObject({ date: '2026-04-01', text: 'Ally Savings ••1234 no longer followed' });
    expect(await timelineNotesStore.count(ctx)).toBe(1);
    await reopenAccount(ctx, 'sav', new Map(), NOW);
    expect(await timelineNotesStore.count(ctx)).toBe(0);
  });

  test('one per account: a change on its current id takes the note an earlier id had', async () => {
    const links = new Map<string, Link>([['old_sav', { to: 'sav', linked_at: '2026-04-01T00:00:00Z', evidence: {} }]]);
    await markEnded(ctx, 'old_sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    await markEnded(ctx, 'sav', { state: 'left', on: '2026-03-20' }, ABOUT, NOW, links);
    expect((await timelineNotesStore.getAll(ctx)).size).toBe(1);
    expect(await timelineNotesStore.get(ctx, autoNoteId('sav'))).toMatchObject({ date: '2026-03-20' });
    // Answered Still open on it: no note is left to mark a change that isn't.
    await markEnded(ctx, 'old_sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    await markStillOpen(ctx, 'sav', { kind: 'missing', since: '2026-03-11' }, ABOUT, NOW, links);
    expect(await timelineNotesStore.count(ctx)).toBe(0);
  });

  test('the words for each state', () => {
    const label = { name: 'Vanguard Brokerage', institution: 'Vanguard', mask: null };
    expect(autoNoteText({ lifecycle: { state: 'closed', on: '2026-01-01' }, label })).toBe('Vanguard Brokerage closed');
    expect(autoNoteText({ lifecycle: { state: 'left', on: '2026-01-01', note: 'Transferred to Fidelity' }, label })).toBe('Vanguard Brokerage no longer yours: Transferred to Fidelity');
    expect(autoNoteText({ lifecycle: { state: 'untracked', from: '2026-01-01' }, label })).toBe('Vanguard Brokerage no longer followed');
    expect(autoNoteText({ lifecycle: { state: 'active' }, label })).toBeNull();
  });

  test('an end is saved even when its note can’t be', async () => {
    // The note's compare-and-set is the second eval.
    fake.failNext('eval', 1);
    await expect(markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW)).rejects.toThrow(/armed failure/);
    // The first eval (the end itself) failing fails the save; a note failing does not.
    const original = timelineNotesStore.update;
    (timelineNotesStore as any).update = async () => {
      throw new Error('note store down');
    };
    try {
      await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    } finally {
      (timelineNotesStore as any).update = original;
    }
    expect((await lifecycleStore.get(ctx, 'sav'))?.lifecycle).toEqual({ state: 'closed', on: '2026-03-12' });
  });
});

describe('for the app', () => {
  test('one per ended account, under its current id; answers that it is open are not listed', async () => {
    await markEnded(ctx, 'sav', { state: 'closed', on: '2026-03-12' }, ABOUT, NOW);
    await markStillOpen(ctx, 'chk', { kind: 'zero', since: '2026-02-01' }, ABOUT, NOW);
    await recordAssumedClosures(ctx, [{ account_id: 'card', on: '2026-03-01', about: CARD }], NOW);
    const list = lifecycleForClient(await getEffectiveLifecycle(ctx, new Map()));
    expect(list.map((l) => [l.account_id, l.lifecycle.state, l.assumed ?? false])).toEqual([
      ['sav', 'closed', false],
      ['card', 'closed', true],
    ]);
  });
});
