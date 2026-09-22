// In-memory stand-in for the Upstash client, covering just the commands the
// modules under test use. Enough to exercise the real encryption and the real
// merge/retention logic without a network or a live database.

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
  | 'type'
  | 'ttl';

/** Upstash's `set` options. Only `ex` is used by this codebase (lib/cache.ts). */
type SetOptions = { ex?: number };

/** Translates a Redis MATCH glob to a RegExp. Only `*` and `?` are supported,
 *  which is everything this codebase's patterns use. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

export class FakeRedis {
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
    return (this.strings.get(key) ?? null) as T | null;
  }

  /**
   * `opts.ex` is RECORDED, not merely tolerated. The previous two-argument
   * signature silently swallowed lib/cache.ts's `{ ex: TTL_SECONDS }`, which is
   * why the cache module's expiry behaviour had never actually been asserted.
   */
  async set(key: string, value: string, opts?: SetOptions): Promise<void> {
    this.gate('set');
    this.strings.set(key, value);
    if (opts?.ex !== undefined) this.ttls.set(key, opts.ex);
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
    return (this.hashes.get(key)?.get(field) ?? null) as T | null;
  }

  async hdel(key: string, ...fields: string[]): Promise<void> {
    this.gate('hdel');
    const h = this.hashes.get(key);
    if (h) for (const f of fields) h.delete(f);
  }

  async hkeys(key: string): Promise<string[]> {
    this.gate('hkeys');
    return [...(this.hashes.get(key)?.keys() ?? [])];
  }

  async hgetall<T>(key: string): Promise<T | null> {
    this.gate('hgetall');
    const h = this.hashes.get(key);
    if (!h || h.size === 0) return null; // Upstash returns null, not {}
    return Object.fromEntries(h) as T;
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.gate('expire');
    this.ttls.set(key, seconds);
  }

  /** Seconds remaining, or -1 when the key exists without one (Redis's answer). */
  async ttl(key: string): Promise<number> {
    this.gate('ttl');
    return this.ttls.get(key) ?? -1;
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
    k: testKey,
    getItems: async () => [],
    saveItem: async () => {},
    removeItem: async () => {},
  };
}
