import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, ctxKey, testKey, TEST_CTX, TEST_CONTAINER, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The weekly summaries the daily job sends (lib/weekly-summary/job.ts): one
// per container per week on its day, never twice (a catch-up run, a retry, an
// answer that never arrived), within the run's time, to the owners only, and
// nothing at all while mail is off or there is no link to stop it. And, from a
// container with a bit of everything, read by the app's own readers: never a
// figure in it.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Plaid must never be reached here: the sync is the job's to inject.
const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
        return async () => {
          throw new Error('Plaid must not be called by the weekly summary’s reads');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { sendWeeklySummaries, weekKey, SYNC_TIMEOUT_MS, GATHER_TIMEOUT_MS } = await import('@/lib/weekly-summary/job');
const { weeklySettingStore, weeklyStateStore } = await import('@/lib/weekly-summary/store');
const { figuresIn } = await import('@/lib/weekly-summary/compose');
const { parseLinkToken } = await import('@/lib/weekly-summary/unsubscribe');
const { encrypt } = await import('@/lib/crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { forgetMailOffLogged } = await import('@/lib/mail');
const { runSnapshots } = await import('@/lib/snapshot-job');
type Facts = import('@/lib/weekly-summary/content').WeeklyFacts;
type ContainerId = import('@/lib/containers').ContainerId;

const ME = TEST_CONTAINER as ContainerId;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' as ContainerId };
const MONDAY = Date.parse('2026-10-12T13:00:00.000Z'); // 9 a.m. in New York
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** What reached Resend, and Resend's own idempotency: the same key again is
 *  the same email, unless the email differs, which it refuses. */
type Sent = { to: string[]; subject: string; text: string; headers?: Record<string, string>; key: string };
let delivered: Sent[] = [];
let byKey = new Map<string, { body: string; id: string }>();
let mode: 'ok' | 'fail' | 'lose-answer' | 'concurrent' = 'ok';
const resend = (async (_url: string, init: RequestInit) => {
  const key = (init.headers as Record<string, string>)['Idempotency-Key'];
  const body = String(init.body);
  if (mode === 'fail') return new Response('{}', { status: 500 });
  if (mode === 'concurrent') return Response.json({ name: 'concurrent_idempotent_requests' }, { status: 409 });
  const seen = byKey.get(key);
  if (seen) return seen.body === body ? Response.json({ id: seen.id }) : Response.json({ name: 'invalid_idempotent_request' }, { status: 409 });
  const id = `email_${delivered.length + 1}`;
  delivered.push({ ...JSON.parse(body), key });
  byKey.set(key, { body, id });
  // Accepted, but the answer never came back.
  if (mode === 'lose-answer') throw new TypeError('fetch failed');
  return Response.json({ id });
}) as unknown as typeof fetch;

/** A quiet week for whatever week the job asks about. */
let level: 'same' | 'higher' = 'same';
const gather = async (_ctx: unknown, o: { sendDay?: string; weekday: number; timeZone: string }): Promise<Facts> => ({
  send_day: o.sendDay!,
  first: '2026-10-05',
  last: '2026-10-11',
  today: o.sendDay!,
  time_zone: o.timeZone,
  weekday: o.weekday as Facts['weekday'],
  spending: { kind: 'compared', level, left_out: [] },
  budgets: null,
  bills: [],
  goals: { reached: [], behind: [] },
  connections: [],
  months: [],
  uncategorized: 0,
});

const registry = (...ids: string[]) => ids.map((id, i) => ({ id: id as ContainerId, status: 'active' as const, primary: i === 0, created_at: '2026-01-01T00:00:00.000Z' }));
const turnOn = (ctx: { container: ContainerId } = TEST_CTX, over: Record<string, unknown> = {}) =>
  weeklySettingStore.set(ctx, { v: 1, enabled: true, weekday: 1, time_zone: 'America/New_York', updated_at: '2026-09-01T00:00:00.000Z', ...over } as never);

let syncs: string[] = [];
const run = (at: number, over: Record<string, unknown> = {}, ids: string[] = [TEST_CONTAINER]) =>
  sendWeeklySummaries(registry(...ids), {
    clock: () => at,
    sleep: async () => {},
    fetch: resend,
    recipients: async () => ['me@example.com'],
    sync: async (ctx) => void syncs.push(ctx.container),
    gather: gather as never,
    ready: () => true,
    ...over,
  });

const saved = { ...process.env };
const quiet = { log: console.log, error: console.error, warn: console.warn };
let logs: string[] = [];
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  forgetMailOffLogged();
  delivered = [];
  byKey = new Map();
  mode = 'ok';
  level = 'same';
  syncs = [];
  logs = [];
  plaidTouched.length = 0;
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.MAIL_FROM = 'Nya <alerts@example.com>';
  process.env.APP_URL = 'https://nya.example.com/';
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  delete process.env.NOTIFY_EMAIL;
  for (const k of ['log', 'error', 'warn'] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  await registerTestContainer(fake);
});
afterEach(() => {
  process.env = { ...saved };
  Object.assign(console, quiet);
  setSystemTime();
  expect(plaidTouched).toEqual([]);
});

describe('one summary per container per week', () => {
  test('sent on its day, with its key and its links, recorded, and never again', async () => {
    await turnOn();
    expect((await run(MONDAY)).get(ME)).toBe('sent');
    expect(delivered).toHaveLength(1);
    const [mail] = delivered;
    expect(mail.to).toEqual(['me@example.com']);
    expect(mail.subject).toBe('Your week in Nya: a quiet week');
    expect(mail.key).toBe(weekKey(ME, '2026-10-12'));
    // The key names neither the container nor the week.
    expect(mail.key).not.toContain(TEST_CONTAINER);
    expect(mail.key).not.toContain('2026');
    // Its links to turn it off: the page in the text, one-click in the headers.
    const page = /https:\/\/nya\.example\.com\/unsubscribe\?t=(\S+)/.exec(mail.text)![1];
    expect(parseLinkToken(page)).toMatchObject({ container: TEST_CONTAINER });
    expect(mail.headers).toEqual({ 'List-Unsubscribe': `<https://nya.example.com/api/weekly-summary/unsubscribe?t=${page}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect(await weeklyStateStore.get(TEST_CTX)).toMatchObject({ sent: '2026-10-12', sent_at: new Date(MONDAY).toISOString() });
    // The catch-up run, the next day, and the day after: nothing more.
    for (const at of [MONDAY + 2 * HOUR, MONDAY + DAY, MONDAY + 2 * DAY]) expect((await run(at)).get(ME)).toBeUndefined();
    expect(delivered).toHaveLength(1);
    // A week later, the next week's, under its own key.
    await run(MONDAY + 7 * DAY);
    expect(delivered).toHaveLength(2);
    expect(delivered[1].key).toBe(weekKey(ME, '2026-10-19'));
  });

  test('brought up to date before it is read, and sent all the same when that fails', async () => {
    await turnOn();
    const order: string[] = [];
    await run(MONDAY, {
      sync: async () => {
        order.push('sync');
        throw new Error('Plaid is down');
      },
      gather: async (ctx: unknown, o: never) => {
        order.push('gather');
        return gather(ctx, o);
      },
    });
    expect(order).toEqual(['sync', 'gather']);
    expect(delivered).toHaveLength(1);
  });

  test('a failed send is not recorded, and the next run sends it under the same key', async () => {
    await turnOn();
    mode = 'fail';
    expect((await run(MONDAY)).get(ME)).toBe('failed');
    expect((await weeklyStateStore.get(TEST_CTX))!.sent).toBeNull();
    mode = 'ok';
    expect((await run(MONDAY + 2 * HOUR)).get(ME)).toBe('sent');
    expect(delivered.map((d) => d.key)).toEqual([weekKey(ME, '2026-10-12')]);
  });

  test('an answer that never arrived is not delivered twice, whether the email is the same or its week moved since', async () => {
    await turnOn();
    mode = 'lose-answer';
    expect((await run(MONDAY)).get(ME)).toBe('failed');
    expect((await weeklyStateStore.get(TEST_CTX))!.sent).toBeNull();
    mode = 'ok';
    // The same email again: Resend answers for the one it has.
    expect((await run(MONDAY)).get(ME)).toBe('sent');
    expect(delivered).toHaveLength(1);
    expect((await weeklyStateStore.get(TEST_CTX))!.sent).toBe('2026-10-12');

    // And when the week's figures moved before the retry: Resend refuses the
    // key for another email, which says one went under it.
    await weeklyStateStore.set(TEST_CTX, { ...(await weeklyStateStore.get(TEST_CTX))!, sent: null, sent_at: null });
    level = 'higher';
    expect((await run(MONDAY + 2 * HOUR)).get(ME)).toBe('sent');
    expect(delivered).toHaveLength(1);
    expect((await weeklyStateStore.get(TEST_CTX))!.sent).toBe('2026-10-12');
  });

  test('one another invocation is sending is left to it', async () => {
    await turnOn();
    mode = 'concurrent';
    expect((await run(MONDAY)).get(ME)).toBe('deferred');
    expect((await weeklyStateStore.get(TEST_CTX))!.sent).toBeNull();
  });
});

describe('when it is due', () => {
  test('never while off, on another day, or never set up', async () => {
    expect((await run(MONDAY)).size).toBe(0);
    await turnOn(TEST_CTX, { enabled: false });
    await run(MONDAY);
    await turnOn(TEST_CTX, { weekday: 3 });
    await run(MONDAY);
    expect(delivered).toEqual([]);
    expect(await weeklyStateStore.get(TEST_CTX)).toBeNull();
  });

  test('only once the day’s snapshot is done', async () => {
    await turnOn();
    await run(MONDAY, { ready: () => false });
    expect(delivered).toEqual([]);
  });

  test('on the person’s calendar: Monday in New York begins at 4 a.m. UTC', async () => {
    await turnOn();
    // 3 a.m. UTC on Monday is still Sunday in New York.
    await run(Date.parse('2026-10-12T03:00:00.000Z'));
    expect(delivered).toEqual([]);
    await run(Date.parse('2026-10-12T04:30:00.000Z'));
    expect(delivered).toHaveLength(1);
  });

  test('a day missed is caught up the day after, once', async () => {
    await turnOn();
    await run(MONDAY + DAY);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].key).toBe(weekKey(ME, '2026-10-12'));
    await run(MONDAY + 2 * DAY);
    expect(delivered).toHaveLength(1);
  });

  test('a setting or record that can’t be read sends nothing, and is left as it is', async () => {
    await fake.set(ctxKey('weekly-summary'), 'not-ciphertext-at-all-but-long-enough-to-try');
    expect((await run(MONDAY)).get(ME)).toBe('unreadable');
    expect(await fake.get<string>(ctxKey('weekly-summary'))).toBe('not-ciphertext-at-all-but-long-enough-to-try');
    fake.reset();
    await registerTestContainer(fake);
    await turnOn();
    await fake.set(ctxKey('weekly-summary-state'), await encrypt(JSON.stringify({ v: 1, key: 'x', sent: 'later' })));
    expect((await run(MONDAY)).get(ME)).toBe('unreadable');
    expect(delivered).toEqual([]);
    expect(logs.join('\n')).toContain('could not be read, so no summary goes for it');
  });

  test('a time zone this runtime doesn’t know waits, and says so', async () => {
    await turnOn(TEST_CTX, { time_zone: 'Mars/Olympus_Mons' });
    expect((await run(MONDAY)).get(ME)).toBe('failed');
    expect(delivered).toEqual([]);
    expect(logs.join('\n')).toContain('is not one this runtime knows');
  });
});

describe('what it takes to send one', () => {
  test('with mail off, nothing is read or sent', async () => {
    await turnOn();
    delete process.env.RESEND_API_KEY;
    expect((await run(MONDAY)).size).toBe(0);
    expect(delivered).toEqual([]);
    expect(syncs).toEqual([]);
    expect(await weeklyStateStore.get(TEST_CTX)).toBeNull();
  });

  test('without APP_URL, none goes: each needs its link to turn it off', async () => {
    await turnOn();
    delete process.env.APP_URL;
    expect((await run(MONDAY)).get(ME)).toBe('no-link');
    expect(delivered).toEqual([]);
    expect(syncs).toEqual([]);
    expect(logs.join('\n')).toContain('APP_URL is not set');
  });

  test('nobody to send it to: not recorded, and said', async () => {
    await turnOn();
    expect((await run(MONDAY, { recipients: async () => [] })).get(ME)).toBe('no-recipient');
    expect((await weeklyStateStore.get(TEST_CTX))?.sent ?? null).toBeNull();
  });

  test('one that can’t be read is tried again by the next run', async () => {
    await turnOn();
    const failing = async () => {
      throw new Error('storage unreachable');
    };
    expect((await run(MONDAY, { gather: failing })).get(ME)).toBe('failed');
    expect(delivered).toEqual([]);
    await run(MONDAY + 2 * HOUR);
    expect(delivered).toHaveLength(1);
  });
});

describe('time', () => {
  test('a summary is started only if every step can end in time, and the rest wait', async () => {
    await turnOn();
    await turnOn(OTHER);
    await fake.hset(testKey('containers'), { [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
    // Not enough for one: nothing is started.
    const need = 500 + SYNC_TIMEOUT_MS + GATHER_TIMEOUT_MS + 3_000 + 4_000;
    let out = await run(MONDAY, { deadline: MONDAY + need - 1 }, [TEST_CONTAINER, OTHER.container]);
    expect([out.get(ME), out.get(OTHER.container)]).toEqual(['deferred', 'deferred']);
    expect(syncs).toEqual([]);
    // Enough for one, and the sync takes half a minute: the second waits.
    let t = MONDAY;
    out = await sendWeeklySummaries(registry(TEST_CONTAINER, OTHER.container), {
      clock: () => t,
      sleep: async () => {},
      fetch: resend,
      recipients: async () => ['me@example.com'],
      sync: async () => {
        t += 30_000;
      },
      gather: gather as never,
      ready: () => true,
      deadline: MONDAY + need + 1,
    });
    expect([out.get(ME), out.get(OTHER.container)]).toEqual(['sent', 'deferred']);
    expect(logs.join('\n')).toContain('no time left for this run');
  });

  test('the email service failing stops the rest until the next run', async () => {
    await turnOn();
    await turnOn(OTHER);
    await fake.hset(testKey('containers'), { [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
    mode = 'fail';
    const out = await run(MONDAY, {}, [TEST_CONTAINER, OTHER.container]);
    expect([out.get(ME), out.get(OTHER.container)]).toEqual(['failed', 'deferred']);
  });
});

describe('who gets it', () => {
  test('with the shared password, NOTIFY_EMAIL, for the deployment’s own container only', async () => {
    process.env.NOTIFY_EMAIL = 'owner@example.com';
    await turnOn();
    await turnOn(OTHER);
    await fake.hset(testKey('containers'), { [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
    const out = await run(MONDAY, { recipients: undefined }, [TEST_CONTAINER, OTHER.container]);
    expect([out.get(ME), out.get(OTHER.container)]).toEqual(['sent', 'no-recipient']);
    expect(delivered.map((d) => d.to)).toEqual([['owner@example.com']]);
  });

  test('with Clerk, the verified owners of the container, never someone it is shared with', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    // Alice owns this container; Bob owns another, and may see what Alice shares.
    await fake.hset(testKey('owners'), { user_alice: TEST_CONTAINER, user_bob: OTHER.container });
    await turnOn();
    await run(MONDAY, {
      recipients: undefined,
      recipientDeps: { allowed: async () => true, primaryEmail: async (id: string) => `${id}@example.com` },
    });
    expect(delivered.map((d) => d.to)).toEqual([['user_alice@example.com']]);
  });
});

describe('through the daily job', () => {
  test('after the day’s snapshot: not while it failed, and once the catch-up run records it', async () => {
    await turnOn();
    const weekly = { fetch: resend, recipients: async () => ['me@example.com'], sync: async () => {}, gather: gather as never, sleep: async () => {} };
    const reg = registry(TEST_CONTAINER);
    await runSnapshots(reg, { scheduledFor: '2026-10-12', startedAt: MONDAY, clock: () => MONDAY, work: async () => ({ status: 'failed', reason: 'x' }), weekly });
    expect(delivered).toEqual([]);
    await runSnapshots(reg, { scheduledFor: '2026-10-12', startedAt: MONDAY + 2 * HOUR, clock: () => MONDAY + 2 * HOUR, work: async () => ({ status: 'recorded' }), weekly });
    expect(delivered).toHaveLength(1);
    // A container recorded already, run again: nothing more.
    await runSnapshots(reg, { scheduledFor: '2026-10-12', startedAt: MONDAY + 3 * HOUR, clock: () => MONDAY + 3 * HOUR, work: async () => ({ status: 'recorded' }), weekly });
    expect(delivered).toHaveLength(1);
  });
});

// ---- From the app's own readers ----

describe('a summary of a container with a bit of everything', () => {
  test('says what the app says, and never a figure', async () => {
    // The fixture's days are counted from now: a Monday afternoon.
    setSystemTime(new Date('2026-10-12T15:00:00.000Z'));
    const { seedPerson, CHASE_TXNS } = await import('./api-fixture');
    await seedPerson(fake);
    await turnOn(TEST_CTX, { time_zone: 'UTC' });
    const out = await sendWeeklySummaries(registry(TEST_CONTAINER), {
      clock: () => Date.now(),
      sleep: async () => {},
      fetch: resend,
      recipients: async () => ['me@example.com'],
      sync: async () => {},
      ready: () => true,
    });
    expect(out.get(ME)).toBe('sent');
    const [{ subject, text }] = delivered;
    expect(figuresIn(subject, text)).toEqual([]);
    const bare = `${subject}\n${text}`.replace(/https:\S+/g, '');
    // No amount the fixture holds, no account mask, no merchant's digits.
    for (const t of CHASE_TXNS) {
      const n = Math.abs(t.amount);
      for (const shown of new Set([String(n), n.toFixed(2), n.toLocaleString('en-US')])) {
        if (n >= 10) expect([shown, bare.includes(shown)]).toEqual([shown, false]);
      }
    }
    for (const mask of ['1111', '2222', '3333', '4444', '123', '300000', '20500']) expect([mask, bare.includes(mask)]).toEqual([mask, false]);
    // Hidden accounts' rows are never named.
    expect(bare).not.toContain('HIDDEN-ACCOUNT-ROW');
    // What the daily job last found about the broker's sign-in, and Plaid's
    // warning about Chase, as the notices word them.
    expect(text).toContain('Broker needs reconnecting.');
    expect(text).toContain('Reconnect Chase soon: Plaid says its connection ends around');
    expect(text).toContain('Your week in Nya: Monday, October 5 to Sunday, October 11.');
    expect(text).toContain('It never includes balances, amounts or account numbers.');
    expect(subject.startsWith('Your week in Nya: ')).toBe(true);
  });
});
