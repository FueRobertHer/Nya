import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, ctxKey, testKey, TEST_CTX, TEST_CONTAINER, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { NextRequest } from 'next/server';

// The weekly summary's routes (app/api/weekly-summary): the setting (checked
// field by field, read strictly, each person's own), the preview, "Send me one
// now" within its limit, and the link that turns it off without signing in,
// which works only with a real, unexpired link for that container's summary,
// says the same whatever else it is given, and is limited.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy({}, { get: () => async () => { throw new Error('Plaid must not be called by the weekly summary’s routes'); } }),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const settingsRoute = await import('@/app/api/weekly-summary/route');
const previewRoute = await import('@/app/api/weekly-summary/preview/route');
const sendRoute = await import('@/app/api/weekly-summary/send/route');
const unsubscribeRoute = await import('@/app/api/weekly-summary/unsubscribe/route');
const { weeklySettingStore, weeklyStateStore, SENDS_NOW_PER_DAY, UNSUBSCRIBES_PER_HOUR } = await import('@/lib/weekly-summary/store');
const { linkToken, linkExpiry, LINK_DAYS, OFF_MESSAGE, REFUSED_MESSAGE } = await import('@/lib/weekly-summary/unsubscribe');
const { sendNow } = await import('@/lib/weekly-summary/send-now');
const { sendWeeklySummaries } = await import('@/lib/weekly-summary/job');
const { forgetEpochs } = await import('@/lib/sessions');
const { forgetMailOffLogged } = await import('@/lib/mail');
const { API_AUTH_MAX_FAILURES } = await import('@/lib/rate-limit');
const { config, proxy } = await import('@/proxy');
type ContainerId = import('@/lib/containers').ContainerId;

const ME = TEST_CONTAINER as ContainerId;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' as ContainerId };

const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const getSetting = () => settingsRoute.GET();
const put = (body: unknown) => settingsRoute.PUT(new Request('https://nya.test/api/weekly-summary', json('PUT', body)));
const ON = { enabled: true, weekday: 1, time_zone: 'America/New_York' };

