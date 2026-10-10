// lib/user-export.ts
//
// Download my data: everything Nya stores about one person, decrypted at the
// boundary and handed over in open formats (#43). The route is
// app/api/my-data; the format is documented, field by field, in
// docs/data-export.md.
//
// NOT THE OPERATOR EXPORT. lib/export.ts copies a whole environment as
// ciphertext, for restoring it; this decrypts one person's data, for them to
// keep or take elsewhere. #55 keeps the two apart: an export that did both
// would be too decrypted to be safe or too complete to be portable.
//
// THE RULES:
//
// 1. NOTHING MISSING WITHOUT A WORD. Every store is read before the first byte
//    is sent, never a file with a gap in it that looks complete: a partial
//    download presented as whole is a lie about what Nya holds. Two kinds of
//    failure, kept apart as the storage seam keeps them (lib/repo.ts, READS):
//      - one that says nothing about the data (storage out of reach, a key
//        this deployment can't load, a failed decrypt under k0) fails the
//        download with the store's name (ExportReadError), as ever;
//      - an entry that is damaged, or saved in a form this version doesn't
//        know, never does. Everything else is in the file, and `problems`
//        names what is missing, by part and id, a note says it in words, and
//        the route's headers say the file is incomplete. One damaged record
//        would otherwise stop the download for good, with nothing in the app
//        to clear it (stores on the seam, balance history, manual accounts,
//        budgets and goals), or nothing the person could do about it at all
//        (the other person's record of showings to me, in sharing, which
//        marks each where it belongs).
//    Nothing is removed here: what can't be read stays stored exactly as it
//    was, and only reported. Budgets and goals, one value each that no other
//    part is read against, are null and named, as a value store on the seam
//    is. The older stores the rest of the file is read against are still
//    read whole, since an entry of theirs left out would read as something
//    else elsewhere in the file: institutions and accounts (an account's
//    balances and transactions with no account to belong to), transactions
//    and investment transactions (the categories, names and exclusions set
//    on a row pointing at nothing), categories and merchant names (a
//    transaction shown without the one set on it), links (one account read
//    as two) and hidden accounts (a hidden account shown as not hidden). One
//    of theirs that can't be read still stops the download, naming the
//    store. Two older readers still pass over what they can't parse without
//    a word, as the app does, and docs/data-export.md says so: sharing's (a
//    connection or a share whose record doesn't parse, an account at a level
//    this version doesn't know) and the remembered accounts' (a record in
//    the old shape, an account without an id or a type).
// 2. ONLY THIS PERSON'S. Everything is read through their container's Ctx,
//    and sharing as their own side of each connection (lib/sharing.ts
//    mySharing): never another person's data. The one thing read from
//    someone else's container is their record of showings to this person:
//    about them, and the same record both see.
// 3. NO CREDENTIALS, NO MACHINERY. Plaid access tokens are left out: they are
//    credentials, not data. So are internal ids, caches, locks, cursors,
//    counters and the records of scheduled jobs: they are about running the
//    app, not about the person. The file says what it leaves out
//    (notIncluded).
// 4. AS STORED, AND MARKED. Every history point says whether it was recorded
//    or estimated. The person's own edits (a category, a merchant's name) sit
//    beside what the bank sent, never over it.
// 5. NEVER WRITTEN DOWN. The file is built in memory and streamed to the
//    browser. Nothing here writes it to storage, a log or a blob.
//
// The version (EXPORT_VERSION) goes up when a field is removed or changes
// meaning; a field added leaves it alone.

import type { Ctx } from './containers';
import { getItems } from './storage';
import { rememberedAccountsByItem, type RememberedAccount } from './last-known';
import {
  readDirectoryStrict,
  readDismissedStrict,
  liveAccountIds,
  expandHidden,
  getLinks,
  effectiveLinks,
  resolveId,
  PROVIDER,
  type DirectoryEntry,
  type Link,
} from './links';
import { getManualAccountsReport, isManualId, ManualAccountsUnavailableError, type ManualAccount } from './manual';
import { getHiddenAccounts, type HiddenAccount, type HiddenMap } from './hidden';
import {
  readStoredItem,
  storeIsBehind,
  supersededPendingIds,
  vendorKey,
  contentKey,
  type StoredAccount,
  type StoredTxn,
} from './transactions';
import { readInvStore, type InvStoreState } from './invstore';
import { readOverridesStrict, readCarriedStrict, carriedCategories, type Carried } from './overrides';
import { readRenamesStrict } from './renames';
import { readHistoryForExport, type StoredPoint } from './history';
import { getBudgetsReport } from './budgets';
import { getGoalsReport } from './goals';
import { mySharing } from './sharing';
import { accessLogStore, type Showing } from './access-log';
import { apiTokenStore } from './api-token-store';
import { declaredStores, declaredStore } from './stores';
import type { MapStore, ValueStore } from './repo';
import { csvRow, UTF8_BOM, type CsvValue } from './csv';
import { manualTxnStore, isManualTxnBook, type ManualTxn } from './manual-txns';

export const EXPORT_FORMAT = 'nya-export';
/** 2 since a part that can't be read is named under `problems` instead of
 *  stopping the download (rule 1): a part can be short, and budgets, goals
 *  and a value store's field null, for a reason only `problems` tells apart,
 *  where version 1 was whole or not made at all (docs/data-export.md). */
export const EXPORT_VERSION = 2;
export const EXPORT_DOCUMENTATION = 'https://github.com/FueRobertHer/Nya/blob/main/docs/data-export.md';

