import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, testKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The emails about bank connections (lib/connection-notices.ts): exactly one
// notice per break and one reminder a week later, across repeated runs and the
// catch-up run; nothing while mail is off; a failed send leaves the break
// unmarked so the next run sends it; and no balance, amount or account number
// in any email.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

// For the end-to-end runs through the daily job: each Item's access token
// decides how Plaid answers. Every call fetchInstitution can make is stubbed,
// since mock.module is process-wide.
const plaidAnswers: Record<string, () => unknown> = {};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async (req: any) => {
      const answer = plaidAnswers[req.access_token];
      if (!answer) throw { response: { data: { error_code: 'ITEM_NOT_FOUND' } } };
      return answer();
    },
    investmentsHoldingsGet: async () => ({ data: { holdings: [], securities: [] } }),
    liabilitiesGet: async () => ({ data: { liabilities: {} } }),
  },
}));

const { encrypt } = await import('@/lib/crypto');
const { classifyFailure } = await import('@/lib/connection-state');
const { recordWarning } = await import('@/lib/connection-health');
const { noticesStore, warningsStore, syncsStore } = await import('@/lib/connection-records');
const { checkConnections, prepareNotices, sendNotices, decideNotice, composeNotice, appUrl, elapsedDays, OUTAGE_NOTICE_DAYS, REMINDER_DAYS, MASS_BREAK_CONTAINERS } = await import(
  '@/lib/connection-notices'
);
const { forgetMailOffLogged } = await import('@/lib/mail');
const { runSnapshots, readRegistry, snapshotDate } = await import('@/lib/snapshot-job');
const { forgetEpochs } = await import('@/lib/sessions');
type Inst = import('@/lib/networth').InstitutionResult;

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T13:00:00.000Z');
const day = (n: number, hours = 0) => T0 + n * DAY + hours * 3_600_000;

const broken = (item_id: string, code = 'ITEM_LOGIN_REQUIRED', over: Partial<Inst> = {}): Inst => {
  const failure = classifyFailure({ code, responded: true });
  return {
    institution_name: 'Chase',
    item_id,
    accounts: [],
    holdings: [],
    error: 'Could not fetch balances',
    needs_reauth: failure.cause === 'login',
    liabilities: 'unavailable',
    failure,
    ...over,
  };
};
const healthy = (item_id: string, over: Partial<Inst> = {}): Inst => ({
  institution_name: 'Chase',
  item_id,
  accounts: [{ account_id: 'acct_1', name: 'Total Checking', mask: '4821', type: 'depository', subtype: 'checking', balance: 1234.56 }],
  holdings: [],
  error: null,
  needs_reauth: false,
  liabilities: 'unavailable',
  ...over,
});

/** What reached Resend: one entry per email, parsed. */
let sent: { to: string[]; subject: string; text: string; key: string }[] = [];
let resendStatus = 200;
const resend = (async (_url: string, init: RequestInit) => {
  if (resendStatus !== 200) return new Response('{}', { status: resendStatus });
  const body = JSON.parse(String(init.body));
  sent.push({ ...body, key: (init.headers as Record<string, string>)['Idempotency-Key'] });
  return Response.json({ id: `email_${sent.length}` });
}) as unknown as typeof fetch;
let episodes = 0;
const run = (institutions: Inst[], now: number, over: Record<string, unknown> = {}) =>
  checkConnections(ctx, institutions, {
    now,
    fetch: resend,
    recipients: async () => ['me@example.com'],
    newEpisode: () => `episode-${++episodes}`,
    ...over,
  });
const notice = (id: string) => noticesStore.get(ctx, id);

const saved = { ...process.env };
const quiet = { log: console.log, error: console.error, warn: console.warn };
beforeEach(async () => {
  fake.reset();
  sent = [];
  resendStatus = 200;
  episodes = 0;
  forgetMailOffLogged();
  forgetEpochs();
  for (const k of Object.keys(plaidAnswers)) delete plaidAnswers[k];
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.MAIL_FROM = 'Nya <alerts@example.com>';
  process.env.APP_URL = 'https://nya.example.com/';
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  await registerTestContainer(fake);
});
afterEach(() => {
  process.env = { ...saved };
  Object.assign(console, quiet);
  setSystemTime();
});

