import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, testKey, ctxKey, TEST_CTX, TEST_CONTAINER, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Personal API tokens (lib/api-tokens.ts): made, kept as a hash, checked,
// limited and revoked; and the card's route (app/api/api-tokens).

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
/** Every command sent, by name, for the checks that every failure costs the same. */
const sent: string[] = [];
const recorded = new Proxy(fake, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== 'function' || typeof prop !== 'string') return value;
    return (...args: unknown[]) => {
      sent.push(prop);
      return value.apply(target, args);
    };
  },
});
mock.module('@/lib/storage', () => ({ ...storageMock(fake), redis: () => recorded }));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const tokens = await import('@/lib/api-tokens');
const { apiTokenStore, apiRequestCount } = await import('@/lib/api-token-store');
const { forgetEpochs } = await import('@/lib/sessions');
const { forgetEmails } = await import('@/lib/auth-mode');
const { encrypt } = await import('@/lib/crypto');
const route = await import('@/app/api/api-tokens/route');
const {
  createToken,
  listTokens,
  revokeToken,
  authenticate,
  takeRequest,
  noteUse,
  parseToken,
  bearerToken,
  cleanLabel,
  formatToken,
  TokenLimitError,
  RateCountUnreadableError,
  MAX_TOKENS,
  REQUESTS_PER_MINUTE,
  RATE_WINDOW_SECONDS,
  LAST_USED_EVERY_MS,
  TOKEN_LENGTH,
} = tokens;

const ctx = TEST_CTX;
/** The container's id, as the branded ContainerId the code hands back. */
const MINE = TEST_CONTAINER as any;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const bearer = (token: string) => `Bearer ${token}`;

/** Registers a container in the registry, as the ops route would. */
async function register(container: string, status: 'active' | 'restoring' | 'archived' = 'active', primary = false) {
  await fake.hset(testKey('containers'), { [container]: JSON.stringify({ status, primary, created_at: '2026-01-01T00:00:00.000Z' }) });
}

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  sent.length = 0;
  forgetEpochs();
  forgetEmails();
  // The shared password: this deployment's container is the one registered.
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  process.env.APP_PASSWORD = 'hunter2';
  process.env.SESSION_SECRET = 'test-session-secret';
  await registerTestContainer(fake);
  clerk.signedIn = null;
  clerk.reverified = true;
});
afterEach(() => {
  process.env = { ...saved };
  clerk.signedIn = null;
  clerk.reverified = true;
});

describe('a token', () => {
  test('is "nya_", its id, its secret and its container, and only its hash is stored', async () => {
    const { token, info } = await createToken(ctx, 'Raycast', new Date(NOW));
    expect(token).toHaveLength(TOKEN_LENGTH);
    expect(token).toMatch(/^nya_[0-9a-f]{16}_[A-Za-z0-9_-]{43}_[0-9a-f-]{36}$/);
    const parts = parseToken(token)!;
    expect(parts).toEqual({ id: info.id, secret: token.slice(21, 64), container: MINE });
    expect(token.endsWith(`_${TEST_CONTAINER}`)).toBe(true);
    expect(info).toEqual({ id: parts.id, label: 'Raycast', hint: `nya_${parts.id.slice(0, 8)}`, created_at: new Date(NOW).toISOString(), last_used_at: null });
    expect(token.startsWith(info.hint)).toBe(true);
    // Stored under its id, in its container: the hash of the secret, never the secret.
    expect(await apiTokenStore.get(ctx, info.id)).toEqual({ v: 1, label: 'Raycast', hash: sha256(parts.secret), created_at: info.created_at, last_used_at: null });
    const raw = JSON.stringify([...fake.hashes.entries()].map(([k, h]) => [k, [...h]]));
    expect(raw).not.toContain(parts.secret);
    expect(raw).not.toContain(sha256(parts.secret)); // encrypted, as every seam value
    expect([...(fake.hashes.get(ctxKey('api-tokens'))?.keys() ?? [])]).toEqual([info.id]);
  });

  test('two are never alike', async () => {
    const a = await createToken(ctx, 'One');
    const b = await createToken(ctx, 'Two');
    expect(a.token).not.toBe(b.token);
    expect(a.info.id).not.toBe(b.info.id);
    expect(parseToken(a.token)!.secret).not.toBe(parseToken(b.token)!.secret);
  });

  test('is read from the header strictly: anything else is no token', () => {
    const good = formatToken('0123456789abcdef', 'A'.repeat(43), TEST_CONTAINER as any);
    expect(parseToken(good)).toEqual({ id: '0123456789abcdef', secret: 'A'.repeat(43), container: MINE });
    for (const bad of [
      '',
      'nya_',
      good.slice(1),
      `${good}x`,
      good.replace('nya_', 'nyb_'),
      good.replace('0123456789abcdef', '0123456789ABCDEF'),
      good.replace(TEST_CONTAINER, TEST_CONTAINER.toUpperCase()),
      formatToken('0123456789abcdef', 'A'.repeat(43), '0b6f5a52-3c1d-1e2f-8a9b-1c2d3e4f5a6b' as any), // not v4
      formatToken('0123456789abcdef', 'A'.repeat(42) + '=', TEST_CONTAINER as any),
      formatToken('0123456789abcdef', 'A'.repeat(42) + ' ', TEST_CONTAINER as any),
    ]) {
      expect([bad, parseToken(bad)]).toEqual([bad, null]);
    }
    expect(bearerToken(`Bearer ${good}`)).toBe(good);
    expect(bearerToken(`bearer ${good}`)).toBe(good);
    expect(bearerToken(`Bearer  ${good} `)).toBe(good);
    for (const header of [null, '', good, `Basic ${good}`, `Bearer`, `Bearer ${good} extra`, `Bearer ${'x'.repeat(600)}`]) {
      expect([header, bearerToken(header)]).toEqual([header, null]);
    }
  });

  test('names are cleaned and checked', () => {
    expect(cleanLabel('  Home   Assistant ')).toBe('Home Assistant');
    expect(cleanLabel('x'.repeat(60))).toBe('x'.repeat(60));
    for (const bad of [undefined, null, 3, '', '   ', 'x'.repeat(61), 'a\u0000b', 'a\u007fb']) {
      expect(typeof cleanLabel(bad)).toBe('object');
    }
  });
});

