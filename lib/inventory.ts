// lib/inventory.ts
//
// What Nya keeps about a person, kind by kind, in plain words: the registry
// behind Your data (app/your-data, lib/inventory-read.ts), the honest data map
// the privacy page points to. One entry for every key family the code stores
// the old way (lib/key-families.ts) and every store declared on the storage
// seam (lib/stores.ts), the same lists the download (lib/user-export.ts) and
// the key inventory (classify() in lib/reencrypt.ts) walk, so a store added
// later is listed by being declared. test/inventory.test.ts fails while any
// family or store has no entry here, or an entry names one that is gone.
//
// Each entry says, for the person:
//   - what it is, and what one stored entry of it is (a day, an account);
//   - how long it is kept: the row of the privacy page's retention table it
//     is kept by (RETENTION_ROWS, which the same test holds to the page);
//   - who else can see it, beyond whoever runs this copy of Nya and the
//     services that hold everything (the database and the host), which the
//     page says once for all of it;
//   - the plain text it carries, said as plain text: key and field names that
//     are dates or ids, and the stores that hold no ciphertext at all.
// What is encrypted, and whether it is in the download, are not written here:
// they follow from how each family is stored (lib/key-families.ts, or the
// store's own kind) and from the download's own lists (STORED_KEYS, and each
// store's `exportable`), so the page can't say something the code doesn't do.
// `download` is only for a store the download covers some other way (API
// tokens: their names and dates, never the hashes).
//
// Most of it is in the person's own container. A few kinds are kept for the
// whole environment and only partly about them (OUTSIDE): their account's
// record, which sign-in is theirs, their sharing connections, unused invite
// links, their data key; and what is about nobody by name (failed sign-ins by
// address, the backups' last outcome, the ECB's public rates).
//
// Nothing here reads storage. Words only, in the docs' plain voice.

import { EXACT, PREFIXES, listedKind, type Kind } from './key-families';
import { declaredPublicStore, declaredPublicStores, declaredStore, declaredStores } from './stores';
import { RUNS_KEEP_DAYS } from './snapshot-job';

/** The rows of the privacy page's "How long things are kept" table that the
 *  entries are kept by, by their first column, exactly as the page writes
 *  them (app/privacy/page.tsx; test/inventory.test.ts checks each is there). */
export const RETENTION_ROWS = [
  'Your data',
  'How each bank connection is doing',
  'A bank you disconnect',
  'A download you brought back',
  'Receipts and documents you attach',
  'A SimpleFIN connection',
  'A Lunch Flow connection',
  'Nightly backups',
  'A deleted account',
  'A record that a deleted account existed',
  'Invite links',
  'Records of when shared accounts were shown',
  'Copies of what the dashboard shows',
  'API tokens',
  'Requests counted for each API token',
  'Changes made with API tokens',
  'The weekly summary',
  'Your home currency and your own exchange rates',
  'Weekly summaries you asked for now, and uses of a link to turn one off',
  'Reads of what is shared with you, and of what someone sees of yours',
  'Failed password attempts, counted by IP address',
  'Requests with API tokens, or links to turn off a weekly summary, that didn’t work, counted by IP address',
  'The app’s own records about your data',
  'Counts that limit how often you can do something',
] as const;
export type RetentionRow = (typeof RETENTION_ROWS)[number];

/** The headings the entries are listed under, in order. */
export const GROUPS = [
  ['accounts', 'Banks and accounts'],
  ['history', 'Balances and history'],
  ['transactions', 'Transactions, and what you said about them'],
  ['imports', 'Imports and restores'],
  ['plans', 'Budgets, goals and plans'],
  ['settings', 'Categories, rules and settings'],
  ['sharing', 'Sharing'],
  ['access', 'Sign-in, keys and access'],
  ['machinery', 'The app’s own records'],
] as const;
export type Group = (typeof GROUPS)[number][0];

/** Who else can see a kind, beyond whoever runs this copy of Nya, the
 *  database and the host, which the page says once for everything: whoever
 *  is shown something read from it, or worked out from it (a setting that
 *  decides what a share shows is seen, in that share). Plaid and the
 *  connectors are written by hand, as where a kind came from; the other three
 *  are held to the code by test/inventory-seers.test.ts, which stores
 *  something of every kind (test/seers-fixture.ts) and then records every
 *  family each of them is answered from. */
export type Seer = 'plaid' | 'connector' | 'shared' | 'api' | 'email';
export const SEERS: Readonly<Record<Seer, string>> = {
  plaid: 'Plaid, where it came from',
  connector: 'SimpleFIN or Lunch Flow, where it came from',
  shared: 'People you share with, in what you choose to share with them',
  api: 'Programs you give an API token to, in what the API and the MCP server answer',
  email: 'The email service, in the emails Nya sends you',
};

export type Entry = {
  group: Group;
  /** What it is, as a heading. */
  name: string;
  /** A sentence more, where the name needs it. */
  about?: string;
  /** What one stored entry of it is, singular and plural. */
  unit: readonly [string, string];
  /** The retention row (or rows) it is kept by. */
  kept: RetentionRow | readonly RetentionRow[];
  seen?: readonly Seer[];
  /** The plain text it carries, beside its encrypted values. */
  plain?: string;
  /** What the download does with it, only where its own lists don't say
   *  (see the header). */
  download?: string;
};