export const EXPORT_FORMATS = ['json', 'transactions-csv', 'balances-csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Who the download is for. `userId` is the signed-in Clerk account, or null
 *  with the shared password, which has no people (so no sharing). */
export type ExportSource = { ctx: Ctx; userId: string | null };

/**
 * A store that could not be read for a reason that says nothing about its
 * data (storage, keys), or an older store read whole with an entry it can't
 * read (rule 1): the download stops before anything is sent. `what` names it
 * for the person, and the message is theirs to read: it holds nothing stored
 * but, at most, an institution's name, which is theirs. `store` is the kind
 * of store alone ("transactions"), for the server's log, which must not say
 * which bank someone uses.
 */
export class ExportReadError extends Error {
  constructor(
    readonly what: string,
    cause: unknown,
    readonly store: string = what
  ) {
    super(
      `Your ${what} could not be read, so nothing was downloaded: a file without them would look complete and not be. Nothing was changed. Try again later; if it keeps happening, whoever runs this Nya needs to look at it.`,
      { cause }
    );
    this.name = 'ExportReadError';
  }
}

/**
 * Every key a container holds (an exact name, or a prefix ending in ":"), and
 * what the download does with it: where it goes, or why it is left out.
 * test/user-export.test.ts checks every key the code builds inside a
 * container is listed here, so a new store can't be missing from the download
 * without someone having decided it should be. docs/data-export.md carries
 * the same list for people. A store declared through the storage seam is not
 * listed: its declaration says whether it is exported (declaredSections).
 */
export const STORED_KEYS: readonly (readonly [key: string, where: string])[] = [
  ['plaid:items', 'institutions (the access token in each record is left out)'],
  ['accounts:meta', 'accounts'],
  ['accounts:directory', 'accounts'],
  ['manual:accounts', 'manual_accounts'],
  ['hidden:accounts', 'hidden_accounts, and accounts[].hidden'],
  ['history:net-worth', 'net_worth_history (recorded)'],
  ['history:net-worth:est', 'net_worth_history (estimated)'],
  ['history:accounts', 'account_history (recorded)'],
  ['history:accounts:partial', 'account_history (recorded on a day no total was)'],
  ['history:accounts:est', 'account_history (estimated)'],
  ['history:accounts:est:ext', 'account_history (estimated)'],
  ['history:accounts:est:flatd', 'left out: balances an estimate held flat, part of the estimated totals, not an account history'],
  ['history:accounts:est:flat', 'left out: the same, from before they were kept per day'],
  ['txns:', 'transactions'],
  ['invtxns:', 'investment_transactions, investment_history_coverage'],
  ['txn-category-overrides', 'category_overrides, and transactions[].your_category'],
  ['txn-vendor-renames', 'merchant_renames, and transactions[].your_merchant_name'],
  ['txn-category-carry', 'account_links.carried_categories, and transactions[].your_category_from_earlier_account'],
  ['account-links', 'account_links.links'],
  ['account-links:dismissed', 'account_links.declined_suggestions'],
  ['budgets', 'budgets'],
  ['goals', 'goals'],
  ['txns-blocked:', 'notes: a transaction store too large to save'],
  ['txns-unsaved:', 'notes: a transaction store whose last save failed'],
  ['cache:', 'left out: copies of other data, kept for minutes or hours'],
  ['accounts:vanished', 'left out: when an account went missing from a bank’s answer, held while the snapshot waits to be sure'],
  ['plaid:new-accounts', 'left out: a prompt to add accounts Plaid found'],
  ['history:backfill-done', 'left out: which version of the estimate was last built'],
  ['history:backfill-pending', 'left out: a retry count for the estimate'],
  ['history:forgetting:', 'left out: the progress of forgetting an account'],
  ['invtxns-lock:', 'left out: a lock'],
  ['account-links:lock', 'left out: a lock'],
  ['sessions:', 'left out: the sign-out-everywhere counter'],
  ['snapshot:', 'left out: the scheduled snapshot’s log, lock and timings, and its checks on connections'],
  ['move:', 'left out: the record of a one-time data move'],
];

/** Whether STORED_KEYS says what happens to a key. */
export function storedKeyListed(key: string): boolean {
  return STORED_KEYS.some(([k]) => key === k || (k.endsWith(':') && key.startsWith(k)));
}

// ---- What a part of the file is missing ----

/** Why something stored is not in the file (docs/data-export.md, "problems"):
 *  `unreadable`, its stored bytes are damaged; `unrecognised`, intact as far
 *  as this version can tell, but saved in a form it doesn't know (a later
 *  version's, say), and kept as it is. Sharing has two more of its own
 *  (lib/share-rules.ts RecordProblem): `unavailable` and
 *  `record_id_unreadable`. */
export type ProblemKind = 'unreadable' | 'unrecognised' | 'unavailable' | 'record_id_unreadable';

/** One part of the file, missing what it says, for one reason. */
export type ExportProblem = {
  /** The part: its key in the JSON file. */
  section: string;
  problem: ProblemKind;
  /** What is missing, by the id it is stored under, in id order: an entry's
   *  id for a store on the seam, a UTC day for the balance histories, an
   *  account's id for manual accounts. Absent for a part that is one value
   *  (then null in the file), for sharing, which names no ids and marks each
   *  record it can't give where it belongs, and for api_tokens, whose ids are
   *  part of each token, so never in the file (`count` instead). */
  ids?: string[];
  /** How many are missing, for a part that can't name them (api_tokens). */
  count?: number;
};

/** A list of ids that can't be used, by why, as problems of one part. */
function idProblems(section: string, named: { unreadable: string[]; unrecognised: string[] }): ExportProblem[] {
  return [
    ...(named.unreadable.length > 0 ? [{ section, problem: 'unreadable' as const, ids: named.unreadable }] : []),
    ...(named.unrecognised.length > 0 ? [{ section, problem: 'unrecognised' as const, ids: named.unrecognised }] : []),
  ];
}

/** The same, counted, for a part whose ids must not be in the file. */
function countedProblems(section: string, named: { unreadable: string[]; unrecognised: string[] }): ExportProblem[] {
  return idProblems(section, named).map(({ ids, ...p }) => ({ ...p, count: ids?.length ?? 0 }));
}

// ---- Stores with nothing to say about the others ----

/** A part of the file as read: what goes under its key, and what it is
 *  missing (ExportProblem), for `problems`. */
export type SectionRead = { value: unknown; problems: ExportProblem[] };

/**
 * A store that stands alone: one small function from the person to what goes
 * in the file under its key, already in the shape it is exported in. A new
 * store of that kind adds an entry here and a section to docs/data-export.md.
 * Its reader throws on anything that says nothing about the data, like every
 * reader here, and either throws on an entry it can't read (an older store,
 * read whole) or names it among its problems (rule 1).
 *
 * These are the stores that predate the storage seam (lib/repo.ts). A store
 * built on the seam needs no entry: declared exportable, it is a section of
 * its own (declaredSections, below), unless an entry here exports it already
 * (covers). Stores that the core sections below cross-reference (accounts,
 * history, transactions) stay in collectUserData.
 */
export type ExportSection = {
  /** Its key in the JSON file. */
  key: string;
  /** What it is, for "Your ___ could not be read". */
  what: string;
  read: (src: ExportSource) => Promise<SectionRead>;
  /** The account ids what it read names, so that `accounts` lists each one
   *  (a goal can still point at an account since forgotten). */
  mentions?: (value: unknown) => Iterable<unknown>;
  /** Stores on the seam whose contents this section exports itself, so they
   *  get no section of their own: "sharing" puts each record of showings
   *  beside the connection it belongs to, where a person can read it. */
  covers?: readonly string[];
};

/** An entry of SECTIONS, typed by what it reads: `problems` says what the
 *  value it read is missing, for one that marks that inside itself. */
function section<T>(s: {
  key: string;
  what: string;
  read: (src: ExportSource) => Promise<T>;
  problems?: (value: T) => ExportProblem[];
  mentions?: (value: T) => Iterable<unknown>;
  covers?: readonly string[];
}): ExportSection {
  return {
    key: s.key,
    what: s.what,
    read: async (src) => {
      const value = await s.read(src);
      return { value, problems: s.problems?.(value) ?? [] };
    },
    ...(s.mentions ? { mentions: s.mentions as (value: unknown) => Iterable<unknown> } : {}),
    ...(s.covers ? { covers: s.covers } : {}),
  };
}

/** One value's problem, if it has one, for a part that is null without it. */
const valueProblems = (section: string, problem: ProblemKind | null): ExportProblem[] => (problem ? [{ section, problem }] : []);

export const SECTIONS: readonly ExportSection[] = [
  // Budgets and goals are one value each, which no other part of the file is
  // read against: saved but unusable, each is null and named among the
  // problems (rule 1), as a value store on the seam is. A goal names an
  // account, which `accounts` lists; with the goals null, nothing names it.
  {
    key: 'budgets',
    what: 'budgets',
    // Monthly, per spending category.
    read: async ({ ctx }) => {
      const { budgets, problem } = await getBudgetsReport(ctx);
      return {
        value:
          budgets &&
          Object.entries(budgets)
            .map(([category, monthly_amount]) => ({ category, monthly_amount }))
            .sort((a, b) => a.category.localeCompare(b.category)),
        problems: valueProblems('budgets', problem),
      };
    },
  },
  {
    key: 'goals',
    what: 'goals',
    read: async ({ ctx }) => {
      const { goals, problem } = await getGoalsReport(ctx);
      return {
        value: goals && goals.map((g) => ({ id: g.id, name: g.name, target: g.target, account_id: g.account_id ?? null })),
        problems: valueProblems('goals', problem),
      };
    },
    mentions: (goals) => ((goals as { account_id: string | null }[] | null) ?? []).map((g) => g.account_id),
  },
  {
    key: 'api_tokens',
    what: 'API tokens',
    // Each token's name and dates: what the person called it, and when it was
    // made and last read their data. Never its secret, which Nya doesn't keep,
    // nor the hash it keeps of it (a credential, so the store itself is not
    // exportable), nor its id, which is part of the token. Read with the
    // seam's report, as every store on it is: a token whose record can't be
    // used is counted among the problems, never named by its id, and never a
    // reason to stop (rule 1).
    read: async ({ ctx }) => {
      const report = await apiTokenStore.getAllReport(ctx);
      return {
        value: [...report.entries.values()]
          .map((t) => ({ label: t.label, created_at: t.created_at, last_used_at: t.last_used_at }))
          .sort((a, b) => byCodePoint(a.created_at, b.created_at) || byCodePoint(a.label, b.label)),
        problems: countedProblems('api_tokens', report),
      };
    },
  },
  section({
    key: 'sharing',
    what: 'sharing settings',
    // With the shared password there is nobody to share with: null, unless
    // records of showings are still stored here.
    read: async ({ ctx, userId }) => mySharing(userId, ctx),
    // A record it can't give is marked where it belongs (the connection's
    // `shown_to_them_problem` and `shown_to_me_problem`, or `problem` in
    // `unmatched`), and named once for each reason here, so the file's
    // problems and its headers say sharing is incomplete too.
    problems: (sharing) => {
      const kinds = new Set<ProblemKind>();
      for (const c of sharing?.connections ?? []) {
        if (c.shown_to_them_problem) kinds.add(c.shown_to_them_problem);
        if (c.shown_to_me_problem) kinds.add(c.shown_to_me_problem);
      }
      for (const e of sharing?.unmatched ?? []) if (e.shown_to_them === null) kinds.add(e.problem);
      return [...kinds].sort().map((problem) => ({ section: 'sharing', problem }));
    },
    // My own accounts: what I share, and what my records say was shown of
    // them. Not shown_to_me: those are theirs.
    mentions: (sharing) => [
      ...(sharing?.connections.flatMap((c) => [...c.shared.map((s) => s.account_id), ...readIds(c.shown_to_them)]) ?? []),
      ...(sharing?.unmatched.flatMap((e) => readIds(e.shown_to_them)) ?? []),
    ],
    covers: [accessLogStore.name],
  }),
];

/** The account ids a record of showings names. */
const readIds = (shown: Showing[] | null) => (shown ?? []).flatMap((s) => Object.keys(s.read));

/**
 * The sections the storage seam's catalogue adds (lib/stores.ts): one for each
 * store declared with exportable: true, under its own name, after SECTIONS, in
 * name order, except a store an entry of SECTIONS exports itself (covers). A
 * value store's section is its value (null if never saved, or if it can't be
 * used); a map store's is its entries as { id, value }, in id order, each one
 * that can be used. Read with the seam's reports (getReport, getAllReport):
 * an entry that is damaged or not recognised is named among the problems,
 * never a reason to stop (rule 1), and a deployment problem stops the download
 * as every reader's does. Declaring a store exportable is the whole decision:
 * nothing else has to remember to add it.
 */
export function declaredSections(): ExportSection[] {
  const covered = new Set(SECTIONS.flatMap((s) => s.covers ?? []));
  return declaredStores().flatMap((store): ExportSection[] =>
    store.exportable && store.kind !== 'counter' && store.kind !== 'counter-map' && !covered.has(store.name)
      ? [{ key: store.name, what: store.what, read: ({ ctx }) => readDeclared(store, ctx) }]
      : []
  );
}

async function readDeclared(store: ValueStore<unknown> | MapStore<unknown>, ctx: Ctx): Promise<SectionRead> {
  if (store.kind === 'value') {
    const report = await store.getReport(ctx);
    const problem = report.unreadable ? 'unreadable' : report.unrecognised ? 'unrecognised' : null;
    return { value: report.value, problems: problem ? [{ section: store.name, problem }] : [] };
  }
  const report = await store.getAllReport(ctx);
  return { value: [...report.entries].map(([id, value]) => ({ id, value })), problems: idProblems(store.name, report) };
}

/** SECTIONS, then the seam's. */
const allSections = (): ExportSection[] => [...SECTIONS, ...declaredSections()];

// ---- Reading ----

export type DeclinedOffer = { earlier_account_id: string; account_id: string | null; declined_at: string };

/** Everything read for one download, each store strictly. */
export type UserData = {
  /** The signed-in account's own download (Clerk), or the shared password's. */
  people: boolean;
  items: { item_id: string; institution_name: string; institution_id: string | null }[];
  remembered: Record<string, RememberedAccount[]>;
  directory: Map<string, DirectoryEntry>;
  manual: ManualAccount[];
  hidden: HiddenMap;
  stores: { item_id: string; accounts: Record<string, StoredAccount>; txns: Record<string, StoredTxn>; behind: boolean }[];
  investments: { item_id: string; state: InvStoreState }[];
  overrides: Map<string, string>;
  renames: Map<string, string>;
  links: Map<string, Link>;
  /** The account ids live now, which pause a link whose old id came back. */
  live: Set<string>;
  declined: DeclinedOffer[];
  carried: Carried;
  history: { totals: StoredPoint[]; accounts: Map<string, StoredPoint[]> };
  /** SECTIONS and the seam's (declaredSections), read, in order. */
  sections: (readonly [string, unknown])[];
  /** What was stored but couldn't be read into the file (rule 1), in the
   *  file's order: the manual accounts, the balance histories, then the
   *  sections'. */
  problems: ExportProblem[];
};

/** The ids of what a part of the file is missing, whatever the reason. */
export function missingIds(problems: readonly ExportProblem[], section: string): string[] {
  return problems.flatMap((p) => (p.section === section ? (p.ids ?? []) : []));
}

/** A linked institution's record, without its access token: that never
 *  leaves the record (notIncluded). */
async function readItems(ctx: Ctx): Promise<UserData['items']> {
  return (await getItems(ctx)).map((item) => {
    if (!item || typeof item.item_id !== 'string' || typeof item.institution_name !== 'string') {
      throw new Error('A linked institution’s record has an unexpected shape');
    }
    return {
      item_id: item.item_id,
      institution_name: item.institution_name,
      institution_id: typeof item.institution_id === 'string' ? item.institution_id : null,
    };
  });
}

/** Declined link offers ("<old>><new>", or "<old>>*" for "None of these"). */
async function readDeclined(ctx: Ctx): Promise<DeclinedOffer[]> {
  return [...(await readDismissedStrict(ctx))].map(([key, at]) => {
    const i = key.indexOf('>');
    if (i <= 0) throw new Error('A declined link offer has an unexpected shape');
    const to = key.slice(i + 1);
    return { earlier_account_id: key.slice(0, i), account_id: to === '*' ? null : to, declined_at: at };
  });
}

/**
 * Reads everything one person has, every store at once. Throws ExportReadError
 * naming the first store that couldn't be read for a reason that says nothing
 * about its data, or an older store read whole that holds an entry it can't
 * read; nothing is returned in part. Every other entry that can't be read is
 * named in `problems` (rule 1).
 */
export async function collectUserData(src: ExportSource): Promise<UserData> {
  const { ctx } = src;
  const read = <T>(what: string, fn: () => Promise<T>, store: string = what): Promise<T> =>
    fn().catch((err: unknown) => {
      throw err instanceof ExportReadError ? err : new ExportReadError(what, err, store);
    });

  const items = await read('linked institutions', () => readItems(ctx));
  const [remembered, directory, manual, hidden, stores, investments, overrides, renames, links, live, declined, carried, history, sections] =
    await Promise.all([
      read('accounts', () => rememberedAccountsByItem(ctx)),
      read('accounts', () => readDirectoryStrict(ctx)),
      read('manual accounts', async () => {
        const report = await getManualAccountsReport(ctx);
        // Sealed under a key this deployment can't use: its problem, never
        // the accounts', so it stops the download as storage out of reach
        // does, and is never named in a file as missing data.
        if (report.unavailable.length > 0) throw new ManualAccountsUnavailableError(report.unavailable);
        return report;
      }),
      read('hidden accounts', () => getHiddenAccounts(ctx)),
      Promise.all(
        items.map((item) =>
          read(
            `transactions from ${item.institution_name}`,
            async () => {
              const [stored, behind] = await Promise.all([readStoredItem(ctx, item.item_id), storeIsBehind(ctx, item.item_id)]);
              return { item_id: item.item_id, ...stored, behind };
            },
            'transactions'
          )
        )
      ),
      Promise.all(
        items.map((item) =>
          read(
            `investment transactions from ${item.institution_name}`,
            async () => ({ item_id: item.item_id, state: await readInvStore(ctx, item.item_id) }),
            'investment transactions'
          )
        )
      ),
      read('categories', () => readOverridesStrict(ctx)),
      read('merchant names', () => readRenamesStrict(ctx)),
      read('account links', () => getLinks(ctx)),
      read('account links', () => liveAccountIds(ctx, { strict: true, readOnly: true })),
      read('account links', () => readDeclined(ctx)),
      read('categories', () => readCarriedStrict(ctx)),
      read('balance history', () => readHistoryForExport(ctx)),
      Promise.all(allSections().map(async (s) => [s.key, await read(s.what, () => s.read(src))] as const)),
    ]);
  return {
    people: src.userId !== null,
    items,
    remembered,
    directory,
    manual: manual.accounts,
    hidden,
    stores,
    investments,
    overrides,
    renames,
    links,
    live,
    declined,
    carried,
    history: { totals: history.totals, accounts: history.accounts },
    sections: sections.map(([key, r]) => [key, r.value] as const),
    problems: [
      ...idProblems('manual_accounts', manual),
      ...idProblems('net_worth_history', history.problems.totals),
      ...idProblems('account_history', history.problems.accounts),
      ...sections.flatMap(([, r]) => r.problems),
    ],
  };
}

// ---- The document ----

export type Kind = 'recorded' | 'estimated';

export type ExportInstitution = { item_id: string; institution_name: string; institution_id: string | null; provider: 'plaid' };

export type ExportAccount = {
  account_id: string;
  /** "plaid"; "manual" for a manual account since removed, known now only
   *  by what still names it; null when nothing stored says. */
  provider: string | null;
  item_id: string | null;
  institution_name: string | null;
  institution_id: string | null;
  connected: boolean;
  name: string | null;
  official_name: string | null;
  type: string | null;
  subtype: string | null;
  mask: string | null;
  currency: string | null;
  credit_limit: number | null;
  persistent_account_id: string | null;
  first_seen: string | null;
  last_seen: string | null;
  hidden: boolean;
  hidden_at: string | null;
  latest_balance: { balance: number; date: string } | null;
};

export type ExportManualAccount = {
  account_id: string;
  name: string;
  institution_name: string;
  type: string;
  subtype: string | null;
  balance: number;
  updated_at: string | null;
  hidden: boolean;
  hidden_at: string | null;
};

export type ExportTransaction = StoredTxn & {
  item_id: string;
  vendor_key: string;
  your_category: string | null;
  your_category_from_earlier_account: string | null;
  your_merchant_name: string | null;
  superseded_by_posted: boolean;
  account_hidden: boolean;
};

export type ExportInvestmentTransaction = Record<string, unknown> & {
  investment_transaction_id: string;
  account_id: string;
  date: string;
  item_id: string;
  security: InvStoreState['securities'][string] | null;
  seen_at: string;
  missing_since: string | null;
  excluded: boolean;
  cancelled: boolean;
};

export type UserExport = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exported_at: string;
  documentation: string;
  not_included: string[];
  /** Caveats about this download, in words: a store behind what the app
   *  showed, and a note for each part that is missing something (problems). */
  notes: string[];
  /** What is stored but couldn't be read into the file (rule 1): empty when
   *  the file has everything. */
  problems: ExportProblem[];
  institutions: ExportInstitution[];
  accounts: ExportAccount[];
  manual_accounts: ExportManualAccount[];
  hidden_accounts: { account_id: string; type: string; hidden_at: string | null }[];
  net_worth_history: { includes_hidden_accounts: true; points: { date: string; total: number; kind: Kind }[] };
  account_history: { account_id: string; points: { date: string; balance: number; kind: Kind }[] }[];
  transactions: ExportTransaction[];
  category_overrides: { transaction_id: string; category: string }[];
  merchant_renames: { vendor_key: string; name: string }[];
  investment_transactions: ExportInvestmentTransaction[];
  investment_history_coverage: { item_id: string; account_id: string; from: string; through: string }[];
  account_links: {
    links: { earlier_account_id: string; account_id: string; linked_at: string; evidence: Record<string, unknown> }[];
    declined_suggestions: DeclinedOffer[];
    carried_categories: { earlier_account_id: string; rows: { date: string; amount: number | null; description: string; category: string | null }[] }[];
  };
  /** SECTIONS, by key. */
  [section: string]: unknown;
};