describe('one notice per break, and one reminder a week later', () => {
  test('across repeated runs and the catch-up: exactly one notice, then exactly one reminder', async () => {
    const inst = broken('item_chase');
    expect((await run([inst], day(0))).mail).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Chase needs reconnecting');
    // The catch-up two hours later, and the days after: nothing new. Days are
    // UTC calendar days, as the daily job's are: day 6 ends at midnight UTC.
    for (const t of [day(0, 2), day(1), day(3), day(6), day(6, 10)]) {
      expect((await run([inst], t)).mail).toBe('none');
    }
    expect(sent).toHaveLength(1);
    // A week after the notice, one reminder; its catch-up and later runs send nothing.
    expect((await run([inst], day(REMINDER_DAYS))).mail).toBe('sent');
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toBe('Reminder: Chase needs reconnecting');
    for (const t of [day(7, 2), day(8), day(14), day(40)]) await run([inst], t);
    expect(sent).toHaveLength(2);
    expect(await notice('item_chase')).toMatchObject({ episode: 'episode-1', notified_at: new Date(day(0)).toISOString(), reminded_at: new Date(day(7)).toISOString() });
  });

  test('a run that finds it fine ends the break; a later break is a new one, with its own notice', async () => {
    await run([broken('item_chase')], day(0));
    await run([healthy('item_chase')], day(1));
    expect(await notice('item_chase')).toBeNull();
    await run([broken('item_chase')], day(2));
    expect(sent.map((s) => s.subject)).toEqual(['Chase needs reconnecting', 'Chase needs reconnecting']);
    expect((await notice('item_chase'))?.episode).toBe('episode-2');
  });

  test('a break that comes to need something new is told of that at once, then reminded of it once', async () => {
    await recordWarning(ctx, 'item_chase', { webhook_code: 'PENDING_EXPIRATION', consent_expiration_time: new Date(day(6)).toISOString() }, day(0));
    await run([healthy('item_chase')], day(0, 1));
    expect(sent.map((s) => s.subject)).toEqual(['Reconnect Chase soon']);
    expect(sent[0].text).toContain("Plaid says Chase's connection will end around October 7");
    // The consent ran out: the connection now needs reconnecting. Same break,
    // but it has stopped now, which is news.
    await run([broken('item_chase')], day(6, 1));
    expect(sent.map((s) => s.subject)).toEqual(['Reconnect Chase soon', 'Chase needs reconnecting']);
    // Its reminder is a week after that notice, not after the first.
    for (let d = 7; d < 13; d++) await run([broken('item_chase')], day(d, 1));
    expect(sent).toHaveLength(2);
    await run([broken('item_chase')], day(13, 1));
    expect(sent.map((s) => s.subject)).toEqual(['Reconnect Chase soon', 'Chase needs reconnecting', 'Reminder: Chase needs reconnecting']);
    for (let d = 14; d < 40; d++) await run([broken('item_chase')], day(d, 1));
    expect(sent).toHaveLength(3);
    expect(await notice('item_chase')).toMatchObject({ told: ['reconnect_soon', 'needs_reauth'] });
  });

  // Review should-fix 2 (probe B): the only email said to wait.
  test('an outage already told as "nothing to do yet" that then needs a sign-in sends that email at once', async () => {
    const down = broken('item_chase', 'INSTITUTION_NOT_RESPONDING');
    await run([healthy('item_chase')], day(0));
    for (let d = 1; d <= 3; d++) await run([down], day(d));
    expect(sent.map((s) => s.subject)).toEqual(["Chase isn't updating"]);
    expect(sent[0].text).toContain("if it turns into something you need to do, Nya will email you about that");
    await run([broken('item_chase')], day(4));
    expect(sent.map((s) => s.subject)).toEqual(["Chase isn't updating", 'Chase needs reconnecting']);
    // One email per run and container, still: never both on one run.
    expect((await run([broken('item_chase')], day(4, 2))).mail).toBe('none');
  });

  test('a connection flapping between two states is told of each once a break, never again', async () => {
    const states = ['ITEM_LOGIN_REQUIRED', 'USER_PERMISSION_REVOKED'];
    for (let d = 0; d < 6; d++) await run([broken('item_chase', states[d % 2])], day(d));
    expect(sent.map((s) => s.subject)).toEqual(['Chase needs reconnecting', 'Chase needs connecting again']);
  });

  test('several connections due at once are one email, naming each', async () => {
    await run([broken('item_chase'), broken('item_amex', 'NO_ACCOUNTS', { institution_name: 'Amex' }), healthy('item_ally', { institution_name: 'Ally' })], day(0));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('2 bank connections need attention');
    expect(sent[0].text).toContain('Chase needs you to sign in again');
    expect(sent[0].text).toContain('Amex reports no open accounts');
    expect(sent[0].text).not.toContain('Ally');
  });

  test('an outage is emailed only once it has lasted three days since the last good answer', async () => {
    const down = broken('item_chase', 'INSTITUTION_DOWN');
    await run([healthy('item_chase')], day(0)); // the last good sync
    for (let d = 1; d < OUTAGE_NOTICE_DAYS; d++) expect((await run([down], day(d))).mail).toBe('none');
    expect(await notice('item_chase')).toMatchObject({ state: 'outage', notified_at: null });
    expect((await run([down], day(OUTAGE_NOTICE_DAYS))).mail).toBe('sent');
    expect(sent[0].subject).toBe("Chase isn't updating");
    expect(sent[0].text).toContain("Chase hasn't updated for 3 days: Chase isn't answering. There's nothing to do yet");
  });

  // Review nit (probe E): counted from the episode, the break may be older.
  test('with no last good answer on record, an outage is "at least" its days, counted from when it was first seen', async () => {
    const down = broken('item_chase', 'INSTITUTION_DOWN');
    await run([down], day(0));
    await run([down], day(3));
    expect(sent[0].text).toContain("Chase hasn't updated for at least 3 days: Chase isn't answering.");
  });

  test('the three days are three days elapsed, not three dates: a last good answer late in the evening waits a day more', () => {
    const lastOk = '2026-10-01T23:59:00.000Z';
    expect(elapsedDays(lastOk, Date.parse('2026-10-04T00:05:00.000Z'))).toBe(2);
    expect(elapsedDays(lastOk, Date.parse('2026-10-04T13:00:00.000Z'))).toBe(2);
    expect(elapsedDays(lastOk, Date.parse('2026-10-05T13:00:00.000Z'))).toBe(3);
    const down = (at: string) => ({ state: 'outage' as const, cause: 'institution_down' as const, side: 'bank' as const, action: 'wait' as const, last_ok_at: at });
    expect(decideNotice(null, down(lastOk), Date.parse('2026-10-04T00:05:00.000Z'), () => 'e').send).toBeNull();
    // The daily job's own timing: the run three days after the one that last
    // saw it answer is three days, even when it starts a little earlier.
    expect(decideNotice(null, down('2026-10-01T13:00:20.000Z'), Date.parse('2026-10-04T13:00:05.000Z'), () => 'e').send).toBe('notice');
  });

  test('an outage that keeps answering in between never builds up to an email', async () => {
    const down = broken('item_chase', 'INSTITUTION_NOT_RESPONDING');
    for (let d = 0; d < 10; d++) await run([d % 2 ? healthy('item_chase') : down], day(d));
    expect(sent).toHaveLength(0);
  });

  test('a connection that needs the person is told at once; one missing an account, never', async () => {
    await run([broken('item_a', 'USER_PERMISSION_REVOKED')], day(0));
    expect(sent[0].subject).toBe('Chase needs connecting again');
    expect(sent[0].text).toContain('its history carries over when you link the new accounts to the old ones');
    sent = [];
    await run([healthy('item_b', { unconfirmed_missing: 1 })], day(0));
    expect(sent).toHaveLength(0);
    expect(await notice('item_b')).toBeNull();
  });
});

describe('sending', () => {
  test('with mail off, nothing is sent and one line says so; the break waits, unmarked', async () => {
    delete process.env.RESEND_API_KEY;
    const logs: string[] = [];
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    expect((await run([broken('item_chase')], day(0))).mail).toBe('off');
    expect((await run([broken('item_chase')], day(1))).mail).toBe('off');
    expect(sent).toHaveLength(0);
    expect(logs.filter((l) => l.includes('no email is sent'))).toHaveLength(1);
    expect(await notice('item_chase')).toMatchObject({ episode: 'episode-1', notified_at: null });
    // Mail turned on later: the break still open gets its notice.
    process.env.RESEND_API_KEY = 're_test_key';
    await run([broken('item_chase')], day(2));
    expect(sent).toHaveLength(1);
  });

  test('a failed send does not mark the break: the next run sends it, under the same key', async () => {
    resendStatus = 500;
    expect((await run([broken('item_chase')], day(0))).mail).toBe('failed');
    expect(await notice('item_chase')).toMatchObject({ notified_at: null });
    resendStatus = 200;
    expect((await run([broken('item_chase')], day(0, 2))).mail).toBe('sent');
    expect((await notice('item_chase'))?.notified_at).toBe(new Date(day(0, 2)).toISOString());
    // The same email again (an answer lost after Resend accepted it) carries the
    // same key, which Resend delivers once.
    const again = composeNotice(
      [{ institution_name: 'Chase', health: { state: 'needs_reauth', cause: 'login', side: 'you', action: 'reconnect', last_ok_at: null }, since: '', kind: 'notice' }],
      appUrl(),
      day(0, 2)
    );
    expect(sent[0].text).toBe(again.text);
    expect(sent[0].key).toMatch(/^nya-connections-[0-9a-f]{48}$/);
  });

  test('a send that never answers is not marked either', async () => {
    const hang = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect((await run([broken('item_chase')], day(0), { fetch: hang })).mail).toBe('failed');
    expect((await notice('item_chase'))?.notified_at).toBeNull();
  });

  test('nobody to write to, or no way to find out, sends nothing and marks nothing', async () => {
    expect((await run([broken('item_chase')], day(0), { recipients: async () => [] })).mail).toBe('no-recipient');
    expect((await run([broken('item_chase')], day(0), { recipients: async () => Promise.reject(new Error('clerk down')) })).mail).toBe('failed');
    expect(sent).toHaveLength(0);
    expect((await notice('item_chase'))?.notified_at).toBeNull();
  });

  test('the email links to the health view at APP_URL, or says to open Nya without one', async () => {
    await run([broken('item_chase')], day(0));
    expect(sent[0].text).toContain('https://nya.example.com/?view=connections');
    expect(sent[0].to).toEqual(['me@example.com']);
    process.env.APP_URL = 'http://nya.example.com';
    expect(appUrl()).toBeNull();
    process.env.APP_URL = 'http://localhost:3000/';
    expect(appUrl()).toBe('http://localhost:3000');
    delete process.env.APP_URL;
    expect(appUrl()).toBeNull();
    await run([broken('item_amex', 'ITEM_LOCKED', { institution_name: 'Amex' })], day(1));
    expect(sent[1].text).toContain('Open Nya to see the details.');
    expect(sent[1].text).not.toContain('http');
  });
});