/** A kind kept for the whole environment, outside the person's container. */
export type Outside = Entry & {
  /** About them (their part of it is counted for them where that is cheap),
   *  or about nobody by name. */
  about_you: boolean;
  /** Only with Clerk accounts: with the shared password there are no people. */
  clerk?: boolean;
  /** What it keeps is a key locked by the master key, beside plain text. */
  wrapped?: true;
};

// Units, shared by many entries.
const DAY = ['day', 'days'] as const;
const VALUE = ['value', 'values'] as const;
const ACCOUNT = ['account', 'accounts'] as const;
const CONNECTION = ['bank connection', 'bank connections'] as const;
const ENTRY = ['entry', 'entries'] as const;
const IMPORT = ['import', 'imports'] as const;
const COUNT = ['count', 'counts'] as const;
const RECORD = ['record', 'records'] as const;
const LOCK = ['lock', 'locks'] as const;

// Plain text, said the same way each time.
const DAYS_PLAIN = 'The days with a balance, as field names.';
const ACCOUNT_IDS = 'Account ids, as field names.';
const TXN_IDS = 'Transaction ids, as field names.';
const ITEM_IDS = 'Plaid’s id for each bank connection, as field names.';
const ITEM_IN_NAME = 'Plaid’s id for each bank connection, in the name each one is stored under.';
const RANDOM_IDS = 'Random ids, as field names.';
const ALL_PLAIN = 'All of it, as plain text: it holds no amounts or names.';
const COUNT_PLAIN = 'The count, as plain text: nothing else.';

const BOTH_CONNECTORS: readonly RetentionRow[] = ['A SimpleFIN connection', 'A Lunch Flow connection'];

