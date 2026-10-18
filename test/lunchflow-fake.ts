// A local Lunch Flow for the connector tests: there is no network here, and no
// test should ever reach the real one. It answers the Personal API as
// lib/connectors/lunchflow.ts reads it: GET /api/v1/accounts,
// /accounts/:id/balance and /accounts/:id/transactions, the key in an
// x-api-key header, `from` and `to` as inclusive days, pending transactions
// only when `include_pending=true` is asked (which Nya never asks), and the
// error bodies Lunch Flow's own MCP server declares ({ error, message }: 401
// without a key, 403 for one it doesn't take, 404 for an account it doesn't
// have). Its sample accounts and transactions are shaped as Firefly III's
// importer and Lunch Flow's own clients carry them (lib/connectors/lunchflow.ts
// cites each), with every date counted back from the test's own clock, so no
// fixture ever ages.
//
// It listens on 127.0.0.1 over TLS with the SimpleFIN fake's certificate
// (test/fixtures/simplefin: bridge.test and *.bridge.test), and the connector
// is pointed at https://bridge.test:<port>/api/v1 (setLunchFlowApiForTests),
// so www.bridge.test is the same site's other name, as www.lunchflow.app is
// lunchflow.app's. Its transport() points both at the fake, and lets a test
// name other hosts to show they are refused.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPublicAddress } from '@/lib/connectors/net-guard';
import type { Transport } from '@/lib/connectors/http';

const FIXTURES = join(import.meta.dir, 'fixtures', 'simplefin');
const TEST_CERT = readFileSync(join(FIXTURES, 'test-cert.pem'), 'utf8');
const TEST_KEY = readFileSync(join(FIXTURES, 'test-key.pem'), 'utf8');

export type LfTxn = {
  id: string | null;
  accountId?: number;
  amount: number | string;
  currency?: string | null;
  /** YYYY-MM-DD, as Lunch Flow gives it. */
  date: string;
  merchant?: string | null;
  description?: string;
  isPending?: boolean;
};

export type LfAccount = {
  id: number;
  name: string;
  institution_name: string;
  institution_logo?: string | null;
  provider: string;
  /** Often absent on /accounts ([sure] in lib/connectors/lunchflow.ts). */
  currency?: string;
  status?: string;
  /** What /balance answers, or null for an account with none. */
  balance: { amount: number | string; currency: string } | null;
  transactions: LfTxn[];
};

/** What the next answers do instead of the API's own. */
export type LfBehaviour = {
  /** Which requests: the listing, a balance or transactions; of one account. */
  on?: 'accounts' | 'balance' | 'transactions';
  account?: number;
  status?: number;
  body?: string;
  /** Wait this long before answering at all. */
  delayMs?: number;
  /** Redirect here. */
  location?: string;
  /** How many requests it applies to (default: every one until cleared). */
  times?: number;
};

export type LfSeen = { method: string; host: string; path: string; query: Record<string, string>; key: string | null };

const DAY = 86_400_000;

/** The day `n` days before the test clock's today, as Lunch Flow writes days. */
export function daysAgo(n: number, now: number = Date.now()): string {
  return new Date(now - n * DAY).toISOString().slice(0, 10);
}

export class FakeLunchFlow {
  readonly host = 'bridge.test';
  /** The key the fake takes, as a person would paste it. */
  readonly key = 'lf_9f8e7d6c5b4a39281706f5e4d3c2b1a0aa77';
  /** Keys it takes: the one above, until a test deletes it (as deleting the
   *  API destination in Lunch Flow would). */
  readonly keys = new Set<string>();
  accounts: LfAccount[] = [];
  readonly seen: LfSeen[] = [];
  behaviours: LfBehaviour[] = [];
  /** Answer every window whole, as an API that ignored `from` and `to` would. */
  ignoreWindow = false;
  /** Added to every `total`: an answer that says it holds more than it sent. */
  totalExtra = 0;
  /** Hosts other than bridge.test and www.bridge.test, and their addresses. */
  readonly names = new Map<string, string[]>();
  private server!: ReturnType<typeof Bun.serve>;