const saved = { ...process.env };
const quiet = { log: console.log, error: console.error, warn: console.warn };
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  forgetMailOffLogged();
  clerk.signedIn = null;
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.MAIL_FROM = 'Nya <alerts@example.com>';
  process.env.APP_URL = 'https://nya.example.com';
  process.env.NOTIFY_EMAIL = 'owner@example.com';
  for (const k of ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'CLERK_ALLOWED_USER_IDS', 'CONTAINER_ID', 'VERCEL_ENV', 'DEMO_USER_IDS']) delete process.env[k];
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  await registerTestContainer(fake);
  await fake.hset(testKey('containers'), { [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-02-01T00:00:00.000Z' }) });
});
afterEach(() => {
  process.env = { ...saved };
  Object.assign(console, quiet);
  setSystemTime();
});

/** Signed in with Clerk as `user`, who owns `container`. */
async function signIn(user: string, container: string = TEST_CONTAINER) {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_placeholder';
  process.env.CLERK_SECRET_KEY = 'sk_test_placeholder';
  process.env.CLERK_ALLOWED_USER_IDS = [process.env.CLERK_ALLOWED_USER_IDS, user].filter(Boolean).join(',');
  await fake.hset(testKey('owners'), { [user]: container });
  clerk.signedIn = user;
}

// ---- The setting ----

describe('the setting', () => {
  test('is off, and unsaved, until the person saves one', async () => {
    const res = await getSetting();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ setting: null, can_send: true, why_not: null, demo: false });
  });

  test('a save is checked field by field, and nothing is saved when it fails', async () => {
    for (const bad of [
      'not json',
      null,
      [],
      { ...ON, enabled: 'yes' },
      { ...ON, weekday: 7 },
      { ...ON, weekday: '1' },
      { ...ON, time_zone: 'Nowhere/Place' },
      { ...ON, time_zone: 'x'.repeat(200) },
      { ...ON, extra: true },
      { enabled: true },
    ]) {
      const res = await put(bad);
      expect([bad, res.status]).toEqual([bad, 400]);
      expect(typeof (await res.json()).error).toBe('string');
    }
    expect(await weeklySettingStore.get(TEST_CTX)).toBeNull();
  });

  test('saved, with its zone as the runtime names it, and read back', async () => {
    const res = await put({ ...ON, time_zone: 'america/new_york' });
    expect(res.status).toBe(200);
    const { setting } = await res.json();
    expect(setting).toMatchObject({ v: 1, enabled: true, weekday: 1, time_zone: 'America/New_York' });
    expect((await (await getSetting()).json()).setting).toEqual(setting);
  });

  test('the same choice again changes nothing; another is saved with its day', async () => {
    const first = (await (await put(ON)).json()).setting;
    await new Promise((r) => setTimeout(r, 5));
    expect((await (await put(ON)).json()).setting).toEqual(first);
    const moved = (await (await put({ ...ON, weekday: 5 })).json()).setting;
    expect(moved.weekday).toBe(5);
    expect(moved.updated_at >= first.updated_at).toBe(true);
  });

  test('turned on makes the key its links are signed with, and turned on again after off, a new one', async () => {
    await put(ON);
    const key = (await weeklyStateStore.get(TEST_CTX))!.key;
    await put({ ...ON, weekday: 2 });
    expect((await weeklyStateStore.get(TEST_CTX))!.key).toBe(key);
    await put({ ...ON, enabled: false });
    await put(ON);
    expect((await weeklyStateStore.get(TEST_CTX))!.key).not.toBe(key);
  });

  test('turned on again, only the key is new: the weeks sent, one with no answer and the goals told of stay', async () => {
    await put(ON);
    const before = { ...(await weeklyStateStore.get(TEST_CTX))!, sent: '2026-10-12', sent_at: '2026-10-12T13:01:00.000Z', unanswered: '2026-10-19', goals_told: ['g-fund'] };
    await weeklyStateStore.set(TEST_CTX, before);
    await put({ ...ON, enabled: false });
    await put(ON);
    const after = (await weeklyStateStore.get(TEST_CTX))!;
    expect(after.key).not.toBe(before.key);
    expect({ ...after, key: before.key }).toEqual(before);
  });

  test('saved but unreadable: a 409, flagged, never read as off, and never written over', async () => {
    await fake.set(ctxKey('weekly-summary'), 'damaged-but-maybe-recoverable-ciphertext-xx');
    const res = await getSetting();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ unreadable: true });
    expect((await put(ON)).status).toBe(409);
    expect(await fake.get<string>(ctxKey('weekly-summary'))).toBe('damaged-but-maybe-recoverable-ciphertext-xx');
  });

  test('each person’s own: one’s save never reaches another’s', async () => {
    await signIn('user_me', TEST_CONTAINER);
    await put(ON);
    await signIn('user_other', OTHER.container);
    expect((await (await getSetting()).json()).setting).toBeNull();
    await put({ ...ON, weekday: 4 });
    expect((await weeklySettingStore.get(TEST_CTX))!.weekday).toBe(1);
    expect((await weeklySettingStore.get(OTHER))!.weekday).toBe(4);
  });

  test('says when this copy of Nya can’t send one, and why', async () => {
    delete process.env.APP_URL;
    expect(await (await getSetting()).json()).toMatchObject({ can_send: false, why_not: expect.stringContaining('APP_URL') });
    delete process.env.NOTIFY_EMAIL;
    expect(await (await getSetting()).json()).toMatchObject({ can_send: false, why_not: expect.stringContaining('NOTIFY_EMAIL') });
    delete process.env.RESEND_API_KEY;
    expect(await (await getSetting()).json()).toMatchObject({ can_send: false, why_not: expect.stringContaining('isn’t set up to send email') });
  });

  test('a demo account can’t turn it on', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.DEMO_USER_IDS = 'user_demo:Alex';
    await signIn('user_demo');
    expect(await (await getSetting()).json()).toMatchObject({ can_send: false, demo: true });
    const res = await put(ON);
    expect(res.status).toBe(403);
    expect(await weeklySettingStore.get(TEST_CTX)).toBeNull();
    // Off is always allowed.
    expect((await put({ ...ON, enabled: false })).status).toBe(200);
  });
});

// ---- The preview ----

