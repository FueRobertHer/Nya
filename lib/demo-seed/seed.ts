// lib/demo-seed/seed.ts
//
// Resets a demo account to its profile (lib/demo-seed/profiles.ts): what
// scripts/seed-demo.ts runs, once the guard (lib/demo-seed/guard.ts) has said
// where. Run again, it gives the same account, its dates moved up to today.
//
// 1. EMPTY. First what would stop emptying is checked, before anything is
//    changed (a connection to SimpleFIN or Lunch Flow, a restore under way:
//    a visitor can leave either), so a refusal leaves the account whole. Then
//    each linked bank is disconnected as the Disconnect button does it
//    (lib/disconnect-item.ts, removing the Item at Plaid), then the container
//    is emptied as Settings' "Empty my account" does it (lib/user-restore/
//    undo.ts emptyAccount): everything but the machinery goes, and the
//    container, its key and the sign-in stay. Receipts and documents, which
//    emptying keeps for a real person, go too: the last visitor's files are
//    not the next one's.
// 2. LINK. Each institution becomes a Plaid sandbox Item made from a custom
//    user (/sandbox/public_token/create with `user_custom`), exchanged and
//    stored as linking one in the app stores it (app/api/exchange-public-
//    token). Two years of history are asked for, so the year's rows all come.
// 3. FILL. Manual accounts, budgets, goals and the Plan's assumptions, each
//    through its own store, as its route writes them.
// 4. WAIT for Plaid to have every transaction ready, syncing each Item through
//    the app's own sync (lib/transactions.ts, the only code that calls
//    Plaid's Transactions endpoints, after its billing check) until its store
//    holds the year, so the first visit after a seed sees all of it at once.

import type { Products } from 'plaid';
import { plaidClient } from '../plaid';
import { encrypt } from '../crypto';
import { getItems, saveItem, type StoredItem } from '../storage';
import { disconnectItem } from '../disconnect-item';
import { emptyAccount } from '../user-restore/undo';
import { sweepContainerExcept } from '../account-deletion';
import { userRestoreStore } from '../user-restore/store';
import { unfinished } from '../user-restore/restored';
import { secretsStore } from '../connectors/store';
import { webhookUrlFor } from '../webhook-url';
import { SeedRefused } from './guard';
import { clearCaches } from '../cache';
import { clearBackfillDone } from '../history';
import { transactionsBilledOf } from '../item-products';
import { readStoredTxns, syncItemTransactions } from '../transactions';
import { newManualId, saveManualAccount } from '../manual';
import { ensureTaxonomy } from '../category-store';
import { categoryForKey, indexTaxonomy, PLAID } from '../categories';
import { loadBudgets, saveBudgets } from '../budget-store';
import { readBudgets } from '../budget-set';
import { setGoals } from '../goals';
import { DEFAULT_PLAN, parsePlan } from '../fire/plan';
import { firePlanStore } from '../fire-plan';
import type { Ctx } from '../containers';
import { customUserConfig, txnCount, type DemoProfile, type SeedInstitution } from './profiles';

export type SeedReport = { removed: string[]; linked: { name: string; accounts: number; transactions: number }[]; waiting: string[] };

