// lib/user-restore/parts.ts
//
// The parts of a download (docs/data-export.md) as a restore knows them, for
// the page that reads the file, which can't load the stores themselves: the
// parts every release has written (the core ones), and one per store on the
// storage seam declared exportable, each with its kind, what a restore does
// with it, and its bounds. Pure. test/user-restore-parts.test.ts keeps SEAM
// equal to what lib/stores.ts declares, so a store added later has to take a
// side here before a download that has it can be brought back: until then
// such a download is refused, as one from a newer release is.

/** The parts that say what the file is. */
export const HEADER_PARTS = ['format', 'version', 'exported_at', 'documentation', 'not_included', 'notes', 'problems'] as const;

/** The parts of the file that predate the seam, in the order the download
 *  writes them, and what a restore does with each. */
export const CORE_PARTS = [
  'institutions',
  'accounts',
  'manual_accounts',
  'hidden_accounts',
  'net_worth_history',
  'account_history',
  'estimate_flat',
  'transactions',
  'category_overrides',
  'merchant_renames',
  'investment_transactions',
  'investment_history_coverage',
  'account_links',
  'budgets',
  'group_budgets',
  'goals',
  'api_tokens',
  'sharing',
] as const;
export type CorePart = (typeof CORE_PARTS)[number];

/** Never brought back (docs/data-export.md, "Bringing it back"): a token is
 *  made again by the person, sharing is between two people. Read only to
 *  count them. */
export const NEVER_CORE: ReadonlySet<string> = new Set(['api_tokens', 'sharing']);

/** What a restore does with a store on the seam:
 *    write   written as the file has it (ids of the bank's rows re-keyed)
 *    never   left out: about connections that aren't here
 *    earlier the record of a restore of the copy the download came from:
 *            kept inside this restore's record, never written as one */
export type SeamRestore = 'write' | 'never' | 'earlier';

export type SeamPart = {
  kind: 'value' | 'map';
  restore: SeamRestore;
  /** An entry's field that can make it too large for one batch, sent in
   *  pieces: a list (`rows`, `records`) appended in order, or a map (`days`)
   *  merged by key. */
  split?: { field: string; as: 'list' | 'map' };
  /** Entries the store keeps at most, checked before each write. */
  max?: number;
};

/** Every store on the seam declared exportable, by name: what the download
 *  has under that name. (budget-set and sharing-access-log are exported
 *  inside core parts, budgets and sharing, so they are no parts of their
 *  own.) */
export const SEAM: Readonly<Record<string, SeamPart>> = {
  'account-lifecycle': { kind: 'map', restore: 'write' },
  'allocation-settings': { kind: 'value', restore: 'write' },
  'app-imports': { kind: 'map', restore: 'write' },
  'budget-months': { kind: 'value', restore: 'write' },
  'carried-annotations': { kind: 'map', restore: 'write' },
  'carried-imported-twins': { kind: 'map', restore: 'write' },
  categories: { kind: 'value', restore: 'write' },
  'connection-notices': { kind: 'map', restore: 'never' },
  'connection-syncs': { kind: 'map', restore: 'never' },
  'connection-warnings': { kind: 'map', restore: 'never' },
  // MAX_CONNECTOR_ACCOUNTS and MAX_CONNECTIONS (lib/connectors/manage.ts).
  'connector-accounts': { kind: 'map', restore: 'write', max: 100 },
  'connector-connections': { kind: 'map', restore: 'write', max: 2 },
  'connector-ended': { kind: 'map', restore: 'write' },
  'currency-settings': { kind: 'value', restore: 'write' },
  'fire-plan': { kind: 'value', restore: 'write' },
  // MAX_GOALS (lib/goal-model.ts).
  'goal-plans': { kind: 'map', restore: 'write', max: 20 },
  'history-imports': { kind: 'map', restore: 'write', split: { field: 'records', as: 'list' } },
  'holdings:history': { kind: 'map', restore: 'write', split: { field: 'days', as: 'map' } },
  'import-settings': { kind: 'map', restore: 'write' },
  'imported-transactions': { kind: 'map', restore: 'write', split: { field: 'rows', as: 'list' } },
  'imported-twins': { kind: 'map', restore: 'write' },
  imports: { kind: 'map', restore: 'write', split: { field: 'records', as: 'list' } },
  'income-carryover': { kind: 'value', restore: 'write' },
  'manual-transactions': { kind: 'map', restore: 'write', split: { field: 'rows', as: 'list' } },
  'planned-items': { kind: 'value', restore: 'write' },
  'report-settings': { kind: 'value', restore: 'write' },
  'restored-accounts': { kind: 'map', restore: 'write' },
  'restored-investment-transactions': { kind: 'map', restore: 'write', split: { field: 'rows', as: 'list' } },
  'restored-transactions': { kind: 'map', restore: 'write', split: { field: 'rows', as: 'list' } },
  'review-settings': { kind: 'value', restore: 'write' },
  rules: { kind: 'value', restore: 'write' },
  tags: { kind: 'value', restore: 'write' },
  // MAX_NOTES (lib/timeline-notes.ts).
  'timeline-notes': { kind: 'map', restore: 'write', max: 500 },
  // MAX_ANNOTATIONS, MAX_APPROVALS, MAX_GROUPS, MAX_SPLITS.
  'transaction-annotations': { kind: 'map', restore: 'write', max: 20_000 },
  'transaction-approvals': { kind: 'map', restore: 'write', max: 50_000 },
  'transaction-groups': { kind: 'map', restore: 'write', max: 2_000 },
  'transaction-splits': { kind: 'map', restore: 'write', max: 5_000 },
  'user-restore': { kind: 'value', restore: 'earlier' },
  'vendor-defaults': { kind: 'value', restore: 'write' },
  'weekly-summary': { kind: 'value', restore: 'write' },
};

/** Manual accounts a restore writes at most: the Add form's limit
 *  (MAX_MANUAL_ACCOUNTS, lib/manual.ts) and every account a connector can
 *  feed (MAX_CONNECTOR_ACCOUNTS), which a disconnect may keep as manual
 *  accounts beside them. A file with more couldn't have come from Nya. */
export const MAX_RESTORED_MANUAL_ACCOUNTS = 50 + 100;

/** Whether a top-level key is a part this release knows. */
export const isKnownPart = (key: string): boolean =>
  (HEADER_PARTS as readonly string[]).includes(key) || (CORE_PARTS as readonly string[]).includes(key) || Object.hasOwn(SEAM, key);
