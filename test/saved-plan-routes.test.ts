import { describe, expect, test, mock, beforeEach, afterEach, afterAll, setSystemTime } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The plan saved as your plan, on the storage seam (app/api/saved-plan,
// lib/saved-plan.ts): every field checked, a save or a forget only of the
// version the page loaded, one a newer version saved never changed or
// deleted, a damaged one deleted only once confirmed, in the data download,
// and only assumptions stored, never a figure.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

/** The file's own clock: Oct 26, 2026, 15:00 UTC. */
const NOW = Date.parse('2026-10-26T15:00:00.000Z');
setSystemTime(new Date(NOW));
afterAll(() => setSystemTime());

const { ctx } = await import('./api-fixture');
const { encrypt } = await import('@/lib/crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { savedPlanStore } = await import('@/lib/saved-plan');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { declaredStore } = await import('@/lib/stores');
const { SEAM } = await import('@/lib/user-restore/parts');
const { STORE_CLASSES } = await import('@/lib/user-restore/classes');
const { collectUserData, buildUserExport } = await import('@/lib/user-export');
const route = await import('@/app/api/saved-plan/route');

const env = { ...process.env };
beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  forgetEpochs();
  clerk.signedIn = null;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
});
afterEach(() => {
  process.env = { ...env };
});

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try {
    return await f();
  } finally {
    console.error = error;
    console.warn = warn;
  }
};

const call = async (method: 'GET' | 'PUT' | 'DELETE', body?: unknown) => {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await (route as any)[method](new Request('https://nya.test/api/saved-plan', init));
  return { res, body: await res.json() };
};

const PLAN = { ...DEFAULT_PLAN, age: 35, targetAge: 55 };
const draft = (over: Record<string, unknown> = {}) => ({ plan: PLAN, savings: 20_000, currency: 'USD', inflation: 0.03, ...over });
const key = ctxKey('fire-plan-saved');

