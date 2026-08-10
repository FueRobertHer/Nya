// In-memory stand-in for the Upstash client, covering just the commands the
// modules under test use. Enough to exercise the real encryption and the real
// merge/retention logic without a network or a live database.

type Hash = Map<string, string>;

export class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Hash>();
  ttls = new Map<string, number>();
  /** Commands issued since the last reset. Lets a test assert that a path
   *  which should cost nothing actually touches Redis zero times. */
  ops = 0;

  private hash(key: string): Hash {
    let h = this.hashes.get(key);
    if (!h) this.hashes.set(key, (h = new Map()));
    return h;
  }

  async get<T>(key: string): Promise<T | null> {
    this.ops++;
    return (this.strings.get(key) ?? null) as T | null;
  }

  async set(key: string, value: string): Promise<void> {
    this.ops++;
    this.strings.set(key, value);
  }

  async del(...keys: string[]): Promise<void> {
    this.ops++;
    for (const key of keys) {
      this.strings.delete(key);
      this.hashes.delete(key);
    }
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    this.ops++;
    const h = this.hash(key);
    for (const [f, v] of Object.entries(fields)) h.set(f, v);
  }

  async hget<T>(key: string, field: string): Promise<T | null> {
    this.ops++;
    return (this.hashes.get(key)?.get(field) ?? null) as T | null;
  }

  async hdel(key: string, ...fields: string[]): Promise<void> {
    this.ops++;
    const h = this.hashes.get(key);
    if (h) for (const f of fields) h.delete(f);
  }

  async hkeys(key: string): Promise<string[]> {
    this.ops++;
    return [...(this.hashes.get(key)?.keys() ?? [])];
  }

  async hgetall<T>(key: string): Promise<T | null> {
    this.ops++;
    const h = this.hashes.get(key);
    if (!h || h.size === 0) return null; // Upstash returns null, not {}
    return Object.fromEntries(h) as T;
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.ops++;
    this.ttls.set(key, seconds);
  }

  reset(): void {
    this.strings.clear();
    this.hashes.clear();
    this.ttls.clear();
    this.ops = 0;
  }
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
    k: (key: string) => `test:${key}`,
    getItems: async () => [],
    saveItem: async () => {},
    removeItem: async () => {},
  };
}
