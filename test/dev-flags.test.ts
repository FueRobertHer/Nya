import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';
import { mockForFile } from './scoped-mock';

// /dev/flags for local development: where it exists (lib/dev-flags.ts), and
// setting a switch there (app/api/dev/flags/route.ts) and showing them
// (app/dev/flags/page.tsx).

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { devFlagsOn } = await import('@/lib/dev-flags');

let here = true;
await mockForFile('@/lib/dev-flags', () => ({ devFlagsOn, devFlagsHere: () => here }));
const { PUT } = await import('@/app/api/dev/flags/route');
const { default: DevFlagsPage } = await import('@/app/dev/flags/page');
const { flagCache } = await import('@/lib/flag-cache');
const { cachedFlags } = await import('@/lib/flag-read');

const AT = '2026-11-01T12:00:00.000Z';
beforeEach(() => {
  fake.reset();
  flagCache.forget();
  here = true;
});

const put = (body: unknown, headers: Record<string, string> = {}) =>
  PUT(new Request('http://localhost:3000/api/dev/flags', { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

describe('where it exists', () => {
  const on = { nodeEnv: 'development', vercel: undefined, prefix: 'dev:', flag: '1' };
  test('only under next dev, off Vercel, on the dev: prefix, with NYA_DEV_FLAGS=1', () => {
    expect(devFlagsOn(on)).toBe(true);
    expect(devFlagsOn({ ...on, nodeEnv: 'production' })).toBe(false);
    expect(devFlagsOn({ ...on, nodeEnv: 'test' })).toBe(false);
    expect(devFlagsOn({ ...on, vercel: '1' })).toBe(false);
    expect(devFlagsOn({ ...on, prefix: 'development:' })).toBe(false); // Vercel's Development
    expect(devFlagsOn({ ...on, prefix: 'production:' })).toBe(false); // REDIS_PREFIX set locally
    expect(devFlagsOn({ ...on, flag: undefined })).toBe(false); // bun run dev:lan
    expect(devFlagsOn({ ...on, flag: 'true' })).toBe(false);
  });

  test('anywhere else the page and the route are missing', async () => {
    here = false;
    expect((await put({ key: 'ops', choice: 'on' })).status).toBe(404);
    await expect(DevFlagsPage()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    expect(fake.hashes.get(testKey('flags:values'))).toBeUndefined();
  });
});

describe('setting a switch', () => {
  test('lands in both keys, as made in local development, and this server’s copy sees it at once', async () => {
    expect((await cachedFlags()).flags.size).toBe(0);
    const res = await put({ key: 'lunchflow', choice: 'admin' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: 'lunchflow', choice: 'admin' });
    const stored = JSON.parse(String(fake.hashes.get(testKey('flags:values'))!.get('lunchflow')));
    expect(stored).toMatchObject({ on: 'admin', containers: [] });
    const [change] = [...fake.hashes.get(testKey('flags:log'))!.values()].map((v) => JSON.parse(v));
    expect(change).toMatchObject({ key: 'lunchflow', from: null, to: { on: 'admin' }, by: 'local development' });
    expect((await cachedFlags()).flags.get('lunchflow')).toMatchObject({ on: 'admin' });
  });

  test('an audience keeps the accounts it is also on for', async () => {
    const C = '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70';
    await fake.hset(testKey('flags:values'), { restore: JSON.stringify({ on: 'nobody', containers: [C], updatedAt: AT }) });
    expect((await put({ key: 'restore', choice: 'everyone' })).status).toBe(200);
    expect(JSON.parse(String(fake.hashes.get(testKey('flags:values'))!.get('restore')))).toMatchObject({ on: 'everyone', containers: [C] });
  });

  test('refuses an unknown key, the sign-in list, a choice the switch doesn’t take, or another site', async () => {
    expect((await put({ key: 'no-such-switch', choice: 'on' })).status).toBe(400);
    expect((await put({ key: 'sign-in', choice: 'everyone' })).status).toBe(400);
    expect((await put({ key: 'ops', choice: 'everyone' })).status).toBe(400);
    expect((await put({ key: 'csp', choice: 'on' })).status).toBe(400);
    expect((await put({ key: 'ops', choice: 'on' }, { origin: 'https://elsewhere.example' })).status).toBe(403);
    expect((await put({ key: 'ops', choice: 'on' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await put({ key: 'ops', choice: 'on' }, { 'content-type': 'text/plain' })).status).toBe(403);
    expect(fake.hashes.get(testKey('flags:values'))).toBeUndefined();
  });

  test('the choice already stored writes nothing and records no change', async () => {
    expect((await put({ key: 'ops', choice: 'on' })).status).toBe(200);
    const values = String(fake.hashes.get(testKey('flags:values'))!.get('ops'));
    expect((await put({ key: 'ops', choice: 'on' })).status).toBe(200);
    expect(String(fake.hashes.get(testKey('flags:values'))!.get('ops'))).toBe(values);
    expect(fake.hashes.get(testKey('flags:log'))!.size).toBe(1);
  });

  test('never writes over a stored value it can’t read', async () => {
    await fake.hset(testKey('flags:values'), { ops: 'not json' });
    const res = await put({ key: 'ops', choice: 'on' });
    expect(res.status).toBe(409);
    expect(fake.hashes.get(testKey('flags:values'))!.get('ops')).toBe('not json');
  });
});

describe('a switch this release doesn’t have', () => {
  // A record outlives its switch (docs/operations.md): plan-tax's, once T5 took
  // the switch away, and plan-items-in-fi's and plan-child-accounts', once their
  // cleanup did.
  const RETIRED = ['plan-tax', 'plan-items-in-fi', 'plan-child-accounts'];
  test('is left where it is, and neither read nor listed', async () => {
    const record = JSON.stringify({ on: 'everyone', containers: [], updatedAt: AT });
    await fake.hset(testKey('flags:values'), Object.fromEntries(RETIRED.map((key) => [key, record])));
    const page = (await DevFlagsPage()) as { props: { children: { props: { rows?: unknown[] } }[] } };
    const rows = page.props.children.find((c) => c?.props?.rows)!.props.rows as { key: string }[];
    const read = [...(await cachedFlags()).flags.keys()];
    for (const key of RETIRED) {
      expect(rows.map((r) => r.key)).not.toContain(key);
      expect(read).not.toContain(key);
      expect(await fake.hget(testKey('flags:values'), key)).toEqual(JSON.parse(record));
    }
  });
});

describe('the page', () => {
  test('shows every switch, what is stored, and what the environment decides', async () => {
    process.env.CSP_MODE = 'enforce';
    try {
      await fake.hset(testKey('flags:values'), {
        'brokerage-link': JSON.stringify({ on: 'admin', containers: ['5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70'], updatedAt: AT }),
        lunchflow: 'not json',
        'sign-in': JSON.stringify({ ids: ['user_a'], emails: ['pat@example.com'], updatedAt: AT }),
      });
      const page = (await DevFlagsPage()) as { props: { children: { props: { rows?: unknown[] } }[] } };
      const rows = page.props.children.find((c) => c?.props?.rows)!.props.rows as { key: string; stored: unknown; variableSet: boolean; people: number | null; accounts: number | null; containers: unknown }[];
      const by = Object.fromEntries(rows.map((r) => [r.key, r]));
      expect(rows.map((r) => r.key)).toEqual(['restore', 'restore-carry-on', 'lunchflow', 'brokerage-link', 'api-writes', 'csp', 'ops', 'sign-in']);
      expect(by['brokerage-link'].stored).toBe('admin');
      expect(by.lunchflow.stored).toBe('unreadable');
      expect(by.restore.stored).toBeNull();
      expect(by.csp.variableSet).toBe(true);
      expect(by['sign-in'].people).toBe(2);
      // Counted, never named: anyone signed in to a local server sees this page.
      expect(by['brokerage-link']).toMatchObject({ accounts: 1, containers: null });
      for (const named of ['5d1c7e2a', 'user_a', 'pat@example.com']) expect(JSON.stringify(rows)).not.toContain(named);
    } finally {
      delete process.env.CSP_MODE;
    }
  });
});
