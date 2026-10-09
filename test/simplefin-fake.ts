// A local SimpleFIN server for the connector tests: there is no network here,
// and no test should ever reach a real one. It speaks the protocol as
// lib/connectors/simplefin.ts reads it (claim a Setup Token once, then GET
// /accounts with HTTP Basic authorization and the window's query), over TLS
// with a certificate made for these tests only (test/fixtures/simplefin:
// self-signed, for bridge.test, *.bridge.test and localhost, valid until 2126;
// its key protects nothing, since nothing but these tests trusts it).
//
// Its transport() points bridge.test at 127.0.0.1, where it listens, and lets
// a test name other hosts (a private address, the metadata service) to show
// they are refused. Only the fake's own address is allowed beyond the real
// rule (lib/connectors/net-guard.ts isPublicAddress).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPublicAddress } from '@/lib/connectors/net-guard';
import type { Transport } from '@/lib/connectors/http';

const FIXTURES = join(import.meta.dir, 'fixtures', 'simplefin');
export const TEST_CERT = readFileSync(join(FIXTURES, 'test-cert.pem'), 'utf8');
const TEST_KEY = readFileSync(join(FIXTURES, 'test-key.pem'), 'utf8');

export type FakeTxn = {
  id: string;
  posted: number;
  amount: string;
  description: string;
  payee?: string;
  memo?: string;
  transacted_at?: number;
  pending?: boolean;
};

export type FakeAccount = {
  org: Record<string, unknown>;
  id: string;
  name: string;
  currency: string;
  balance: string;
  'available-balance'?: string;
  'balance-date': number;
  transactions: FakeTxn[];
};

/** What the next answers do instead of the protocol's own. */
export type Behaviour = {
  /** For which path: the claim, the accounts, or both. */
  on?: 'claim' | 'accounts';
  status?: number;
  body?: string;
  /** Wait this long before answering at all. */
  delayMs?: number;
  /** Answer a little at a time: this many pieces, this far apart. */
  trickle?: { pieces: number; everyMs: number };
  /** An answer this many bytes long, declared or not. */
  huge?: { bytes: number; declared: boolean };
  /** Redirect here. */
  location?: string;
  /** How many requests it applies to (default: every one until cleared). */
  times?: number;
};

export type SeenRequest = { method: string; path: string; query: Record<string, string>; authorized: boolean; authorization: string | null };

const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / 1000);
/** A Unix time at noon UTC on a day, as the protocol sends times. */
export const at = day;

export class FakeSimplefin {
  readonly host = 'bridge.test';
  readonly user = 'nya-demo-user';
  readonly password = 'Pa55w0rd-0f-The-Access-URL-9f8e7d';
  /** Claim ids, and whether each has been claimed. */
  readonly claimed = new Map<string, boolean>();
  accounts: FakeAccount[] = [];
  errors: string[] = [];
  /** Extra top-level fields to send (an errlist, say). */
  extra: Record<string, unknown> = {};
  readonly seen: SeenRequest[] = [];
  behaviour: Behaviour | null = null;
  /** Hosts other than bridge.test, and the address each resolves to. */
  readonly names = new Map<string, string[]>();
  private server!: ReturnType<typeof Bun.serve>;