describe('the plan saved as your plan', () => {
  test('saved, read back, replaced and forgotten, each by the version the page loaded, in the data download', async () => {
    expect((await call('GET')).body).toEqual({ saved: null });
    const first = await call('PUT', { saved: draft(), based_on: null });
    expect(first.res.status).toBe(200);
    const at = new Date(NOW).toISOString();
    expect(first.body.saved).toMatchObject({ version: 1, ...draft(), day: '2026-10-26', savedAt: at });
    expect(first.body.saved.rev).toMatch(/^[0-9a-f-]{36}$/);
    // Only what the person chose and the savings the Plan used: never a figure.
    expect(Object.keys(first.body.saved).sort()).toEqual(['currency', 'day', 'inflation', 'plan', 'rev', 'savedAt', 'savings', 'version']);
    const read = await call('GET');
    expect(read.body).toEqual({ saved: first.body.saved });
    expect(read.res.headers.get('Cache-Control')).toBe('no-store');

    // Saved again a day later, as the Plan is then.
    setSystemTime(new Date(NOW + 86_400_000));
    const again = await call('PUT', { saved: draft({ savings: 22_000, inflation: 0.025 }), based_on: first.body.saved.rev });
    expect(again.res.status).toBe(200);
    expect(again.body.saved).toMatchObject({ savings: 22_000, inflation: 0.025, day: '2026-10-27' });
    expect(again.body.saved.rev).not.toBe(first.body.saved.rev);

    expect(declaredStore('fire-plan-saved')).toMatchObject({ kind: 'value', exportable: true, what: 'the plan you saved as your plan' });
    expect(SEAM['fire-plan-saved']).toEqual({ kind: 'value', restore: 'write' });
    expect(STORE_CLASSES['fire-plan-saved']).toBe('data');
    const doc = buildUserExport(await quiet(() => collectUserData({ ctx, userId: null })), new Date(NOW)) as any;
    expect(doc['fire-plan-saved']).toEqual(again.body.saved);

    expect((await call('DELETE', { based_on: again.body.saved.rev })).body).toEqual({ ok: true });
    expect((await call('GET')).body).toEqual({ saved: null });
    expect(fake.strings.has(key)).toBe(false);
    const empty = buildUserExport(await quiet(() => collectUserData({ ctx, userId: null })), new Date(NOW)) as any;
    expect(empty['fire-plan-saved']).toBeNull();
  });

  test('a save or a forget made to another version than the one there gets the one there, and changes nothing', async () => {
    const first = (await call('PUT', { saved: draft(), based_on: null })).body.saved;
    // Another device saved meanwhile: this page loaded none.
    const late = await call('PUT', { saved: draft({ savings: 1 }), based_on: null });
    expect(late.res.status).toBe(409);
    expect(late.body).toMatchObject({ stale: true, saved: first });
    const wrong = await call('PUT', { saved: draft({ savings: 1 }), based_on: 'rev-other' });
    expect(wrong.res.status).toBe(409);
    const forget = await call('DELETE', { based_on: 'rev-other' });
    expect(forget.res.status).toBe(409);
    expect(forget.body).toMatchObject({ stale: true, saved: first });
    expect((await call('GET')).body).toEqual({ saved: first });
    // One already gone is gone.
    await call('DELETE', { based_on: first.rev });
    expect((await call('DELETE', { based_on: first.rev })).body).toEqual({ ok: true });
    // Saving one over none that was there needs based_on null.
    expect((await call('PUT', { saved: draft(), based_on: first.rev })).res.status).toBe(409);
  });

  test('every field is checked, and anything else refused', async () => {
    const refused: [unknown, string][] = [
      ['not json', 'Send the plan'],
      [{ saved: draft() }, 'based_on'],
      [{ saved: draft(), based_on: 7 }, 'based_on'],
      [{ saved: draft(), based_on: null, extra: 1 }, 'extra isn’t taken here'],
      [{ saved: draft({ inflation: 0.5 }), based_on: null }, 'inflation is a rate'],
      [{ saved: { ...draft(), rev: 'mine' }, based_on: null }, 'rev isn’t taken here'],
      [{ saved: draft({ plan: { ...PLAN, age: 300 } }), based_on: null }, 'plan:'],
    ];
    for (const [body, said] of refused) {
      const r = await call('PUT', body);
      expect([body, r.res.status, r.body.error]).toEqual([body, 400, expect.stringContaining(said)]);
    }
    for (const body of ['nope', {}, { based_on: 'x', unreadable: true }, { unreadable: 'yes' }, { based_on: 'x', extra: 1 }]) {
      expect([body, (await call('DELETE', body)).res.status]).toEqual([body, 400]);
    }
    expect(fake.strings.has(key)).toBe(false);
  });

  test('one that can’t be read is said, never read as none, and goes only once the person confirms', async () => {
    await fake.set(key, 'not-a-ciphertext');
    expect((await quiet(() => call('GET'))).body).toEqual({ saved: null, problem: 'unreadable' });
    // A save would replace it unseen: refused.
    const save = await quiet(() => call('PUT', { saved: draft(), based_on: null }));
    expect(save.res.status).toBe(409);
    expect(save.body.unreadable).toBe(true);
    expect((await quiet(() => call('DELETE', { based_on: 'x' }))).res.status).toBe(409);
    expect(fake.strings.get(key)).toBe('not-a-ciphertext');
    expect((await quiet(() => call('DELETE', { unreadable: true }))).body).toEqual({ ok: true });
    expect(fake.strings.has(key)).toBe(false);
  });

  test('one a newer version saved is named, and never changed or deleted from here', async () => {
    await fake.set(key, await encrypt(ctx, JSON.stringify({ version: 2, plan: PLAN, goal: 'later' })));
    expect((await quiet(() => call('GET'))).body).toEqual({ saved: null, problem: 'newer' });
    for (const r of [await quiet(() => call('PUT', { saved: draft(), based_on: null })), await quiet(() => call('DELETE', { unreadable: true })), await quiet(() => call('DELETE', { based_on: 'x' }))]) {
      expect(r.res.status).toBe(409);
      expect(r.body.error).toContain('newer version of Nya');
    }
    expect(fake.strings.has(key)).toBe(true);
  });

  test('an intact one is never deleted as unreadable', async () => {
    const first = (await call('PUT', { saved: draft(), based_on: null })).body.saved;
    const r = await call('DELETE', { unreadable: true });
    expect(r.res.status).toBe(409);
    expect(r.body.saved).toEqual(first);
    expect(await savedPlanStore.get(ctx)).toEqual(first);
  });
});
