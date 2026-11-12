// lib/demo-seed/seed.ts
//
// Resets a demo account to its profile (lib/demo-seed/profiles.ts): what
// scripts/seed-demo.ts runs, once the guard (lib/demo-seed/guard.ts) has said
// where. Run again, it gives the same account, its dates moved up to today.
//
// 0. CHECK the profile as the app's routes would (lib/demo-seed/fill.ts
//    checkProfile), so a scenario the app refuses part of stops here.
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
// 3. FILL. Manual accounts, then what needs no account and no transaction
//    (budgets, goals, tags and rules, people, planned items and the rest),
//    then the Plan, each through its own store, as its route writes them
//    (lib/demo-seed/fill.ts).
// 4. WAIT for Plaid to have every transaction ready, syncing each Item through
//    the app's own sync (lib/transactions.ts, the only code that calls
//    Plaid's Transactions endpoints, after its billing check) until its store
//    holds the year, so the first visit after a seed sees all of it at once.
// 5. RECORD. One load as the daily job makes it (lib/snapshot-job.ts,
//    without its notices); the balance history a visitor's load built while
//    the year came in is swept; then that load records today and remembers
//    every account, with the past months' holdings recorded before today's.
//    A load that held its total back (a bank didn't answer) records no
//    totals for the year either. Then what is keyed by
//    an account (deposits and withdrawals, hidden, ended, notes) and by a
//    transaction (tags, notes, splits, groups, shares), the recorded year and
//    the saved plan (lib/demo-seed/recorded.ts), and last what a scenario puts
//    wrong with a connection. The caches and the estimated history go last.

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
import { newManualId, saveManualAccount, type ManualAccount } from '../manual';
import { computeNetWorth, recordFetch } from '../networth';
import { rememberAccounts } from '../last-known';
import { recordDirectory } from '../links';
import { recordSyncs } from '../connection-health';
import type { Ctx } from '../containers';
import { customUserConfig, txnCount, type DemoProfile, type SeedInstitution } from './profiles';
import { checkProfile, fillAccounts, fillPlan, fillSettings, fillTransactions, fillTrouble, savedPlanDay, type Linked, type SeedRun } from './fill';
import { measuredOf, recordedYear, writeHoldingsMonths, writeRecordedYear, writeSavedPlan } from './recorded';

export type SeedReport = {
  removed: string[];
  linked: { name: string; accounts: number; transactions: number }[];
  waiting: string[];
  /** What the profile names that couldn't be written, and why. */
  skipped: string[];
};

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

  // 0. Check.
  checkProfile(profile, today);

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
  const items: Linked[] = [];
  const pendingHistory: { item: StoredItem; expected: number }[] = [];
  for (const inst of profile.institutions) {
    const { item, ids } = await linkInstitution(ctx, inst, today);
    for (const [mask, id] of ids) accountIds.set(mask, id);
    items.push({ inst, item });
    const transactions = txnCount(inst);
    linked.push({ name: inst.name, accounts: inst.accounts.length, transactions });
    if (inst.products.includes('transactions') && transactions > 0) pendingHistory.push({ item, expected: transactions });
    log(`  linked ${inst.name}: ${inst.accounts.length} accounts, ${transactions} transactions`);
  }

  // 3. Fill.
  const now = new Date().toISOString();
  const manual = new Map<string, ManualAccount>();
  for (const m of profile.manual) {
    const account: ManualAccount = { account_id: newManualId(), name: m.name, institution_name: 'Manual', type: m.type, subtype: m.subtype, balance: m.balance, updated_at: now };
    await saveManualAccount(ctx, account);
    manual.set(m.name, account);
  }
  const run: SeedRun = { ctx, profile, today, accountIds, linked: items, manual, people: new Map(), waiting: new Set(), skipped: [] };
  await fillSettings(run);
  const plans = await fillPlan(run);

  // 4. Wait.
  const waiting: string[] = [];
  await Promise.all(
    pendingHistory.map(async (p) => {
      const ready = await waitForHistory(ctx, p.item, p.expected, opts);
      if (!ready) {
        waiting.push(p.item.institution_name);
        run.waiting.add(p.item.item_id);
      }
    })
  );

  // 5. Record. The load first, then the sweep: the history was empty when
  //    the year began to come in, and a visitor's load since would leave part
  //    of it. Swept just before the months go in, since a visitor's holdings
  //    for today, recorded first, would keep the older months off the index.
  const { institutions, netWorth } = await computeNetWorth(ctx);
  for (const inst of institutions) if (inst.error) run.skipped.push(`${inst.institution_name} didn't answer, so its balances aren't recorded`);
  await sweepContainerExcept(ctx, (key) => !key.startsWith('history:') && !key.startsWith('holdings:history'));
  await writeHoldingsMonths(ctx, profile, today, institutions, accountIds);
  const fetched = await recordFetch(ctx, institutions, netWorth);
  if (fetched.date === null) run.skipped.push('the year’s net worth totals, since today’s load held its total back');
  await rememberAccounts(ctx, institutions);
  await recordDirectory(ctx, institutions);
  await recordSyncs(ctx, institutions);
  await fillAccounts(run);
  await fillTransactions(run);
  const manualIds = new Map([...manual].map(([name, a]) => [name, a.account_id]));
  await writeRecordedYear(ctx, recordedYear(profile, today, measuredOf(institutions), accountIds, manualIds), fetched.date !== null);
  const savedOn = savedPlanDay(profile, today);
  if (savedOn) await writeSavedPlan(ctx, profile, plans.main, savedOn);
  await fillTrouble(run);
  // The caches and the estimated history go last, so nothing a visitor's
  // page load built from part of the year stays.
  await clearCaches(ctx);
  await clearBackfillDone(ctx);
  for (const line of run.skipped) log(`  skipped ${line}`);
  return { removed: before.map((i) => i.institution_name), linked, waiting, skipped: run.skipped };
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