export type SeedOptions = {
  /** How long to wait for Plaid's history, per Item. */
  historyTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

const sleeper = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Replaces everything in the container with the profile. */
export async function seedDemoAccount(ctx: Ctx, userId: string, profile: DemoProfile, today: string, opts: SeedOptions = {}): Promise<SeedReport> {
  const log = opts.log ?? (() => {});

  // 1. Empty.
  await checkEmptiable(ctx);
  const before = await getItems(ctx);
  for (const item of before) {
    log(`  disconnecting ${item.institution_name}`);
    await disconnectItem(ctx, item.item_id, item);
  }
  const { deleted } = await emptyAccount(ctx, { userId });
  const files = await sweepContainerExcept(ctx, (key) => !key.startsWith('attachment'));
  log(`  emptied (${deleted + files} keys)`);

  // 2. Link.
  const accountIds = new Map<string, string>();
  const linked: SeedReport['linked'] = [];
  const pendingHistory: { item: StoredItem; expected: number }[] = [];
  for (const inst of profile.institutions) {
    const { item, ids } = await linkInstitution(ctx, inst, today);
    for (const [mask, id] of ids) accountIds.set(mask, id);
    const transactions = txnCount(inst);
    linked.push({ name: inst.name, accounts: inst.accounts.length, transactions });
    if (inst.products.includes('transactions') && transactions > 0) pendingHistory.push({ item, expected: transactions });
    log(`  linked ${inst.name}: ${inst.accounts.length} accounts, ${transactions} transactions`);
  }

  // 3. Fill.
  const now = new Date().toISOString();
  for (const m of profile.manual) {
    await saveManualAccount(ctx, { account_id: newManualId(), name: m.name, institution_name: 'Manual', type: m.type, subtype: m.subtype, balance: m.balance, updated_at: now });
  }

  const required = Object.keys(profile.budgets).map((key) => ({ provider: PLAID, key }) as const);
  const taxonomy = await ensureTaxonomy(ctx, { required });
  const ix = indexTaxonomy(taxonomy);
  const categories: Record<string, { amount: number }> = {};
  for (const [key, amount] of Object.entries(profile.budgets)) {
    const c = categoryForKey(ix, PLAID, key);
    if (!c) throw new Error(`No category files Plaid's ${key}`);
    categories[c.id] = { amount };
  }
  await loadBudgets(ctx);
  await saveBudgets(ctx, readBudgets({ categories, groups: {} }), taxonomy);

  await setGoals(
    ctx,
    profile.goals.map((g) => {
      const account_id = g.mask === null ? null : (accountIds.get(g.mask) ?? null);
      if (g.mask !== null && account_id === null) throw new Error(`No account ending ${g.mask} for the goal ${g.name}`);
      return { id: crypto.randomUUID(), name: g.name, target: g.target, account_id };
    })
  );

  const plan = parsePlan({ ...DEFAULT_PLAN, ...profile.plan });
  if ('error' in plan) throw new Error(`The profile's plan is refused: ${plan.error}`);
  await firePlanStore.set(ctx, plan.plan);

  // 4. Wait. Then the balance history, the caches and the estimated history
  //    are cleared, so nothing a visitor's page load built from part of the
  //    year while it came in stays: the history was empty when it began.
  const waiting: string[] = [];
  await Promise.all(
    pendingHistory.map(async (p) => {
      const ready = await waitForHistory(ctx, p.item, p.expected, opts);
      if (!ready) waiting.push(p.item.institution_name);
    })
  );
  await sweepContainerExcept(ctx, (key) => !key.startsWith('history:'));
  await clearCaches(ctx);
  await clearBackfillDone(ctx);
  return { removed: before.map((i) => i.institution_name), linked, waiting };
}

/** Refuses, changing nothing, what emptyAccount would refuse once the banks
 *  were already disconnected. (Another sign-in owning the container is
 *  refused before this, lib/demo-seed/guard.ts.) */
export async function checkEmptiable(ctx: Ctx): Promise<void> {
  const secrets = await secretsStore.getAllReport(ctx);
  if (secrets.entries.size + secrets.unreadable.length + secrets.unrecognised.length > 0) {
    throw new SeedRefused('This demo account has a connection to SimpleFIN or Lunch Flow: disconnect it on its card on the Accounts tab first, so it isn’t left running there.');
  }
  const restore = await userRestoreStore.getReport(ctx);
  if (restore.value && unfinished(restore.value)) {
    throw new SeedRefused('A restore is under way in this demo account: undo it first (Settings, Your data and privacy, Bring back a download).');
  }
}

/** Makes the institution's Item and stores it, as linking it in the app
 *  does. Answers the stored Item and its accounts' ids by mask. */
async function linkInstitution(ctx: Ctx, inst: SeedInstitution, today: string): Promise<{ item: StoredItem; ids: Map<string, string> }> {
  const created = await plaidClient.sandboxPublicTokenCreate({
    institution_id: inst.institution_id,
    initial_products: inst.products as Products[],
    options: {
      override_username: 'user_custom',
      override_password: JSON.stringify(customUserConfig(inst, today)),
      transactions: { days_requested: 730 },
      // As Link is given it (app/api/create-link-token), so the Item's
      // webhooks reach this deployment.
      webhook: webhookUrlFor(ctx),
    },
  });
  const exchange = await plaidClient.itemPublicTokenExchange({ public_token: created.data.public_token });
  const access_token = exchange.data.access_token;
  const got = await plaidClient.itemGet({ access_token });
  const item: StoredItem = {
    item_id: exchange.data.item_id,
    institution_name: inst.name,
    encrypted_access_token: await encrypt(ctx, access_token),
    institution_id: got.data.item.institution_id ?? inst.institution_id,
    transactions_billed: transactionsBilledOf(got.data.item),
  };
  await saveItem(ctx, item);
  const accounts = await plaidClient.accountsGet({ access_token });
  const ids = new Map<string, string>();
  for (const a of accounts.data.accounts) if (a.mask) ids.set(a.mask, a.account_id);
  for (const a of inst.accounts) if (!ids.has(a.mask)) throw new Error(`Plaid made no account ending ${a.mask} at ${inst.name}`);
  return { item, ids };
}

/** Whether the Item's store holds all `expected` transactions, syncing it
 *  as a page load does until it does or the time runs out. An Item the sync
 *  finds has no Transactions has nothing to wait for. */
export async function waitForHistory(ctx: Ctx, item: StoredItem, expected: number, opts: SeedOptions = {}): Promise<boolean> {
  const sleep = opts.sleep ?? sleeper;
  const deadline = Date.now() + (opts.historyTimeoutMs ?? 120_000);
  for (;;) {
    const synced = await syncItemTransactions(ctx, item);
    if (synced.noTransactions) return true;
    if ((await readStoredTxns(ctx, item.item_id)).length >= expected) return true;
    if (Date.now() >= deadline) return false;
    await sleep(opts.pollMs ?? 3_000);
  }
}