describe('the preview', () => {
  test('checks what it is asked for', async () => {
    for (const q of ['', '?weekday=1', '?weekday=7&time_zone=UTC', '?weekday=x&time_zone=UTC', '?weekday=1&time_zone=Nowhere/Place']) {
      expect([q, (await previewRoute.GET(new Request(`https://nya.test/api/weekly-summary/preview${q}`))).status]).toEqual([q, 400]);
    }
  });

  test('is this week’s summary, as it would go, without its link to turn it off', async () => {
    const res = await previewRoute.GET(new Request('https://nya.test/api/weekly-summary/preview?weekday=1&time_zone=UTC'));
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.subject.startsWith('Your week in Nya: ')).toBe(true);
    expect(p.text).toContain(`Your week in Nya: `);
    expect(p.text).toContain('To stop these summaries, open https://nya.example.com/unsubscribe?t=... or turn them off in Nya');
    expect(p.first < p.last && p.last < p.send_day).toBe(true);
    // Nothing was written for it.
    expect(await weeklyStateStore.get(TEST_CTX)).toBeNull();
  });
});

// ---- Send me one now ----

/** What reached Resend. */
let sent: { to: string[]; subject: string; text: string; headers?: Record<string, string> }[] = [];
const resend = (async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)));
  return Response.json({ id: `email_${sent.length}` });
}) as unknown as typeof fetch;

