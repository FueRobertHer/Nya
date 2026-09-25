// In-memory stand-in for the Upstash client, covering just the commands the
// modules under test use. Enough to exercise the real encryption and the real
// merge/retention logic without a network or a live database.

import { createHash } from 'node:crypto';

type Hash = Map<string, string>;

/** The commands a test can arm to fail via `failNext`. */
export type FakeCommand =
  | 'get'
  | 'set'
  | 'incr'
  | 'del'
  | 'hset'
  | 'hget'
  | 'hdel'
  | 'hkeys'
  | 'hgetall'
  | 'expire'
  | 'scan'
  | 'hscan'
  | 'type'
  | 'strlen'
  | 'rename'
  | 'ttl'
  | 'getrange'
  | 'eval';

/** Upstash's `set` options used by this codebase: `ex` (lib/cache.ts), and
 *  `nx` with `px` for the rotation lock (lib/crypto.ts). */
type SetOptions = { ex?: number; px?: number; nx?: boolean };

/** Translates a Redis MATCH glob to a RegExp. Only `*` and `?` are supported,
 *  which is everything this codebase's patterns use. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/** What Upstash's default client does to a value on the way out: JSON is
 *  parsed, anything else comes back as the string it was. */
function upstashParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class FakeRedis {
  /**
   * @param opts.deserialize read values back the way Upstash's default client
   *   does (parsing JSON), instead of as the raw stored strings. Off by
   *   default because most modules store ciphertext, which is not JSON either
   *   way; on for code that stores JSON and must cope with getting it back
   *   parsed, as production does.
   */
  constructor(private readonly opts: { deserialize?: boolean } = {}) {}

  private out(value: string | undefined): any {
    if (value === undefined) return null;
    return this.opts.deserialize ? upstashParse(value) : value;
  }

  strings = new Map<string, string>();
  hashes = new Map<string, Hash>();
  ttls = new Map<string, number>();
  /** Commands issued since the last reset. Lets a test assert that a path
   *  which should cost nothing actually touches Redis zero times. */
  ops = 0;

  /** Commands armed to throw, and how many more calls each should fail. */
  private failing = new Map<FakeCommand, number>();

  private hash(key: string): Hash {
    let h = this.hashes.get(key);
    if (!h) this.hashes.set(key, (h = new Map()));
    return h;
  }

  /**
   * Make the next `times` calls to `command` throw, then disarm.
   *
   * Exists because the alternative is swapping in a whole second
   * `storageMock(broken)` (see test/history.test.ts), which fails every command
   * at once. Failure isolation in the snapshot fan-out and the refuse-to-persist
   * path both need one command to fail while the rest still work.
   *
   * `times` matters when a code path issues the same command more than once and
   * swallows the earlier failures itself — lib/transactions.ts reads its
   * blocked marker before it reads the state blob, and deliberately tolerates
   * that first read failing.
   */
  failNext(command: FakeCommand, times = 1): void {
    this.failing.set(command, (this.failing.get(command) ?? 0) + times);
  }

  private gate(command: FakeCommand): void {
    this.ops++;
    const remaining = this.failing.get(command) ?? 0;
    if (remaining > 0) {
      if (remaining === 1) this.failing.delete(command);
      else this.failing.set(command, remaining - 1);
      throw new Error(`FakeRedis: armed failure for ${command}`);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    this.gate('get');
    return this.out(this.strings.get(key)) as T | null;
  }

  /**
   * `opts.ex` is RECORDED, not merely tolerated. The previous two-argument
   * signature silently swallowed lib/cache.ts's `{ ex: TTL_SECONDS }`, which is
   * why the cache module's expiry behaviour had never actually been asserted.
   */
  async set(key: string, value: string, opts?: SetOptions): Promise<'OK' | null> {
    this.gate('set');
    // Like Redis: with nx, an existing key is left alone and the answer is null.
    if (opts?.nx && (this.strings.has(key) || this.hashes.has(key))) return null;
    this.strings.set(key, value);
    if (opts?.ex !== undefined) this.ttls.set(key, opts.ex);
    else if (opts?.px !== undefined) this.ttls.set(key, Math.ceil(opts.px / 1000));
    else this.ttls.delete(key);
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    this.gate('incr');
    const next = Number(this.strings.get(key) ?? 0) + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async del(...keys: string[]): Promise<void> {
    this.gate('del');
    for (const key of keys) {
      this.strings.delete(key);
      this.hashes.delete(key);
      this.ttls.delete(key);
    }
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    this.gate('hset');
    const h = this.hash(key);
    for (const [f, v] of Object.entries(fields)) h.set(f, v);
  }

  async hget<T>(key: string, field: string): Promise<T | null> {
    this.gate('hget');
    return this.out(this.hashes.get(key)?.get(field)) as T | null;
  }

  async hdel(key: string, ...fields: string[]): Promise<void> {
    this.gate('hdel');
    const h = this.hashes.get(key);
    if (!h) return;
    for (const f of fields) h.delete(f);
    // Like Redis: a hash with no fields left no longer exists.
    if (h.size === 0) {
      this.hashes.delete(key);
      this.ttls.delete(key);
    }
  }

  async hkeys(key: string): Promise<string[]> {
    this.gate('hkeys');
    return [...(this.hashes.get(key)?.keys() ?? [])];
  }

  async hgetall<T>(key: string): Promise<T | null> {
    this.gate('hgetall');
    const h = this.hashes.get(key);
    if (!h || h.size === 0) return null; // Upstash returns null, not {}
    return Object.fromEntries([...h].map(([f, v]) => [f, this.out(v)])) as T;
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.gate('expire');
    this.ttls.set(key, seconds);
  }

  /** Seconds remaining; -1 when the key exists without one; -2 when there is
   *  no such key. All three are Redis's answers, and the last matters: code
   *  that treats a vanished key differently from a persistent one is otherwise
   *  untestable. */
  async ttl(key: string): Promise<number> {
    this.gate('ttl');
    if (!this.strings.has(key) && !this.hashes.has(key)) return -2;
    return this.ttls.get(key) ?? -1;
  }

  /** Moves a key, replacing any at the destination, keeping its expiry. */
  async rename(from: string, to: string): Promise<'OK'> {
    this.gate('rename');
    if (!this.strings.has(from) && !this.hashes.has(from)) throw new Error('ERR no such key');
    this.strings.delete(to);
    this.hashes.delete(to);
    this.ttls.delete(to);
    if (this.strings.has(from)) this.strings.set(to, this.strings.get(from)!);
    else this.hashes.set(to, this.hashes.get(from)!);
    const ttl = this.ttls.get(from);
    if (ttl !== undefined) this.ttls.set(to, ttl);
    this.strings.delete(from);
    this.hashes.delete(from);
    this.ttls.delete(from);
    return 'OK';
  }

  /** Length of a string value; 0 for a missing key, like Redis. */
  async strlen(key: string): Promise<number> {
    this.gate('strlen');
    if (this.hashes.has(key)) throw new Error('WRONGTYPE');
    return this.strings.get(key)?.length ?? 0;
  }

  /** 'string' | 'hash' | 'none'. Needed because the two coexist in one
   *  namespace: history:accounts:est:flat is a plain string while every one of
   *  its siblings is a hash, so anything walking the keyspace has to branch. */
  async type(key: string): Promise<'string' | 'hash' | 'none'> {
    this.gate('type');
    if (this.strings.has(key)) return 'string';
    if (this.hashes.has(key)) return 'hash';
    return 'none';
  }

  /**
   * Cursor-paginated keyspace walk over strings and hashes together.
   *
   * Real SCAN gives no ordering guarantee and may return duplicates; this one
   * is deterministic, which makes tests stable. Do not let a caller come to
   * depend on either property — anything built on this must tolerate the real
   * client's looser contract.
   */
  async scan(
    cursor: number | string,
    opts?: { match?: string; count?: number }
  ): Promise<[string, string[]]> {
    this.gate('scan');
    const all = [...this.strings.keys(), ...this.hashes.keys()];
    const matched = opts?.match
      ? all.filter((key) => globToRegExp(opts.match!).test(key))
      : all;

    const start = Number(cursor) || 0;
    const count = opts?.count ?? 10;
    const page = matched.slice(start, start + count);
    const next = start + count >= matched.length ? '0' : String(start + count);
    return [next, page];
  }

  /**
   * Cursor-paginated walk of one hash, returning Upstash's flat
   * [field, value, field, value, ...] page. Same deterministic caveat as scan.
   */
  async hscan(
    key: string,
    cursor: number | string,
    opts?: { count?: number }
  ): Promise<[string, string[]]> {
    this.gate('hscan');
    const entries = [...(this.hashes.get(key)?.entries() ?? [])];
    const start = Number(cursor) || 0;
    const count = opts?.count ?? 10;
    const page = entries.slice(start, start + count).flat();
    const next = start + count >= entries.length ? '0' : String(start + count);
    return [next, page];
  }

  /** Byte offsets, like Redis. */
  async getrange(key: string, start: number, end: number): Promise<string> {
    this.gate('getrange');
    return Buffer.from(this.strings.get(key) ?? '', 'utf8').subarray(start, end + 1).toString('utf8');
  }

  /**
   * Runs the few Lua scripts this codebase sends, recognised by the name on
   * their first line (lib/reencrypt.ts, lib/containers.ts), with the same answers. Anything else
   * throws, so a new script cannot pass a test without this learning what it
   * does. The real scripts are also run against a real Redis in
   * test/reencrypt.test.ts where one is installed.
   */
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    this.gate('eval');
    const sha1 = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex');
    const name = script.split('\n', 1)[0];
    if (name === '-- nya:probe') return sha1('nya');
    const guardOk = (active: string) => this.strings.get(keys[1]) === active && (this.hashes.get(keys[2])?.has(active) ?? false);
    if (name === '-- nya:cas-string') {
      if (!guardOk(args[2])) return -2;
      if (this.hashes.has(keys[0])) throw new Error('WRONGTYPE');
      const cur = this.strings.get(keys[0]);
      if (cur === undefined) return -1;
      if (sha1(cur) !== args[0]) return 0;
      this.strings.set(keys[0], args[1]);
      return 1;
    }
    if (name === '-- nya:cas-hash') {
      if (!guardOk(args[3])) return -2;
      if (this.strings.has(keys[0])) throw new Error('WRONGTYPE');
      const cur = this.hashes.get(keys[0])?.get(args[0]);
      if (cur === undefined) return -1;
      if (sha1(cur) !== args[1]) return 0;
      this.hash(keys[0]).set(args[0], args[2]);
      return 1;
    }
    if (name === '-- nya:release-lock') {
      if (this.strings.get(keys[0]) !== args[0]) return 0;
      this.strings.delete(keys[0]);
      this.ttls.delete(keys[0]);
      return 1;
    }
    if (name === '-- nya:container-create-first') {
      if ((this.hashes.get(keys[0])?.size ?? 0) !== 0) return 0;
      this.hash(keys[0]).set(args[0], args[1]);
      return 1;
    }
    throw new Error(`FakeRedis: unknown script ${name}`);
  }

  reset(): void {
    this.strings.clear();
    this.hashes.clear();
    this.ttls.clear();
    this.failing.clear();
    this.ops = 0;
  }
}

/**
 * The key a mocked lib/storage builds, so a test can seed or assert one without
 * writing the prefix out by hand.
 *
 * Worth having for exactly one reason: the prefix then appears in the test
 * suite once instead of in every file that seeds a fixture. When `k()` gains a
 * container id, this is the single place that changes, rather than every
 * literal `'test:history:accounts'` scattered through the assertions.
 */
export function testKey(key: string): string {
  return `test:${key}`;
}

/** The container tests keep their data in, unless a test needs another. A
 *  valid v4 UUID, so it passes isContainerId. */
export const TEST_CONTAINER = '0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b';
export const TEST_CTX = { container: TEST_CONTAINER } as { container: any };

/** Registers TEST_CONTAINER as the one active container, so a route's
 *  dataCtx() resolves to it. Pair with forgetEpochs() (lib/sessions.ts), which
 *  drops the few seconds the deployment's container is reused for. */
export async function registerTestContainer(fake: FakeRedis, status: 'active' | 'restoring' | 'archived' = 'active'): Promise<void> {
  await fake.hset(testKey('containers'), {
    [TEST_CONTAINER]: JSON.stringify({ status, primary: true, created_at: '2026-01-01T00:00:00.000Z' }),
  });
}

/** Environment-wide stores (kEnv): the only keys allowed outside a container. */
const ENV_WIDE = ['containers', 'crypto:', 'ratelimit:', 'sessions:legacy-cutoff'];

/**
 * Every key the fake holds that is stored data outside any container. After
 * the move (#53) nothing may write one, so data tests assert this is empty
 * after every test: a write that slipped back to an unscoped key fails loudly
 * even where the test only reads its container's keys.
 */
export function unscopedDataKeys(fake: FakeRedis): string[] {
  const all = [...(fake as any).strings.keys(), ...(fake as any).hashes.keys()] as string[];
  return all.filter((key) => {
    if (!key.startsWith('test:') || key.startsWith('test:c:')) return false;
    const rel = key.slice('test:'.length);
    return !ENV_WIDE.some((p) => rel === p || (p.endsWith(':') && rel.startsWith(p)));
  });
}

/** A key inside a container, as the mocked kc() builds it (TEST_CTX's by
 *  default). */
export function ctxKey(key: string, ctx: { container: string } = TEST_CTX): string {
  return testKey(`c:${ctx.container}:${key}`);
}

/**
 * The full shape of lib/storage, for `mock.module('@/lib/storage', ...)`.
 *
 * Every export, not just the two the module under test calls: mock.module
 * registers process-wide, so a partial stub breaks any OTHER test file whose
 * imports transitively reach lib/storage. lib/networth.ts imports getItems, and
 * a stub without it fails the whole run with "Export named 'getItems' not
 * found" from a file that never mocked anything.
 */
export function storageMock(fake: FakeRedis) {
  return {
    redis: () => fake,
    // The fake already stores and returns plain strings, which is exactly what
    // the raw client promises, so one instance serves both.
    rawRedis: () => fake,
    envPrefix: () => testKey(''),
    kEnv: testKey,
    kc: (ctx: { container: string }, key: string) => ctxKey(key, ctx),
    // Backed by the fake, so code that filters by the stored Items sees the
    // ones a test seeds (none unless it does), in the container asked for.
    getItems: async (ctx: { container: string }) =>
      Object.values((await fake.hgetall<Record<string, unknown>>(ctxKey('plaid:items', ctx))) ?? {}).map((v) =>
        typeof v === 'string' ? JSON.parse(v) : v
      ),
    saveItem: async (ctx: { container: string }, item: { item_id: string }) => {
      await fake.hset(ctxKey('plaid:items', ctx), { [item.item_id]: JSON.stringify(item) });
    },
    removeItem: async (ctx: { container: string }, item_id: string) => {
      await fake.hdel(ctxKey('plaid:items', ctx), item_id);
    },
  };
}
