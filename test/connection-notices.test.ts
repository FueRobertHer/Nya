import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

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
const { checkConnections, decideNotice, composeNotice, appUrl, OUTAGE_NOTICE_DAYS, REMINDER_DAYS } = await import('@/lib/connection-notices');
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

  test('a change of state within a break sends nothing new; the reminder speaks of the state it finds', async () => {
    await recordWarning(ctx, 'item_chase', { webhook_code: 'PENDING_EXPIRATION', consent_expiration_time: new Date(day(6)).toISOString() }, day(0));
    await run([healthy('item_chase')], day(0, 1));
    expect(sent.map((s) => s.subject)).toEqual(['Reconnect Chase soon']);
    expect(sent[0].text).toContain("Plaid says Chase's connection will end around October 7");
    // The consent ran out: the connection now needs reconnecting. Same break.
    for (let d = 1; d < 7; d++) await run([broken('item_chase')], day(d, 1));
    expect(sent).toHaveLength(1);
    await run([broken('item_chase')], day(7, 1));
    expect(sent.map((s) => s.subject)).toEqual(['Reconnect Chase soon', 'Reminder: Chase needs reconnecting']);
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
    unshown_accounts: [{ name: 'Savings', mask: '7777' }],
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
    // Every one of them was in the emails, by name.
    for (const inst of insts) expect(all).toContain(inst.institution_name);
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
    expect(first).toEqual({ next: { episode: 'e1', since: at(day(0)), state: 'needs_reauth', notified_at: null, reminded_at: null }, send: 'notice' });
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
