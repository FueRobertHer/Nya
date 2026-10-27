import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys, TEST_CTX } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Plaid's sandbox, in memory: each custom user becomes an Item whose accounts
// and transactions are the ones its JSON describes, as the sandbox makes them.
type FakeItem = { institution_id: string; products: string[]; config: any };
const items = new Map<string, FakeItem>();
const removed: string[] = [];
let made = 0;
/** How many syncs answer with no rows yet, as the sandbox does at first. */
let syncsBeforeReady = 0;
/** A row of /transactions/sync, as Plaid makes it from a custom user's. */
const syncRow = (id: string, account_id: string, t: any) => ({
  transaction_id: id,
  pending_transaction_id: null,
  account_id,
  amount: t.amount,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  date: t.date_transacted,
  authorized_date: t.date_transacted,
  authorized_datetime: null,
  datetime: null,
  name: t.description,
  merchant_name: null,
  merchant_entity_id: null,
  website: null,
  logo_url: null,
  personal_finance_category: null,
  payment_channel: 'other',
  pending: t.date_posted > t.date_transacted && t.date_posted > new Date().toISOString().slice(0, 10),
  counterparties: [],
});
const itemOf = (access_token: string) => {
  const item = items.get(access_token);
  if (!item) throw new Error(`unknown token ${access_token}`);
  return item;
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    sandboxPublicTokenCreate: async (req: any) => {
      expect(req.options.override_username).toBe('user_custom');
      expect(req.options.transactions.days_requested).toBe(730);
      const n = ++made;
      items.set(`access-${n}`, { institution_id: req.institution_id, products: req.initial_products, config: JSON.parse(req.options.override_password) });
      return { data: { public_token: `public-${n}` } };
    },
    itemPublicTokenExchange: async (req: any) => {
      const n = req.public_token.slice('public-'.length);
      return { data: { access_token: `access-${n}`, item_id: `item-${n}` } };
    },
    itemGet: async (req: any) => {
      const item = itemOf(req.access_token);
      return { data: { item: { institution_id: item.institution_id, billed_products: item.products, products: item.products } } };
    },
    accountsGet: async (req: any) => ({
      data: { accounts: itemOf(req.access_token).config.override_accounts.map((a: any, i: number) => ({ account_id: `${req.access_token}-acct-${i}`, mask: a.meta.mask })) },
    }),
    // Everything at once from the start, once ready; nothing after.
    transactionsSync: async (req: any) => {
      const accounts = itemOf(req.access_token).config.override_accounts;
      const ready = syncsBeforeReady-- <= 0;
      const rows = accounts.flatMap((a: any, i: number) =>
        (a.transactions ?? []).map((t: any, j: number) => syncRow(`${req.access_token}-t-${i}-${j}`, `${req.access_token}-acct-${i}`, t))
      );
      const added = ready && !req.cursor ? rows : [];
      return { data: { added, modified: [], removed: [], accounts: [], next_cursor: ready ? 'done' : '', has_more: false, transactions_update_status: ready ? 'HISTORICAL_UPDATE_COMPLETE' : 'NOT_READY' } };
    },
    itemRemove: async (req: any) => {
      removed.push(req.access_token);
      return { data: {} };
    },
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { demoProfile, customUserConfig, txnCount, addDays, MAX_TXNS_PER_ITEM, HISTORY_MONTHS } = await import('@/lib/demo-seed/profiles');
const { checkSeedEnvironment, seedTargets, SeedRefused } = await import('@/lib/demo-seed/guard');
const { seedDemoAccount, waitForHistory } = await import('@/lib/demo-seed/seed');
const { parseArgs } = await import('@/scripts/seed-demo');
const { PLAID_PRIMARIES, categoryForKey, indexTaxonomy, PLAID } = await import('@/lib/categories');
const { parsePlan, DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { ownerContainer } = await import('@/lib/owners');
const { encrypt } = await import('@/lib/crypto');
const { getItems } = await import('@/lib/storage');
const { getManualAccounts, saveManualAccount, newManualId } = await import('@/lib/manual');
const { getGoals } = await import('@/lib/goals');
const { loadBudgets } = await import('@/lib/budget-store');
const { readTaxonomy } = await import('@/lib/category-store');
const { firePlanStore } = await import('@/lib/fire-plan');
const { readStoredTxns } = await import('@/lib/transactions');
const { secretsStore } = await import('@/lib/connectors/store');

const TODAY = '2026-10-26';
const NAMES = ['Alex', 'Sam'] as const;

describe('the profiles', () => {
  test('are the same every time for the same day', () => {
    for (const name of NAMES) expect(JSON.stringify(demoProfile(name, TODAY))).toBe(JSON.stringify(demoProfile(name, TODAY)));
  });

  test('fill every tab: banks, a card, investments with holdings, a loan, budgets, goals and a Plan', () => {
    for (const name of NAMES) {
      const p = demoProfile(name, TODAY);
      const accounts = p.institutions.flatMap((i) => i.accounts);
      for (const kind of ['depository', 'credit', 'investment', 'loan']) expect(accounts.some((a) => a.type === kind)).toBe(true);
      expect(accounts.filter((a) => a.type === 'investment').every((a) => (a.holdings ?? []).length > 0)).toBe(true);
      expect(Object.keys(p.budgets).length).toBeGreaterThan(0);
      expect(p.goals.length).toBeGreaterThan(0);
      expect(p.plan.age).toBeGreaterThan(0);
      expect(p.plan.targetAge).toBeGreaterThan(p.plan.age!);
    }
  });

  test('stay within what a sandbox custom user takes', () => {
    for (const name of NAMES) {
      for (const inst of demoProfile(name, TODAY).institutions) {
        expect(txnCount(inst)).toBeLessThanOrEqual(MAX_TXNS_PER_ITEM);
        expect(inst.accounts.length).toBeLessThanOrEqual(10);
        // Plaid documents about 55 KB.
        expect(JSON.stringify(customUserConfig(inst, TODAY)).length).toBeLessThan(50_000);
        // The sandbox puts each investment transaction on every investment
        // account of the Item, so only an Item of one may have any.
        const active = inst.accounts.filter((a) => (a.investment_transactions ?? []).length > 0);
        if (active.length > 0) expect(inst.accounts.filter((a) => a.type === 'investment').length).toBe(1);
        // And the sandbox runs its own schedule on a student loan.
        expect(inst.accounts.some((a) => a.subtype === 'student')).toBe(false);
      }
    }
  });

  test('hold a year of rows, none after today but the pending ones', () => {
    const earliest = addDays(TODAY, -31 * HISTORY_MONTHS);
    for (const name of NAMES) {
      const rows = demoProfile(name, TODAY).institutions.flatMap((i) => i.accounts.flatMap((a) => [...a.transactions, ...(a.investment_transactions ?? [])]));
      for (const t of rows) {
        expect(t.date <= TODAY).toBe(true);
        expect(t.date >= earliest).toBe(true);
      }
      const months = new Set(rows.map((t) => t.date.slice(0, 7)));
      expect(months.size).toBe(HISTORY_MONTHS);
    }
  });

  test('balances that walk back through their rows without a cash account going below zero', () => {
    for (const name of NAMES) {
      for (const a of demoProfile(name, TODAY).institutions.flatMap((i) => i.accounts)) {
        let balance = a.balance;
        for (const t of [...a.transactions].filter((t) => !t.pending).reverse()) {
          balance = a.type === 'depository' ? balance + t.amount : balance - t.amount;
          if (a.type === 'depository' || a.type === 'loan') expect(balance).toBeGreaterThan(0);
          if (a.type === 'credit') {
            expect(balance).toBeGreaterThanOrEqual(0);
            expect(balance).toBeLessThan(a.limit!);
          }
        }
      }
    }
  });

  test('an investment account is worth what its holdings are', () => {
    for (const name of NAMES) {
      for (const a of demoProfile(name, TODAY).institutions.flatMap((i) => i.accounts).filter((a) => a.type === 'investment')) {
        const worth = a.holdings!.reduce((s, h) => s + h.price * h.quantity, 0);
        expect(Math.abs(worth - a.balance)).toBeLessThan(0.01);
      }
    }
  });

  test('a card is paid in full each month from checking, the same amount on both sides', () => {
    for (const name of NAMES) {
      const accounts = demoProfile(name, TODAY).institutions.flatMap((i) => i.accounts);
      const paid = accounts.filter((a) => a.type === 'depository').flatMap((a) => a.transactions).filter((t) => t.description === 'TARTAN BANK CARD PAYMENT');
      const received = accounts.filter((a) => a.type === 'credit').flatMap((a) => a.transactions).filter((t) => t.description === 'AUTOPAY PAYMENT THANK YOU');
      expect(received.map((t) => [t.date, -t.amount])).toEqual(paid.map((t) => [t.date, t.amount]));
    }
  });

  test('money sent to an investment account arrives there, the same day and amount', () => {
    for (const name of NAMES) {
      const accounts = demoProfile(name, TODAY).institutions.flatMap((i) => i.accounts);
      const sent = accounts
        .filter((a) => a.type === 'depository')
        .flatMap((a) => a.transactions)
        .filter((t) => t.amount > 0 && /BROKERAGE|ROTH|529/.test(t.description));
      const arrived = accounts.flatMap((a) => a.investment_transactions ?? []).filter((t) => t.type === 'cash');
      expect(sent.length).toBeGreaterThan(0);
      for (const t of sent) expect(arrived.some((c) => c.date === t.date && c.price === t.amount && c.quantity === -1)).toBe(true);
    }
  });

  test('budget on categories Plaid files into, goals on accounts the profile has, and a Plan the route takes', () => {
    for (const name of NAMES) {
      const p = demoProfile(name, TODAY);
      for (const key of Object.keys(p.budgets)) expect(PLAID_PRIMARIES[key]).toBeDefined();
      const masks = p.institutions.flatMap((i) => i.accounts.map((a) => a.mask));
      expect(new Set(masks).size).toBe(masks.length);
      for (const g of p.goals) if (g.mask !== null) expect(masks).toContain(g.mask);
      expect('error' in parsePlan({ ...DEFAULT_PLAN, ...p.plan })).toBe(false);
    }
  });

  test('move with the day they are seeded on', () => {
    const later = demoProfile('Alex', '2027-03-02');
    const rows = later.institutions.flatMap((i) => i.accounts.flatMap((a) => a.transactions));
    expect(rows.some((t) => t.date.startsWith('2027-03'))).toBe(true);
    expect(rows.every((t) => t.date <= '2027-03-02')).toBe(true);
  });
});

const saved = { ...process.env };
const env = (vars: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
};

beforeEach(async () => {
  fake.reset();
  items.clear();
  removed.length = 0;
  syncsBeforeReady = 0;
  await registerTestContainer(fake);
  env({
    VERCEL_ENV: 'preview',
    NODE_ENV: undefined,
    PLAID_ENV: 'sandbox',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
    CLERK_SECRET_KEY: 'sk_test_x',
    DEMO_USER_IDS: 'user_alex:Alex, user_sam:Sam',
  });
});
afterEach(() => {
  process.env = { ...saved };
});

describe('where it may write', () => {
  // The tests' prefix is "test" (test/fake-redis.ts).
  test('only the prefix named twice, on Preview or Development, on the sandbox', () => {
    expect(() => checkSeedEnvironment('test')).not.toThrow();
    expect(() => checkSeedEnvironment(undefined)).toThrow(SeedRefused);
    expect(() => checkSeedEnvironment('preview')).toThrow(/would write to "test"/);
    env({ VERCEL_ENV: 'development' });
    expect(() => checkSeedEnvironment('test')).not.toThrow();
  });

  test('never production, whatever names it', () => {
    expect(() => checkSeedEnvironment('production')).toThrow(/never writes to production/);
    env({ VERCEL_ENV: 'production' });
    expect(() => checkSeedEnvironment('test')).toThrow(/never writes to production/);
  });

  test('not a self-hosted server, nor anything off Vercel but a dev server', () => {
    env({ VERCEL_ENV: undefined, NODE_ENV: 'production' });
    expect(() => checkSeedEnvironment('test')).toThrow(/only on Vercel Preview and Development/);
    env({ NODE_ENV: undefined });
    expect(() => checkSeedEnvironment('test')).toThrow(/only on Vercel Preview and Development/);
  });

  test('not Plaid beyond the sandbox', () => {
    env({ PLAID_ENV: 'production' });
    expect(() => checkSeedEnvironment('test')).toThrow(/PLAID_ENV must be sandbox/);
  });

  test('each demo account into the container it owns, once it has signed in', async () => {
    await ownerContainer('user_owner'); // the first sign-in takes the primary container
    await expect(seedTargets()).rejects.toThrow(/Alex hasn't signed in/);
    const alex = await ownerContainer('user_alex');
    const sam = await ownerContainer('user_sam');
    const targets = await seedTargets();
    expect(targets.map((t) => [t.name, t.userId, t.ctx.container])).toEqual([
      ['Alex', 'user_alex', alex],
      ['Sam', 'user_sam', sam],
    ]);
    expect((await seedTargets(['Sam'])).map((t) => t.name)).toEqual(['Sam']);
  });

  test('never the primary container, nor one another sign-in owns too', async () => {
    await ownerContainer('user_alex'); // Alex signed in first, taking the primary container
    await expect(seedTargets(['Alex'])).rejects.toThrow(/primary one/);
    const sam = await ownerContainer('user_sam');
    await fake.hset('test:owners', { user_partner: sam });
    await expect(seedTargets(['Sam'])).rejects.toThrow(/another sign-in too/);
  });

  test('nothing without demo accounts', async () => {
    env({ DEMO_USER_IDS: undefined });
    await expect(seedTargets()).rejects.toThrow(/names no demo account/);
    env({ DEMO_USER_IDS: 'user_alex:Alex', VERCEL_ENV: 'production' });
    await expect(seedTargets()).rejects.toThrow(/names no demo account/);
  });

  test('the arguments', () => {
    expect(parseArgs(['--target', 'preview', '--only', 'sam', '--dry-run'])).toEqual({ target: 'preview', only: ['Sam'], dryRun: true });
    expect(() => parseArgs(['--only', 'Jordan'])).toThrow(SeedRefused);
    expect(() => parseArgs(['--force'])).toThrow(SeedRefused);
  });
});

describe('seeding', () => {
  const quick = { historyTimeoutMs: 1_000, pollMs: 1, sleep: async () => {} };

  test('replaces what was there with the profile, through the app’s own stores', async () => {
    const ctx = TEST_CTX;
    // What a visitor left: a bank linked, a manual account.
    await fake.hset(`test:c:${ctx.container}:plaid:items`, {
      old: JSON.stringify({ item_id: 'old', institution_name: 'Chime', encrypted_access_token: await encrypt(ctx, 'access-old') }),
    });
    items.set('access-old', { institution_id: 'ins_x', products: ['transactions'], config: { override_accounts: [] } });
    await saveManualAccount(ctx, { account_id: newManualId(), name: 'Left behind', institution_name: 'Manual', type: 'depository', subtype: null, balance: 1, updated_at: new Date().toISOString() });

    const profile = demoProfile('Sam', TODAY);
    const report = await seedDemoAccount(ctx, 'user_sam', profile, TODAY, quick);
    expect(report.removed).toEqual(['Chime']);
    expect(removed).toEqual(['access-old']);
    expect(report.waiting).toEqual([]);
    // Every bank's year is in its store already, for the first visit.
    for (const inst of profile.institutions.filter((i) => i.products.includes('transactions'))) {
      const item = (await getItems(ctx)).find((i) => i.institution_name === inst.name)!;
      expect((await readStoredTxns(ctx, item.item_id)).length).toBe(txnCount(inst));
    }

    const stored = await getItems(ctx);
    expect(stored.map((i) => i.institution_name).sort()).toEqual(profile.institutions.map((i) => i.name).sort());
    expect(stored.every((i) => i.encrypted_access_token && !i.encrypted_access_token.includes('access-'))).toBe(true);
    expect(stored.find((i) => i.institution_name === 'Ascensus - Merrill Lynch')?.transactions_billed).toBe(false);

    expect((await getManualAccounts(ctx)).map((m) => m.name)).toEqual(['Home (estimated value)']);

    const goals = await getGoals(ctx);
    expect(goals.map((g) => [g.name, g.target])).toEqual(profile.goals.map((g) => [g.name, g.target]));
    // Each tracks the account Plaid made with that mask.
    const [savingsItem] = [...items.entries()].filter(([, i]) => i.config.override_accounts.some((a: any) => a.meta.mask === '6145'));
    const index = savingsItem[1].config.override_accounts.findIndex((a: any) => a.meta.mask === '6145');
    expect(goals[0].account_id).toBe(`${savingsItem[0]}-acct-${index}`);

    const { budgets } = await loadBudgets(ctx);
    const ix = indexTaxonomy((await readTaxonomy(ctx))!);
    expect(budgets.categories[categoryForKey(ix, PLAID, 'FOOD_AND_DRINK')!.id]).toEqual({ amount: profile.budgets.FOOD_AND_DRINK });
    expect(Object.keys(budgets.categories)).toHaveLength(Object.keys(profile.budgets).length);

    const plan = await firePlanStore.get(ctx);
    expect([plan?.age, plan?.targetAge]).toEqual([38, 52]);
    expect(plan?.income.map((i) => i.fromAge)).toEqual([67]);
  });

  test('refuses before changing anything when emptying would be refused', async () => {
    const ctx = TEST_CTX;
    await fake.hset(`test:c:${ctx.container}:plaid:items`, {
      old: JSON.stringify({ item_id: 'old', institution_name: 'Chime', encrypted_access_token: await encrypt(ctx, 'access-old') }),
    });
    await secretsStore.set(ctx, 'conn-1', { connector: 'simplefin', secret: 'https://example.invalid/access' });
    await expect(seedDemoAccount(ctx, 'user_sam', demoProfile('Sam', TODAY), TODAY, quick)).rejects.toThrow(SeedRefused);
    expect(removed).toEqual([]);
    expect((await getItems(ctx)).map((i) => i.institution_name)).toEqual(['Chime']);
  });

  test('run again, it resets to the same account rather than adding to it', async () => {
    const profile = demoProfile('Alex', TODAY);
    await seedDemoAccount(TEST_CTX, 'user_alex', profile, TODAY, quick);
    const first = await getItems(TEST_CTX);
    await seedDemoAccount(TEST_CTX, 'user_alex', profile, TODAY, quick);
    const second = await getItems(TEST_CTX);
    expect(second).toHaveLength(profile.institutions.length);
    expect(removed.sort()).toEqual(first.map((i) => `access-${i.item_id.slice('item-'.length)}`).sort());
    expect(await getManualAccounts(TEST_CTX)).toHaveLength(profile.manual.length);
    expect(await getGoals(TEST_CTX)).toHaveLength(profile.goals.length);
  });

  test('waits, syncing as a page load does, until the store holds the whole history, and says when it gave up', async () => {
    const t = (n: number) => ({ date_transacted: `2026-10-0${n}`, date_posted: `2026-10-0${n}`, amount: n, description: `ROW ${n}` });
    items.set('access-w', { institution_id: 'ins_x', products: ['transactions'], config: { override_accounts: [{ type: 'depository', meta: { mask: '1' }, transactions: [t(1), t(2), t(3)] }] } });
    const item = { item_id: 'item-w', institution_name: 'Wait Bank', encrypted_access_token: await encrypt(TEST_CTX, 'access-w'), transactions_billed: true };
    syncsBeforeReady = 2;
    let slept = 0;
    expect(await waitForHistory(TEST_CTX, item, 3, { pollMs: 1, sleep: async () => void slept++ })).toBe(true);
    expect(slept).toBe(2);
    expect((await readStoredTxns(TEST_CTX, 'item-w')).map((r) => r.name).sort()).toEqual(['ROW 1', 'ROW 2', 'ROW 3']);
    expect(await waitForHistory(TEST_CTX, item, 4, { historyTimeoutMs: 0, sleep: async () => {} })).toBe(false);
  });
});