/** What the file leaves out, in plain words: the file says so itself. */
export function notIncluded(people: boolean): string[] {
  return [
    'Bank access tokens: the credentials Nya uses to reach your banks through Plaid. They are credentials, not your data, and they work only for Nya, so they are left out.',
    'Your API tokens themselves, and the hashes Nya keeps to check them: credentials, not your data. Each token’s name and when it was made and last used are in, under api_tokens.',
    people
      ? 'Your sign-in (email address, password, sign-in methods): kept by Clerk, the sign-in service, not by Nya. Your account window shows it.'
      : 'The app password: a credential, not your data.',
    'Internal ids and the machinery of the app: your storage container’s id, caches, locks, sync cursors, whether Plaid included transactions when each connection was linked, rate-limit counters, and the records of scheduled jobs (snapshots, backups, checks on connections and on accounts a bank stopped reporting). They are about running the app, not about you.',
    'The balances an estimate held flat: for an account the estimate could not walk back through its transactions, estimated net-worth totals use that account’s balance on the day the estimate was made. That copied balance is part of the estimated totals, and is not listed as the account’s own history.',
    'What other people share with you, what they call you and how they introduced themselves: that is their data. Their record of each time what they share was shown to you is in, under sharing: it is about you, and they see the same one.',
    'Unused invite links: they work for 72 hours and are then gone.',
    ...(people ? [] : ['Sharing: with one shared password there are no separate people to share with.']),
  ];
}