/** The key families stored the old way that live in a container. */
const FAMILIES: Readonly<Record<string, Entry>> = {
  // ---- EXACT ----
  goals: {
    group: 'plans',
    name: 'Your savings goals',
    about: 'Each goal’s name, target and account.',
    unit: VALUE,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
  },
  budgets: {
    group: 'plans',
    name: 'Your budgets by category name',
    about: 'The form earlier versions of Nya read, kept beside your budgets on categories and groups.',
    unit: VALUE,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
  },
  'history:accounts:est:flat': {
    group: 'history',
    name: 'Balances an estimate held flat, from before they were kept by day',
    unit: VALUE,
    kept: 'Your data',
    seen: ['shared', 'api'],
  },
  'history:net-worth': {
    group: 'history',
    name: 'Your net worth, one total for each day Nya recorded it',
    unit: DAY,
    kept: 'Your data',
    seen: ['shared', 'api'],
    plain: DAYS_PLAIN,
  },
  'history:net-worth:est': {
    group: 'history',
    name: 'Your estimated net worth, before Nya recorded it',
    about: 'Worked out from your transactions, and marked as estimated wherever it shows.',
    unit: DAY,
    kept: 'Your data',
    seen: ['shared', 'api'],
    plain: DAYS_PLAIN,
  },
  'history:accounts': {
    group: 'history',
    name: 'Each account’s balance on each recorded day',
    unit: DAY,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: DAYS_PLAIN,
  },
  'history:accounts:est': {
    group: 'history',
    name: 'Each account’s estimated balance, on the estimated days',
    unit: DAY,
    kept: 'Your data',
    seen: ['shared', 'api'],
    plain: DAYS_PLAIN,
  },
  'history:accounts:est:ext': {
    group: 'history',
    name: 'Investment accounts’ estimated balances, further back than the estimated totals',
    unit: DAY,
    kept: 'Your data',
    seen: ['shared', 'api'],
    plain: DAYS_PLAIN,
  },
  'history:accounts:partial': {
    group: 'history',
    name: 'Accounts’ balances recorded on a day no total was',
    unit: DAY,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: DAYS_PLAIN,
  },
  'history:accounts:est:flatd': {
    group: 'history',
    name: 'Balances an estimate held flat, by day',
    about: 'Part of the estimated totals, not an account’s own history.',
    unit: DAY,
    kept: 'Your data',
    seen: ['shared', 'api'],
    plain: DAYS_PLAIN,
  },
  'accounts:vanished': {
    group: 'machinery',
    name: 'Accounts that went missing from a bank’s answer',
    about: 'Held while the daily snapshot waits to be sure an account is gone.',
    unit: ACCOUNT,
    kept: 'The app’s own records about your data',
    plain: ACCOUNT_IDS,
  },
  'accounts:meta': {
    group: 'accounts',
    name: 'The accounts each bank last reported',
    about: 'Their names, types, masks and currencies, so a bank that can’t be reached still shows its last balances.',
    unit: CONNECTION,
    kept: 'Your data',
    seen: ['plaid', 'shared', 'api', 'email'],
    plain: ITEM_IDS,
  },
  'accounts:directory': {
    group: 'accounts',
    name: 'Every account Nya has known',
    about: 'Its name and bank, kept after you disconnect the bank, so its history still has a name.',
    unit: ACCOUNT,
    kept: 'A bank you disconnect',
    seen: ['plaid', 'shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'account-links': {
    group: 'accounts',
    name: 'Links between an earlier account and the same one after you reconnected',
    unit: ['link', 'links'],
    kept: 'A bank you disconnect',
    seen: ['shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'txn-category-overrides': {
    group: 'transactions',
    name: 'The categories you set on transactions',
    unit: ['transaction', 'transactions'],
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: TXN_IDS,
  },
  'txn-category-carry': {
    group: 'transactions',
    name: 'Categories you set on a disconnected bank’s transactions',
    about: 'Each with its date, amount and bank description, so the category carries across a reconnection.',
    unit: ACCOUNT,
    kept: 'A bank you disconnect',
    seen: ['shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'account-links:lock': {
    group: 'machinery',
    name: 'A lock while links between accounts change',
    unit: LOCK,
    kept: 'The app’s own records about your data',
    plain: ALL_PLAIN,
  },
  'txn-vendor-renames': {
    group: 'transactions',
    name: 'Merchant names you renamed',
    about: 'The new name you gave each one is encrypted.',
    unit: ['merchant', 'merchants'],
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: 'Each merchant’s name as the bank sent it, as field names.',
  },
  'manual:accounts': {
    group: 'accounts',
    name: 'Your manual accounts',
    about: 'Each one’s name, type, currency and balance.',
    unit: ACCOUNT,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'hidden:accounts': {
    group: 'accounts',
    name: 'Accounts you hid',
    unit: ACCOUNT,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'plaid:items': {
    group: 'accounts',
    name: 'Your bank connections through Plaid',
    about: 'Each bank’s name, Plaid’s ids for it, whether Plaid included transactions when it was linked, and the token that reaches it, which is encrypted and never in your download.',
    unit: CONNECTION,
    kept: 'Your data',
    seen: ['plaid', 'shared', 'api', 'email'],
    plain: 'Each bank’s name, Plaid’s ids, and whether Plaid included transactions: all but the token.',
  },
  'history:backfill-done': {
    group: 'machinery',
    name: 'Which version of the estimated history was last built',
    unit: VALUE,
    kept: 'The app’s own records about your data',
    plain: ALL_PLAIN,
  },
  'history:backfill-pending': {
    group: 'machinery',
    name: 'How many times building the estimated history was tried again',
    unit: VALUE,
    kept: 'The app’s own records about your data',
    plain: ALL_PLAIN,
  },
  'account-links:dismissed': {
    group: 'accounts',
    name: 'Suggested links between accounts that you declined',
    unit: ['suggestion', 'suggestions'],
    kept: 'Your data',
    plain: 'All of it, as plain text: which accounts, and when.',
  },
  'plaid:new-accounts': {
    group: 'machinery',
    name: 'When Plaid said a bank has accounts you haven’t added',
    unit: CONNECTION,
    kept: 'The app’s own records about your data',
    seen: ['plaid'],
    plain: 'All of it, as plain text: which connection, and when.',
  },

  // ---- PREFIXES ----
  'txns:': {
    group: 'transactions',
    name: 'Transactions from your banks through Plaid',
    about: 'One compressed record for each bank connection, with the details of its accounts that came with them.',
    unit: CONNECTION,
    kept: 'Your data',
    seen: ['plaid', 'shared', 'api', 'email'],
    plain: ITEM_IN_NAME,
  },
  'invtxns:': {
    group: 'transactions',
    name: 'Investment transactions from your brokerages through Plaid',
    unit: CONNECTION,
    kept: 'Your data',
    seen: ['plaid'],
    plain: ITEM_IN_NAME,
  },
  'txns-blocked:': {
    group: 'machinery',
    name: 'A note that a bank’s transactions grew too large to save',
    unit: CONNECTION,
    kept: 'The app’s own records about your data',
    plain: 'All of it, as plain text: which connection, and the size.',
  },
  'invtxns-lock:': {
    group: 'machinery',
    name: 'A lock while a brokerage’s transactions are saved',
    unit: LOCK,
    kept: 'The app’s own records about your data',
    plain: ALL_PLAIN,
  },
  'txns-unsaved:': {
    group: 'machinery',
    name: 'A note that a bank’s last save of transactions failed',
    unit: CONNECTION,
    kept: 'The app’s own records about your data',
    plain: ALL_PLAIN,
  },
  'history:forgetting:': {
    group: 'machinery',
    name: 'How far forgetting an account has got',
    unit: RECORD,
    kept: 'The app’s own records about your data',
    plain: ALL_PLAIN,
  },
  'sign-repairs': {
    group: 'machinery',
    name: 'An account’s past balances being turned over',
    about: 'While an account’s kind changes between money held and money owed, which days of its balance history are turned over so each goes on counting as it was recorded, with the account’s balance on each of those days (encrypted, as everything here is), the days left as they were, with why, and how many nights in a row the daily update got nowhere with it. Once that is done, a short record of when it began and finished, for a last look at those days and the day before each; gone after it.',
    unit: ACCOUNT,
    kept: 'The app’s own records about your data',
    plain: 'Each account’s id, as a field name.',
  },
  'restored-sign-repairs': {
    group: 'machinery',
    name: 'Accounts a download was turning over',
    about: 'For each account a download you brought back was turning over to match its kind as it was made: whether its repair here was planned, needed nothing, or waits for whoever runs your Nya, with the first days nothing could tell.',
    unit: ACCOUNT,
    kept: 'The app’s own records about your data',
    plain: 'Each account’s id, as a field name.',
  },
  'sessions:': {
    group: 'access',
    name: 'Your sign-out-everywhere count',
    about: 'Raised each time you sign out everywhere, which ends every session made before it.',
    unit: VALUE,
    kept: 'The app’s own records about your data',
    plain: COUNT_PLAIN,
  },
  'move:': {
    group: 'machinery',
    name: 'The record of a one-time move of your data into an account of its own',
    unit: RECORD,
    kept: 'The app’s own records about your data',
    plain: ALL_PLAIN,
  },
  'snapshot:': {
    group: 'machinery',
    name: 'The daily snapshot’s records',
    about: `How each day’s snapshot went (kept ${RUNS_KEEP_DAYS} days), when each day’s balances were taken, its checks on your bank connections, and its lock.`,
    unit: RECORD,
    kept: 'The app’s own records about your data',
    seen: ['shared', 'api', 'email'],
    plain: 'All of it, as plain text: days, times, outcomes and Plaid’s ids for your connections.',
  },
  'cache:': {
    group: 'machinery',
    name: 'Short-lived copies of what the dashboard shows',
    unit: ['copy', 'copies'],
    kept: 'Copies of what the dashboard shows',
  },
};

/** The stores declared on the storage seam. */
const STORES: Readonly<Record<string, Entry>> = {
  'account-lifecycle': {
    group: 'accounts',
    name: 'Accounts you said ended',
    about: 'Closed, no longer yours or not followed, with the day and any note.',
    unit: ACCOUNT,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'allocation-settings': {
    group: 'plans',
    name: 'Your allocation settings',
    about: 'The tax buckets, splits and target you set under Allocation on the Plan tab.',
    unit: VALUE,
    kept: 'Your data',
    seen: ['shared'],
  },
  'api-requests': {
    group: 'access',
    name: 'Requests counted for each API token',
    unit: ['token', 'tokens'],
    kept: 'Requests counted for each API token',
    plain: 'Each token’s id and its count, as plain text.',
  },
  'api-changes': {
    group: 'access',
    name: 'Changes made with your API tokens',
    about:
      'Each change a token made through the API or an AI assistant, and each undo of one: when, which token, and what it changed, as it was before and after, so a transaction it deleted is kept with it. Forget one under API tokens to drop those copies.',
    unit: ['change', 'changes'],
    kept: 'Changes made with API tokens',
    seen: ['api'],
    plain: 'The day each change was made and a reference to the token that made it (worked out from its id, never the id itself), as field names.',
  },
  'api-change-keys': {
    group: 'access',
    name: 'Keys your tokens sent with what they made',
    about: 'A fingerprint of each key a program sent so that making something twice makes it once, with which change it was for and whether that made it, so a key sent again never makes again what you deleted.',
    unit: ['token', 'tokens'],
    kept: 'Requests counted for each API token',
    plain: 'Each token’s id, as a field name.',
  },
  'api-write-requests': {
    group: 'access',
    name: 'Changes counted for each API token, by the minute',
    about: 'How many changes a token that can make them has sent in the current minute, for its limit.',
    unit: ['token', 'tokens'],
    kept: 'Requests counted for each API token',
    plain: 'Each token’s id and its count, as plain text.',
  },
  'api-write-days': {
    group: 'access',
    name: 'Changes counted for each API token, by the day',
    about: 'How many changes each token that can make them has made in the current day, and how many all of them have, for their limits; and for each manual account whose balance a token set, that it did today, so the estimated history is rebuilt at most once a day for it, and that a later push skipped the rebuild, so the nightly update has it rebuilt.',
    unit: COUNT,
    kept: 'Requests counted for each API token',
    plain: 'Each token’s id, and each such manual account’s, with its counts, as plain text.',
  },
  'api-tokens': {
    group: 'access',
    name: 'Your API tokens',
    about: 'Each one’s name, the sign-in that made it, when it was made and last used, and a hash of its secret. The token itself is never stored.',
    unit: ['token', 'tokens'],
    kept: 'API tokens',
    plain: 'Each token’s id, as a field name: part of the token, and not enough to use it.',
    download: 'In your download, under api_tokens: each token’s name and dates, never the hash.',
  },
  'app-imports': {
    group: 'imports',
    name: 'What you brought over from other apps',
    unit: IMPORT,
    kept: 'Your data',
    plain: RANDOM_IDS,
  },
  'attachment-places': {
    group: 'transactions',
    name: 'Which transactions have a receipt or document',
    about: 'An index kept beside your receipts and documents, so a transaction shows that it has one without each file being read.',
    unit: ['transaction', 'transactions'],
    kept: 'The app’s own records about your data',
    plain: 'Transaction ids, and the ids of disconnected accounts, as field names: they say which of your transactions have something attached.',
  },
  'attachment-requests': {
    group: 'machinery',
    name: 'Receipts and documents sent and opened this hour',
    unit: COUNT,
    kept: 'Counts that limit how often you can do something',
    plain: COUNT_PLAIN,
  },
  'attachment-sweep': {
    group: 'machinery',
    name: 'The nightly clean-up’s record of your receipts and documents',
    about: 'Which stored files no record named, and since when, so none is deleted while a backup could still name it; and whether their places need checking.',
    unit: VALUE,
    kept: 'The app’s own records about your data',
  },
  'attachment-usage': {
    group: 'machinery',
    name: 'How much your receipts and documents take',
    about: 'The space and the number of files your receipts and documents use, the uploads in progress, and when you last downloaded them.',
    unit: VALUE,
    kept: 'The app’s own records about your data',
  },
  attachments: {
    group: 'transactions',
    name: 'Receipts and documents attached to transactions',
    about:
      'Each file’s type, size, the name your device gave it, when you added it, which transaction it is on and what that transaction said then, and the key that opens it. The files themselves are kept apart, in the private file store, encrypted with that key. Never shown to anyone you share with, to programs with an API token, or in an email.',
    unit: ['file', 'files'],
    kept: 'Receipts and documents you attach',
    plain: 'Each file’s random id, as a field name. In the file store, beside each encrypted file: its size, when it was uploaded, and your account’s random id and the file’s in its name.',
    download: 'In your download, under attachments: the list of them, never their keys. The files themselves are a download of their own, Receipts and documents (ZIP).',
  },
  'budget-months': {
    group: 'plans',
    name: 'Your budgets by month, and what rolls over',
    unit: VALUE,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
  },
  'budget-set': {
    group: 'plans',
    name: 'Your budgets on categories and groups',
    unit: VALUE,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
  },
  'carried-annotations': {
    group: 'transactions',
    name: 'Notes, tags and exclusions on a disconnected bank’s transactions',
    about: 'Kept so that linking the account again says them again.',
    unit: ACCOUNT,
    kept: 'A bank you disconnect',
    seen: ['shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'carried-imported-twins': {
    group: 'transactions',
    name: 'Which bank transactions stood for rows you imported, at a disconnected bank',
    unit: ACCOUNT,
    kept: 'A bank you disconnect',
    plain: ACCOUNT_IDS,
  },
  categories: {
    group: 'settings',
    name: 'Your categories and groups',
    unit: VALUE,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
  },
  'connection-notices': {
    group: 'accounts',
    name: 'Problems with a bank connection, and the emails about them',
    unit: CONNECTION,
    kept: 'How each bank connection is doing',
    seen: ['shared', 'api', 'email'],
    plain: ITEM_IDS,
  },
  'connection-syncs': {
    group: 'accounts',
    name: 'When each bank connection last answered',
    unit: CONNECTION,
    kept: 'How each bank connection is doing',
    seen: ['shared', 'api', 'email'],
    plain: ITEM_IDS,
  },
  'connection-warnings': {
    group: 'accounts',
    name: 'Plaid’s warnings that a connection is going to end',
    unit: CONNECTION,
    kept: 'How each bank connection is doing',
    seen: ['plaid', 'shared', 'api', 'email'],
    plain: ITEM_IDS,
  },
  'connector-accounts': {
    group: 'accounts',
    name: 'Accounts SimpleFIN or Lunch Flow keeps up to date',
    about: 'What each one is, its currency, and its balance as last reported.',
    unit: ACCOUNT,
    kept: BOTH_CONNECTORS,
    seen: ['connector', 'shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'connector-claims': {
    group: 'machinery',
    name: 'Connections to SimpleFIN or Lunch Flow tried this hour',
    unit: COUNT,
    kept: 'Counts that limit how often you can do something',
    plain: COUNT_PLAIN,
  },
  'connector-connections': {
    group: 'accounts',
    name: 'Your connections to SimpleFIN or Lunch Flow',
    about: 'Which one, the host it reaches, how its last request went, and the names of the accounts it offers that you don’t track.',
    unit: ['connection', 'connections'],
    kept: BOTH_CONNECTORS,
    seen: ['connector', 'shared', 'api', 'email'],
    plain: RANDOM_IDS,
  },
  'connector-ended': {
    group: 'accounts',
    name: 'Accounts you stopped tracking through SimpleFIN or Lunch Flow',
    unit: ACCOUNT,
    kept: BOTH_CONNECTORS,
    seen: ['shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'connector-requests': {
    group: 'machinery',
    name: 'Requests to SimpleFIN or Lunch Flow today',
    unit: COUNT,
    kept: 'Counts that limit how often you can do something',
    plain: COUNT_PLAIN,
  },
  'connector-secrets': {
    group: 'access',
    name: 'The access SimpleFIN or Lunch Flow gave Nya',
    about: 'A credential: never in your download, nor in backups.',
    unit: ['connection', 'connections'],
    kept: BOTH_CONNECTORS,
    plain: RANDOM_IDS,
    download: 'Not in your download: a credential, not your data.',
  },
  'currency-settings': {
    group: 'settings',
    name: 'Your home currency and your own exchange rates',
    about: 'People you share with see the currency what you share is in, converted at the European Central Bank’s rates alone: a share never uses your own rates, and never shows a rate.',
    unit: VALUE,
    kept: 'Your home currency and your own exchange rates',
    seen: ['shared', 'api', 'email'],
  },
  'download-count': {
    group: 'machinery',
    name: 'Downloads of your data this hour',
    unit: COUNT,
    kept: 'Counts that limit how often you can do something',
    plain: COUNT_PLAIN,
  },
  'fire-plan': {
    group: 'plans',
    name: 'Your plan’s assumptions',
    about: 'What the Plan tab’s FI figures and its test of a retirement use.',
    unit: VALUE,
    kept: 'Your data',
  },
  'fire-plan-currency': {
    group: 'plans',
    name: 'The currency your plan’s figures are in',
    about: 'The currency you typed your plan’s amounts in, with those amounts as the save that recorded it left them, so a plan changed since is told apart.',
    unit: VALUE,
    kept: 'Your data',
  },
  'goal-plans': {
    group: 'plans',
    name: 'How each goal is funded, and when it is due',
    about: 'Its allocation, monthly target, target date and whether it is archived.',
    unit: ['goal', 'goals'],
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: 'Goal ids, as field names.',
  },
  'history-import-summaries': {
    group: 'machinery',
    name: 'Summaries of imports into linked accounts',
    about: 'Each import’s entry without its records, which the imports themselves hold.',
    unit: IMPORT,
    kept: 'The app’s own records about your data',
    seen: ['shared', 'api', 'email'],
    plain: RANDOM_IDS,
  },
  'history-imports': {
    group: 'imports',
    name: 'Files you imported into a linked account',
    unit: IMPORT,
    kept: 'Your data',
    plain: RANDOM_IDS,
  },
  'holdings:history': {
    group: 'history',
    name: 'Your holdings on each recorded day',
    about: 'What each investment account held: each position’s quantity, price and value, a month to an entry.',
    unit: ['month', 'months'],
    kept: 'Your data',
    seen: ['shared', 'api'],
    plain: RANDOM_IDS,
  },
  'holdings:history:index': {
    group: 'machinery',
    name: 'Where each month of holdings is kept',
    about: 'Which id each month is under, and the first and last day each account was recorded.',
    unit: ENTRY,
    kept: 'The app’s own records about your data',
    seen: ['shared', 'api'],
  },
  'import-reads': {
    group: 'machinery',
    name: 'Reads of the list of imports this hour',
    unit: COUNT,
    kept: 'Counts that limit how often you can do something',
    plain: COUNT_PLAIN,
  },
  'import-requests': {
    group: 'machinery',
    name: 'File imports and previews this hour',
    unit: COUNT,
    kept: 'Counts that limit how often you can do something',
    plain: COUNT_PLAIN,
  },
  'inventory-reads': {
    group: 'machinery',
    name: 'Looks at Your data this hour',
    unit: COUNT,
    kept: 'Counts that limit how often you can do something',
    plain: COUNT_PLAIN,
  },
  'import-settings': {
    group: 'imports',
    name: 'How the last file imported into each account was read',
    unit: ACCOUNT,
    kept: 'Your data',
    plain: ACCOUNT_IDS,
  },
  'import-summaries': {
    group: 'machinery',
    name: 'Summaries of file imports',
    about: 'Each import’s entry without its records, which the imports themselves hold.',
    unit: IMPORT,
    kept: 'The app’s own records about your data',
    plain: RANDOM_IDS,
  },
  'imported-history-walk': {
    group: 'machinery',
    name: 'What the history worked out from imported transactions covers',
    unit: ENTRY,
    kept: 'The app’s own records about your data',
    seen: ['shared', 'api'],
  },
  'imported-transactions': {
    group: 'transactions',
    name: 'Transactions imported into linked accounts',
    unit: ACCOUNT,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'imported-twins': {
    group: 'transactions',
    name: 'Which bank transactions stand for rows you imported',
    unit: CONNECTION,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: ITEM_IDS,
  },
  imports: {
    group: 'imports',
    name: 'Files you imported into manual accounts',
    about: 'Each import’s records, so it can be undone.',
    unit: IMPORT,
    kept: 'Your data',
    plain: RANDOM_IDS,
  },
  'income-carryover': {
    group: 'plans',
    name: 'Your income carryover setting',
    unit: VALUE,
    kept: 'Your data',
    seen: ['api', 'email'],
  },
  'manual-transactions': {
    group: 'transactions',
    name: 'Transactions on manual accounts, and those SimpleFIN or Lunch Flow brings',
    unit: ACCOUNT,
    kept: 'Your data',
    seen: ['connector', 'shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'plan-scenarios': {
    group: 'plans',
    name: 'Your saved plan scenarios',
    about: 'The name, the changes from your plan and the life events of each scenario you saved on the Plan tab, and the currency its amounts are in, never a figure.',
    unit: ['scenario', 'scenarios'],
    kept: 'Your data',
    plain: RANDOM_IDS,
  },
  'planned-items': {
    group: 'plans',
    name: 'Your planned bills and income',
    unit: VALUE,
    kept: 'Your data',
    seen: ['api', 'email'],
  },
  'report-settings': {
    group: 'settings',
    name: 'Your report settings',
    unit: VALUE,
    kept: 'Your data',
  },
  'restored-accounts': {
    group: 'imports',
    name: 'Accounts brought back from a download',
    unit: ACCOUNT,
    kept: 'A download you brought back',
    seen: ['shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'restored-answers': {
    group: 'imports',
    name: 'Your answers about accounts brought back from a download',
    about: 'Whether to count a bank’s transactions as an ended account’s, which connections it isn’t at, and which account carries it on.',
    unit: ENTRY,
    kept: 'A download you brought back',
    seen: ['shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'restored-investment-transactions': {
    group: 'imports',
    name: 'Investment transactions brought back from a download',
    unit: ENTRY,
    kept: 'A download you brought back',
    plain: ITEM_IDS,
  },
  'restored-transactions': {
    group: 'imports',
    name: 'Transactions brought back from a download',
    unit: ENTRY,
    kept: 'A download you brought back',
    seen: ['shared', 'api', 'email'],
    plain: ACCOUNT_IDS,
  },
  'review-settings': {
    group: 'settings',
    name: 'Your review queue settings',
    unit: VALUE,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
  },
  'runway-scenarios': {
    group: 'plans',
    name: 'Your saved runway scenarios',
    about: 'The name and settings of each what-if you saved on the runway report, never a figure.',
    unit: ['scenario', 'scenarios'],
    kept: 'Your data',
    plain: RANDOM_IDS,
  },
  rules: {
    group: 'settings',
    name: 'Your rules',
    unit: VALUE,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
  },
  'sharing-access-log': {
    group: 'sharing',
    name: 'Records of when what you share was shown',
    about: 'Each time someone you share with was shown it. They see the same record.',
    unit: ['connection', 'connections'],
    kept: 'Records of when shared accounts were shown',
    seen: ['shared'],
    plain: 'A random id for each connection, as field names.',
  },
  'sharing-reads': {
    group: 'machinery',
    name: 'Reads of what is shared with you, and of what someone sees of yours',
    unit: COUNT,
    kept: 'Reads of what is shared with you, and of what someone sees of yours',
    plain: COUNT_PLAIN,
  },
  tags: {
    group: 'settings',
    name: 'Your tags',
    unit: VALUE,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
  },
  'timeline-notes': {
    group: 'history',
    name: 'Notes on your timeline',
    unit: ['note', 'notes'],
    kept: 'Your data',
    plain: 'Random ids, and the ids of the accounts a note is about, as field names.',
  },
  'transaction-annotations': {
    group: 'transactions',
    name: 'Notes, tags and exclusions on transactions',
    unit: ['transaction', 'transactions'],
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: TXN_IDS,
  },
  'transaction-approvals': {
    group: 'transactions',
    name: 'Transactions you approved in the review queue',
    unit: ['transaction', 'transactions'],
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: TXN_IDS,
  },
  'transaction-groups': {
    group: 'transactions',
    name: 'Transactions you grouped',
    unit: ['group', 'groups'],
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: RANDOM_IDS,
  },
  'transaction-splits': {
    group: 'transactions',
    name: 'Transactions you split',
    unit: ['transaction', 'transactions'],
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
    plain: TXN_IDS,
  },
  'user-restore': {
    group: 'imports',
    name: 'The record of bringing back a download',
    about: 'When the file was made, its size and how much came back; never the file.',
    unit: VALUE,
    kept: 'A download you brought back',
  },
  'user-restore-batches': {
    group: 'machinery',
    name: 'Batches of a restore this hour',
    unit: COUNT,
    kept: 'Counts that limit how often you can do something',
    plain: COUNT_PLAIN,
  },
  'user-restore-previews': {
    group: 'machinery',
    name: 'Looks at whether your account is empty this hour',
    unit: COUNT,
    kept: 'Counts that limit how often you can do something',
    plain: COUNT_PLAIN,
  },
  'user-restore-starts': {
    group: 'machinery',
    name: 'Restores, undos and emptyings today',
    unit: COUNT,
    kept: 'Counts that limit how often you can do something',
    plain: COUNT_PLAIN,
  },
  'vendor-defaults': {
    group: 'settings',
    name: 'Your merchants’ default categories',
    unit: VALUE,
    kept: 'Your data',
    seen: ['shared', 'api', 'email'],
  },
  'weekly-summary': {
    group: 'settings',
    name: 'Your weekly summary setting',
    about: 'Whether it is on, its day and your time zone.',
    unit: VALUE,
    kept: 'The weekly summary',
    seen: ['shared'],
  },
  'weekly-summary-sends': {
    group: 'machinery',
    name: 'Weekly summaries you asked for today',
    unit: COUNT,
    kept: 'Weekly summaries you asked for now, and uses of a link to turn one off',
    plain: COUNT_PLAIN,
  },
  'weekly-summary-state': {
    group: 'machinery',
    name: 'The weekly summary’s own records',
    about: 'The key its links to turn it off are signed with, the last week one went for, and the goals the last one found at their target.',
    unit: VALUE,
    kept: 'The weekly summary',
    download: 'Not in your download: it holds the key the summary’s links are signed with.',
  },
  'weekly-summary-unsubscribes': {
    group: 'machinery',
    name: 'Uses of a link to turn the weekly summary off, this hour',
    unit: COUNT,
    kept: 'Weekly summaries you asked for now, and uses of a link to turn one off',
    plain: COUNT_PLAIN,
  },
};

/** What is kept for the whole environment, outside every container: the key
 *  families lib/containers.ts lists as environment-wide, and the public
 *  stores (lib/repo.ts definePublicMapStore). */
const OUTSIDE: Readonly<Record<string, Outside>> = {
  containers: {
    group: 'access',
    name: 'Your account’s record',
    about: 'When it was made, whether it is active, and whether it is the first on this copy of Nya, under your account’s random id.',
    unit: VALUE,
    kept: 'A deleted account',
    plain: 'All of it, as plain text.',
    download: 'Not in your download: your account’s id is the app’s machinery.',
    about_you: true,
  },
  owners: {
    group: 'access',
    name: 'Which sign-in your data belongs to',
    about: 'Your sign-in account’s id beside your account’s random id: how Nya finds your data when you sign in.',
    unit: VALUE,
    kept: 'A deleted account',
    plain: 'All of it, as plain text.',
    download: 'Not in your download: your sign-in is kept by Clerk, the sign-in service.',
    about_you: true,
    clerk: true,
  },
  connections: {
    group: 'sharing',
    name: 'Your sharing connections',
    about: 'Who you are connected with, by sign-in id, what each of you calls the other and introduced yourselves as, and what each of you shares, at which level and until when.',
    unit: ['connection', 'connections'],
    kept: 'Your data',
    seen: ['shared'],
    plain: 'All of it, as plain text, apart from the records of when what is shared was shown.',
    download: 'In your download, under sharing: your side of each connection.',
    about_you: true,
    clerk: true,
  },
  'invites:': {
    group: 'sharing',
    name: 'Invite links you made that nobody has used',
    about: 'Your sign-in id and the name you gave, under a hash of the link.',
    unit: ['link', 'links'],
    kept: 'Invite links',
    plain: 'All of it, as plain text.',
    download: 'Not in your download: they are gone within 72 hours.',
    about_you: true,
    clerk: true,
  },
  'crypto:': {
    group: 'access',
    name: 'Your data key',
    about: 'The key your account’s encrypted values are under, kept locked by the master key, which is never in the database.',
    unit: ['key', 'keys'],
    kept: ['A deleted account', 'A record that a deleted account existed'],
    plain: 'Its id, when it was made and when your data was moved to it, beside your account’s random id. The key itself is locked.',
    download: 'Not in your download: a key, not your data.',
    about_you: true,
    wrapped: true,
  },
  grants: {
    group: 'sharing',
    name: 'Shares from sharing’s first version',
    about: 'No longer read or written by Nya.',
    unit: ['share', 'shares'],
    kept: 'A deleted account',
    plain: 'All of it, as plain text.',
    download: 'Not in your download: this version no longer reads them.',
    about_you: true,
    clerk: true,
  },
  'ratelimit:': {
    group: 'access',
    name: 'Failed sign-ins, and tokens or links that didn’t work, counted by the IP address they came from',
    unit: COUNT,
    kept: ['Failed password attempts, counted by IP address', 'Requests with API tokens, or links to turn off a weekly summary, that didn’t work, counted by IP address'],
    plain: 'The IP address and its count, as plain text.',
    download: 'Not in your download: kept by address, not under your account.',
    about_you: false,
  },
  'backups:': {
    group: 'machinery',
    name: 'How the nightly backup last went',
    unit: RECORD,
    kept: 'Nightly backups',
    plain: ALL_PLAIN,
    download: 'Not in your download: about this copy of Nya, not about you.',
    about_you: false,
  },
  'fx:ecb': {
    group: 'settings',
    name: 'The European Central Bank’s exchange rates',
    about: 'Public, the same for everyone, and kept once for every account.',
    unit: DAY,
    kept: 'Your home currency and your own exchange rates',
    plain: 'All of it, as plain text: public rates, not about anyone.',
    download: 'Not in your download: public, and on the ECB’s own site.',
    about_you: false,
  },
};

/** The key families stored the old way, exact names and prefixes alike. */
export function families(): string[] {
  return [...Object.keys(EXACT), ...PREFIXES.map(([p]) => p)];
}

/** The entry for a kind kept for the whole environment (a family
 *  lib/containers.ts lists as environment-wide, or a public store), never in
 *  a container. */
export function outsideEntry(name: string): Outside | null {
  return Object.hasOwn(OUTSIDE, name) ? OUTSIDE[name] : null;
}

/** The entry for a key family or a declared store kept in a container. */
export function containerEntry(name: string): Entry | null {
  if (Object.hasOwn(FAMILIES, name)) return FAMILIES[name];
  if (Object.hasOwn(STORES, name)) return STORES[name];
  return null;
}

/** Every entry outside the container, in the registry's order. */
export function outsideEntries(): [string, Outside][] {
  return Object.entries(OUTSIDE);
}

/** How a family or store's values are stored: its kind on the lists, or its
 *  declaration's (lib/reencrypt.ts SEAM_KINDS, as classify() maps them). */
export function kindOf(name: string): Kind | null {
  const listed = listedKind(name);
  if (listed) return listed;
  const store = declaredStore(name);
  if (!store) return declaredPublicStore(name) ? 'plain' : null;
  return store.kind === 'value' ? 'string' : store.kind === 'map' ? 'hash' : 'plain';
}

/** Families and stores with no entry, and entries naming neither: what the
 *  test checks is empty both ways. */
export function registryGaps(): { missing: string[]; stale: string[] } {
  const known = new Set([...families(), ...declaredStores().map((s) => s.name), ...declaredPublicStores().map((s) => s.name)]);
  const listed = [...Object.keys(FAMILIES), ...Object.keys(STORES), ...Object.keys(OUTSIDE)];
  const missing = [...known].filter((name) => containerEntry(name) === null && outsideEntry(name) === null);
  const stale = listed.filter((name) => !known.has(name));
  // Once each: a name with two entries would say two things.
  const twice = listed.filter((name, i) => listed.indexOf(name) !== i);
  return { missing: missing.sort(), stale: [...stale, ...twice].sort() };
}

/** The retention rows an entry is kept by, as a list. */
export const keptRows = (e: Entry): readonly RetentionRow[] => (typeof e.kept === 'string' ? [e.kept] : e.kept);