describe('what an email may say', () => {
  // Distinctive figures, so any trace of them in an email is found.
  const BALANCE = 98765.43;
  const MASK = '4821';
  const rich = (inst: Inst): Inst => ({
    ...inst,
    accounts: [
      { account_id: 'acct_secret_1', name: 'Sapphire Reserve', official_name: 'Sapphire Reserve 4821', mask: MASK, type: 'credit', balance: BALANCE, limit: 25000, available: 1000, stale: true },
    ],
    stale_as_of: '2026-09-28',
    unshown_accounts: [{ account_id: 'acct_secret_2', name: 'Savings', mask: '7777' }],
  });

  test('never a balance, an amount or an account number, whatever the state', async () => {
    const codes = ['ITEM_LOGIN_REQUIRED', 'ACCESS_NOT_GRANTED', 'ITEM_LOCKED', 'USER_SETUP_REQUIRED', 'INSTITUTION_DOWN', 'INTERNAL_SERVER_ERROR', 'BRAND_NEW', 'USER_PERMISSION_REVOKED', 'ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN', 'ITEM_NOT_SUPPORTED', 'NO_ACCOUNTS'];
    const insts = codes.map((code, i) => rich(broken(`item_${i}`, code, { institution_name: `Bank ${String.fromCharCode(65 + i)}` })));
    insts.push(rich({ ...broken('item_cred', 'X'), failure: { cause: 'credentials', side: 'nya', code: null }, institution_name: 'Credit Union' }));
    await recordWarning(ctx, 'item_soon', { webhook_code: 'PENDING_DISCONNECT', reason: 'INSTITUTION_MIGRATION' }, day(0));
    insts.push(rich(healthy('item_soon', { institution_name: 'Soon Bank' })));
    await run(insts, day(-10)); // the breaks begin; the outages are told once they have lasted
    await run(insts, day(0));
    await run(insts, day(7));
    expect(sent.length).toBeGreaterThan(0);
    const all = sent.map((s) => `${s.subject}\n${s.text}`).join('\n');
    for (const trace of ['98765', '98,765', '765.43', MASK, '7777', '25000', '25,000', 'Sapphire', 'Savings', 'acct_secret', 'item_']) {
      expect([trace, all.includes(trace)]).toEqual([trace, false]);
    }
    // No currency, and no figure with decimals anywhere.
    expect(all).not.toMatch(/[$€£¥]|\d[\d,]*\.\d{2}\b|\bUSD\b/);
    // Every one of them was in the emails, by name, but those on Nya's side,
    // which nobody is emailed about.
    const nya = new Set(['Bank J', 'Credit Union']);
    for (const inst of insts) expect([inst.institution_name, all.includes(inst.institution_name)]).toEqual([inst.institution_name, !nya.has(inst.institution_name)]);
  });

  // Review nit (probe D): an end already past said "will end around".
  test('a warned end already past is "reconnect now", in the subject and the text', () => {
    const { subject, text } = composeNotice(
      [
        {
          institution_name: 'Chase',
          health: { state: 'reconnect_soon', cause: 'consent_ending', side: 'bank', action: 'reconnect', last_ok_at: new Date(day(0)).toISOString(), ends_at: new Date(day(-2)).toISOString(), ends_estimated: false },
          since: new Date(day(-6)).toISOString(),
          kind: 'notice',
        },
      ],
      null,
      day(0)
    );
    expect(subject).toBe('Reconnect Chase now');
    expect(text).toContain("Plaid said Chase's connection would end around September 29. Reconnect it now to keep it updating: it takes a minute.");
    expect(text).not.toContain('before then');
  });

  test('a name is one line, without control characters', () => {
    const { subject, text } = composeNotice(
      [{ institution_name: 'Evil\r\nBcc: x@y.z\u0000Bank', health: { state: 'needs_reauth', cause: 'login', side: 'you', action: 'reconnect', last_ok_at: null }, since: '', kind: 'notice' }],
      null,
      day(0)
    );
    expect(subject).toBe('Evil Bcc: x@y.z Bank needs reconnecting');
    expect(subject).not.toMatch(/[\r\n\u0000]/);
    expect(text.split('\n\n')[0]).not.toMatch(/[\r\n]/);
  });
});