/** "1970-01-01T00:00:00.000Z" is what a reader fills in when a record has no
 *  time of its own (lib/hidden.ts, lib/manual.ts): not a time to pass off as
 *  one. */
const realTime = (iso: string | undefined | null): string | null => (iso && Date.parse(iso) > 0 ? iso : null);

const byText = (a: string | null, b: string | null) => (a ?? '￿').localeCompare(b ?? '￿');
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const kindOf = (p: StoredPoint): Kind => (p.estimated ? 'estimated' : 'recorded');

/** A carried row's content key (lib/transactions.ts contentKey) in parts:
 *  "<account>|<date>|<cents>|<descriptor>". Total: an unexpected key still
 *  gives every part it has. */
function carriedRow(key: string, account_id: string) {
  const rest = key.startsWith(`${account_id}|`) ? key.slice(account_id.length + 1) : key.split('|').slice(1).join('|');
  const [date = '', cents = '', ...description] = rest.split('|');
  const amount = cents === '' ? NaN : Number(cents) / 100;
  return { date, amount: Number.isFinite(amount) ? amount : null, description: description.join('|') };
}

/** Every account id the file mentions anywhere, so `accounts` can name each
 *  one (manual ones are in `manual_accounts`), the SECTIONS' included. */
function mentionedAccountIds(data: UserData): Set<string> {
  const ids = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === 'string' && id) ids.add(id);
  };
  for (const accounts of Object.values(data.remembered)) for (const a of accounts) add(a.account_id);
  for (const id of data.directory.keys()) add(id);
  for (const s of data.stores) {
    for (const id of Object.keys(s.accounts)) add(id);
    for (const t of Object.values(s.txns)) add(t.account_id);
  }
  for (const inv of data.investments) {
    for (const id of Object.keys(inv.state.accounts)) add(id);
    for (const row of Object.values(inv.state.txns)) add(row?.raw?.account_id);
  }
  for (const id of data.history.accounts.keys()) add(id);
  for (const id of data.hidden.keys()) add(id);
  for (const [old, l] of data.links) {
    add(old);
    add(l.to);
  }
  for (const d of data.declined) {
    add(d.earlier_account_id);
    add(d.account_id);
  }
  for (const id of data.carried.keys()) add(id);
  const read = new Map(data.sections);
  for (const s of SECTIONS) if (s.mentions && read.has(s.key)) for (const id of s.mentions(read.get(s.key))) add(id);
  return ids;
}

/**
 * How many accounts the person had, as they would count them, for the receipt
 * an account deletion ends with (lib/account-deletion.ts):
 *   - `accounts`: the accounts of the banks still connected, and the manual
 *     accounts, those that couldn't be read included (they are still stored,
 *     and deleted with the rest);
 *   - `earlier`: the accounts of banks they disconnected, kept for their
 *     history, apart from those.
 * An account linked across a reconnect (lib/links.ts) is one account, under
 * however many ids. An id known only from balance history, a link or a
 * declined offer is not an account of its own here: `accounts` in the
 * download lists those ids, which is a different question.
 */