  static async start(): Promise<FakeLunchFlow> {
    const fake = new FakeLunchFlow();
    fake.keys.add(fake.key);
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
    this.keys.clear();
    this.keys.add(this.key);
    this.accounts = [];
    this.seen.length = 0;
    this.behaviours = [];
    this.ignoreWindow = false;
    this.totalExtra = 0;
    this.names.clear();
  }

  /** Where the connector is pointed (setLunchFlowApiForTests). */
  base(): string {
    return `https://${this.host}:${this.port}/api/v1`;
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

  /** The requests for one kind of answer. */
  requests(kind: 'accounts' | 'balance' | 'transactions'): LfSeen[] {
    return this.seen.filter((r) => kindOf(r.path)?.kind === kind);
  }

  private async answer(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const key = req.headers.get('x-api-key');
    this.seen.push({ method: req.method, host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), key });
    const what = kindOf(url.pathname);
    const b = this.behaviours.find((x) => (!x.on || x.on === what?.kind) && (x.account === undefined || x.account === what?.account));
    if (b) {
      if (b.times !== undefined && --b.times <= 0) this.behaviours = this.behaviours.filter((x) => x !== b);
      if (b.delayMs) await Bun.sleep(b.delayMs);
      if (b.location) return new Response(null, { status: b.status ?? 302, headers: { location: b.location } });
      return new Response(b.body ?? '', { status: b.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    if (!what || req.method !== 'GET') return Response.json({ error: 'Not Found', message: 'Not found.' }, { status: 404 });
    if (!key) return Response.json({ error: 'Unauthorized', message: 'API key is required. Please provide x-api-key header.' }, { status: 401 });
    if (!this.keys.has(key)) return Response.json({ error: 'Forbidden', message: 'Invalid API key.' }, { status: 403 });
    if (what.kind === 'accounts') {
      const accounts = this.accounts.map(({ balance: _b, transactions: _t, ...rest }) => ({ institution_logo: null, status: 'ACTIVE', ...rest }));
      return Response.json({ accounts, total: accounts.length + this.totalExtra });
    }
    const account = this.accounts.find((a) => a.id === what.account);
    if (!account) return Response.json({ error: 'Not Found', message: 'Account not found.' }, { status: 404 });
    if (what.kind === 'balance') {
      if (!account.balance) return Response.json({ error: 'Not Found', message: 'Balance not found.' }, { status: 404 });
      return Response.json({ balance: account.balance });
    }
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const pending = url.searchParams.get('include_pending') === 'true';
    const transactions = account.transactions
      .filter((t) => pending || !t.isPending)
      .filter((t) => this.ignoreWindow || ((from === null || t.date >= from) && (to === null || t.date <= to)))
      .map((t) => ({ accountId: account.id, currency: account.balance?.currency ?? 'EUR', merchant: null, description: '', isPending: false, ...t }));
    return Response.json({ transactions, total: transactions.length + this.totalExtra });
  }
}

/** What a path asks for. */
function kindOf(path: string): { kind: 'accounts' | 'balance' | 'transactions'; account?: number } | null {
  if (/^\/api\/v1\/accounts\/?$/.test(path)) return { kind: 'accounts' };
  const m = /^\/api\/v1\/accounts\/([^/]+)\/(balance|transactions)$/.exec(path);
  if (!m) return null;
  return { kind: m[2] as 'balance' | 'transactions', account: /^\d+$/.test(m[1]) ? Number(m[1]) : -1 };
}

/** An account as the fake serves it, with defaults a test overrides: shaped
 *  as Firefly III's importer's sample (lib/connectors/lunchflow.ts [firefly]). */
export function lfAccount(over: Partial<LfAccount> = {}): LfAccount {
  return {
    id: 1470,
    name: 'Main Account A',
    institution_name: 'Sandbox Finance',
    institution_logo: 'https://cdn-logos.gocardless.com/ais/SANDBOXFINANCE_SFIN0000.png',
    provider: 'gocardless',
    status: 'ACTIVE',
    balance: { amount: 1520.4, currency: 'EUR' },
    transactions: [],
    ...over,
  };
}

/** A transaction as the fake serves it, `days` before today, with Lunch
 *  Flow's sign (money out negative). */
export function lfTxn(id: string, days: number, amount: number | string, merchant: string, over: Partial<LfTxn> = {}): LfTxn {
  return { id, amount, date: daysAgo(days), merchant, description: '', ...over };
}