describe('records', () => {
  test('a break whose record cannot be read is left exactly as it is, and nothing is sent for it', async () => {
    await fake.hset(ctxKey('connection-notices'), { item_chase: 'not-ciphertext' });
    const report = await run([broken('item_chase'), broken('item_amex', 'ITEM_LOCKED', { institution_name: 'Amex' })], day(0));
    expect(report).toMatchObject({ skipped: 1, mail: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).not.toContain('Chase');
    expect(await fake.hget<string>(ctxKey('connection-notices'), 'item_chase')).toBe('not-ciphertext');
  });

  test('so is one whose warning cannot be read: it is never taken for "no warning"', async () => {
    await run([healthy('item_chase')], day(0));
    await recordWarning(ctx, 'item_chase', { webhook_code: 'PENDING_EXPIRATION' }, day(0));
    await run([healthy('item_chase')], day(0, 1));
    expect(sent).toHaveLength(1);
    await fake.hset(ctxKey('connection-warnings'), { item_chase: 'damaged' });
    // Fine now, as far as the fetch knows; but its warning is unreadable, so its
    // break is not ended (which would let it be told again later).
    expect((await run([healthy('item_chase')], day(1))).skipped).toBe(1);
    expect(await notice('item_chase')).not.toBeNull();
  });

  test('records of connections no longer linked are dropped, and lapsed warnings too; unreadable ones stay', async () => {
    await run([broken('item_gone'), healthy('item_kept')], day(0));
    await recordWarning(ctx, 'item_gone', { webhook_code: 'PENDING_DISCONNECT' }, day(0));
    await recordWarning(ctx, 'item_kept', { webhook_code: 'PENDING_EXPIRATION', consent_expiration_time: new Date(day(2)).toISOString() }, day(0));
    await fake.hset(ctxKey('connection-syncs'), { item_damaged: 'damaged' });
    // item_gone was disconnected; item_kept answered past the end it was warned of.
    await run([healthy('item_kept')], day(3));
    expect([...(await noticesStore.getAllReport(ctx)).entries.keys()]).toEqual([]);
    expect((await warningsStore.getAllReport(ctx)).entries.size).toBe(0);
    const syncs = await syncsStore.getAllReport(ctx);
    expect([...syncs.entries.keys()]).toEqual(['item_kept']);
    expect(syncs.unreadable).toEqual(['item_damaged']);
  });

  test('a lapsed warning is dropped only if it is still the one read: a fresh one recorded meanwhile stays', async () => {
    await recordWarning(ctx, 'item_chase', { webhook_code: 'PENDING_EXPIRATION', consent_expiration_time: new Date(day(1)).toISOString() }, day(0));
    // The webhook lands between the run's read and its tidying.
    const original = warningsStore.update;
    warningsStore.update = async (c, id, fn) => {
      await warningsStore.set(c, id, { kind: 'pending_disconnect', received_at: new Date(day(3)).toISOString(), ends_at: new Date(day(10)).toISOString(), ends_estimated: true, reason: null });
      return original(c, id, fn);
    };
    try {
      await run([healthy('item_chase')], day(3));
    } finally {
      warningsStore.update = original;
    }
    expect((await warningsStore.get(ctx, 'item_chase'))?.kind).toBe('pending_disconnect');
  });

  test('stored encrypted, under the connection id, outside nothing but the container', async () => {
    await run([broken('item_chase')], day(0));
    const raw = await fake.hget<string>(ctxKey('connection-notices'), 'item_chase');
    expect(typeof raw).toBe('string');
    expect(raw).not.toContain('needs_reauth');
    expect(raw).not.toContain('episode');
  });

  test('nothing here ever writes to the history layer', async () => {
    const stale = { ...broken('item_chase'), accounts: [{ account_id: 'acct_1', name: 'Checking', type: 'depository', balance: 500, stale: true }], stale_as_of: '2026-09-28' };
    const ally = healthy('item_ally', { institution_name: 'Ally' });
    await run([stale, ally], day(0));
    await run([stale, ally], day(7));
    const keys = [...(fake as any).strings.keys(), ...(fake as any).hashes.keys()] as string[];
    expect(keys.filter((k) => k.includes(':history:') || k.includes('snapshot:'))).toEqual([]);
    expect(keys.filter((k) => k.includes(':c:')).map((k) => k.split(':').pop()).sort()).toEqual(['connection-notices', 'connection-syncs']);
  });
});

describe('the decision, on its own', () => {
  const h = (state: any, last_ok_at: string | null = null) => ({ state, cause: 'login' as const, side: 'you' as const, action: 'reconnect' as const, last_ok_at });
  const at = (t: number) => new Date(t).toISOString();

  test('a break starts an episode and is due a notice; fine ends it', () => {
    const first = decideNotice(null, h('needs_reauth'), day(0), () => 'e1');
    expect(first).toEqual({ next: { episode: 'e1', since: at(day(0)), state: 'needs_reauth', side: 'you', notified_at: null, reminded_at: null, told: [] }, send: 'notice' });
    expect(decideNotice(first.next, h('healthy'), day(1))).toEqual({ next: null, send: null });
    expect(decideNotice(null, h('partial'), day(1))).toEqual({ next: null, send: null });
  });

  test('a notified break is due its reminder on the seventh day, once', () => {
    const told = { episode: 'e1', since: at(day(0)), state: 'needs_reauth' as const, notified_at: at(day(0)), reminded_at: null };
    expect(decideNotice(told, h('needs_reauth'), day(6, 10)).send).toBeNull();
    expect(decideNotice(told, h('needs_reauth'), day(7)).send).toBe('reminder');
    expect(decideNotice({ ...told, reminded_at: at(day(7)) }, h('needs_reauth'), day(30)).send).toBeNull();
  });
});

describe('end to end, through the daily snapshot and its catch-up', () => {
  const DATE0 = new Date(day(0));

  async function link(item_id: string, token: string) {
    await fake.hset(ctxKey('plaid:items'), {
      [item_id]: JSON.stringify({ item_id, institution_name: 'Chase', encrypted_access_token: await encrypt(token) }),
    });
  }
  const daily = async (t: number) => {
    setSystemTime(new Date(t));
    forgetEpochs();
    return runSnapshots(await readRegistry(), { scheduledFor: snapshotDate(t) });
  };

  test('a connection that breaks gets one notice and one reminder, however often the job runs', async () => {
    process.env.NOTIFY_EMAIL = 'owner@example.com';
    const realFetch = globalThis.fetch;
    globalThis.fetch = resend;
    try {
      await link('item_chase', 'tok-chase');
      plaidAnswers['tok-chase'] = () => ({
        data: { item: { institution_id: 'ins_3' }, accounts: [{ account_id: 'acct_1', name: 'Checking', type: 'depository', subtype: 'checking', mask: '4821', balances: { current: 1234.56 } }] },
      });
      expect((await daily(DATE0.getTime())).results[0].status).toBe('recorded');
      expect(sent).toHaveLength(0);

      // It breaks: the next day's run and its catch-up.
      plaidAnswers['tok-chase'] = () => {
        throw { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } };
      };
      expect((await daily(day(1))).results[0].status).toBe('unclean');
      expect((await daily(day(1, 2))).results[0].status).toBe('unclean'); // the catch-up
      expect(sent.map((s) => [s.to, s.subject])).toEqual([[['owner@example.com'], 'Chase needs reconnecting']]);
      for (let d = 2; d < 8; d++) {
        await daily(day(d));
        await daily(day(d, 2));
      }
      expect(sent).toHaveLength(1);
      await daily(day(8));
      await daily(day(8, 2));
      await daily(day(9));
      expect(sent.map((s) => s.subject)).toEqual(['Chase needs reconnecting', 'Reminder: Chase needs reconnecting']);
      // The history layer holds only the day it answered.
      const totals = await fake.hkeys(ctxKey('history:net-worth'));
      expect(totals).toEqual([snapshotDate(DATE0.getTime())]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// The review's blocking finding (probe A): INVALID_ACCESS_TOKEN is what a
// PLAID_ENV or PLAID_SECRET for another environment answers, for every
// connection at once, and the code itself puts it on Nya's side. Telling
// everybody to remove their connections would delete their stored
// transactions and leave the Items live at Plaid.
describe("Nya's side, and a fault many containers share", () => {
  const OTHERS = ['5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', '6e2d3c4b-5f6a-4b7c-9d8e-0f1a2b3c4d5e', '7f3e4d5c-6a7b-4c8d-ae9f-1a2b3c4d5e6f'];
  const CONTAINERS = [ctx.container as string, ...OTHERS];
  const ctxOf = (container: string) => ({ container }) as typeof ctx;
  const mailbox = (c: { container: string }) => `${c.container.slice(0, 8)}@example.com`;
  const logs: string[] = [];

  beforeEach(async () => {
    logs.length = 0;
    console.error = (...a: unknown[]) => void logs.push(a.join(' '));
    console.warn = (...a: unknown[]) => void logs.push(a.join(' '));
    for (const id of OTHERS) {
      await fake.hset(testKey('containers'), { [id]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
    }
  });

  test("a connection Plaid refuses Nya's token for is never emailed about, however long it lasts, and the log says why", async () => {
    const refused = broken('item_chase', 'INVALID_ACCESS_TOKEN');
    expect(refused.failure).toEqual({ cause: 'token', side: 'nya', code: 'INVALID_ACCESS_TOKEN' });
    await run([healthy('item_chase')], day(0));
    for (let d = 1; d <= 40; d++) expect((await run([refused], day(d))).mail).toBe('none');
    expect(sent).toHaveLength(0);
    expect(await notice('item_chase')).toMatchObject({ state: 'outage', side: 'nya', notified_at: null });
    expect(logs.some((l) => l.includes("fail for a reason on Nya's side (INVALID_ACCESS_TOKEN)") && l.includes('PLAID_ENV'))).toBe(true);
    // Nor the other ways Plaid refuses Nya, or a token Nya can't read.
    for (const failure of [classifyFailure({ code: 'INVALID_API_KEYS', type: 'INVALID_INPUT', responded: true }), { cause: 'credentials' as const, side: 'nya' as const, code: null }]) {
      for (let d = 41; d <= 50; d++) await run([{ ...broken('item_amex', 'X'), failure, institution_name: 'Amex' }], day(d));
    }
    expect(sent).toHaveLength(0);
  });

  test('a break that then turns out to be the person’s own is told, once it is', async () => {
    await run([broken('item_chase', 'INVALID_ACCESS_TOKEN')], day(0));
    await run([broken('item_chase', 'INVALID_ACCESS_TOKEN')], day(1));
    // The settings were put back, and the bank wants a new sign-in.
    await run([broken('item_chase')], day(2));
    expect(sent.map((s) => s.subject)).toEqual(['Chase needs reconnecting']);
  });

  test("relink advice for a cause on Plaid's side waits three days, so whoever runs Nya can see it first", async () => {
    await run([healthy('item_chase')], day(0));
    for (let d = 1; d < 3; d++) expect((await run([broken('item_chase', 'ITEM_NOT_FOUND')], day(d))).mail).toBe('none');
    expect((await run([broken('item_chase', 'ITEM_NOT_FOUND')], day(3))).mail).toBe('sent');
    expect(sent[0].subject).toBe('Chase needs connecting again');
    // The person's own withdrawal is told at once.
    await run([broken('item_amex', 'USER_PERMISSION_REVOKED', { institution_name: 'Amex' })], day(3));
    expect(sent.map((s) => s.subject)).toContain('Amex needs connecting again');
  });

  /** Each container's part of one run: its connections as the fetch found them. */
  const prepare = (now: number, byContainer: Record<string, Inst[]>) =>
    Promise.all(Object.entries(byContainer).map(([c, insts]) => prepareNotices(ctxOf(c), insts, { now, newEpisode: () => `episode-${++episodes}` })));
  const deliver = (batch: Awaited<ReturnType<typeof prepare>>, over: Record<string, unknown> = {}) =>
    sendNotices(batch, { fetch: resend, recipients: async (c) => [mailbox(c)], sleep: async () => {}, ...over });

  test('a new problem with the same code in many containers at once is held back for three days, then each goes, once', async () => {
    const all = (insts: (c: string) => Inst[]) => Object.fromEntries(CONTAINERS.map((c) => [c, insts(c)]));
    await deliver(await prepare(day(0), all(() => [healthy('item_chase')])));
    // A code Nya can't place, everywhere at once: due an email three days on,
    // on the same run in all four.
    for (let d = 1; d <= 5; d++) {
      const outcomes = await deliver(await prepare(day(d), all(() => [broken('item_chase', 'SOMETHING_NEW')])));
      if (d >= 3) expect([...outcomes.values()]).toEqual(['held', 'held', 'held', 'held']);
    }
    expect(sent).toHaveLength(0);
    // The operator is told why, and when they go: day 3 is October 4.
    expect(logs.some((l) => l.includes('(SOMETHING_NEW in 4)') && l.includes('those 4 email(s) are held back until October 7 (UTC)'))).toBe(true);
    expect(logs.some((l) => l.includes('4 email(s) held back by an earlier run') && l.includes('go from October 7 (UTC)'))).toBe(true);
    for (const c of CONTAINERS) expect(await noticesStore.get(ctxOf(c), 'item_chase')).toMatchObject({ notified_at: null, held_at: new Date(day(3)).toISOString() });
    // Three days on, the break still open: each goes, once, and is never held
    // again; the record of the hold goes with it.
    expect([...(await deliver(await prepare(day(6), all(() => [broken('item_chase', 'SOMETHING_NEW')])))).values()]).toEqual(['sent', 'sent', 'sent', 'sent']);
    expect(sent.map((s) => s.subject)).toEqual(Array(4).fill("Chase isn't updating"));
    for (let d = 7; d <= 12; d++) await deliver(await prepare(day(d), all(() => [broken('item_chase', 'SOMETHING_NEW')])));
    expect(sent).toHaveLength(4);
    const record = await noticesStore.get(ctx, 'item_chase');
    expect(record?.held_at).toBeUndefined();
    expect(record?.due_since).toBeUndefined();
  });

  test('while a notice is held, a sign-in somebody owes their bank still goes, and names only that', async () => {
    const all = (insts: (c: string) => Inst[]) => Object.fromEntries(CONTAINERS.map((c) => [c, insts(c)]));
    await deliver(await prepare(day(0), all(() => [healthy('item_chase')])));
    for (let d = 1; d <= 3; d++) await deliver(await prepare(day(d), all(() => [broken('item_chase', 'SOMETHING_NEW')])));
    const mixed = all(() => [broken('item_chase', 'SOMETHING_NEW')]);
    mixed[CONTAINERS[0]].push(broken('item_amex', 'ITEM_LOGIN_REQUIRED', { institution_name: 'Amex' }));
    expect([...(await deliver(await prepare(day(4), mixed))).values()]).toEqual(['sent', 'held', 'held', 'held']);
    expect(sent.map((s) => [s.to, s.subject])).toEqual([[[mailbox(ctx)], 'Amex needs reconnecting']]);
    expect(sent[0].text).not.toContain('Chase');
    // A held one whose break turns out to be the person's own goes at once,
    // and one whose break ends goes never.
    const later = all(() => [broken('item_chase', 'SOMETHING_NEW')]);
    later[CONTAINERS[1]] = [broken('item_chase', 'ITEM_LOGIN_REQUIRED')];
    later[CONTAINERS[2]] = [healthy('item_chase')];
    await deliver(await prepare(day(5), later));
    expect(sent.map((s) => [s.to[0], s.subject])).toEqual([
      [mailbox(ctx), 'Amex needs reconnecting'],
      [mailbox(ctxOf(CONTAINERS[1])), 'Chase needs reconnecting'],
    ]);
    await deliver(await prepare(day(6), later));
    expect(sent.map((s) => s.to[0])).toEqual([mailbox(ctx), mailbox(ctxOf(CONTAINERS[1])), mailbox(ctx), mailbox(ctxOf(CONTAINERS[3]))]);
  });

  // The verification's probe V1: a hold that latched never let these go.
  test('a lasting INSTITUTION_NO_LONGER_SUPPORTED across three containers is held, then each is told once; a fourth container’s own break is never caught in it', async () => {
    const [a, b, c, d] = CONTAINERS;
    const cu = (code?: string) => (code ? broken('item_cu', code, { institution_name: 'Small CU' }) : healthy('item_cu', { institution_name: 'Small CU' }));
    const bank = (code?: string) => (code ? broken('item_bank', code, { institution_name: 'Other Bank' }) : healthy('item_bank', { institution_name: 'Other Bank' }));
    await deliver(await prepare(day(0), { [a]: [cu()], [b]: [cu()], [c]: [cu()], [d]: [bank()] }));
    const byDay: Record<number, string[]> = {};
    for (let n = 1; n <= 30; n++) {
      // Plaid loses the fourth container's own connection on day 10.
      const out = await deliver(await prepare(day(n), { [a]: [cu('INSTITUTION_NO_LONGER_SUPPORTED')], [b]: [cu('INSTITUTION_NO_LONGER_SUPPORTED')], [c]: [cu('INSTITUTION_NO_LONGER_SUPPORTED')], [d]: [bank(n >= 10 ? 'ITEM_NOT_FOUND' : undefined)] }));
      byDay[n] = [...out.values()];
    }
    expect(byDay[3]).toEqual(['held', 'held', 'held', 'none']);
    expect(byDay[5]).toEqual(['held', 'held', 'held', 'none']);
    expect(byDay[6]).toEqual(['sent', 'sent', 'sent', 'none']);
    // Its own removal advice waits its three days, and goes alone.
    expect(byDay[12]).toEqual(['none', 'none', 'none', 'sent']);
    const mails = (box: string) => sent.filter((s) => s.to[0] === box).map((s) => s.subject);
    // Each told once, and reminded once a week on, as any notice is.
    for (const x of [a, b, c]) expect(mails(mailbox(ctxOf(x)))).toEqual(['Small CU can no longer be updated', 'Reminder: Small CU can no longer be updated']);
    expect(mails(mailbox(ctxOf(d)))).toEqual(['Other Bank needs connecting again', 'Reminder: Other Bank needs connecting again']);
  });

  // The coordinator's case: a deployment mistake can't make a bank ask for a
  // new sign-in, and a bank asking everyone at once is when each person
  // should be told, however long an outage elsewhere lasts.
  test('a Plaid outage across three containers, beside a sign-in break in a fourth: only the sign-in email goes while the hold lasts', async () => {
    const [a, b, c, d] = CONTAINERS;
    const ally = (code?: string) => (code ? broken('item_ally', code, { institution_name: 'Ally' }) : healthy('item_ally', { institution_name: 'Ally' }));
    const chase = (code?: string) => (code ? broken('item_chase', code) : healthy('item_chase'));
    await deliver(await prepare(day(0), { [a]: [ally()], [b]: [ally()], [c]: [ally()], [d]: [chase()] }));
    const outage = () => ally('INTERNAL_SERVER_ERROR');
    expect(outage().failure).toEqual({ cause: 'provider', side: 'plaid', code: 'INTERNAL_SERVER_ERROR' });
    for (let n = 1; n <= 2; n++) await deliver(await prepare(day(n), { [a]: [outage()], [b]: [outage()], [c]: [outage()], [d]: [chase()] }));
    expect(sent).toHaveLength(0);
    // Day three: the outage is due everywhere at once, and Chase asks the
    // fourth container's owner to sign in again.
    const day3 = await deliver(await prepare(day(3), { [a]: [outage()], [b]: [outage()], [c]: [outage()], [d]: [chase('ITEM_LOGIN_REQUIRED')] }));
    expect([day3.get(a as any), day3.get(b as any), day3.get(c as any), day3.get(d as any)]).toEqual(['held', 'held', 'held', 'sent']);
    expect(sent.map((s) => [s.to, s.subject])).toEqual([[[mailbox(ctxOf(d))], 'Chase needs reconnecting']]);
    // Held while its days last; the sign-in was told once, as ever.
    for (let n = 4; n <= 5; n++) await deliver(await prepare(day(n), { [a]: [outage()], [b]: [outage()], [c]: [outage()], [d]: [chase('ITEM_LOGIN_REQUIRED')] }));
    expect(sent.map((s) => s.subject)).toEqual(['Chase needs reconnecting']);
    for (const x of [a, b, c]) expect(await noticesStore.get(ctxOf(x), 'item_ally')).toMatchObject({ state: 'outage', side: 'plaid', notified_at: null });
    // Still down three days on: each outage email goes, once.
    await deliver(await prepare(day(6), { [a]: [outage()], [b]: [outage()], [c]: [outage()], [d]: [chase('ITEM_LOGIN_REQUIRED')] }));
    expect(sent.map((s) => s.subject)).toEqual(['Chase needs reconnecting', "Ally isn't updating", "Ally isn't updating", "Ally isn't updating"]);
  });

  test('an outage each was told of that turns into the same Plaid-side relink everywhere at once is held, then told, once', async () => {
    const [a, b, c] = CONTAINERS;
    await deliver(await prepare(day(0), { [a]: [healthy('item_x')], [b]: [healthy('item_x')], [c]: [healthy('item_x')] }));
    // Each stops answering a day apart, so each outage is told on its own.
    const at = (n: number, code: string) => ({
      [a]: [broken('item_x', code)],
      [b]: [n >= 2 ? broken('item_x', code) : healthy('item_x')],
      [c]: [n >= 3 ? broken('item_x', code) : healthy('item_x')],
    });
    for (let n = 1; n <= 5; n++) await deliver(await prepare(day(n), at(n, 'SOMETHING_NEW')));
    expect(sent.map((s) => s.subject)).toEqual(Array(3).fill("Chase isn't updating"));
    // Day 6: Plaid says all three are gone, at once.
    expect([...(await deliver(await prepare(day(6), at(6, 'ITEM_NOT_FOUND')))).values()]).toEqual(['held', 'held', 'held']);
    for (let n = 7; n <= 8; n++) await deliver(await prepare(day(n), at(n, 'ITEM_NOT_FOUND')));
    expect(sent).toHaveLength(3);
    expect([...(await deliver(await prepare(day(9), at(9, 'ITEM_NOT_FOUND')))).values()]).toEqual(['sent', 'sent', 'sent']);
    expect(sent.slice(3).map((s) => s.subject)).toEqual(Array(3).fill('Chase needs connecting again'));
  });

  // The verification's probe R4: the holds were recorded past the deadline.
  test('a run already past its mail deadline records no holds and sends nothing; those emails then go, unheld, with the next run', async () => {
    const [a, b, c] = CONTAINERS;
    const fine = { [a]: [healthy('item_x')], [b]: [healthy('item_x')], [c]: [healthy('item_x')] };
    const gone = () => ({ [a]: [broken('item_x', 'ITEM_NOT_FOUND')], [b]: [broken('item_x', 'ITEM_NOT_FOUND')], [c]: [broken('item_x', 'ITEM_NOT_FOUND')] });
    await deliver(await prepare(day(0), fine));
    for (let n = 1; n <= 2; n++) await deliver(await prepare(day(n), gone()));
    const now = day(3);
    const batch = await prepare(now, gone());
    const writes = fake.ops;
    const out = await deliver(batch, { clock: () => now, deadline: now - 60_000 });
    expect([...out.values()]).toEqual(['held', 'held', 'held']);
    expect(fake.ops).toBe(writes);
    expect(sent).toHaveLength(0);
    for (const x of [a, b, c]) expect((await noticesStore.get(ctxOf(x), 'item_x'))?.held_at).toBeUndefined();
    expect(logs.some((l) => l.includes('3 of those holds could not be recorded in time'))).toBe(true);
    // Not first due any more, so not held again: each goes the next day.
    expect([...(await deliver(await prepare(day(4), gone()))).values()]).toEqual(['sent', 'sent', 'sent']);
  });

  test('three different codes maturing on the same run are three problems, each told; so is the same code a day later', async () => {
    const [a, b, c, d] = CONTAINERS;
    const codes = { [a]: 'ITEM_NOT_FOUND', [b]: 'INSTITUTION_NO_LONGER_SUPPORTED', [c]: 'SOMETHING_NEW' };
    await deliver(await prepare(day(0), { [a]: [healthy('item_x')], [b]: [healthy('item_x')], [c]: [healthy('item_x')], [d]: [healthy('item_x')] }));
    for (let n = 1; n <= 3; n++) {
      const out = await deliver(await prepare(day(n), { [a]: [broken('item_x', codes[a])], [b]: [broken('item_x', codes[b])], [c]: [broken('item_x', codes[c])], [d]: [healthy('item_x')] }));
      if (n === 3) expect([...out.values()]).toEqual(['sent', 'sent', 'sent', 'none']);
    }
    expect(sent).toHaveLength(3);
    expect(logs.some((l) => l.includes('held back'))).toBe(false);
  });

  test('only notices first due on a run can start a hold: one that failed to send is not counted again', async () => {
    const [a, b, c] = CONTAINERS;
    const fine = { [a]: [healthy('item_x')], [b]: [healthy('item_x')], [c]: [healthy('item_x')] };
    await deliver(await prepare(day(0), fine));
    // a and b lose their connection on day 1, c on day 2: due on days 3 and 4,
    // three days after each last answered.
    const gone = (n: number) => ({ [a]: [broken('item_x', 'ITEM_NOT_FOUND')], [b]: [broken('item_x', 'ITEM_NOT_FOUND')], [c]: [n >= 2 ? broken('item_x', 'ITEM_NOT_FOUND') : healthy('item_x')] });
    for (let n = 1; n <= 2; n++) await deliver(await prepare(day(n), gone(n)));
    // Day 3: a's and b's are due, two containers, no hold; but Resend is down.
    resendStatus = 500;
    expect([...(await deliver(await prepare(day(3), gone(3)))).values()]).toEqual(['failed', 'deferred', 'none']);
    resendStatus = 200;
    expect(sent).toHaveLength(0);
    // Day 4: c's is due for the first time. a's and b's were due before, so
    // they can't make a shared fault with it: all three go.
    expect([...(await deliver(await prepare(day(4), gone(4)))).values()]).toEqual(['sent', 'sent', 'sent']);
    expect(logs.some((l) => l.includes('held back'))).toBe(false);
  });

  test(`fewer than ${MASS_BREAK_CONTAINERS} containers breaking that way are each told, as their own`, async () => {
    const pair = { [CONTAINERS[0]]: [healthy('item_chase')], [CONTAINERS[1]]: [healthy('item_chase')] };
    await deliver(await prepare(day(0), pair));
    const down = { [CONTAINERS[0]]: [broken('item_chase', 'SOMETHING_NEW')], [CONTAINERS[1]]: [broken('item_chase', 'SOMETHING_NEW')], [CONTAINERS[2]]: [healthy('item_chase')] };
    for (let d = 1; d <= 3; d++) await deliver(await prepare(day(d), down));
    expect(sent.map((s) => s.to[0]).sort()).toEqual([mailbox(ctxOf(CONTAINERS[0])), mailbox(ctxOf(CONTAINERS[1]))].sort());
  });

  // What the coordinator asked a test to prove: one deployment mistake, every
  // container's connections refused at once, through the daily job itself.
  test('one PLAID_ENV mix-up, every container refused at once: nobody is emailed, run after run, and the operator is told', async () => {
    for (const c of CONTAINERS) {
      for (const bank of ['chase', 'amex']) {
        await fake.hset(ctxKey('plaid:items', ctxOf(c)), {
          [`item_${bank}`]: JSON.stringify({ item_id: `item_${bank}`, institution_name: bank, encrypted_access_token: await encrypt(`tok-${c}-${bank}`) }),
        });
      }
    }
    const answer = (fn: () => unknown) => {
      for (const c of CONTAINERS) for (const bank of ['chase', 'amex']) plaidAnswers[`tok-${c}-${bank}`] = fn;
    };
    const daily = async (t: number) => {
      setSystemTime(new Date(t));
      forgetEpochs();
      return runSnapshots(await readRegistry(), { scheduledFor: snapshotDate(t), mail: { fetch: resend, recipients: async (c) => [mailbox(c)], sleep: async () => {} } });
    };
    answer(() => ({ data: { item: { institution_id: 'ins_3' }, accounts: [{ account_id: 'acct_1', name: 'Checking', type: 'depository', subtype: 'checking', mask: '4821', balances: { current: 100 } }] } }));
    await daily(day(0));
    // Production deployed with Preview's PLAID_ENV and PLAID_SECRET.
    answer(() => {
      throw { response: { data: { error_code: 'INVALID_ACCESS_TOKEN', error_type: 'INVALID_INPUT' } } };
    });
    for (let d = 1; d <= 9; d++) {
      const report = await daily(day(d));
      expect(report.results.map((r) => r.status)).toEqual(['unclean', 'unclean', 'unclean', 'unclean']);
      await daily(day(d, 2)); // the catch-up
    }
    expect(sent).toHaveLength(0);
    expect(logs.some((l) => l.includes("8 connection(s) in 4 container(s) fail for a reason on Nya's side (INVALID_ACCESS_TOKEN (8))"))).toBe(true);
    for (const c of CONTAINERS) expect(await noticesStore.get(ctxOf(c), 'item_chase')).toMatchObject({ state: 'outage', side: 'nya', notified_at: null });
    // The settings put back: every connection works again, and its break ends
    // without a word to anyone.
    answer(() => ({ data: { item: { institution_id: 'ins_3' }, accounts: [{ account_id: 'acct_1', name: 'Checking', type: 'depository', subtype: 'checking', mask: '4821', balances: { current: 100 } }] } }));
    await daily(day(10));
    expect(sent).toHaveLength(0);
    for (const c of CONTAINERS) expect(await noticesStore.get(ctxOf(c), 'item_chase')).toBeNull();
  });
});

// Review item 4: mail must never push the daily job past its 300 s limit.
describe('the time the emails may take', () => {
  const ctxOf = (container: string) => ({ container }) as typeof ctx;
  const IDS = [ctx.container as string, '8a4f5e6d-7b8c-4d9e-bf0a-2b3c4d5e6f7a', '9b5a6f7e-8c9d-4eaf-80b1-3c4d5e6f7a8b'];
  const dueIn = (now: number) => Promise.all(IDS.map((c) => prepareNotices(ctxOf(c), [broken('item_chase')], { now, newEpisode: () => `episode-${++episodes}` })));

  test('a slow email service: each send waits at most its timeout, none starts that could not end in time, and the rest wait, unmarked, for the next run', async () => {
    let clock = 0;
    // Resend taking its time: four seconds a call.
    const slow = (async (url: string, init: RequestInit) => {
      clock += 4_000;
      return resend(url, init);
    }) as unknown as typeof fetch;
    const batch = await dueIn(day(0));
    const outcomes = await sendNotices(batch, { fetch: slow, recipients: async () => ['me@example.com'], clock: () => clock, deadline: 15_000, sleep: async (ms) => void (clock += ms) });
    // 0 s and 4.5 s start in time (with 3 s to find the recipient, 4 s to
    // send and the pause between); 9 s could not end by 15 s.
    expect([...outcomes.values()]).toEqual(['sent', 'sent', 'deferred']);
    expect(sent).toHaveLength(2);
    expect(await noticesStore.get(ctxOf(IDS[2]), 'item_chase')).toMatchObject({ notified_at: null });
    // The next run sends it, and only it.
    const next = await sendNotices(await dueIn(day(0, 2)), { fetch: resend, recipients: async () => ['me@example.com'], sleep: async () => {} });
    expect([...next.values()]).toEqual(['none', 'none', 'sent']);
    expect(sent).toHaveLength(3);
  });

  test('a send that never answers is given up on at its timeout; the rest wait for the next run', async () => {
    const stalled = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const started = Date.now();
    const outcomes = await sendNotices(await dueIn(day(0)), { fetch: stalled, recipients: async () => ['me@example.com'], sendTimeoutMs: 30, sleep: async () => {} });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect([...outcomes.values()]).toEqual(['failed', 'deferred', 'deferred']);
    for (const c of IDS) expect(await noticesStore.get(ctxOf(c), 'item_chase')).toMatchObject({ notified_at: null });
  });

  test('a lookup of whom to write to that hangs is given up on too', async () => {
    const outcomes = await sendNotices([await prepareNotices(ctx, [broken('item_chase')], { now: day(0) })], {
      fetch: resend,
      recipients: () => new Promise<string[]>(() => {}),
      recipientsTimeoutMs: 20,
    });
    expect(outcomes.get(ctx.container)).toBe('failed');
    expect(sent).toHaveLength(0);
  });

  test('through the daily job: with its deadline already past, nothing is sent and nothing marked', async () => {
    process.env.NOTIFY_EMAIL = 'owner@example.com';
    await fake.hset(ctxKey('plaid:items'), { item_chase: JSON.stringify({ item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('tok-late') }) });
    plaidAnswers['tok-late'] = () => {
      throw { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } };
    };
    setSystemTime(new Date(day(1)));
    forgetEpochs();
    // The request began 290 s ago: past MAIL_DEADLINE_MS.
    await runSnapshots(await readRegistry(), { scheduledFor: snapshotDate(day(1)), startedAt: day(1) - 290_000, budgetMs: 300_000, mail: { fetch: resend } });
    expect(sent).toHaveLength(0);
    expect(await notice('item_chase')).toMatchObject({ notified_at: null });
    // The catch-up, on time, sends it.
    setSystemTime(new Date(day(1, 2)));
    await runSnapshots(await readRegistry(), { scheduledFor: snapshotDate(day(1)), mail: { fetch: resend } });
    expect(sent.map((s) => s.subject)).toEqual(['Chase needs reconnecting']);
  });
});

// Review nit: Resend's default limit is two requests a second, and the job
// may have many containers due at once.
describe("Resend's rate limit", () => {
  const ctxOf = (container: string) => ({ container }) as typeof ctx;
  const IDS = [ctx.container as string, '8a4f5e6d-7b8c-4d9e-bf0a-2b3c4d5e6f7a'];
  const dueIn = (now: number) => Promise.all(IDS.map((c) => prepareNotices(ctxOf(c), [broken('item_chase')], { now, newEpisode: () => `episode-${++episodes}` })));
  const limitedThen = (answers: Response[]) => {
    const keys: string[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)['Idempotency-Key']);
      return answers.shift() ?? resend(url, init);
    }) as unknown as typeof fetch;
    return { fn, keys };
  };
  const tooMany = (after?: string) => new Response('{"name":"rate_limit_exceeded"}', { status: 429, headers: after ? { 'Retry-After': after } : {} });

  test('one email at a time, at most two a second', async () => {
    const pauses: number[] = [];
    let clock = 0;
    await sendNotices(await dueIn(day(0)), { fetch: resend, recipients: async () => ['me@example.com'], clock: () => clock, sleep: async (ms) => void (pauses.push(ms), (clock += ms)) });
    expect(sent).toHaveLength(2);
    expect(pauses).toEqual([500]);
  });

  test('a 429 that asks for a short wait is waited out once, with the same idempotency key', async () => {
    const pauses: number[] = [];
    let clock = 0;
    const f = limitedThen([tooMany('1')]);
    const outcomes = await sendNotices([(await dueIn(day(0)))[0]], {
      fetch: f.fn,
      recipients: async () => ['me@example.com'],
      clock: () => clock,
      sleep: async (ms) => void (pauses.push(ms), (clock += ms)),
    });
    expect([...outcomes.values()]).toEqual(['sent']);
    expect(pauses).toEqual([1000]);
    expect(f.keys).toHaveLength(2);
    expect(f.keys[0]).toBe(f.keys[1]);
  });

  test('still limited, or asked to wait long: not marked, and the rest wait for the next run', async () => {
    for (const answers of [[tooMany('1'), tooMany('1')], [tooMany('30')]]) {
      sent = [];
      fake.reset();
      await registerTestContainer(fake);
      const f = limitedThen(answers);
      const outcomes = await sendNotices(await dueIn(day(0)), { fetch: f.fn, recipients: async () => ['me@example.com'], sleep: async () => {} });
      expect([...outcomes.values()]).toEqual(['failed', 'deferred']);
      expect(sent).toHaveLength(0);
      for (const c of IDS) expect(await noticesStore.get(ctxOf(c), 'item_chase')).toMatchObject({ notified_at: null });
    }
  });

  test('one email refused for itself (a 4xx) does not stop the others', async () => {
    const f = limitedThen([new Response('{"name":"validation_error"}', { status: 422 })]);
    const outcomes = await sendNotices(await dueIn(day(0)), { fetch: f.fn, recipients: async () => ['me@example.com'], sleep: async () => {} });
    expect([...outcomes.values()]).toEqual(['failed', 'sent']);
  });
});

// Review nit: the owners mapping was read once per container with an email due.
test('with Clerk, the owners mapping is read once for the whole run', async () => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_ALLOWED_USER_IDS = 'user_a, user_b';
  const OTHER = '8a4f5e6d-7b8c-4d9e-bf0a-2b3c4d5e6f7a';
  await fake.hset(testKey('owners'), { user_a: ctx.container, user_b: OTHER, user_gone: OTHER });
  let reads = 0;
  const hgetall = fake.hgetall.bind(fake);
  (fake as any).hgetall = async (key: string) => {
    if (key === testKey('owners')) reads++;
    return hgetall(key);
  };
  try {
    const batch = await Promise.all([ctx.container, OTHER].map((c) => prepareNotices({ container: c } as typeof ctx, [broken('item_chase')], { now: day(0) })));
    await sendNotices(batch, { fetch: resend, sleep: async () => {}, recipientDeps: { primaryEmail: async (id) => `${id}@example.com` } });
  } finally {
    (fake as any).hgetall = hgetall;
  }
  expect(reads).toBe(1);
  // And an owner taken off the allowlist is not written to.
  expect(sent.map((s) => s.to)).toEqual([['user_a@example.com'], ['user_b@example.com']]);
});