export function countAccounts(data: UserData): { accounts: number; earlier: number } {
  const links = effectiveLinks(data.links, data.live);
  const connected = new Set(data.items.map((i) => i.item_id));
  const current = new Set<string>();
  const add = (into: Set<string>, id: string) => {
    if (!isManualId(id)) into.add(resolveId(id, links));
  };
  for (const [item_id, accounts] of Object.entries(data.remembered)) {
    if (connected.has(item_id)) for (const a of accounts) add(current, a.account_id);
  }
  // A connected bank's stores name its accounts too, including one it has
  // stopped reporting (a closed card with stored transactions).
  for (const s of data.stores) for (const id of Object.keys(s.accounts)) add(current, id);
  for (const inv of data.investments) for (const id of Object.keys(inv.state.accounts)) add(current, id);
  const earlier = new Set<string>();
  for (const [id, entry] of data.directory) {
    if (!connected.has(entry.item_id)) add(earlier, id);
  }
  for (const id of current) earlier.delete(id);
  return { accounts: current.size + data.manual.length + missingIds(data.problems, 'manual_accounts').length, earlier: earlier.size };
}

/** The newest recorded balance in a series (never an estimate), with its day. */
function latestRecorded(points: StoredPoint[] | undefined): { balance: number; date: string } | null {
  for (let i = (points?.length ?? 0) - 1; i >= 0; i--) {
    const p = points![i];
    if (!p.estimated) return { balance: p.value, date: p.date };
  }
  return null;
}

/** How a core part of the file that can be missing something says so in
 *  words: what it holds, what it counts, and the sentence. A store on the
 *  seam is named by its declaration (`what`) and counts entries. */
type PartWords = {
  noun: string;
  one: string;
  many: string;
  missing: (noun: string, counts: string) => string;
  /** Where the person finds what is missing: the JSON file, unless said. */
  listed?: string;
  /** The sentence in a CSV made from this part (CSV_SOURCES), where what the
   *  CSV lacks is not what the JSON file lacks: `counts` as for `missing`. */
  inCsv?: (counts: string) => string;
};
const missingFrom = (noun: string, counts: string) => `Not all of your ${noun} could be read, so this file is missing ${counts}.`;
const PART_WORDS: Record<string, PartWords> = {
  manual_accounts: {
    noun: 'manual accounts',
    one: 'account',
    many: 'accounts',
    missing: (noun, counts) => `${missingFrom(noun, counts)} Any balance history they have is still in account_history, under their ids.`,
    // A CSV's rows of such an account are all there, under its id: only its
    // name is missing from them.
    inCsv: (counts) => `Not all of your manual accounts could be read: ${counts}. Their rows in this file are under their account ids, with no account name.`,
  },
  // One entry per manual account: its book.
  'manual-transactions': {
    noun: 'manual transactions',
    one: 'account',
    many: 'accounts',
    missing: (noun, counts) => `Not all of your ${noun} could be read, so this file is missing the transactions of ${counts}.`,
  },
  net_worth_history: { noun: 'net worth history', one: 'day', many: 'days', missing: missingFrom },
  // Counted, never named: a token's id is part of the token.
  api_tokens: { noun: 'API tokens', one: 'token', many: 'tokens', missing: missingFrom, listed: 'The API tokens card lists them, and can remove a damaged one.' },
  account_history: {
    noun: 'account balance history',
    one: 'day',
    many: 'days',
    // A day's maps hold every account's balance, and another layer may still
    // have some of them that day.
    missing: (noun, counts) => `Not all of your ${noun} could be read, so this file may be missing balances on ${counts}.`,
  },
};

/**
 * One note in words for each part of the file that is missing something, in
 * the order the parts come: what it is missing, why, and that nothing was
 * changed. From the problems alone, so a file made from only some parts (a
 * CSV, exportFile) says the same of those, in its own words where what it
 * lacks differs (PartWords inCsv), and pointing to the JSON download for the
 * list.
 */
export function problemNotes(problems: readonly ExportProblem[], format: ExportFormat = 'json'): string[] {
  const unchanged = 'Nothing was changed: what could not be read is still stored as it was.';
  const csv = format !== 'json';
  return [...new Set(problems.map((p) => p.section))].map((section) => {
    const mine = problems.filter((p) => p.section === section);
    if (section === 'sharing') {
      return 'Some records of when shared accounts were shown could not be read or reached, so they are not in this file: each one is marked where it belongs, under sharing, with why.';
    }
    const words = PART_WORDS[section] ?? { noun: declaredStore(section)?.what ?? section, one: 'entry', many: 'entries', missing: missingFrom };
    const why = (p: ExportProblem) => (p.problem === 'unrecognised' ? 'saved in a form this version of Nya does not know' : 'whose stored data is damaged');
    if (mine.every((p) => p.ids === undefined && p.count === undefined)) {
      // A part that is one value, null in the file.
      return `Your ${words.noun} could not be read (${mine[0].problem === 'unrecognised' ? 'they were saved in a form this version of Nya does not know' : 'the stored data is damaged'}), so this file does not have them. ${unchanged}`;
    }
    const counts = mine
      .map((p) => {
        const n = p.ids?.length ?? p.count ?? 0;
        return `${n} ${n === 1 ? words.one : words.many} ${why(p)}`;
      })
      .join(' and ');
    const said = csv && words.inCsv ? words.inCsv(counts) : words.missing(words.noun, counts);
    const listed = csv ? 'The JSON download lists them under problems.' : (words.listed ?? 'The JSON file lists them under problems.');
    return `${said} ${listed} ${unchanged}`;
  });
}

/**
 * The document, from what was read. Pure. Every account any part of the file
 * mentions is in `accounts` (or `manual_accounts`); what is known about each
 * comes from the freshest record that has it: what the last good balance
 * fetch remembered, then the directory of every account ever seen, then the
 * transaction store, then the investment store.
 */