describe('checking a token', () => {
  test('a good one reads its own container, and nothing is written but its bookkeeping', async () => {
    const { token, info } = await createToken(ctx, 'Raycast');
    const auth = await authenticate(bearer(token), NOW);
    expect(auth).toMatchObject({ ctx: { container: MINE }, id: info.id, token: { label: 'Raycast', last_used_at: null } });
  });

  test('every kind of failure is the same null, after the same work', async () => {
    const { token, info } = await createToken(ctx, 'Raycast');
    const parts = parseToken(token)!;
    const revoked = await createToken(ctx, 'Gone');
    await revokeToken(ctx, revoked.info.id);
    await register(OTHER.container, 'archived');
    const failures: [string, string | null][] = [
      ['no header', null],
      ['not bearer', `Basic ${token}`],
      ['malformed', 'Bearer nya_nope'],
      ['wrong secret', bearer(formatToken(info.id, 'B'.repeat(43), TEST_CONTAINER as any))],
      ['unknown id', bearer(formatToken('fedcba9876543210', parts.secret, TEST_CONTAINER as any))],
      ['revoked', bearer(revoked.token)],
      ['unknown container', bearer(formatToken(info.id, parts.secret, '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6' as any))],
      ['archived container', bearer(formatToken(info.id, parts.secret, OTHER.container as any))],
    ];
    const work: string[][] = [];
    for (const [what, header] of failures) {
      sent.length = 0;
      expect([what, await authenticate(header, NOW)]).toEqual([what, null]);
      work.push([...sent].sort());
    }
    // The registry entry and the token's record, read at once, every time.
    for (const w of work) expect(w).toEqual(['eval', 'hget']);
  });

  test('a container being restored or archived refuses its own good token', async () => {
    const { token } = await createToken(ctx, 'Raycast');
    for (const status of ['restoring', 'archived'] as const) {
      await registerTestContainer(fake, status);
      forgetEpochs();
      expect(await authenticate(bearer(token), NOW)).toBeNull();
    }
    await registerTestContainer(fake, 'active');
    forgetEpochs();
    expect(await authenticate(bearer(token), NOW)).not.toBeNull();
  });

  test('with the shared password, only a token for this deployment’s container works', async () => {
    // Another active container, with a token of its own: not this deployment's.
    await register(OTHER.container, 'active');
    process.env.CONTAINER_ID = TEST_CONTAINER;
    forgetEpochs();
    const theirs = await createToken(OTHER, 'Elsewhere');
    expect(await authenticate(bearer(theirs.token), NOW)).toBeNull();
    const mine = await createToken(ctx, 'Here');
    expect((await authenticate(bearer(mine.token), NOW))?.ctx).toEqual({ container: MINE });
  });

  test('a token whose record is damaged or from another version is refused, and nothing is changed', async () => {
    const { token, info } = await createToken(ctx, 'Raycast');
    const quiet = console.error;
    console.error = () => {};
    try {
      await fake.hset(ctxKey('api-tokens'), { [info.id]: 'not-ciphertext-but-long-enough-to-be-tried' });
      expect(await authenticate(bearer(token), NOW)).toBeNull();
      // A field this version doesn't know (scopes, say): never more access than meant.
      const later = { v: 1, label: 'Raycast', hash: sha256(parseToken(token)!.secret), created_at: info.created_at, last_used_at: null, scopes: ['read'] };
      await fake.hset(ctxKey('api-tokens'), { [info.id]: await encrypt(JSON.stringify(later)) });
      expect(await authenticate(bearer(token), NOW)).toBeNull();
    } finally {
      console.error = quiet;
    }
  });

  test('storage failing is an error, never a refusal or a pass', async () => {
    const { token } = await createToken(ctx, 'Raycast');
    fake.failNext('eval');
    await expect(authenticate(bearer(token), NOW)).rejects.toThrow('armed failure');
    fake.failNext('hget');
    await expect(authenticate(bearer(token), NOW)).rejects.toThrow('armed failure');
  });

  test('with Clerk, the container must still have an owner on the allowlist', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_placeholder';
    process.env.CLERK_SECRET_KEY = 'sk_test_placeholder';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_me';
    await fake.hset(testKey('owners'), { user_me: TEST_CONTAINER, user_gone: OTHER.container });
    await register(OTHER.container, 'active');
    const mine = await createToken(ctx, 'Mine');
    const theirs = await createToken(OTHER, 'Theirs');
    expect((await authenticate(bearer(mine.token), NOW))?.ctx).toEqual({ container: MINE });
    // Taken off the allowlist: they can't sign in, and their tokens stop too.
    expect(await authenticate(bearer(theirs.token), NOW)).toBeNull();
    process.env.CLERK_ALLOWED_USER_IDS = 'user_me, user_gone';
    expect((await authenticate(bearer(theirs.token), NOW))?.ctx).toEqual({ container: OTHER.container as any });
    // Each token reaches only its own container.
    expect((await authenticate(bearer(mine.token), NOW))?.ctx).toEqual({ container: MINE });
  });
});

