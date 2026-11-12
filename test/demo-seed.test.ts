import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys, TEST_CTX } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Plaid's sandbox, in memory: each custom user becomes an Item whose accounts
// and transactions are the ones its JSON describes, as the sandbox makes them.
type FakeItem = { institution_id: string; products: string[]; config: any; loginRequired?: boolean };
const items = new Map<string, FakeItem>();
const removed: string[] = [];
/** The Items /sandbox/item/reset_login was called on. */
const signedOut: string[] = [];
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
/** An account as /accounts/get answers it, from the custom user's. */
const accountOf = (access_token: string, a: any, i: number) => ({
  account_id: `${access_token}-acct-${i}`,
  mask: a.meta.mask,
  name: a.meta.name,
  official_name: null,
  type: a.type,
  subtype: a.subtype,
  balances: { current: a.starting_balance, available: null, limit: a.meta.limit ?? null, iso_currency_code: 'USD', unofficial_currency_code: null },
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
    accountsGet: async (req: any) => {
      const item = itemOf(req.access_token);
      if (item.loginRequired) throw { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED', error_type: 'ITEM_ERROR' } } };
      return { data: { item: { institution_id: item.institution_id }, accounts: item.config.override_accounts.map((a: any, i: number) => accountOf(req.access_token, a, i)) } };
    },
    // Each custom user's holdings, as the sandbox makes them: one security per ticker.
    investmentsHoldingsGet: async (req: any) => {
      const accounts = itemOf(req.access_token).config.override_accounts.map((a: any, i: number) => ({ a, acct: accountOf(req.access_token, a, i) })).filter((x: any) => x.a.type === 'investment');
      const securities = new Map<string, any>();
      const holdings = accounts.flatMap(({ a, acct }: any) =>
        (a.holdings ?? []).map((h: any) => {
          const ticker = h.security.ticker_symbol;
          const security_id = `sec-${ticker.replace(/[^A-Za-z0-9]/g, '')}`;
          securities.set(security_id, { security_id, ticker_symbol: ticker, name: h.security.name, type: ticker === 'CUR:USD' ? 'cash' : 'etf', is_cash_equivalent: ticker === 'CUR:USD', iso_currency_code: 'USD' });
          return { account_id: acct.account_id, security_id, quantity: h.quantity, institution_price: h.institution_price, institution_price_as_of: h.institution_price_as_of, institution_value: Math.round(h.quantity * h.institution_price * 100) / 100, cost_basis: h.cost_basis, iso_currency_code: 'USD' };
        })
      );
      return { data: { accounts: accounts.map((x: any) => x.acct), holdings, securities: [...securities.values()] } };
    },
    liabilitiesGet: async () => ({ data: { liabilities: { credit: [], mortgage: [], student: [] } } }),
    sandboxItemResetLogin: async (req: any) => {
      itemOf(req.access_token).loginRequired = true;
      signedOut.push(req.access_token);
      return { data: { reset_login: true } };
    },
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
const { firePlansStore, planFactsStore, readPlanAnswer } = await import('@/lib/plan-copies');
const { parsePlanV2, planOf } = await import('@/lib/fire/plan-v2');
const { MAIN_ID, factsOf, holdsAmounts } = await import('@/lib/fire/copies');
const { readStoredTxns } = await import('@/lib/transactions');
const { secretsStore } = await import('@/lib/connectors/store');
const { demoTarget } = await import('@/lib/demo-seed/guard');
const { SCENARIOS, scenarioById, DEFAULT_SCENARIO } = await import('@/lib/demo-seed/scenarios');
const { resetDemoAccount, resetState, ResetLimited, SEED_VERSION } = await import('@/lib/demo-seed/reset');
const { seedRecordStore } = await import('@/lib/demo-seed/store');
const { createInvite, acceptInvite, myConnections } = await import('@/lib/sharing');
const { keptWhenEmptied, classOfKey } = await import('@/lib/user-restore/classes');
const { checkProfile, categoryKeys } = await import('@/lib/demo-seed/fill');
const { RECORDED_DAYS, holdingsDays, recordedYear, yearlySavings } = await import('@/lib/demo-seed/recorded');
const { historyMonths, lastDay, on } = await import('@/lib/demo-seed/profiles');
const { readTagSet } = await import('@/lib/tags-store');
const { readRuleSet } = await import('@/lib/rules-store');
const { txnAnnotationStore } = await import('@/lib/txn-annotations');
const { getOverride } = await import('@/lib/overrides');
const { vendorDefaultsStore } = await import('@/lib/vendor-default-store');
const { expensePeopleStore, expenseSharesStore, expenseIousStore } = await import('@/lib/shared-expenses/store');
const { reviewSettingsStore } = await import('@/lib/review-store');
const { budgetMonthsStore, incomeCarryoverStore } = await import('@/lib/budget-months-store');
const { plannedStore } = await import('@/lib/planned-store');
const { moneyInOutStore } = await import('@/lib/money-in-out-store');
const { getHiddenAccounts } = await import('@/lib/hidden');
const { lifecycleStore } = await import('@/lib/lifecycle');
const { timelineNotesStore } = await import('@/lib/timeline-notes');
const { allocationSettingsStore } = await import('@/lib/allocation-settings');
const { readManualTxnsForDisplay } = await import('@/lib/manual-txns');
const { goalPlansStore } = await import('@/lib/goal-plans');
const { savedPlanStore } = await import('@/lib/saved-plan');
const { parseSavedDraft } = await import('@/lib/fire/saved-plan');
const { splitStore } = await import('@/lib/splits');
const { groupStore } = await import('@/lib/groups');
const { reportSettingsStore } = await import('@/lib/report/store');
const { runwayScenariosStore } = await import('@/lib/report/runway-scenario-store');
const { warningsStore } = await import('@/lib/connection-records');
const { getAccountHistory, getHistory } = await import('@/lib/history');
const { readHoldingsSpan } = await import('@/lib/holdings-history');
const { readInvestmentMonths } = await import('@/lib/investment-months-store');
const { monthsProblem, nextMonth, withPastMonths } = await import('@/lib/investment-months');
const { flowsOf, pastMonths } = await import('@/lib/demo-seed/past-months');
const { signedContribution } = await import('@/lib/balance');
const { decrypt } = await import('@/lib/crypto');

const TODAY = '2026-10-26';
const NAMES = ['Alex', 'Sam'] as const;
/** Every scenario's profile, the demo accounts' own among them. */
const everyProfile = () => SCENARIOS.map((x) => x.build(TODAY));

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
    for (const p of everyProfile()) {
      for (const inst of p.institutions) {
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
    for (const p of everyProfile()) {
      // An account with months imported has the two years of activity Plaid
      // shares, checked below.
      const imported = p.extras?.investmentMonths?.mask;
      const rows = p.institutions.flatMap((i) => i.accounts.flatMap((a) => [...a.transactions, ...(a.mask === imported ? [] : (a.investment_transactions ?? []))]));
      for (const t of rows) {
        expect(t.date <= TODAY).toBe(true);
        expect(t.date >= earliest).toBe(true);
      }
      const months = new Set(rows.map((t) => t.date.slice(0, 7)));
      expect(months.size).toBe(HISTORY_MONTHS);
    }
  });

  test('give an account with imported months activity from before the recorded year, inside the two years Plaid shares', () => {
    const profiles = everyProfile().filter((p) => p.extras?.investmentMonths);
    expect(profiles.length).toBeGreaterThan(0);
    for (const p of profiles) {
      const a = p.institutions.flatMap((i) => i.accounts).find((x) => x.mask === p.extras!.investmentMonths!.mask)!;
      const days = a.investment_transactions!.map((t) => t.date).sort();
      // Before it, so the months join the recorded year (else withPastMonths
      // says activity-late); within lib/invstore.ts's 730 days asked for.
      expect(days[0] < addDays(TODAY, -RECORDED_DAYS)).toBe(true);
      expect(days[0] >= addDays(TODAY, -730)).toBe(true);
      expect(days[days.length - 1] <= TODAY).toBe(true);
    }
  });

  test('balances that walk back through their rows without a cash account going below zero', () => {
    for (const p of everyProfile()) {
      for (const a of p.institutions.flatMap((i) => i.accounts)) {
        let balance = a.balance;
        for (const t of [...a.transactions].filter((t) => !t.pending).reverse()) {
          balance = a.type === 'depository' ? balance + t.amount : balance - t.amount;
          if (a.type === 'depository' || a.type === 'loan') expect(balance).toBeGreaterThan(0);
          if (a.type === 'credit') {
            expect(balance).toBeGreaterThanOrEqual(0);
            expect(balance).toBeLessThan(a.limit!);
          }
        }
        // Nor an investment account selling more of a fund than it held.
        const held = new Map((a.holdings ?? []).map((h) => [h.ticker, h.quantity]));
        for (const t of [...(a.investment_transactions ?? [])].reverse()) {
          if (t.type === 'cash') continue;
          held.set(t.ticker, (held.get(t.ticker) ?? 0) - t.quantity);
          expect(held.get(t.ticker)!).toBeGreaterThanOrEqual(-0.001);
        }
      }
    }
  });

  test('an investment account is worth what its holdings are', () => {
    for (const p of everyProfile()) {
      for (const a of p.institutions.flatMap((i) => i.accounts).filter((a) => a.type === 'investment')) {
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
      const plan = parsePlan({ ...DEFAULT_PLAN, ...p.plan });
      if ('error' in plan) throw new Error(`${name}'s plan is refused: ${plan.error}`);
      // As the seed saves it: version 2, which is what the route takes.
      expect('error' in parsePlanV2(planOf(plan.plan))).toBe(false);
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
  signedOut.length = 0;
  made = 0;
  syncsBeforeReady = 0;
  await registerTestContainer(fake);
  env({
    VERCEL_ENV: 'preview',
    NODE_ENV: undefined,
    PLAID_ENV: 'sandbox',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
    CLERK_SECRET_KEY: 'sk_test_x',
    DEMO_USER_IDS: 'user_alex:Alex, user_sam:Sam',
    UPSTASH_REDIS_REST_URL: 'https://redis.example.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'token',
    PLAID_CLIENT_ID: 'client',
    PLAID_SECRET: 'secret',
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

  test('says which settings are empty, as Vercel pulls Sensitive ones', () => {
    env({ CLERK_SECRET_KEY: '', PLAID_SECRET: '', UPSTASH_REDIS_REST_URL: '', KV_REST_API_URL: 'https://kv.example.invalid' });
    expect(() => checkSeedEnvironment('test')).toThrow('These are empty here: PLAID_SECRET, CLERK_SECRET_KEY.');
    env({ PLAID_ENCRYPTION_KEY: '', MASTER_KEY: undefined, PLAID_SECRET: 's', CLERK_SECRET_KEY: 'k' });
    expect(() => checkSeedEnvironment('test')).toThrow('These are empty here: PLAID_ENCRYPTION_KEY.');
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
    await expect(seedTargets(['Alex'])).rejects.toThrow(/primary container/);
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
    expect(parseArgs(['--target', 'preview', '--scenario', 'household']).scenario).toBe('household');
    expect(() => parseArgs(['--scenario', 'nope'])).toThrow(SeedRefused);
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

    // Seeded as your plan's entry, version 2 as this release saves, in USD
    // (the sandbox's currency) since it types an income; then the facts.
    const mine = await firePlansStore.get(ctx, MAIN_ID);
    expect(mine).toMatchObject({ name: 'First plan', currency: 'USD' });
    const plan = mine!.plan;
    if (plan.version !== 2) throw new Error('expected a version 2 plan');
    expect([plan.age, plan.targetAge]).toEqual([38, 52]);
    // What working tax out reads is said, so Preview offers it and then shows everything.
    expect(mine!.tax).toMatchObject({ state: 'NV', stateRate: 0, health: { beforeMedicare: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null } } });
    expect(plan.items.map((x) => [x.kind, x.beforeTax, x.from])[0]).toEqual(['social-security', true, { anchor: { at: 'age', age: 67 }, offset: 0 }]);
    // Then the child and the two of them working part-time after the stop.
    expect(plan.items.map((x) => x.id)).toEqual(['social-security', 'maya', 'sam-consulting', 'jordan-tutoring']);
    // Version 2, with the tax facts the profile holds: a partner's Roth, a basis
    // typed for the joint brokerage, and the 529 left out, to show that group.
    expect(plan.partnerAge).toBe(37);
    const facts = await planFactsStore.get(ctx);
    expect(facts).toMatchObject({ version: 2, main: MAIN_ID, ...factsOf(plan) });
    if (facts?.version !== 2) throw new Error('expected version 2 facts');
    expect(facts.tax.model).toBe('flat');
    expect(facts.tax.filing).toBe('joint');
    expect(facts.tax.owners.map((o) => o.owner)).toEqual(['partner', 'partner']);
    expect(facts.tax.basis.map((b) => b.amount)).toEqual([88_000]);
    expect(facts.tax.rothContributions).toEqual([
      { owner: 'you', amount: 42_000 },
      { owner: 'partner', amount: 31_000 },
    ]);
    expect(facts.tax.countAnyway).toEqual([]);
    // The child, in the household.
    expect(facts.tax.dependents).toEqual([{ id: 'maya', untilAge: 52 }]);
  });

  test('every profile’s plan is your plan and its copies, and holds a currency wherever it holds an amount', async () => {
    for (const name of NAMES) {
      const profile = demoProfile(name, TODAY);
      await seedDemoAccount(TEST_CTX, `user_${name.toLowerCase()}`, profile, TODAY, quick);
      const entries = await firePlansStore.getAll(TEST_CTX);
      expect([name, entries.has(MAIN_ID), entries.size]).toEqual([name, true, 1 + (profile.extras?.plan?.copies?.length ?? 0)]);
      expect([...entries.values()].map((e) => e.name).sort()).toEqual(['First plan', ...(profile.extras?.plan?.copies ?? []).map((c) => c.name)].sort());
      for (const [id, e] of entries) {
        if (holdsAmounts(e.plan)) expect([name, id, e.currency]).toEqual([name, id, 'USD']);
        else expect([name, id, e.currency]).toEqual([name, id, null]);
      }
      expect((await readPlanAnswer(TEST_CTX)).plan?.age).toBe(demoProfile(name, TODAY).plan.age);
    }
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

  test('seeds your plan over what was there: the plans and their facts go with the rest, so the plan seeded is the one read', async () => {
    const at = '2026-10-01T00:00:00.000Z';
    await firePlansStore.set(TEST_CTX, MAIN_ID, { name: 'First plan', plan: DEFAULT_PLAN, tax: null, currency: null, createdAt: at, updatedAt: at });
    await firePlansStore.set(TEST_CTX, 'x', { name: 'A visitor’s copy', plan: { ...DEFAULT_PLAN, age: 60 }, tax: null, currency: null, createdAt: at, updatedAt: at });
    await planFactsStore.set(TEST_CTX, { version: 1, main: 'x', ...factsOf({ ...DEFAULT_PLAN, age: 60 }) });
    await seedDemoAccount(TEST_CTX, 'user_alex', demoProfile('Alex', TODAY), TODAY, quick);
    const ids = await firePlansStore.ids(TEST_CTX);
    expect(ids).toContain(MAIN_ID);
    expect(ids).not.toContain('x');
    expect(ids).toHaveLength(1 + demoProfile('Alex', TODAY).extras!.plan!.copies!.length);
    expect((await planFactsStore.get(TEST_CTX))!.main).toBe(MAIN_ID);
    expect((await readPlanAnswer(TEST_CTX)).plan).toMatchObject({ age: 31, targetAge: 45 });
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

describe('what a seed sets up', () => {
  const quick = { historyTimeoutMs: 1_000, pollMs: 1, sleep: async () => {} };
  /** The account id Plaid made for the account ending `mask`. */
  const idOf = (mask: string) => {
    for (const [token, item] of items) {
      const i = item.config.override_accounts.findIndex((a: any) => a.meta.mask === mask);
      if (i >= 0) return `${token}-acct-${i}`;
    }
    throw new Error(`no account ending ${mask}`);
  };
  const category = async (key: string) => categoryForKey(indexTaxonomy((await readTaxonomy(TEST_CTX))!), PLAID, key)!;
  /** The stored transaction the row became. */
  const txnOf = async (row: { mask: string; date: string; amount: number; description: string } | null) => {
    const account_id = idOf(row!.mask);
    for (const item of await getItems(TEST_CTX)) {
      const found = (await readStoredTxns(TEST_CTX, item.item_id)).find((t) => t.account_id === account_id && t.date === row!.date && t.amount === row!.amount && t.name === row!.description);
      if (found) return found;
    }
    throw new Error(`no stored row ${row!.description}`);
  };

  test('every scenario passes the routes’ checks, and one that doesn’t stops the reset before anything changes', async () => {
    for (const x of SCENARIOS) expect(() => checkProfile(x.build(TODAY), TODAY)).not.toThrow();
    for (const x of SCENARIOS) for (const key of categoryKeys(x.build(TODAY))) expect(PLAID_PRIMARIES[key]).toBeDefined();

    const ctx = TEST_CTX;
    await fake.hset(`test:c:${ctx.container}:plaid:items`, {
      old: JSON.stringify({ item_id: 'old', institution_name: 'Chime', encrypted_access_token: await encrypt(ctx, 'access-old') }),
    });
    const alex = demoProfile('Alex', TODAY);
    const broken = { ...alex, extras: { ...alex.extras, plan: { ...alex.extras!.plan, copies: [{ name: 'A copy', drop: ['nope'] }] } } };
    await expect(seedDemoAccount(ctx, 'user_alex', broken, TODAY, quick)).rejects.toThrow(/drops nope/);
    const late = { ...alex, extras: { ...alex.extras, ended: [{ mask: '4821', on: addDays(TODAY, 1), note: 'x' }] } };
    await expect(seedDemoAccount(ctx, 'user_alex', late, TODAY, quick)).rejects.toThrow(/after today/);
    // What a route checks on its own: a name, a rule, a note, a group, the household.
    const longTag = { ...alex, extras: { ...alex.extras, tags: [...alex.extras!.tags!, 'x'.repeat(41)] } };
    await expect(seedDemoAccount(ctx, 'user_alex', longTag, TODAY, quick)).rejects.toThrow(/The tag x+ is refused/);
    const blankRule = { ...alex, extras: { ...alex.extras, rules: [{ name: '', tags: ['Vacation'] }] } };
    await expect(seedDemoAccount(ctx, 'user_alex', blankRule, TODAY, quick)).rejects.toThrow(/The rule on {2}is refused/);
    const blankNote = { ...alex, extras: { ...alex.extras, notes: [{ date: addDays(TODAY, -3), text: '   ' }] } };
    await expect(seedDemoAccount(ctx, 'user_alex', blankNote, TODAY, quick)).rejects.toThrow(/timeline note .* is refused/);
    const sam = demoProfile('Sam', TODAY);
    const unnamed = { ...sam, extras: { ...sam.extras, groups: sam.extras!.groups!.map((g) => ({ ...g, name: ' ' })) } };
    await expect(seedDemoAccount(ctx, 'user_alex', unnamed, TODAY, quick)).rejects.toThrow(/The group .* is refused: Give the group a name/);
    const ageless = { ...sam, extras: { ...sam.extras, plan: { ...sam.extras!.plan, dependents: [{ id: 'maya', untilAge: 200 }] } } };
    await expect(seedDemoAccount(ctx, 'user_alex', ageless, TODAY, quick)).rejects.toThrow(/household is refused/);
    // Months imported only at Vanguard, and only where the app would use them.
    const vanguard = scenarioById('vanguard-history')!.build(TODAY);
    const notThere = { ...alex, extras: { ...alex.extras, investmentMonths: vanguard.extras!.investmentMonths } };
    await expect(seedDemoAccount(ctx, 'user_alex', notThere, TODAY, quick)).rejects.toThrow(/isn't at Vanguard/);
    const startLater = (inst: (typeof vanguard.institutions)[number]) => ({ ...inst, accounts: inst.accounts.map((x) => ({ ...x, investment_transactions: x.investment_transactions?.filter((t) => t.date >= addDays(TODAY, -300)) })) });
    const lateActivity = { ...vanguard, institutions: vanguard.institutions.map((i) => (i.name === 'Vanguard' ? startLater(i) : i)) };
    await expect(seedDemoAccount(ctx, 'user_alex', lateActivity, TODAY, quick)).rejects.toThrow(/wouldn't be used \(activity-late\)/);
    expect(removed).toEqual([]);
    expect((await getItems(ctx)).map((i) => i.institution_name)).toEqual(['Chime']);
  });

  test('Alex: tags, rules, marks, a shared weekend, the review queue, plans and settings, each in its own store', async () => {
    const profile = demoProfile('Alex', TODAY);
    const x = profile.extras!;
    const report = await seedDemoAccount(TEST_CTX, 'user_alex', profile, TODAY, quick);
    expect(report.skipped).toEqual([]);

    // Tags, and the rules in the order listed, one of them off.
    const tags = (await readTagSet(TEST_CTX))!.tags;
    expect(tags.map((t) => t.name).sort()).toEqual(['Subscriptions', 'Vacation']);
    const tagId = (name: string) => tags.find((t) => t.name === name)!.id;
    const rules = (await readRuleSet(TEST_CTX))!.rules.sort((a, b) => a.priority - b.priority);
    expect(rules.map((r) => [r.conditions[0].value, r.enabled])).toEqual([
      ['NETFLIX', true],
      ['SPOTIFY', true],
      ['VENMO PAYMENT', true],
      ['CLIPPER', false],
    ]);
    expect(rules[0].actions.add_tags).toEqual([tagId('Subscriptions')]);
    expect(rules[2]).toMatchObject({ conditions: [{ field: 'name', op: 'equals', value: 'VENMO PAYMENT' }], actions: { set_name: 'Venmo' } });

    // The trip's rows tagged, one noted; the laptop left out, with its note.
    const [united, hyatt, laptop] = await Promise.all(x.marks!.map((m) => txnOf(m.row)));
    expect((await txnAnnotationStore.get(TEST_CTX, united.transaction_id))?.tags).toEqual([tagId('Vacation')]);
    expect(await txnAnnotationStore.get(TEST_CTX, hyatt.transaction_id)).toMatchObject({ tags: [tagId('Vacation')], note: 'Tokyo, five nights' });
    expect(await txnAnnotationStore.get(TEST_CTX, laptop.transaction_id)).toMatchObject({ excluded: true });

    // Two REI rows filed under entertainment, and the merchant's default from them.
    const entertainment = await category('ENTERTAINMENT');
    for (const r of x.recategorized!) expect(await getOverride(TEST_CTX, (await txnOf(r.row)).transaction_id)).toBe(entertainment.name.toLowerCase());
    const rei = (await vendorDefaultsStore.get(TEST_CTX))!.vendors.find((v) => v.name.startsWith('REI'))!;
    expect(rei.votes.map((v) => v.category_id)).toEqual([entertainment.id, entertainment.id]);
    expect(rei.default?.category_id).toBe(entertainment.id);

    // The Tahoe weekend shared with two friends, and what one still owes.
    const people = await expensePeopleStore.getAll(TEST_CTX);
    expect([...people.values()].map((p) => p.name).sort()).toEqual(['Marcus', 'Priya']);
    const tahoe = await txnOf(x.shares![0].row);
    const share = (await expenseSharesStore.get(TEST_CTX, tahoe.transaction_id))!;
    expect(share.entries.map((e) => [people.get(e.person)!.name, e.amount])).toEqual([
      ['Priya', 173.33],
      ['Marcus', 173.33],
    ]);
    const [iou] = [...(await expenseIousStore.getAll(TEST_CTX)).values()];
    expect(iou).toMatchObject({ direction: 'to_you', amount: 40, what: 'Concert tickets' });

    // The queue from a week back; travel rolling over from the history's first month.
    expect(await reviewSettingsStore.get(TEST_CTX)).toMatchObject({ on: true, since: addDays(TODAY, -7) });
    const first = historyMonths(TODAY)[0];
    const travel = await category('TRAVEL');
    expect((await budgetMonthsStore.get(TEST_CTX))!.categories[travel.id].rollover).toEqual([{ from: `${first.year}-${String(first.month).padStart(2, '0')}` }]);
    expect(await incomeCarryoverStore.get(TEST_CTX)).toBeNull();

    const planned = (await plannedStore.get(TEST_CTX))!;
    expect(planned.items.map((i) => [i.name, i.cadence, i.currency])).toEqual([
      ['Renter’s insurance', 'yearly', 'USD'],
      ['Flights to Japan', 'once', 'USD'],
    ]);
    expect(planned.threshold).toEqual({ amount: 2_000, currency: 'USD' });

    // Deposits and withdrawals on the Roth and the 401(k); the brokerage left to set.
    expect(await moneyInOutStore.get(TEST_CTX, idOf('5521'))).toMatchObject({ in: 29_400, out: 0, as_of: x.moneyInOut![0].as_of });
    expect(await moneyInOutStore.get(TEST_CTX, idOf('3314'))).toMatchObject({ in: 71_250 });
    expect(await moneyInOutStore.get(TEST_CTX, idOf('7788'))).toBeNull();
    expect([...(await getHiddenAccounts(TEST_CTX)).keys()]).toEqual([idOf('4830')]);
    const notes = [...(await timelineNotesStore.getAll(TEST_CTX)).values()];
    expect(notes.filter((n) => n.text === 'Raise at Northwind').map((n) => [n.date, n.account_id])).toEqual([[x.notes![0].date, idOf('4821')]]);
    expect((await allocationSettingsStore.get(TEST_CTX))!.target).toEqual({ 'us-stocks': 65, 'intl-stocks': 25, bonds: 10 });

    // Cash on hand's rows, under the categories they were given.
    const manualRows = (await readManualTxnsForDisplay(TEST_CTX, { hidden: new Set(), cutoff: '2000-01-01' })).txns;
    expect(manualRows.map((t) => t.name).sort()).toEqual(['Farmers market', 'Haircut tip', 'Taqueria']);

    // Goals: a start six months back, a date set, and one archived.
    const goals = await getGoals(TEST_CTX);
    const plans = await goalPlansStore.getAll(TEST_CTX);
    const planOfGoal = (name: string) => plans.get(goals.find((g) => g.name === name)!.id)?.plan;
    expect(planOfGoal('Emergency fund')).toMatchObject({ target_date: profile.goals[0].plan!.target_date, plan_start: { date: profile.goals[0].plan!.started!.date, account_id: idOf('9930') } });
    expect(planOfGoal('Japan trip')).toMatchObject({ monthly_target: 500 });
    expect(planOfGoal('New laptop')?.archived).toEqual(profile.goals[2].plan!.archived);

    // Your plan with its own items and workplace plan; two copies beside it.
    const mine = (await firePlansStore.get(TEST_CTX, MAIN_ID))!.plan;
    if (mine.version !== 2) throw new Error('expected version 2');
    expect(mine.items.map((i) => i.id)).toEqual(['japan-trip']);
    expect(mine.planFunding).toEqual([{ account_id: idOf('3314'), paidFrom: 'payroll' }]);
    expect(mine.partTimeIncome).toBe(18_000);
    const copies = [...(await firePlansStore.getAll(TEST_CTX)).values()].filter((e) => e.name !== 'First plan');
    const coast = copies.find((c) => c.name === 'Coast from 40')!.plan;
    if (coast.version !== 2) throw new Error('expected version 2');
    expect([coast.targetAge, coast.rule, coast.items.map((i) => i.id)]).toEqual([40, 'guardrails', ['japan-trip', 'freelance']]);
    const lasts = copies.find((c) => c.name === 'Earliest stop that lasts')!.plan;
    expect(lasts.version === 2 && lasts.lastsIn).toBe(0.9);

    // Saved three months back, as the Progress card saves one.
    const savedPlan = (await savedPlanStore.get(TEST_CTX))!;
    expect(savedPlan.day.slice(0, 7)).toBe(`${historyMonths(TODAY)[8].year}-${String(historyMonths(TODAY)[8].month).padStart(2, '0')}`);
    expect(savedPlan.savings).toBeGreaterThan(50_000);
    expect('error' in parseSavedDraft({ plan: savedPlan.plan, savings: savedPlan.savings, currency: savedPlan.currency, inflation: savedPlan.inflation })).toBe(false);
  });

  test('Sam: a split, a group, a group budget, report marks, a runway scenario and a closed card', async () => {
    const profile = demoProfile('Sam', TODAY);
    const x = profile.extras!;
    const report = await seedDemoAccount(TEST_CTX, 'user_sam', profile, TODAY, quick);
    expect(report.skipped).toEqual([]);

    const costco = await txnOf(x.splits![0].row);
    const split = (await splitStore.get(TEST_CTX, costco.transaction_id))!;
    expect(split.parts.map((p) => p.amount).reduce((a, b) => a + b, 0)).toBeCloseTo(costco.amount, 2);
    expect(split.parts.map((p) => p.category_id)).toEqual([(await category('FOOD_AND_DRINK')).id, (await category('GENERAL_MERCHANDISE')).id]);

    const [group] = [...(await groupStore.getAll(TEST_CTX)).values()];
    const trip = await Promise.all(x.groups![0].rows.map(txnOf));
    expect(group).toMatchObject({ name: 'San Diego trip', category_id: (await category('TRAVEL')).id, members: trip.map((t) => t.transaction_id), date: trip[0].date });

    const ix = indexTaxonomy((await readTaxonomy(TEST_CTX))!);
    const { budgets } = await loadBudgets(TEST_CTX);
    const { groupOf } = await import('@/lib/categories');
    expect(budgets.groups[groupOf(ix, await category('FOOD_AND_DRINK')).id]).toEqual({ amount: 1_300 });

    expect((await reportSettingsStore.get(TEST_CTX))!.marked).toEqual([(await category('MEDICAL')).name.toLowerCase()]);
    const [runway] = [...(await runwayScenariosStore.getAll(TEST_CTX)).values()];
    expect(runway).toMatchObject({ name: 'If both paychecks stop', months: 6, lower_by: 800, currency: 'USD' });

    expect((await lifecycleStore.get(TEST_CTX, idOf('4402')))!.lifecycle).toEqual({ state: 'closed', on: x.ended![0].on, note: 'Closed once the family card came' });
    expect(await moneyInOutStore.get(TEST_CTX, idOf('9013'))).toMatchObject({ in: 104_000, out: 8_500 });
    const copies = [...(await firePlansStore.getAll(TEST_CTX)).values()].map((e) => e.name).sort();
    expect(copies).toEqual(['A bigger home', 'First plan', 'Jordan part-time at 48']);
  });

  test('a row whose bank’s history hasn’t all come is passed over, and the report says so', async () => {
    syncsBeforeReady = 1_000;
    const profile = demoProfile('Sam', TODAY);
    const report = await seedDemoAccount(TEST_CTX, 'user_sam', profile, TODAY, { ...quick, historyTimeoutMs: 0 });
    expect(report.waiting.length).toBeGreaterThan(0);
    expect(report.skipped.some((line) => line.startsWith('COSTCO WHSE #0144') && line.includes('history hadn')).valueOf()).toBe(true);
    expect(await splitStore.getAll(TEST_CTX)).toHaveProperty('size', 0);
    expect(await groupStore.getAll(TEST_CTX)).toHaveProperty('size', 0);
  });

  test('a year of recorded balances, walked back from today’s through the rows, with totals as a snapshot sums them', async () => {
    const profile = demoProfile('Alex', TODAY);
    await seedDemoAccount(TEST_CTX, 'user_alex', profile, TODAY, quick);
    const container = TEST_CTX.container;
    const raw = (await fake.hgetall(`test:c:${container}:history:accounts`)) as Record<string, string>;
    const days: Record<string, Record<string, number>> = {};
    for (const [date, blob] of Object.entries(raw)) days[date] = JSON.parse(await decrypt(TEST_CTX, blob));
    const recorded = Object.keys(days).filter((d) => d < TODAY).sort();
    expect(recorded).toHaveLength(RECORDED_DAYS);
    expect(recorded[0]).toBe(addDays(TODAY, -RECORDED_DAYS));

    // A bank account: today's balance and the rows posted since.
    const checking = profile.institutions[0].accounts[0];
    for (const day of [recorded[0], recorded[100], recorded[RECORDED_DAYS - 1]]) {
      const since = checking.transactions.filter((t) => !t.pending && t.date > day).reduce((n, t) => n + t.amount, 0);
      expect(days[day][idOf('4821')]).toBeCloseTo(checking.balance + since, 2);
    }
    // A card owes less back then by what was spent since.
    const card = profile.institutions[1].accounts[0];
    const cardSince = card.transactions.filter((t) => !t.pending && t.date > recorded[50]).reduce((n, t) => n + t.amount, 0);
    expect(days[recorded[50]][idOf('1077')]).toBeCloseTo(card.balance - cardSince, 2);
    // An investment account near today's yesterday, well below it a year back.
    const k401 = idOf('3314');
    expect(Math.abs(days[recorded[RECORDED_DAYS - 1]][k401] / 96_500 - 1)).toBeLessThan(0.05);
    expect(days[recorded[0]][k401]).toBeLessThan(96_500 * 0.8);
    // Hidden accounts held flat, and counted, as a snapshot counts them.
    expect(new Set(recorded.map((d) => days[d][idOf('4830')]))).toEqual(new Set([1_240]));

    const totals = (await fake.hgetall(`test:c:${container}:history:net-worth`)) as Record<string, string>;
    const typeOf = new Map<string, string>(profile.institutions.flatMap((i) => i.accounts.map((a) => [idOf(a.mask), a.type] as const)));
    const manual = await getManualAccounts(TEST_CTX);
    for (const m of manual) typeOf.set(m.account_id, m.type);
    const day = recorded[200];
    const sum = Object.entries(days[day]).reduce((n, [id, b]) => n + signedContribution(typeOf.get(id)!, b), 0);
    expect(Number(await decrypt(TEST_CTX, totals[day]))).toBeCloseTo(sum, 2);
    // Every account, manual ones too.
    expect(Object.keys(days[day]).sort()).toEqual([...typeOf.keys()].sort());

    // The app reads them back as measured, not estimated.
    const history = await getHistory(TEST_CTX);
    expect(history.filter((p) => p.date < TODAY && !p.estimated)).toHaveLength(RECORDED_DAYS);
    const points = await getAccountHistory(TEST_CTX, idOf('4821'));
    expect(points.find((p) => p.date === recorded[100])?.value).toBeCloseTo(days[recorded[100]][idOf('4821')], 2);
    // Holdings once a month, the oldest first, so the span starts back then.
    const span = await readHoldingsSpan(TEST_CTX);
    expect(span.first).toBe(holdingsDays(TODAY)[0]);
  });

  test('a bank that doesn’t answer today’s load gets no year of totals, only the accounts measured, as such a load records them', async () => {
    const client = (await import('@/lib/plaid')).plaidClient as any;
    const sync = client.transactionsSync;
    // First Gingham signs out while the history comes in, so the load finds it so.
    client.transactionsSync = async (req: any) => {
      for (const item of items.values()) if (item.institution_id === 'ins_109509') item.loginRequired = true;
      return sync(req);
    };
    let report;
    try {
      report = await seedDemoAccount(TEST_CTX, 'user_alex', demoProfile('Alex', TODAY), TODAY, quick);
    } finally {
      client.transactionsSync = sync;
    }
    const container = TEST_CTX.container;
    expect(report.skipped).toContain('the year’s net worth totals, since today’s load held its total back');
    expect(await fake.hgetall(`test:c:${container}:history:net-worth`)).toBeNull();
    expect(await fake.hgetall(`test:c:${container}:history:accounts`)).toBeNull();
    const partial = (await fake.hgetall(`test:c:${container}:history:accounts:partial`)) as Record<string, string>;
    const past = Object.keys(partial).filter((d) => d < TODAY);
    expect(past).toHaveLength(RECORDED_DAYS);
    const day: Record<string, number> = JSON.parse(await decrypt(TEST_CTX, partial[past[0]]));
    expect(day[idOf('4821')]).toBeDefined();
    expect(day[idOf('6620')]).toBeUndefined();
  });

  test('the early retiree: drawn down monthly, conversions planned, tax worked out from the accounts', async () => {
    const profile = scenarioById('early-retiree')!.build(TODAY);
    const report = await seedDemoAccount(TEST_CTX, 'user_alex', profile, TODAY, quick);
    expect(report.skipped).toEqual([]);
    const draws = profile.institutions.flatMap((i) => i.accounts).find((a) => a.mask === '6604')!.investment_transactions!;
    expect(draws.filter((t) => t.type === 'cash' && t.quantity === 1).length).toBeGreaterThanOrEqual(HISTORY_MONTHS - 1);
    const mio = (await moneyInOutStore.get(TEST_CTX, idOf('6604')))!;
    expect(mio.out).toBeGreaterThan(mio.in);
    const facts = await planFactsStore.get(TEST_CTX);
    expect(facts?.version === 2 && facts.tax.model).toBe('detailed');
    const entries = [...(await firePlansStore.getAll(TEST_CTX)).values()];
    for (const e of entries) expect(e.tax?.strategy.conversions).toEqual({ kind: 'aca-then-bracket', top: 0.12 });
    const mine = (await firePlansStore.get(TEST_CTX, MAIN_ID))!.plan;
    expect(mine.version === 2 && [mine.age, mine.targetAge, mine.rule]).toEqual([47, 47, 'guardrails']);
    expect(await incomeCarryoverStore.get(TEST_CTX)).toMatchObject({ enabled: true });
    expect(signedOut).toEqual([]);
  });

  test('needs attention: signs one bank out last, warns of another, marks new accounts, and keeps an account at $0', async () => {
    const profile = scenarioById('needs-attention')!.build(TODAY);
    const report = await seedDemoAccount(TEST_CTX, 'user_alex', profile, TODAY, quick);
    expect(report.skipped).toEqual([]);
    const stored = await getItems(TEST_CTX);
    const tokenOf = async (name: string) => decrypt(TEST_CTX, stored.find((i) => i.institution_name === name)!.encrypted_access_token);
    expect(signedOut).toEqual([await tokenOf('First Gingham Credit Union')]);
    const tartan = stored.find((i) => i.institution_name === 'Tartan Bank')!;
    expect(await warningsStore.get(TEST_CTX, tartan.item_id)).toMatchObject({ kind: 'pending_expiration', ends_estimated: false });
    const platypus = stored.find((i) => i.institution_name === 'First Platypus Bank')!;
    expect(await fake.hget(`test:c:${TEST_CTX.container}:plaid:new-accounts`, platypus.item_id)).not.toBeNull();
    // The loan's balance was recorded before its bank was signed out, so it is kept as last known.
    const raw = (await fake.hgetall(`test:c:${TEST_CTX.container}:history:accounts`)) as Record<string, string>;
    const yesterday = JSON.parse(await decrypt(TEST_CTX, raw[addDays(TODAY, -1)]));
    expect(yesterday[idOf('6620')]).toBeGreaterThan(0);
    expect(yesterday[idOf('7001')]).toBe(0);
    expect((await moneyInOutStore.get(TEST_CTX, idOf('5521')))!.as_of < on(historyMonths(TODAY)[0], 2)).toBe(true);
  });

  test('history from Vanguard: the brokerage at Vanguard, its months imported and joined to the recorded year as its chart joins them', async () => {
    const profile = scenarioById('vanguard-history')!.build(TODAY);
    const report = await seedDemoAccount(TEST_CTX, 'user_alex', profile, TODAY, quick);
    expect(report.skipped.filter((line) => line.includes('months'))).toEqual([]);
    const item = (await getItems(TEST_CTX)).find((i) => i.institution_name === 'Vanguard')!;
    expect(item.institution_id).toBe('ins_115616');

    const id = idOf('7788');
    const entry = (await readInvestmentMonths(TEST_CTX, id))!;
    expect(entry.imports).toHaveLength(1);
    const [imported] = entry.imports;
    expect(imported.source).toBe('vanguard-performance');
    expect(imported.file_name).toBe('Vanguard performance.pdf');
    expect(imported.start.balance).toBe(0);
    expect(imported.months).toHaveLength(48);
    expect(nextMonth(imported.months[47].month)).toBe(TODAY.slice(0, 7));
    expect(monthsProblem(imported.start, imported.months)).toBeNull();

    const a = profile.institutions.flatMap((i) => i.accounts).find((x) => x.mask === '7788')!;
    const from = a.investment_transactions!.map((t) => t.date).sort()[0];
    const points = await getAccountHistory(TEST_CTX, id);
    const joined = withPastMonths(points, { flows: flowsOf(a), flows_from: from, flows_to: TODAY, moves: [] }, entry, 'USD');
    expect(joined.unused).toBeNull();
    expect(joined.applied!.joined).toBe(true);
    expect(joined.differs).toEqual([]);
    // Solid month ends from the month it opened to the recorded year, and a
    // deposit at the middle of each month before Plaid's activity.
    const entered = joined.points.filter((p) => p.entered);
    expect(entered).toHaveLength(imported.months.filter((m) => `${nextMonth(m.month)}-01` < joined.applied!.first_recorded).length + 1);
    expect(joined.flows!.filter((f) => f.date < from && f.amount === 300).length).toBeGreaterThan(12);
    // The line runs on from the last month's end to the recorded year.
    const firstRecorded = points.find((p) => p.date === joined.applied!.first_recorded)!;
    expect(Math.abs(firstRecorded.value / entered[entered.length - 1].value - 1)).toBeLessThan(0.05);
  });

  test('the months meet the recorded year at its balance less what came in since the month began, that day’s too', () => {
    // A year back on the 16th is a deposit day, which the recorded balance holds.
    for (const today of [TODAY, '2026-11-16', '2027-01-16']) {
      const profile = scenarioById('vanguard-history')!.build(today);
      const a = profile.institutions.flatMap((i) => i.accounts).find((x) => x.mask === '7788')!;
      const ids = new Map(profile.institutions.flatMap((i) => i.accounts.map((x) => [x.mask, x.mask] as const)));
      const days = recordedYear(profile, today, profile.institutions.flatMap((i) => i.accounts.map((x) => ({ account_id: x.mask, type: x.type, balance: x.balance }))), ids, new Map());
      const byDay = new Map(days.map((d) => [d.date, d.accounts['7788']]));
      const made = pastMonths(a, profile.extras!.investmentMonths!, today, (d) => (d >= today ? a.balance : byDay.get(d)), 1);
      const first = addDays(today, -RECORDED_DAYS);
      const joinAt = made.months.filter((m) => `${nextMonth(m.month)}-01` < first).length - 1;
      const began = `${nextMonth(made.months[joinAt].month)}-01`;
      const since = a.investment_transactions!.filter((t) => t.type === 'cash' && t.date >= began && t.date <= first).reduce((n, t) => n + (t.quantity < 0 ? t.price : -t.price), 0);
      expect(made.months[joinAt].end).toBeCloseTo(byDay.get(first)! - since, 2);
    }
  });

  test('the saved plan’s savings count each account over its own part of the year', () => {
    const day = addDays(TODAY, -90);
    const profile = scenarioById('vanguard-history')!.build(TODAY);
    // The brokerage's longer history leaves the others' part years as they are:
    // the whole is what each account gives on its own.
    const only = (keep: (mask: string) => boolean) => ({
      ...profile,
      institutions: profile.institutions.map((i) => ({ ...i, accounts: i.accounts.map((a) => (keep(a.mask) ? a : { ...a, investment_transactions: [] })) })),
    });
    const brokerage = yearlySavings(only((m) => m === '7788'), day);
    const others = yearlySavings(only((m) => m !== '7788'), day);
    expect(brokerage).toBeGreaterThan(0);
    expect(others).toBeGreaterThan(0);
    expect(yearlySavings(profile, day)).toBeCloseTo(brokerage + others, 1);
  });

  test('months that can’t be made from the balance the bank gave are passed over, and the rest of the reset runs', async () => {
    const client = (await import('@/lib/plaid')).plaidClient as any;
    const accounts = client.accountsGet;
    client.accountsGet = async (req: any) => {
      const res = await accounts(req);
      if (items.get(req.access_token)?.institution_id !== 'ins_115616') return res;
      return { data: { ...res.data, accounts: res.data.accounts.map((x: any) => ({ ...x, balances: { ...x.balances, current: 100 } })) } };
    };
    let report;
    try {
      report = await seedDemoAccount(TEST_CTX, 'user_alex', scenarioById('vanguard-history')!.build(TODAY), TODAY, quick);
    } finally {
      client.accountsGet = accounts;
    }
    expect(report.skipped.some((line) => line.startsWith('the months imported for the account ending 7788:'))).toBe(true);
    expect(await readInvestmentMonths(TEST_CTX, idOf('7788'))).toBeNull();
    // What comes after it still ran.
    expect(await savedPlanStore.get(TEST_CTX)).not.toBeNull();
  });
});

describe('scenarios', () => {
  test('each has a title, a line about it and its own id, and every demo account starts on one', () => {
    expect(new Set(SCENARIOS.map((x) => x.id)).size).toBe(SCENARIOS.length);
    for (const x of SCENARIOS) expect(x.title && x.description).toBeTruthy();
    for (const name of NAMES) expect(scenarioById(DEFAULT_SCENARIO[name])).not.toBeNull();
    expect(scenarioById('nope')).toBeNull();
  });

  test('the reset’s record and count survive the emptying it does part way', () => {
    expect(keptWhenEmptied(`c:${TEST_CTX.container}:demo-seed`)).toBe(true);
    expect(keptWhenEmptied(`c:${TEST_CTX.container}:demo-reset`)).toBe(true);
    expect(classOfKey(`c:${TEST_CTX.container}:demo-seed`).cls).toBe('machinery');
  });
});

describe('resetting a demo account', () => {
  const quick = { historyTimeoutMs: 1_000, pollMs: 1, sleep: async () => {} };
  const alexTarget = async () => {
    await ownerContainer('user_owner');
    await ownerContainer('user_alex');
    return (await demoTarget('user_alex'))!;
  };
  const plaid = async () => (await import('@/lib/plaid')).plaidClient as any;

  test('runs the scenario chosen, records it, and refuses another inside the window', async () => {
    const t = await alexTarget();
    await resetDemoAccount(t, scenarioById('household')!, TODAY, quick);
    expect((await getManualAccounts(t.ctx)).map((m) => m.name)).toEqual(['Home (estimated value)']);
    const record = await seedRecordStore.get(t.ctx);
    expect(record).toMatchObject({ version: SEED_VERSION, scenario: 'household' });
    expect(record?.finished_at).not.toBeNull();
    const before = (await getItems(t.ctx)).length;
    await expect(resetDemoAccount(t, scenarioById('single-renter')!, TODAY, quick)).rejects.toBeInstanceOf(ResetLimited);
    expect(await getItems(t.ctx)).toHaveLength(before);
    expect((await resetState(t.ctx)).secondsLeft).toBeGreaterThan(0);
  });

  test('a reset that stops part way is recorded as unfinished', async () => {
    const t = await alexTarget();
    const client = await plaid();
    const create = client.sandboxPublicTokenCreate;
    client.sandboxPublicTokenCreate = async () => {
      throw new Error('sandbox down');
    };
    try {
      await expect(resetDemoAccount(t, scenarioById('single-renter')!, TODAY, quick)).rejects.toThrow('sandbox down');
    } finally {
      client.sandboxPublicTokenCreate = create;
    }
    expect((await seedRecordStore.get(t.ctx))?.finished_at).toBeNull();
  });

  test('leaves alone an account a newer version reset, and checks what would stop it before counting', async () => {
    const t = await alexTarget();
    await seedRecordStore.set(t.ctx, { version: SEED_VERSION + 1, scenario: 'household', started_at: 'x', finished_at: 'y' });
    await expect(resetDemoAccount(t, scenarioById('household')!, TODAY, quick)).rejects.toThrow(/newer version/);
    await seedRecordStore.remove(t.ctx);
    await secretsStore.set(t.ctx, 'conn-1', { connector: 'simplefin', secret: 'https://example.invalid/access' });
    await expect(resetDemoAccount(t, scenarioById('household')!, TODAY, quick)).rejects.toThrow(/SimpleFIN or Lunch Flow/);
    expect((await resetState(t.ctx)).secondsLeft).toBe(0);
  });

  test('ends what the account shared', async () => {
    const t = await alexTarget();
    const { token } = await createInvite('user_alex', {});
    await acceptInvite('user_owner', token, 'Alex');
    expect((await myConnections('user_alex')).connections).toHaveLength(1);
    await resetDemoAccount(t, scenarioById('single-renter')!, TODAY, quick);
    expect((await myConnections('user_alex')).connections).toHaveLength(0);
    expect((await myConnections('user_owner')).connections).toHaveLength(0);
  });

  test('takes the last visitor’s files with the rest', async () => {
    const t = await alexTarget();
    await fake.hset(`test:c:${t.ctx.container}:attachments`, { 'att-1': 'a receipt' });
    await resetDemoAccount(t, scenarioById('single-renter')!, TODAY, quick);
    expect(await fake.hgetall(`test:c:${t.ctx.container}:attachments`)).toBeNull();
  });

  test('clears balance history a page load wrote while it waited, and records its own', async () => {
    const t = await alexTarget();
    const client = await plaid();
    const sync = client.transactionsSync;
    client.transactionsSync = async (req: any) => {
      await fake.hset(`test:c:${t.ctx.container}:history:net-worth`, { [TODAY]: 'partial' });
      await fake.hset(`test:c:${t.ctx.container}:holdings:history:index`, { x: 'partial' });
      return sync(req);
    };
    try {
      await resetDemoAccount(t, scenarioById('single-renter')!, TODAY, quick);
    } finally {
      client.transactionsSync = sync;
    }
    const days = (await fake.hgetall(`test:c:${t.ctx.container}:history:net-worth`)) as Record<string, string>;
    expect(days[TODAY]).not.toBe('partial');
    expect(Object.keys(days)).toContain(addDays(TODAY, -1));
    expect(((await fake.hgetall(`test:c:${t.ctx.container}:holdings:history:index`)) as Record<string, string> | null)?.x).toBeUndefined();
  });

  test('clears what a page load wrote while today’s load ran, so the months it records still start the span', async () => {
    const t = await alexTarget();
    const client = await plaid();
    const holdings = client.investmentsHoldingsGet;
    client.investmentsHoldingsGet = async (req: any) => {
      await fake.hset(`test:c:${t.ctx.container}:holdings:history:index`, { x: 'partial' });
      return holdings(req);
    };
    try {
      await resetDemoAccount(t, scenarioById('single-renter')!, TODAY, quick);
    } finally {
      client.investmentsHoldingsGet = holdings;
    }
    expect(((await fake.hgetall(`test:c:${t.ctx.container}:holdings:history:index`)) as Record<string, string> | null)?.x).toBeUndefined();
    expect((await readHoldingsSpan(t.ctx)).first).toBe(holdingsDays(TODAY)[0]);
  });
});

describe('the route', () => {
  const SAME = { 'content-type': 'application/json', origin: 'http://x', 'sec-fetch-site': 'same-origin' };
  const route = async (method: 'GET' | 'POST', body?: unknown, headers: Record<string, string> = SAME) => {
    const mod: any = await import('@/app/api/demo/seed/route');
    const res = await mod[method](
      new Request('http://x/api/demo/seed', { method, headers: method === 'POST' ? headers : {}, body: body === undefined ? undefined : JSON.stringify(body) })
    );
    return { status: res.status, body: await res.json(), headers: res.headers as Headers };
  };
  beforeEach(async () => {
    clerk.signedIn = null;
    await ownerContainer('user_owner');
    await ownerContainer('user_alex');
  });
  afterEach(() => {
    clerk.signedIn = null;
  });

  test('says nothing of it to anyone but a demo account', async () => {
    clerk.signedIn = 'user_owner';
    expect((await route('GET')).body).toEqual({ demo: false });
    expect((await route('POST', { scenario: 'household' })).status).toBe(403);
    expect(made).toBe(0);
  });

  test('tells a demo account its scenarios, where it starts, and when it may reset again', async () => {
    clerk.signedIn = 'user_alex';
    const got = (await route('GET')).body;
    expect(got).toMatchObject({ demo: true, default: 'single-renter', last: null, next_in_seconds: 0, window_minutes: 10 });
    expect(got.scenarios.map((x: any) => x.id)).toEqual(SCENARIOS.map((x) => x.id));
  });

  test('resets it from its own page, once in the window', async () => {
    clerk.signedIn = 'user_alex';
    const done = await route('POST', { scenario: 'household' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ ok: true, scenario: 'household' });
    const t = (await demoTarget('user_alex'))!;
    expect((await getItems(t.ctx)).length).toBe(scenarioById('household')!.build(TODAY).institutions.length);
    expect((await route('GET')).body.last).toMatchObject({ scenario: 'household', phase: 'finished' });
    const again = await route('POST', { scenario: 'household' });
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('refuses another site, a form, and a scenario it doesn’t know', async () => {
    clerk.signedIn = 'user_alex';
    expect((await route('POST', { scenario: 'household' }, { 'content-type': 'application/json', origin: 'https://elsewhere.example' })).status).toBe(403);
    expect((await route('POST', { scenario: 'household' }, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await route('POST', { scenario: 'household' }, { 'content-type': 'text/plain', origin: 'http://x' })).status).toBe(403);
    expect((await route('POST', { scenario: 'nope' })).status).toBe(400);
    expect(made).toBe(0);
  });

  test('takes its own page at any of its addresses, and a request that names no site at all', async () => {
    clerk.signedIn = 'user_alex';
    env({ APP_URL: 'https://nya-preview.example' });
    // At the deployment's own address, though the configured one is another.
    expect((await route('POST', { scenario: 'household' }, { 'content-type': 'application/json', origin: 'http://x', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    const t = (await demoTarget('user_alex'))!;
    await fake.del(`test:c:${t.ctx.container}:demo-reset`);
    // At the configured address.
    expect((await route('POST', { scenario: 'household' }, { 'content-type': 'application/json', origin: 'https://nya-preview.example' })).status).toBe(200);
    await fake.del(`test:c:${t.ctx.container}:demo-reset`);
    // Neither header (not a browser, or an old one): JSON alone, which a page on another site can't send unasked.
    expect((await route('POST', { scenario: 'household' }, { 'content-type': 'application/json' })).status).toBe(200);
  });

  test('says a reset is running while it runs, and one that stopped as stopped', async () => {
    clerk.signedIn = 'user_alex';
    const t = (await demoTarget('user_alex'))!;
    await seedRecordStore.set(t.ctx, { version: SEED_VERSION, scenario: 'household', started_at: new Date().toISOString(), finished_at: null });
    expect((await route('GET')).body.last).toMatchObject({ phase: 'running' });
    await seedRecordStore.set(t.ctx, { version: SEED_VERSION, scenario: 'household', started_at: new Date(Date.now() - 7 * 60_000).toISOString(), finished_at: null });
    expect((await route('GET')).body.last).toMatchObject({ phase: 'stopped' });
  });

  test('says why a demo account can’t be reset, rather than nothing', async () => {
    clerk.signedIn = 'user_alex';
    const t = (await demoTarget('user_alex'))!;
    await fake.hset('test:owners', { user_partner: t.ctx.container });
    const got = (await route('GET')).body;
    expect(got).toMatchObject({ demo: true, default: 'single-renter' });
    expect(got.refused).toMatch(/another sign-in too/);
    expect((await route('POST', { scenario: 'household' })).status).toBe(409);
    expect(made).toBe(0);
  });

  test('refuses beyond Plaid’s sandbox', async () => {
    clerk.signedIn = 'user_alex';
    env({ PLAID_ENV: 'production' });
    expect((await route('POST', { scenario: 'household' })).status).toBe(403);
    expect(made).toBe(0);
  });
});