export function buildUserExport(data: UserData, now: Date): UserExport {
  const items = new Map(data.items.map((i) => [i.item_id, i]));
  // A manual account that couldn't be read is still one (problems names it):
  // never listed in `accounts` as one since removed.
  const unreadableManual = missingIds(data.problems, 'manual_accounts');
  const manualIds = new Set([...data.manual.map((m) => m.account_id), ...unreadableManual]);
  const effective = effectiveLinks(data.links, data.live);
  // Hiding one id of an account hides every id it has had, as the app reads it.
  const hidden = expandHidden(data.hidden, effective);

  const remembered = new Map<string, { item_id: string; a: RememberedAccount }>();
  for (const [item_id, accounts] of Object.entries(data.remembered)) for (const a of accounts) remembered.set(a.account_id, { item_id, a });
  const synced = new Map<string, { item_id: string; a: StoredAccount }>();
  const rowFacts = new Map<string, { item_id: string; account_name: string; institution_name: string }>();
  for (const s of data.stores) {
    for (const [id, a] of Object.entries(s.accounts)) synced.set(id, { item_id: s.item_id, a });
    for (const t of Object.values(s.txns)) {
      if (!rowFacts.has(t.account_id)) rowFacts.set(t.account_id, { item_id: s.item_id, account_name: t.account_name, institution_name: t.institution_name });
    }
  }
  const invested = new Map<string, { item_id: string; a: InvStoreState['accounts'][string] }>();
  for (const inv of data.investments) for (const [id, a] of Object.entries(inv.state.accounts)) invested.set(id, { item_id: inv.item_id, a });

  const accounts: ExportAccount[] = [...mentionedAccountIds(data)]
    .filter((id) => !manualIds.has(id))
    .map((id): ExportAccount => {
      const m = remembered.get(id);
      const d = data.directory.get(id);
      const s = synced.get(id);
      const v = invested.get(id);
      const r = rowFacts.get(id);
      const item_id = m?.item_id ?? d?.item_id ?? s?.item_id ?? r?.item_id ?? v?.item_id ?? null;
      const item = item_id ? items.get(item_id) : undefined;
      const h = hidden.get(id);
      return {
        account_id: id,
        // The directory records it (older entries without it are Plaid's), and
        // every other record here is Plaid's. A removed manual account's id
        // names its kind; an id nothing describes is unknown, not a guess.
        provider: isManualId(id) ? 'manual' : d ? (d.provider ?? PROVIDER) : m || s || v || r ? PROVIDER : null,
        item_id,
        institution_name: item?.institution_name ?? d?.institution_name ?? r?.institution_name ?? null,
        institution_id: item?.institution_id ?? d?.institution_id ?? null,
        connected: !!item,
        name: m?.a.name || d?.name || s?.a.name || v?.a.name || r?.account_name || null,
        official_name: m?.a.official_name ?? d?.official_name ?? s?.a.official_name ?? v?.a.official_name ?? null,
        type: m?.a.type ?? d?.type ?? s?.a.type ?? v?.a.type ?? null,
        subtype: m?.a.subtype ?? d?.subtype ?? s?.a.subtype ?? v?.a.subtype ?? null,
        mask: m?.a.mask ?? d?.mask ?? s?.a.mask ?? v?.a.mask ?? null,
        currency: m?.a.currency ?? s?.a.balances?.iso_currency_code ?? null,
        credit_limit: m?.a.limit ?? s?.a.balances?.limit ?? null,
        persistent_account_id: d?.persistent_account_id ?? null,
        first_seen: d?.first_seen ?? null,
        last_seen: d?.last_seen ?? null,
        hidden: !!h,
        hidden_at: realTime(h?.hidden_at),
        latest_balance: latestRecorded(data.history.accounts.get(id)),
      };
    })
    .sort((a, b) => byText(a.institution_name, b.institution_name) || byText(a.name, b.name) || byCodePoint(a.account_id, b.account_id));

  const manual_accounts: ExportManualAccount[] = data.manual.map((m) => {
    const h = hidden.get(m.account_id);
    return {
      account_id: m.account_id,
      name: m.name,
      institution_name: m.institution_name,
      type: m.type,
      subtype: m.subtype,
      balance: m.balance,
      updated_at: realTime(m.updated_at),
      hidden: !!h,
      hidden_at: realTime(h?.hidden_at),
    };
  });

  // Each account's series, in the order the accounts are listed; then those
  // of manual accounts that couldn't be read, whose balances still read.
  const order = [...accounts.map((a) => a.account_id), ...manual_accounts.map((m) => m.account_id), ...unreadableManual];
  const account_history = order
    .filter((id) => (data.history.accounts.get(id)?.length ?? 0) > 0)
    .map((id) => ({
      account_id: id,
      points: data.history.accounts.get(id)!.map((p) => ({ date: p.date, balance: p.value, kind: kindOf(p) })),
    }));

  // Categories carried across a re-link, by the key of the row they apply to,
  // following the links that apply now (as /api/transactions does).
  const carried = carriedCategories(data.carried, effective);
  const transactions: ExportTransaction[] = data.stores
    .flatMap((s) => {
      const superseded = supersededPendingIds(s.txns);
      return Object.values(s.txns).map(
        (t): ExportTransaction => ({
          ...t,
          item_id: s.item_id,
          vendor_key: vendorKey(t),
          your_category: data.overrides.get(t.transaction_id) ?? null,
          your_category_from_earlier_account: carried.get(contentKey(t.account_id, t)) ?? null,
          your_merchant_name: data.renames.get(vendorKey(t)) ?? null,
          superseded_by_posted: superseded.has(t.transaction_id),
          account_hidden: hidden.has(t.account_id),
        })
      );
    })
    // Newest first, as the app lists them; then by the event time, then the id,
    // so two downloads of the same data are the same file.
    .sort(
      (a, b) =>
        byCodePoint(b.date, a.date) ||
        byCodePoint(b.datetime ?? b.authorized_datetime ?? '', a.datetime ?? a.authorized_datetime ?? '') ||
        byCodePoint(a.transaction_id, b.transaction_id)
    );

  const investment_transactions: ExportInvestmentTransaction[] = data.investments
    .flatMap(({ item_id, state }) =>
      Object.entries(state.txns).map(([id, row]): ExportInvestmentTransaction => {
        const raw = row?.raw as unknown as Record<string, unknown> | undefined;
        if (!raw || typeof raw.investment_transaction_id !== 'string') {
          throw new ExportReadError('investment transactions', new Error('A stored investment transaction has an unexpected shape'));
        }
        const security_id = typeof raw.security_id === 'string' ? raw.security_id : null;
        return {
          // Every field Plaid sent, as it sent it.
          ...raw,
          investment_transaction_id: raw.investment_transaction_id,
          account_id: String(raw.account_id ?? ''),
          date: String(raw.date ?? ''),
          item_id,
          security: security_id ? (state.securities[security_id] ?? null) : null,
          seen_at: row.seen_at,
          missing_since: row.missing_since ?? null,
          excluded: !!row.excluded,
          cancelled: !!state.cancelled?.[id],
        };
      })
    )
    .sort((a, b) => byCodePoint(b.date, a.date) || byCodePoint(a.investment_transaction_id, b.investment_transaction_id));

  // A Set: two connections to the same bank, both behind, are one caveat.
  const notes = new Set<string>();
  for (const s of data.stores) {
    if (!s.behind) continue;
    const name = items.get(s.item_id)?.institution_name ?? 'one institution';
    notes.add(
      `Nya could not save the newest transactions from ${name} (a storage limit, or a write that failed), so ones the app showed recently may be missing from this file. They are saved again once a sync can store them.`
    );
  }

  const doc: UserExport = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: now.toISOString(),
    documentation: EXPORT_DOCUMENTATION,
    not_included: notIncluded(data.people),
    // Each part that is missing something says so in words too, after the
    // caveats (problemNotes).
    notes: [...notes, ...problemNotes(data.problems)],
    problems: data.problems,
    institutions: data.items
      .map((i): ExportInstitution => ({ item_id: i.item_id, institution_name: i.institution_name, institution_id: i.institution_id, provider: 'plaid' }))
      .sort((a, b) => byText(a.institution_name, b.institution_name) || byCodePoint(a.item_id, b.item_id)),
    accounts,
    manual_accounts,
    hidden_accounts: [...data.hidden]
      .map(([account_id, entry]: [string, HiddenAccount]) => ({ account_id, type: entry.type, hidden_at: realTime(entry.hidden_at) }))
      .sort((a, b) => byCodePoint(a.account_id, b.account_id)),
    net_worth_history: {
      includes_hidden_accounts: true,
      points: data.history.totals.map((p) => ({ date: p.date, total: p.value, kind: kindOf(p) })),
    },
    account_history,
    transactions,
    category_overrides: [...data.overrides]
      .map(([transaction_id, category]) => ({ transaction_id, category }))
      .sort((a, b) => byCodePoint(a.transaction_id, b.transaction_id)),
    merchant_renames: [...data.renames].map(([vendor_key, name]) => ({ vendor_key, name })).sort((a, b) => byCodePoint(a.vendor_key, b.vendor_key)),
    investment_transactions,
    investment_history_coverage: data.investments
      .flatMap(({ item_id, state }) => Object.entries(state.coverage).map(([account_id, c]) => ({ item_id, account_id, from: c.from, through: c.through })))
      .sort((a, b) => byCodePoint(a.account_id, b.account_id)),
    account_links: {
      links: [...data.links]
        .map(([old, l]) => ({ earlier_account_id: old, account_id: l.to, linked_at: l.linked_at, evidence: l.evidence ?? {} }))
        .sort((a, b) => byCodePoint(a.earlier_account_id, b.earlier_account_id)),
      declined_suggestions: [...data.declined].sort((a, b) => byCodePoint(a.earlier_account_id, b.earlier_account_id) || byCodePoint(a.account_id ?? '', b.account_id ?? '')),
      carried_categories: [...data.carried]
        .map(([earlier_account_id, rows]) => ({
          earlier_account_id,
          rows: Object.entries(rows)
            .map(([key, category]) => ({ ...carriedRow(key, earlier_account_id), category }))
            .sort((a, b) => byCodePoint(a.date, b.date) || byCodePoint(a.description, b.description)),
        }))
        .sort((a, b) => byCodePoint(a.earlier_account_id, b.earlier_account_id)),
    },
  };
  for (const [key, value] of data.sections) {
    // A section named like a core one would replace it without a word.
    if (Object.hasOwn(doc, key)) throw new Error(`Two parts of the download are both called ${key}`);
    doc[key] = value;
  }
  return doc;
}

