// In-memory stand-in for the Upstash client, covering just the commands
// lib/history.ts uses. Enough to exercise the real encryption and the real
// merge/retention logic without a network or a live database.

type Hash = Map<string, string>;

export class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Hash>();
  ttls = new Map<string, number>();

  private hash(key: string): Hash {
    let h = this.hashes.get(key);
    if (!h) this.hashes.set(key, (h = new Map()));
    return h;
  }

  async get<T>(key: string): Promise<T | null> {
    return (this.strings.get(key) ?? null) as T | null;
  }

  async set(key: string, value: string): Promise<void> {
    this.strings.set(key, value);
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.strings.delete(key);
      this.hashes.delete(key);
    }
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    const h = this.hash(key);
    for (const [f, v] of Object.entries(fields)) h.set(f, v);
  }

  async hget<T>(key: string, field: string): Promise<T | null> {
    return (this.hashes.get(key)?.get(field) ?? null) as T | null;
  }

  async hdel(key: string, ...fields: string[]): Promise<void> {
    const h = this.hashes.get(key);
    if (h) for (const f of fields) h.delete(f);
  }

  async hkeys(key: string): Promise<string[]> {
    return [...(this.hashes.get(key)?.keys() ?? [])];
  }

  async hgetall<T>(key: string): Promise<T | null> {
    const h = this.hashes.get(key);
    if (!h || h.size === 0) return null; // Upstash returns null, not {}
    return Object.fromEntries(h) as T;
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.ttls.set(key, seconds);
  }

  reset(): void {
    this.strings.clear();
    this.hashes.clear();
    this.ttls.clear();
  }
}