describe('limits', () => {
  test(`at most ${MAX_TOKENS} tokens; revoking one makes room`, async () => {
    for (let i = 0; i < MAX_TOKENS; i++) await createToken(ctx, `Token ${i}`);
    await expect(createToken(ctx, 'One more')).rejects.toBeInstanceOf(TokenLimitError);
    expect(await apiTokenStore.count(ctx)).toBe(MAX_TOKENS);
    const { tokens: list } = await listTokens(ctx);
    await revokeToken(ctx, list[0].id);
    await createToken(ctx, 'One more');
    expect(await apiTokenStore.count(ctx)).toBe(MAX_TOKENS);
    // Another person's tokens are theirs to count.
    await createToken(OTHER, 'Elsewhere');
  });

  test('two made at once at the limit cannot both pass it', async () => {
    for (let i = 0; i < MAX_TOKENS - 1; i++) await createToken(ctx, `Token ${i}`);
    const results = await Promise.allSettled([createToken(ctx, 'A'), createToken(ctx, 'B')]);
    expect(await apiTokenStore.count(ctx)).toBeLessThanOrEqual(MAX_TOKENS);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe((await apiTokenStore.count(ctx)) - (MAX_TOKENS - 1));
  });

  test(`${REQUESTS_PER_MINUTE} requests a minute per token, then refused until the window ends`, async () => {
    const a = (await authenticate(bearer((await createToken(ctx, 'A')).token), NOW))!;
    const b = (await authenticate(bearer((await createToken(ctx, 'B')).token), NOW))!;
    for (let i = 1; i <= REQUESTS_PER_MINUTE; i++) {
      expect(await takeRequest(a, NOW + i)).toEqual({ ok: true, limit: REQUESTS_PER_MINUTE, remaining: REQUESTS_PER_MINUTE - i, resetSeconds: RATE_WINDOW_SECONDS });
    }
    expect(await takeRequest(a, NOW + 30_000)).toEqual({ ok: false, limit: REQUESTS_PER_MINUTE, remaining: 0, resetSeconds: RATE_WINDOW_SECONDS - 30 });
    // Another token of the same person has its own.
    expect((await takeRequest(b, NOW + 30_000)).ok).toBe(true);
    // A new window, a new count.
    expect(await takeRequest(a, NOW + RATE_WINDOW_SECONDS * 1000)).toMatchObject({ ok: true, remaining: REQUESTS_PER_MINUTE - 1 });
  });

  test('a count that can’t be read is said, and cleared so the next request starts again', async () => {
    const auth = (await authenticate(bearer((await createToken(ctx, 'A')).token), NOW))!;
    await fake.hset(ctxKey('api-requests'), { [auth.id]: 'garbage' });
    const quiet = console.error;
    console.error = () => {};
    try {
      await expect(takeRequest(auth, NOW)).rejects.toBeInstanceOf(RateCountUnreadableError);
    } finally {
      console.error = quiet;
    }
    expect(await takeRequest(auth, NOW)).toMatchObject({ ok: true, remaining: REQUESTS_PER_MINUTE - 1 });
  });
});