// ---- Writing it out ----

/** Pieces are gathered up to about this many characters before one is handed
 *  to the stream: one per value would make thousands of tiny writes. */
const CHUNK_CHARS = 64 * 1024;

function* gathered(pieces: Iterable<string>): Generator<string> {
  let buffer = '';
  for (const piece of pieces) {
    buffer += piece;
    if (buffer.length >= CHUNK_CHARS) {
      yield buffer;
      buffer = '';
    }
  }
  if (buffer) yield buffer;
}

/** Which objects are laid out over several lines, by where each sits in the
 *  document: the keys and indexes that lead to it. */
export type JsonLayout = (path: readonly (string | number)[]) => boolean;

/** Every object over several lines: the text of JSON.stringify(value, null, 2). */
export const EVERY_OBJECT: JsonLayout = () => true;

/**
 * The download's layout: one record per line. The document and each of its
 * sections are laid out a field per line and every list an entry per line,
 * while each record (an institution, an account, a transaction, one day's
 * balance, a link) takes one line of its own. The two records that hold long
 * lists themselves (one account's history, one earlier account's carried
 * categories) are laid out too, so their lists run an entry per line.
 *
 * Readable in a text editor at about the size of compact JSON. Indenting every
 * field cost 38% more (146 MB against 106 MB for an account with 60,000
 * transactions and ten years of history) and several times the time to write,
 * which a slow connection pays again.
 */
export const ONE_RECORD_PER_LINE: JsonLayout = (path) =>
  path.length <= 1 ||
  (path.length === 2 && path[0] === 'account_history') ||
  (path.length === 3 && path[0] === 'account_links' && path[1] === 'carried_categories');

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { toJSON?: unknown }).toJSON !== 'function';

/**
 * A JSON value as text, a piece at a time, without ever holding all of it, so
 * a long history doesn't become one string the size of the file. Lists are
 * written an entry per line; an object `layout` doesn't lay out is written on
 * one line, as JSON.stringify writes it. Whatever the layout, the text parses
 * to exactly what JSON.stringify(value) does.
 */
export function* jsonPieces(value: unknown, layout: JsonLayout = EVERY_OBJECT, path: (string | number)[] = [], indent = ''): Generator<string> {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      yield '[]';
      return;
    }
    const inner = indent + '  ';
    yield '[\n';
    for (let i = 0; i < value.length; i++) {
      yield inner;
      // As JSON.stringify writes them: nothing representable in an array is null.
      const v = value[i];
      yield* jsonPieces(v === undefined || typeof v === 'function' || typeof v === 'symbol' ? null : v, layout, [...path, i], inner);
      yield i < value.length - 1 ? ',\n' : '\n';
    }
    yield `${indent}]`;
    return;
  }
  if (isPlainObject(value)) {
    if (!layout(path)) {
      yield JSON.stringify(value);
      return;
    }
    const entries = Object.entries(value).filter(([, v]) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol');
    if (entries.length === 0) {
      yield '{}';
      return;
    }
    const inner = indent + '  ';
    yield '{\n';
    for (let i = 0; i < entries.length; i++) {
      yield `${inner}${JSON.stringify(entries[i][0])}: `;
      yield* jsonPieces(entries[i][1], layout, [...path, entries[i][0]], inner);
      yield i < entries.length - 1 ? ',\n' : '\n';
    }
    yield `${indent}}`;
    return;
  }
  yield JSON.stringify(value) ?? 'null';
}

/** The columns of transactions.csv, in order (docs/data-export.md). */
export const TRANSACTION_COLUMNS = [
  'date',
  'account_name',
  'institution_name',
  'name',
  'merchant_name',
  'your_merchant_name',
  'amount',
  'iso_currency_code',
  'category',
  'your_category',
  'your_category_from_earlier_account',
  'category_detailed',
  'category_confidence',
  'pending',
  'superseded_by_posted',
  'account_hidden',
  'authorized_date',
  'datetime',
  'authorized_datetime',
  'payment_channel',
  'transaction_code',
  'transaction_type',
  'check_number',
  'account_owner',
  'website',
  'location_address',
  'location_city',
  'location_region',
  'location_postal_code',
  'location_country',
  'location_lat',
  'location_lon',
  'location_store_number',
  'payment_reference',
  'payment_processor',
  'payment_payee',
  'payment_payer',
  'payment_method',
  'counterparties',
  'unofficial_currency_code',
  'transaction_id',
  'pending_transaction_id',
  'account_id',
  'item_id',
  'merchant_entity_id',
  'vendor_key',
  'logo_url',
  'category_icon_url',
  // Added with the rows of manual accounts, at the end, so every column
  // before them keeps its place.
  'source',
  'note',
] as const;

type TransactionColumn = (typeof TRANSACTION_COLUMNS)[number];

function transactionRow(t: ExportTransaction): CsvValue[] {
  const loc = t.location ?? null;
  const pay = t.payment_meta ?? null;
  const cells: Record<TransactionColumn, CsvValue> = {
    date: t.date,
    account_name: t.account_name,
    institution_name: t.institution_name,
    name: t.name,
    merchant_name: t.merchant_name,
    your_merchant_name: t.your_merchant_name,
    amount: t.amount,
    iso_currency_code: t.iso_currency_code,
    category: t.category,
    your_category: t.your_category,
    your_category_from_earlier_account: t.your_category_from_earlier_account,
    category_detailed: t.personal_finance_category?.detailed ?? null,
    category_confidence: t.personal_finance_category?.confidence_level ?? null,
    pending: t.pending,
    superseded_by_posted: t.superseded_by_posted,
    account_hidden: t.account_hidden,
    authorized_date: t.authorized_date,
    datetime: t.datetime,
    authorized_datetime: t.authorized_datetime,
    payment_channel: t.payment_channel,
    transaction_code: t.transaction_code,
    transaction_type: t.transaction_type,
    check_number: t.check_number,
    account_owner: t.account_owner,
    website: t.website,
    location_address: loc?.address ?? null,
    location_city: loc?.city ?? null,
    location_region: loc?.region ?? null,
    location_postal_code: loc?.postal_code ?? null,
    location_country: loc?.country ?? null,
    location_lat: loc?.lat ?? null,
    location_lon: loc?.lon ?? null,
    location_store_number: loc?.store_number ?? null,
    payment_reference: pay?.reference_number ?? null,
    payment_processor: pay?.payment_processor ?? null,
    payment_payee: pay?.payee ?? null,
    payment_payer: pay?.payer ?? null,
    payment_method: pay?.payment_method ?? null,
    counterparties: (t.counterparties ?? []).map((c) => (c.type ? `${c.name} (${c.type})` : c.name)).join('; '),
    unofficial_currency_code: t.unofficial_currency_code,
    transaction_id: t.transaction_id,
    pending_transaction_id: t.pending_transaction_id,
    account_id: t.account_id,
    item_id: t.item_id,
    merchant_entity_id: t.merchant_entity_id,
    vendor_key: t.vendor_key,
    logo_url: t.logo_url,
    category_icon_url: t.personal_finance_category_icon_url,
    source: PROVIDER,
    note: null,
  };
  return TRANSACTION_COLUMNS.map((c) => cells[c]);
}

/**
 * A transaction on a manual account, entered by hand or imported (the
 * `manual-transactions` part of the file), in the same columns as a bank's:
 * its own payee, category (its own, so nothing is in your_category), amount
 * and currency, its account as `manual_accounts` names it (empty for one that
 * couldn't be read, which `problems` names), where it came from (`source`)
 * and its note. What only a bank sends is empty, and so is item_id: a manual
 * account has no connection.
 */
