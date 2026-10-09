import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { PlaidApi } from 'plaid';

// Only lib/transactions.ts may call a Transactions endpoint, and only from
// syncItem, after its check (lib/item-products.ts). On an Item without
// Transactions a first call starts Plaid billing it, for good; that check is
// what keeps a 401(k) or an IRA from gaining the charge. A new call anywhere
// else (a Refresh button calling /transactions/refresh, a bills feature calling
// /transactions/recurring/get, a branch merged in) would go around it, and the
// tests that pin today's paths would not notice. So this reads the source, as
// test/plaid-scrub.test.ts does for Plaid clients.

const root = join(import.meta.dir, '..');
const GATED = ['lib', 'transactions.ts'].join(sep);

/** Every client method of the Transactions product, from the SDK itself, so
 *  one an upgrade adds is covered too: transactionsSync, transactionsGet,
 *  transactionsRefresh, transactionsRecurringGet and the rest, and their
 *  processor forms. investmentsTransactionsGet belongs to Investments. */
const METHODS = Object.getOwnPropertyNames(PlaidApi.prototype).filter((n) => /transactions/i.test(n) && !n.startsWith('investments'));
const MENTION = new RegExp(`\\b(${METHODS.join('|')})\\b`, 'g');
/** The endpoints' own paths, for a call made without the client. */
const ENDPOINT = /\/(processor\/)?transactions\/(sync|get|refresh|recurring|enhance|enrich|rules|user_insights)/g;

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' || name.startsWith('.') ? [] : walk(p);
    return SOURCE.test(name) ? [p] : [];
  });

/** The app's own code: every file at the root (proxy.ts, say) and in every
 *  directory there, but the tests, which stub the client. */
function appFiles(): string[] {
  return readdirSync(root).flatMap((name) => {
    const p = join(root, name);
    if (!statSync(p).isDirectory()) return SOURCE.test(name) ? [p] : [];
    return name === 'node_modules' || name === 'test' || name.startsWith('.') ? [] : walk(p);
  });
}

/** A file as it runs: types and comments gone (a comment may name an
 *  endpoint), strings and calls kept. */
function code(file: string): string {
  const loader = file.endsWith('.tsx') ? 'tsx' : /\.[mc]?ts$/.test(file) ? 'ts' : 'jsx';
  return new Bun.Transpiler({ loader }).transformSync(readFileSync(file, 'utf8'));
}

describe('Transactions is called only where its check is', () => {
  test('the SDK methods the scan looks for', () => {
    for (const m of ['transactionsSync', 'transactionsGet', 'transactionsRefresh', 'transactionsRecurringGet', 'processorTransactionsSync']) {
      expect(METHODS).toContain(m);
    }
    expect(METHODS).not.toContain('investmentsTransactionsGet');
  });

  test('the scan sees through comments and types, and catches every way to reach a method', () => {
    const probe = (src: string) => new Bun.Transpiler({ loader: 'ts' }).transformSync(src).match(MENTION) ?? [];
    expect(probe('// transactionsSync is not called here\ntype T = { transactionsGet: 1 };\nexport const x = 1;')).toEqual([]);
    expect(
      probe(
        "import { plaidClient as c } from '@/lib/plaid';\nexport async function f() {\n  await c.transactionsRefresh({} as any);\n  const { transactionsRecurringGet } = c;\n  await c['processorTransactionsGet']({} as any);\n  return transactionsRecurringGet;\n}"
      )
    ).toEqual(['transactionsRefresh', 'transactionsRecurringGet', 'processorTransactionsGet', 'transactionsRecurringGet']);
  });

  test('no file but lib/transactions.ts names a Transactions method or endpoint', () => {
    const files = appFiles();
    // The scan reaches the app: routes, the library, the proxy, the scripts.
    for (const f of ['app/api/transactions/route.ts', 'app/api/backfill/route.ts', 'lib/transactions.ts', 'proxy.ts', 'scripts/restore.ts']) {
      expect(files.map((p) => relative(root, p).split(sep).join('/'))).toContain(f);
    }
    const offenders = files
      .filter((f) => relative(root, f) !== GATED)
      .flatMap((f) => {
        const js = code(f);
        return [...(js.match(MENTION) ?? []), ...(js.match(ENDPOINT) ?? [])].map((m) => `${relative(root, f)}: ${m}`);
      });
    expect(offenders).toEqual([]);
  });

  test('lib/transactions.ts calls it once, from syncItem, after the check, and syncItem is its own', () => {
    const js = code(join(root, GATED));
    expect(js.match(MENTION)).toEqual(['transactionsSync']);
    expect(js.match(ENDPOINT)).toBeNull();
    const start = js.indexOf('async function syncItem(');
    expect(start).toBeGreaterThan(-1);
    // Not exported, so nothing outside reaches the call but through it.
    expect(js.slice(Math.max(0, start - 10), start)).not.toContain('export');
    expect(js).not.toMatch(/export\s*\{[^}]*\bsyncItem\b/);
    const end = js.indexOf('\n}\n', start);
    const body = js.slice(start, end);
    const call = body.indexOf('plaidClient.transactionsSync(');
    expect(call).toBeGreaterThan(-1);
    // The check: Plaid not known to bill it and never synced means a first
    // call, made only for an Item holding a bank account or card, and not
    // while a refusal stands.
    const starting = body.search(/const starting = !transactionsBilled\(item\) && stored\.cursor === "";/);
    expect(starting).toBeGreaterThan(-1);
    const check = body.indexOf('if (starting) {', starting);
    expect(check).toBeGreaterThan(-1);
    const gate = body.slice(check, call);
    for (const step of ['await accountKinds(', 'holdsTransactionAccounts(types)', 'refusalStands(stored.refused, cash)']) expect(gate).toContain(step);
    expect(check).toBeLessThan(call);
  });
});