describe('when a token was last used', () => {
  test('written at most once a minute, the later time kept', async () => {
    const { token, info } = await createToken(ctx, 'A');
    let auth = (await authenticate(bearer(token), NOW))!;
    await noteUse(auth, NOW);
    expect((await apiTokenStore.get(ctx, info.id))!.last_used_at).toBe(new Date(NOW).toISOString());
    auth = (await authenticate(bearer(token), NOW + 1000))!;
    sent.length = 0;
    await noteUse(auth, NOW + 1000);
    expect(sent).toEqual([]); // nothing written within the minute
    await noteUse(auth, NOW + LAST_USED_EVERY_MS);
    expect((await apiTokenStore.get(ctx, info.id))!.last_used_at).toBe(new Date(NOW + LAST_USED_EVERY_MS).toISOString());
    // An instance whose clock is behind never moves it back.
    await noteUse({ ...auth, token: { ...auth.token, last_used_at: null } }, NOW - 5 * 60_000);
    expect((await apiTokenStore.get(ctx, info.id))!.last_used_at).toBe(new Date(NOW + LAST_USED_EVERY_MS).toISOString());
  });

  test('never brings back a token revoked meanwhile, and never throws', async () => {
    const { token, info } = await createToken(ctx, 'A');
    const auth = (await authenticate(bearer(token), NOW))!;
    await revokeToken(ctx, info.id);
    await noteUse(auth, NOW);
    expect(await apiTokenStore.has(ctx, info.id)).toBe(false);
    const quiet = console.error;
    console.error = () => {};
    try {
      const other = (await authenticate(bearer((await createToken(ctx, 'B')).token), NOW))!;
      fake.failNext('eval');
      await noteUse(other, NOW);
    } finally {
      console.error = quiet;
    }
  });
});