function manualTransactionRow(row: ManualTxn, account: ExportManualAccount | undefined, hidden: boolean): CsvValue[] {
  const cells: Record<TransactionColumn, CsvValue> = {
    ...(Object.fromEntries(TRANSACTION_COLUMNS.map((c) => [c, null])) as Record<TransactionColumn, CsvValue>),
    date: row.date,
    account_name: account?.name ?? null,
    institution_name: account?.institution_name ?? null,
    name: row.name,
    amount: row.amount,
    iso_currency_code: row.currency,
    category: row.category,
    pending: false,
    superseded_by_posted: false,
    account_hidden: hidden,
    // Plaid's code for what its file said it was ("atm"), where it said so.
    transaction_code: row.transaction_code ?? null,
    transaction_id: row.id,
    account_id: row.account_id,
    source: row.source,
    note: row.note,
  };
  return TRANSACTION_COLUMNS.map((c) => cells[c]);
}

/** Every row of the manual accounts' books in the file, once each: a book
 *  restored from a backup could repeat one, which counts once, the copy
 *  saved last, as the app shows it (lib/manual-txns.ts). */
function manualTransactionsIn(doc: UserExport): ManualTxn[] {
  const entries = doc[manualTxnStore.name] ?? [];
  if (!Array.isArray(entries)) throw new Error('The manual transactions in the file have an unexpected shape');
  const byId = new Map<string, ManualTxn>();
  for (const entry of entries) {
    const book = (entry as { value?: unknown } | null)?.value;
    if (!isManualTxnBook(book)) throw new Error('A manual account’s transactions have an unexpected shape');
    for (const row of book.rows) {
      const seen = byId.get(row.id);
      if (!seen || row.updated_at > seen.updated_at) byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

/**
 * transactions.csv: one row per transaction, newest first: every one stored
 * from the banks, and every one on a manual account (manualTransactionRow).
 * In the order the bank's rows are listed in the file (then by the event
 * time, which a manual row doesn't have, then the id), so two downloads of
 * the same data are the same file.
 */
export function* transactionsCsv(doc: UserExport): Generator<string> {
  yield UTF8_BOM + csvRow(TRANSACTION_COLUMNS);
  const accounts = new Map(doc.manual_accounts.map((m) => [m.account_id, m]));
  const hidden = new Set(doc.hidden_accounts.map((h) => h.account_id));
  const rows: { date: string; time: string; id: string; cells: () => CsvValue[] }[] = [
    ...doc.transactions.map((t) => ({ date: t.date, time: t.datetime ?? t.authorized_datetime ?? '', id: t.transaction_id, cells: () => transactionRow(t) })),
    ...manualTransactionsIn(doc).map((r) => ({
      date: r.date,
      time: '',
      id: r.id,
      cells: () => manualTransactionRow(r, accounts.get(r.account_id), hidden.has(r.account_id)),
    })),
  ];
  rows.sort((a, b) => byCodePoint(b.date, a.date) || byCodePoint(b.time, a.time) || byCodePoint(a.id, b.id));
  for (const row of rows) yield csvRow(row.cells());
}

/** The columns of balances.csv, in order (docs/data-export.md). */
export const BALANCE_COLUMNS = [
  'date',
  'record',
  'account_id',
  'account_name',
  'institution_name',
  'account_type',
  'balance',
  'currency',
  'kind',
  'account_hidden',
] as const;

/**
 * balances.csv: the net-worth total for each day ("net_worth" rows, every
 * account, hidden ones too, as recorded) and each account's own balance
 * ("account" rows), oldest day first, the total before the accounts.
 */
export function* balancesCsv(doc: UserExport): Generator<string> {
  yield UTF8_BOM + csvRow(BALANCE_COLUMNS);
  const about = new Map<string, { name: string | null; institution: string | null; type: string | null; currency: string | null; hidden: boolean }>();
  for (const a of doc.accounts) about.set(a.account_id, { name: a.name, institution: a.institution_name, type: a.type, currency: a.currency, hidden: a.hidden });
  for (const m of doc.manual_accounts) about.set(m.account_id, { name: m.name, institution: m.institution_name, type: m.type, currency: null, hidden: m.hidden });
  // A manual account that couldn't be read is in neither list (problems names
  // it). When it is hidden, hidden_accounts still holds its type and says it
  // is hidden, as transactions.csv reads it there too.
  for (const h of doc.hidden_accounts) {
    if (!about.has(h.account_id)) about.set(h.account_id, { name: null, institution: null, type: h.type, currency: null, hidden: true });
  }

  type Row = { date: string; rank: number; cells: CsvValue[] };
  const rows: Row[] = doc.net_worth_history.points.map((p) => ({
    date: p.date,
    rank: -1,
    cells: [p.date, 'net_worth', null, null, null, null, p.total, null, p.kind, null],
  }));
  doc.account_history.forEach((series, rank) => {
    const a = about.get(series.account_id);
    for (const p of series.points) {
      rows.push({
        date: p.date,
        rank,
        cells: [p.date, 'account', series.account_id, a?.name ?? null, a?.institution ?? null, a?.type ?? null, p.balance, a?.currency ?? null, p.kind, a?.hidden ?? false],
      });
    }
  });
  rows.sort((x, y) => byCodePoint(x.date, y.date) || x.rank - y.rank);
  for (const row of rows) yield csvRow(row.cells);
}

/**
 * One download: its name, its type, its text a piece at a time, and what the
 * person should know about it, which the route sends as headers (a CSV has
 * nowhere inside to say it): `notes`, its caveats in words, and `incomplete`,
 * the parts of the JSON file it is made from that are missing something
 * (problems), by key, empty when it is whole.
 */
export type ExportFile = { filename: string; contentType: string; pieces: () => Iterable<string>; notes: string[]; incomplete: string[] };

/**
 * The parts of the JSON file each CSV is made from, of those that can be
 * missing something (problems): what any other part is missing leaves the CSV
 * whole, so its download never says otherwise. The JSON file is made from
 * every part.
 */
export const CSV_SOURCES: Readonly<Record<Exclude<ExportFormat, 'json'>, readonly string[]>> = {
  // The books of the manual accounts, and the names of the accounts they are on.
  'transactions-csv': ['manual-transactions', 'manual_accounts'],
  // The days, and the names of the manual accounts the rows are for.
  'balances-csv': ['net_worth_history', 'account_history', 'manual_accounts'],
};

export function exportFile(doc: UserExport, format: ExportFormat): ExportFile {
  const day = doc.exported_at.slice(0, 10);
  // What this file is missing, and its notes: the caveats, then a note for
  // each part it is made from that is missing something (problemNotes, which
  // the document's own notes end with, for every part).
  const problems = format === 'json' ? doc.problems : doc.problems.filter((p) => CSV_SOURCES[format].includes(p.section));
  const everyPart = new Set(problemNotes(doc.problems));
  const notes = [...doc.notes.filter((n) => !everyPart.has(n)), ...problemNotes(problems, format)];
  const about = { notes, incomplete: [...new Set(problems.map((p) => p.section))] };
  switch (format) {
    case 'json':
      return {
        filename: `nya-data-${day}.json`,
        contentType: 'application/json; charset=utf-8',
        pieces: () =>
          gathered(
            (function* () {
              yield* jsonPieces(doc, ONE_RECORD_PER_LINE);
              yield '\n';
            })()
          ),
        ...about,
      };
    case 'transactions-csv':
      return { filename: `nya-transactions-${day}.csv`, contentType: 'text/csv; charset=utf-8', pieces: () => gathered(transactionsCsv(doc)), ...about };
    case 'balances-csv':
      return { filename: `nya-balances-${day}.csv`, contentType: 'text/csv; charset=utf-8', pieces: () => gathered(balancesCsv(doc)), ...about };
  }
}

/** The file as UTF-8 bytes, a chunk at a time: what the route streams. */
export function* fileChunks(file: ExportFile): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const piece of file.pieces()) yield encoder.encode(piece);
}

/**
 * How many bytes the file is, from a pass over it that keeps none of them.
 * The route sends the count ahead of the body, so the page can tell a whole
 * file from one cut short. The document is wholly in memory before this pass,
 * and the writers depend on nothing else, so the pass that streams it
 * afterwards writes exactly the same bytes (test/user-export.test.ts checks).
 */
export function fileByteLength(file: ExportFile): number {
  let bytes = 0;
  for (const chunk of fileChunks(file)) bytes += chunk.byteLength;
  return bytes;
}