describe('send me one now', () => {
  beforeEach(() => {
    sent = [];
  });
  const send = (body: unknown) => sendRoute.POST(new Request('https://nya.test/api/weekly-summary/send', json('POST', body)));

  test('checks what it is asked for', async () => {
    for (const bad of ['x', null, { weekday: 1 }, { weekday: 9, time_zone: 'UTC' }, { weekday: 1, time_zone: 'Nowhere/Place' }, { weekday: 1, time_zone: 'UTC', to: 'someone@example.com' }]) {
      expect([bad, (await send(bad)).status]).toEqual([bad, 400]);
    }
  });

  test('says why it can’t, when this copy of Nya can’t send one', async () => {
    delete process.env.RESEND_API_KEY;
    const res = await send({ weekday: 1, time_zone: 'UTC' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('isn’t set up to send email');
  });

  test('sends the preview’s summary to the owner, asked for, and while off with no link to turn it off', async () => {
    expect(await sendNow(TEST_CTX, { weekday: 1, time_zone: 'UTC' }, { fetch: resend, sleep: async () => {} })).toMatchObject({ kind: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['owner@example.com']);
    expect(sent[0].text).toContain('You asked Nya to send this now. The weekly summary isn’t on'.replace('’', "'"));
    expect(sent[0].text).not.toContain('/unsubscribe');
    expect(sent[0].headers).toBeUndefined();
  });

  test('with the summary on, it carries its links and counts as the week’s, so the job doesn’t send it again', async () => {
    await put({ enabled: true, weekday: 1, time_zone: 'UTC' });
    const monday = Date.parse('2026-10-12T09:00:00.000Z');
    // The setting was chosen before the day began.
    await weeklySettingStore.set(TEST_CTX, { ...(await weeklySettingStore.get(TEST_CTX))!, updated_at: '2026-09-01T00:00:00.000Z' });
    expect(await sendNow(TEST_CTX, { weekday: 1, time_zone: 'UTC' }, { now: monday, fetch: resend, sleep: async () => {} })).toEqual({ kind: 'sent', send_day: '2026-10-12' });
    expect(sent[0].text).toContain('https://nya.example.com/unsubscribe?t=');
    expect(sent[0].headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect((await weeklyStateStore.get(TEST_CTX))!.sent).toBe('2026-10-12');
    const out = await sendWeeklySummaries([{ id: ME, status: 'active', primary: true, created_at: '2026-01-01T00:00:00.000Z' }], {
      clock: () => monday + 4 * 3_600_000,
      fetch: resend,
      sync: async () => {},
      ready: () => true,
    });
    expect(out.get(ME)).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  test('its footer says the day saved, never the sheet’s unsaved day, and a summary for another day isn’t the week’s', async () => {
    await put({ enabled: true, weekday: 1, time_zone: 'UTC' });
    await weeklySettingStore.set(TEST_CTX, { ...(await weeklySettingStore.get(TEST_CTX))!, updated_at: '2026-09-01T00:00:00.000Z' });
    const saturday = Date.parse('2026-10-17T09:00:00.000Z');
    // The sheet shows Friday, to look at it; Monday is what is saved.
    expect(await sendNow(TEST_CTX, { weekday: 5, time_zone: 'UTC' }, { now: saturday, fetch: resend, sleep: async () => {} })).toEqual({ kind: 'sent', send_day: '2026-10-16' });
    expect(sent[0].text).toContain('Your week in Nya: Friday, October 9 to Thursday, October 15.');
    expect(sent[0].text).toContain("You asked Nya to send this now. It comes every Monday too, because you turned on the weekly summary.");
    expect(sent[0].text).not.toContain('every Friday');
    expect((await weeklyStateStore.get(TEST_CTX))!.sent).toBeNull();
  });

  test('one that can’t say how the week’s spending went isn’t the week’s: the job’s full one still goes', async () => {
    const { saveManualAccount } = await import('@/lib/manual');
    const { manualTxnStore } = await import('@/lib/manual-txns');
    const at = '2026-10-12T08:00:00.000Z';
    const monday = Date.parse('2026-10-12T09:00:00.000Z');
    // The readers read their year back from the clock: set to the week's
    // Monday, so the row below is in it whatever the real date.
    setSystemTime(new Date(monday));
    await saveManualAccount(TEST_CTX, { account_id: 'manual_wallet', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 40, updated_at: at });
    // One transaction this week and none before: too few weeks to compare.
    await manualTxnStore.set(TEST_CTX, 'manual_wallet', {
      version: 1,
      rows: [{ id: 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', account_id: 'manual_wallet', date: '2026-10-08', amount: 25, currency: 'USD', name: 'Farmers market', category: 'food and drink', note: '', source: 'manual', source_id: null, created_at: at, updated_at: at }],
    });
    await put({ enabled: true, weekday: 1, time_zone: 'UTC' });
    await weeklySettingStore.set(TEST_CTX, { ...(await weeklySettingStore.get(TEST_CTX))!, updated_at: '2026-09-01T00:00:00.000Z' });
    expect(await sendNow(TEST_CTX, { weekday: 1, time_zone: 'UTC' }, { now: monday, fetch: resend, sleep: async () => {} })).toMatchObject({ kind: 'sent' });
    expect(sent[0].text).toContain("Nya doesn't have enough weeks of transactions yet");
    expect((await weeklyStateStore.get(TEST_CTX))!.sent).toBeNull();
    const out = await sendWeeklySummaries([{ id: ME, status: 'active', primary: true, created_at: '2026-01-01T00:00:00.000Z' }], {
      clock: () => monday + 4 * 3_600_000,
      fetch: resend,
      sync: async () => {},
      ready: () => true,
    });
    expect(out.get(ME)).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  test(`at most ${SENDS_NOW_PER_DAY} a day, never a burst`, async () => {
    for (let i = 0; i < SENDS_NOW_PER_DAY; i++) expect((await sendNow(TEST_CTX, { weekday: 1, time_zone: 'UTC' }, { fetch: resend, sleep: async () => {} })).kind).toBe('sent');
    expect(await sendNow(TEST_CTX, { weekday: 1, time_zone: 'UTC' }, { fetch: resend })).toMatchObject({ kind: 'limited' });
    expect(sent).toHaveLength(SENDS_NOW_PER_DAY);
    const res = await send({ weekday: 1, time_zone: 'UTC' });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another person's own count.
    expect((await sendNow(OTHER, { weekday: 1, time_zone: 'UTC' }, { fetch: resend, recipients: async () => ['other@example.com'], sleep: async () => {} })).kind).toBe('sent');
  });

  test('nobody to send it to, or the email service refusing it, is said, and nothing is recorded', async () => {
    expect(await sendNow(TEST_CTX, { weekday: 1, time_zone: 'UTC' }, { fetch: resend, recipients: async () => [] })).toEqual({ kind: 'no-recipient' });
    const refusing = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    expect(await sendNow(TEST_CTX, { weekday: 1, time_zone: 'UTC' }, { fetch: refusing, sleep: async () => {} })).toEqual({ kind: 'failed' });
    expect(await weeklyStateStore.get(TEST_CTX)).toBeNull();
  });
});

// ---- The link that turns it off ----

const IP = '203.0.113.9';
const post = (token: string | null, ip = IP) =>
  unsubscribeRoute.POST(
    new Request(`https://nya.test/api/weekly-summary/unsubscribe${token === null ? '' : `?t=${token}`}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
      body: 'List-Unsubscribe=One-Click',
    })
  );
const failuresOf = async (ip = IP) => Number((await fake.get(testKey(`ratelimit:api:${ip}`))) ?? 0);

/** Turned on for `ctx`, and a link for it as an email would carry it. */
async function onWithLink(ctx: { container: ContainerId } = TEST_CTX, expires = linkExpiry(Date.now())) {
  await weeklySettingStore.set(ctx, { v: 1, enabled: true, weekday: 1, time_zone: 'UTC', updated_at: '2026-09-01T00:00:00.000Z' });
  await weeklyStateStore.set(ctx, { v: 1, key: Buffer.alloc(32, ctx.container === ME ? 1 : 2).toString('base64url'), sent: null, sent_at: null });
  return linkToken(ctx.container, (await weeklyStateStore.get(ctx))!.key, expires);
}

describe('the link that turns it off', () => {
  test('a real link turns off that container’s summary, and nobody else’s', async () => {
    const mine = await onWithLink(TEST_CTX);
    await onWithLink(OTHER);
    const res = await post(mine);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: OFF_MESSAGE });
    expect((await weeklySettingStore.get(TEST_CTX))!.enabled).toBe(false);
    expect((await weeklySettingStore.get(OTHER))!.enabled).toBe(true);
    // Again, or with it off already: the same answer.
    expect(await (await post(mine)).json()).toEqual({ ok: true, message: OFF_MESSAGE });
    expect(await failuresOf()).toBe(0);
  });

  test('every link that doesn’t work gets the same answer, and is counted against its address', async () => {
    const good = await onWithLink(TEST_CTX);
    const [container, expires, mac] = good.split('.');
    const otherKey = Buffer.alloc(32, 2).toString('base64url');
    await onWithLink(OTHER);
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    const cases: [string, string][] = [
      ['a forged mac', `${container}.${expires}.${flip(mac)}`],
      ['another day than it was signed for', `${container}.${String(Number(expires) + 1)}.${mac}`],
      ['expired', linkToken(ME, Buffer.alloc(32, 1).toString('base64url'), '2026-01-01')],
      ['signed with another container’s key', linkToken(ME, otherKey, expires.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'))],
      ['another container’s id on this one’s mac', `${OTHER.container}.${expires}.${mac}`],
      ['a container that doesn’t exist', linkToken('1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b' as ContainerId, Buffer.alloc(32, 1).toString('base64url'), '2027-01-01')],
    ];
    let counted = 0;
    for (const [what, token] of cases) {
      const res = await post(token);
      expect([what, res.status]).toEqual([what, 400]);
      expect(await res.json()).toEqual({ error: REFUSED_MESSAGE });
      expect([what, await failuresOf()]).toEqual([what, ++counted]);
    }
    // Neither summary was touched.
    expect((await weeklySettingStore.get(TEST_CTX))!.enabled).toBe(true);
    expect((await weeklySettingStore.get(OTHER))!.enabled).toBe(true);
    // Not even in a token's form: the same answer, and nothing counted or read.
    for (const junk of [null, '', 'x', `${good}x`, good.toUpperCase(), good.replace('.', '-')]) {
      const res = await post(junk);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: REFUSED_MESSAGE });
    }
    expect(await failuresOf()).toBe(counted);
  });

  test('an address past a flood of links that don’t work is turned away before anything is read', async () => {
    const good = await onWithLink(TEST_CTX);
    await fake.set(testKey(`ratelimit:api:${IP}`), String(API_AUTH_MAX_FAILURES));
    const res = await post(good);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await weeklySettingStore.get(TEST_CTX))!.enabled).toBe(true);
    // Another address is let through.
    expect((await post(good, '198.51.100.7')).status).toBe(200);
  });

  test(`a link that works, at most ${UNSUBSCRIBES_PER_HOUR} times an hour`, async () => {
    const good = await onWithLink(TEST_CTX);
    for (let i = 0; i < UNSUBSCRIBES_PER_HOUR; i++) expect((await post(good)).status).toBe(200);
    expect((await post(good)).status).toBe(429);
  });

  test('only a real link is told its data can’t be reached just now', async () => {
    const good = await onWithLink(TEST_CTX);
    await registerTestContainer(fake, 'restoring');
    expect((await post(good)).status).toBe(503);
    // Its first character changed: all six of its bits are the mac's. The
    // last one's lowest two are padding, so changing only those, as some days'
    // macs would, leaves the same mac.
    const [container, expires, mac] = good.split('.');
    expect((await post(`${container}.${expires}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`)).status).toBe(400);
  });

  test('a link whose container’s data key can’t be used is refused, or, once it checked out, told its data can’t be reached', async () => {
    const c = await import('@/lib/crypto');
    process.env.MASTER_KEY = Buffer.alloc(32, 71).toString('base64');
    c.forgetActiveKey();
    const lose = (id: string) => {
      fake.hashes.get(c.keysHashKey())!.delete(id);
      c.reloadKey(id);
      c.forgetActiveKey();
    };
    try {
      // Its record under its own key, gone from the store: the link can't be checked.
      const p = (await c.prepareContainerKey(OTHER.container, { born: true }))!;
      expect((await c.claimContainerKey(p)).outcome).toBe('made');
      const link = await onWithLink(OTHER);
      lose(p.id);
      const res = await post(link);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: REFUSED_MESSAGE });
      expect(await failuresOf()).toBe(1);
      // Its records written before its key, not moved yet: the link checks
      // out, but turning it off writes under the key that can't be used.
      const mine = await onWithLink(TEST_CTX);
      const q = (await c.prepareContainerKey(ME, { born: false }))!;
      expect((await c.claimContainerKey(q)).outcome).toBe('made');
      lose(q.id);
      const later = await post(mine);
      expect(later.status).toBe(503);
      expect(await later.json()).toEqual({ error: 'Your data can’t be reached just now. Try the link again later.' });
      expect(await failuresOf()).toBe(1);
    } finally {
      c.forgetActiveKey();
    }
  });

  test('a setting that can’t be read is left as it is, and said', async () => {
    const good = await onWithLink(TEST_CTX);
    await fake.set(ctxKey('weekly-summary'), 'damaged-but-maybe-recoverable-ciphertext-xx');
    const res = await post(good);
    expect(res.status).toBe(409);
    expect(await fake.get<string>(ctxKey('weekly-summary'))).toBe('damaged-but-maybe-recoverable-ciphertext-xx');
  });

  test('works for its days and no longer', async () => {
    expect(LINK_DAYS).toBe(90);
    const now = Date.parse('2026-10-12T13:00:00.000Z');
    expect(linkExpiry(now)).toBe('2027-01-10');
    const lastDay = await onWithLink(TEST_CTX, new Date().toISOString().slice(0, 10));
    expect((await post(lastDay)).status).toBe(200);
    const yesterday = await onWithLink(TEST_CTX, new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
    expect((await post(yesterday)).status).toBe(400);
  });

  test('opened in a browser, it acts on nothing: it goes to the page that asks', async () => {
    const good = await onWithLink(TEST_CTX);
    const res = await unsubscribeRoute.GET(new Request(`https://nya.test/api/weekly-summary/unsubscribe?t=${good}`));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`https://nya.test/unsubscribe?t=${good}`);
    expect((await weeklySettingStore.get(TEST_CTX))!.enabled).toBe(true);
    const odd = await unsubscribeRoute.GET(new Request(`https://nya.test/api/weekly-summary/unsubscribe?t=${'x'.repeat(500)}`));
    expect(odd.headers.get('location')).toBe('https://nya.test/unsubscribe');
  });
});

describe('the session gate', () => {
  const gated = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

  test('lets the link’s route past it, and only that path', () => {
    expect(gated('/api/weekly-summary/unsubscribe')).toBe(false);
    for (const path of ['/api/weekly-summary', '/api/weekly-summary/preview', '/api/weekly-summary/send', '/api/weekly-summary/unsubscribe/x', '/api/weekly-summary/unsubscribe2']) {
      expect([path, gated(path)]).toEqual([path, true]);
    }
  });

  test('the page that asks is public, and nothing beside it', async () => {
    const res = await proxy(new NextRequest('https://nya.test/unsubscribe?t=abc'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect((await proxy(new NextRequest('https://nya.test/unsubscribe/x'))).headers.get('location')).toBe('https://nya.test/login');
    expect((await proxy(new NextRequest('https://nya.test/api/weekly-summary'))).status).toBe(401);
  });
});