describe('listing and revoking', () => {
  test('the list is newest first, with hints and never hashes', async () => {
    await createToken(ctx, 'Old', new Date(NOW - 86_400_000));
    await createToken(ctx, 'New', new Date(NOW));
    const { tokens: list, unreadable, unrecognised } = await listTokens(ctx);
    expect(list.map((t) => t.label)).toEqual(['New', 'Old']);
    expect(JSON.stringify(list)).not.toMatch(/[0-9a-f]{64}/);
    expect([unreadable, unrecognised]).toEqual([[], []]);
  });

  test('revoking takes effect on the next request, with its count', async () => {
    const { token, info } = await createToken(ctx, 'A');
    const auth = (await authenticate(bearer(token), NOW))!;
    await takeRequest(auth, NOW);
    expect(fake.hashes.get(ctxKey('api-requests'))?.has(info.id)).toBe(true);
    expect(await revokeToken(ctx, info.id)).toBe(true);
    expect(await authenticate(bearer(token), NOW)).toBeNull();
    expect(fake.hashes.get(ctxKey('api-requests'))?.has(info.id) ?? false).toBe(false);
    expect(await revokeToken(ctx, info.id)).toBe(false);
    expect(await revokeToken(ctx, 'not-an-id')).toBe(false);
    // Revoked in one container, never another's.
    const theirs = await createToken(OTHER, 'Theirs');
    expect(await revokeToken(ctx, theirs.info.id)).toBe(false);
    expect(await apiTokenStore.has(OTHER, theirs.info.id)).toBe(true);
  });

  test('a damaged record is listed and removed only once confirmed; one from another version never', async () => {
    const damaged = await createToken(ctx, 'Damaged');
    const later = await createToken(ctx, 'Later');
    await fake.hset(ctxKey('api-tokens'), { [damaged.info.id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    await fake.hset(ctxKey('api-tokens'), { [later.info.id]: await encrypt(JSON.stringify({ v: 2 })) });
    const listed = await listTokens(ctx);
    expect(listed).toEqual({ tokens: [], unreadable: [damaged.info.id], unrecognised: [later.info.id] });
    await expect(revokeToken(ctx, damaged.info.id)).rejects.toThrow('could not be read');
    expect(await revokeToken(ctx, damaged.info.id, { unreadable: true })).toBe(true);
    await expect(revokeToken(ctx, later.info.id, { unreadable: true })).rejects.toThrow('could not be read');
    expect(await apiTokenStore.has(ctx, later.info.id)).toBe(true);
  });
});

describe('the card’s route', () => {
  const call = (method: 'GET' | 'POST' | 'DELETE', body?: unknown) =>
    (route as any)[method](
      new Request('http://x/api/api-tokens', {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    ) as Promise<Response>;

  test('makes a token after the password again, shows it once, and lists it without it', async () => {
    let res = await call('POST', { label: 'Raycast' });
    expect(res.status).toBe(403);
    expect((await res.json()).wrong_password).toBe(true);
    res = await call('POST', { label: 'Raycast', password: 'nope' });
    expect(res.status).toBe(403);
    expect(await apiTokenStore.count(ctx)).toBe(0);

    res = await call('POST', { label: '  Raycast ', password: 'hunter2' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const made = await res.json();
    expect(made.token).toMatch(/^nya_/);
    expect(made.info).toMatchObject({ label: 'Raycast', last_used_at: null });

    res = await call('GET');
    const listed = await res.json();
    expect(listed).toEqual({ tokens: [made.info], unreadable: [], unrecognised: [], limit: MAX_TOKENS });
    expect(JSON.stringify(listed)).not.toContain(parseToken(made.token)!.secret);
    expect((await authenticate(bearer(made.token), NOW))?.id).toBe(made.info.id);
  });

  test('with Clerk, a sign-in from the last ten minutes, or Clerk’s hint to confirm it is you', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_placeholder';
    process.env.CLERK_SECRET_KEY = 'sk_test_placeholder';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_me';
    await fake.hset(testKey('owners'), { user_me: TEST_CONTAINER });
    clerk.signedIn = 'user_me';
    clerk.reverified = false;
    let res = await call('POST', { label: 'Claude' });
    expect(res.status).toBe(403);
    expect((await res.json()).clerk_error).toMatchObject({ type: 'forbidden', reason: 'reverification-error' });
    expect(await apiTokenStore.count(ctx)).toBe(0);
    clerk.reverified = true;
    res = await call('POST', { label: 'Claude' });
    expect(res.status).toBe(200);
    expect(await apiTokenStore.count(ctx)).toBe(1);
  });

  test('refuses a bad name or a token past the limit before asking to sign in', async () => {
    for (const body of [null, [], { label: '' }, { label: 'x'.repeat(61) }, { label: 3 }, { label: 'ok', password: 5 }]) {
      expect([body, (await call('POST', body)).status]).toEqual([body, 400]);
    }
    for (let i = 0; i < MAX_TOKENS; i++) await createToken(ctx, `T${i}`);
    const res = await call('POST', { label: 'One more' }); // no password: the limit answers first
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(`at most ${MAX_TOKENS}`);
  });

  test('revokes by id, and says when there is no such token', async () => {
    const { token, info } = await createToken(ctx, 'A');
    expect((await call('DELETE', { id: info.id })).status).toBe(200);
    expect(await authenticate(bearer(token), NOW)).toBeNull();
    expect((await call('DELETE', { id: info.id })).status).toBe(404);
    for (const body of [null, {}, { id: 'nope' }, { id: info.id, unreadable: 'yes' }]) {
      expect([body, (await call('DELETE', body)).status]).toEqual([body, 400]);
    }
  });

  test('a damaged record is a 409 naming it, removed only with unreadable: true', async () => {
    const { info } = await createToken(ctx, 'A');
    await fake.hset(ctxKey('api-tokens'), { [info.id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(await (await call('GET')).json()).toMatchObject({ tokens: [], unreadable: [info.id] });
      const res = await call('DELETE', { id: info.id });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ unreadable: true, unreadable_ids: [info.id], unrecognised_ids: [] });
      expect((await call('DELETE', { id: info.id, unreadable: true })).status).toBe(200);
    } finally {
      console.error = quiet;
    }
  });
});
