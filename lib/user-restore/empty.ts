// lib/user-restore/empty.ts
//
// Whether an account is empty enough to bring a download into
// (docs/data-export.md, "Bringing it back"): a scan of every key in its
// container, each classed by lib/user-restore/classes.ts. Machinery is
// ignored; settings are allowed (the file's replace them, and the preview
// says so); anything else, the person's money or a key nothing names, means
// the account is in use, and the answer says what was found, in words the
// person knows, never ids.
//
// The scan is a SCAN of the environment's keyspace (lib/account-deletion.ts
// containerKeys), so it runs where it is counted: the preview, the start, and
// before emptying. Never for the banner's state.

import type { Ctx } from '../containers';
import { containerKeys } from '../account-deletion';
import { getItems } from '../storage';
import { secretsStore } from '../connectors/store';
import { classOfKey } from './classes';

/** What a scan found, grouped as the person would name it. */
export type AccountScan = {
  /** Nothing of the person's money, and no restore's record. */
  empty: boolean;
  /** A restore's record is here (one restore at a time). */
  record: boolean;
  /** What was found, in words, in a fixed order. */
  found: string[];
  /** Some of it is of a kind the app doesn't show (a key nothing names, or
   *  one left by an earlier version), which only emptying the account, or
   *  whoever runs this copy, can clear. */
  unseen: boolean;
  /** The settings this account has (store names), which the file's replace. */
  settings: string[];
  /** The names of the banks linked through Plaid. */
  banks: string[];
  /** Connections that hold a credential: Plaid items, and SimpleFIN
   *  connections with their Access URL. Emptying and undoing are refused
   *  while there are any: deleting their keys would leave them running at
   *  the provider. */
  credentials: { plaid: number; simplefin: number };
};

/** The words for each group of what an account can hold, in the order a
 *  refusal names them. */
const GROUPS: readonly (readonly [words: string, families: readonly string[]])[] = [
  ['linked banks', ['plaid:items']],
  ['connections to SimpleFIN', ['connector-connections', 'connector-secrets', 'connector-accounts', 'connector-ended']],
  ['manual accounts', ['manual:accounts']],
  ['balance history', ['history:net-worth', 'history:net-worth:est', 'history:accounts', 'history:accounts:est', 'history:accounts:est:ext', 'history:accounts:partial', 'history:accounts:est:flatd', 'history:accounts:est:flat']],
  [
    'transactions',
    [
      'txns:',
      'invtxns:',
      'manual-transactions',
      'imported-transactions',
      'restored-transactions',
      'restored-investment-transactions',
      'imports',
      'history-imports',
      'import-summaries',
      'history-import-summaries',
      'imported-twins',
      'carried-imported-twins',
      'import-settings',
    ],
  ],
  ['accounts kept from a bank you disconnected', ['accounts:directory', 'accounts:meta', 'account-links', 'account-links:dismissed', 'txn-category-carry', 'carried-annotations', 'hidden:accounts', 'account-lifecycle', 'restored-accounts']],
  ['budgets', ['budgets', 'budget-set', 'budget-months']],
  ['goals', ['goals', 'goal-plans']],
  ['rules and tags', ['rules', 'tags']],
  ['what you said about transactions', ['txn-category-overrides', 'txn-vendor-renames', 'transaction-annotations', 'transaction-splits', 'transaction-groups', 'transaction-approvals', 'vendor-defaults']],
  ['notes on the timeline', ['timeline-notes']],
  ['holdings history', ['holdings:history']],
  ['planned bills and income', ['planned-items']],
];

const GROUP_OF = new Map<string, string>(GROUPS.flatMap(([words, families]) => families.map((f) => [f, words] as const)));
const UNSEEN = 'data Nya doesn’t show';

/** Scans the account's container (see the header). Strict: a failure to scan
 *  or read throws, never reads as empty. */
export async function scanAccount(ctx: Ctx): Promise<AccountScan> {
  const keys = await containerKeys(ctx);
  const found = new Set<string>();
  const settings = new Set<string>();
  let record = false;
  let unseen = false;
  let items = false;
  let secrets = false;
  for (const key of keys) {
    const { family, cls } = classOfKey(key);
    if (cls === 'machinery') continue;
    if (cls === 'record') {
      record = true;
      continue;
    }
    if (cls === 'setting') {
      settings.add(family!);
      continue;
    }
    const words = family ? GROUP_OF.get(family) : undefined;
    if (words) found.add(words);
    else {
      found.add(UNSEEN);
      unseen = true;
    }
    if (family === 'plaid:items') items = true;
    if (family === 'connector-secrets') secrets = true;
  }
  const [stored, secretCount] = await Promise.all([items ? getItems(ctx) : Promise.resolve([]), secrets ? secretsStore.count(ctx) : Promise.resolve(0)]);
  const order = [...GROUPS.map(([w]) => w), UNSEEN];
  return {
    empty: found.size === 0 && !record,
    record,
    found: order.filter((w) => found.has(w)),
    unseen,
    settings: [...settings].sort(),
    banks: [...new Set(stored.map((i) => i.institution_name))].sort(),
    credentials: { plaid: stored.length, simplefin: secretCount },
  };
}

/** The words of a refusal: what this account holds, and what to do. */
export function inUseMessage(scan: AccountScan): string {
  const named = scan.found.map((w) => (w === 'linked banks' && scan.banks.length > 0 ? `linked banks (${scan.banks.join(', ')})` : w));
  const list = named.length <= 1 ? named.join('') : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  const what = `This account already has ${list}. A restore brings back a whole copy, so it goes only into an account with nothing in it yet.`;
  const how = scan.unseen
    ? ' Some of it is data Nya doesn’t show here: empty this account first (Manage, Bring back a download), or ask whoever runs this copy of Nya.'
    : ' To bring in transactions, import a file into an account instead (Manage). To restore this file here, empty this account first.';
  return what + how;
}