  static async start(): Promise<FakeSimplefin> {
    const fake = new FakeSimplefin();
    fake.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert: TEST_CERT, key: TEST_KEY },
      fetch: (req) => fake.answer(req),
    });
    return fake;
  }

  get port(): number {
    return this.server.port as number;
  }

  stop(): void {
    this.server.stop(true);
  }

  /** Back to a fresh server's state, keeping its port. */
  reset(): void {
    this.claimed.clear();
    this.accounts = [];
    this.errors = [];
    this.extra = {};
    this.seen.length = 0;
    this.behaviour = null;
    this.names.clear();
  }

  claimUrl(id = 'demo'): string {
    return `https://${this.host}:${this.port}/simplefin/claim/${id}`;
  }

  /** A Setup Token for a claim id: the base64 of its claim URL. */
  setupToken(id = 'demo'): string {
    this.claimed.set(id, this.claimed.get(id) ?? false);
    return Buffer.from(this.claimUrl(id), 'utf8').toString('base64');
  }

  accessUrl(): string {
    return `https://${this.user}:${this.password}@${this.host}:${this.port}/simplefin`;
  }

  /** The transport a test runs the connector through. */
  transport(): Transport {
    return {
      resolve: async (host) => {
        if (host === this.host || host.endsWith(`.${this.host}`)) return [{ address: '127.0.0.1', family: 4 }];
        const named = this.names.get(host);
        if (named) return named.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      },
      allowAddress: (address) => address === '127.0.0.1' || isPublicAddress(address),
      ca: TEST_CERT,
    };
  }

  /** How many requests reached /accounts. */
  get accountRequests(): SeenRequest[] {
    return this.seen.filter((r) => r.path.endsWith('/accounts'));
  }

  private async answer(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const authorization = req.headers.get('authorization');
    const expected = `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`;
    this.seen.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorized: authorization === expected,
      authorization,
    });
    const kind = url.pathname.startsWith('/simplefin/claim/') ? 'claim' : url.pathname === '/simplefin/accounts' ? 'accounts' : 'other';
    const b = this.behaviour;
    if (b && (!b.on || b.on === kind)) {
      if (b.times !== undefined && --b.times <= 0) this.behaviour = null;
      return this.misbehave(b);
    }
    if (kind === 'claim' && req.method === 'POST') {
      const id = url.pathname.slice('/simplefin/claim/'.length);
      if (this.claimed.get(id) !== false) return new Response('Forbidden', { status: 403 });
      this.claimed.set(id, true);
      return new Response(this.accessUrl(), { headers: { 'content-type': 'text/plain' } });
    }
    if (kind === 'accounts' && req.method === 'GET') {
      if (authorization !== expected) return new Response('Forbidden', { status: 403 });
      const start = url.searchParams.has('start-date') ? Number(url.searchParams.get('start-date')) : null;
      const end = url.searchParams.has('end-date') ? Number(url.searchParams.get('end-date')) : null;
      const pending = url.searchParams.get('pending') === '1';
      const balancesOnly = url.searchParams.get('balances-only') === '1';
      const accounts = this.accounts.map((a) => {
        const { transactions, ...rest } = a;
        if (balancesOnly) return rest;
        return {
          ...rest,
          transactions: transactions.filter(
            (t) => (pending || !t.pending) && (start === null || t.posted >= start) && (end === null || t.posted < end)
          ),
        };
      });
      return Response.json({ errors: this.errors, accounts, ...this.extra });
    }
    return new Response('Not found', { status: 404 });
  }

  private async misbehave(b: Behaviour): Promise<Response> {
    if (b.delayMs) await Bun.sleep(b.delayMs);
    if (b.location) return new Response(null, { status: b.status ?? 302, headers: { location: b.location } });
    if (b.huge) {
      const chunk = 'x'.repeat(64 * 1024);
      let left = b.huge.bytes;
      const stream = new ReadableStream({
        pull(c) {
          if (left <= 0) return c.close();
          const piece = chunk.slice(0, Math.min(chunk.length, left));
          left -= piece.length;
          c.enqueue(new TextEncoder().encode(piece));
        },
      });
      return new Response(stream, { headers: b.huge.declared ? { 'content-length': String(b.huge.bytes) } : {} });
    }
    if (b.trickle) {
      const { pieces, everyMs } = b.trickle;
      const stream = new ReadableStream({
        async start(c) {
          for (let i = 0; i < pieces; i++) {
            c.enqueue(new TextEncoder().encode(' '));
            await Bun.sleep(everyMs);
          }
          c.enqueue(new TextEncoder().encode('{"errors":[],"accounts":[]}'));
          c.close();
        },
      });
      return new Response(stream);
    }
    return new Response(b.body ?? '', { status: b.status ?? 200 });
  }
}

/** An account as the fake serves it, with defaults a test overrides. */
export function fakeAccount(over: Partial<FakeAccount> = {}): FakeAccount {
  return {
    org: { domain: 'mybank.example', 'sfin-url': 'https://sfin.mybank.example', name: 'My Bank' },
    id: 'ACT-1',
    name: 'Checking',
    currency: 'USD',
    balance: '1500.25',
    'available-balance': '1400.25',
    'balance-date': day('2026-10-08'),
    transactions: [],
    ...over,
  };
}
