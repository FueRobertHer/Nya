// lib/user-restore/plan.ts
//
// From what the page read of a download (Collected, lib/user-restore/file.ts)
// to the restore's plan: whether it can be brought back at all and what it
// would leave out, what each part becomes, and the batches that write it, in
// order. Pure, for the page; the server checks every batch it is sent again
// (lib/user-restore/check.ts) and never takes this module's word for it.
//
// AS THE FILE HAS IT. Every record is written as the file has it (see
// docs/data-export.md, "Bringing it back"). The one change is the ids of the
// bank's own rows, re-keyed by restoredId (lib/user-restore/ids.ts), and the
// records naming them with them: a category chosen for one, a note, a split,
// a place in a group, an approval. Pending rows are left out, and what was
// said about them with them, but an approval kept under a pending row that a
// posted one replaced, which is the posted row's (lib/review-layer.ts
// pending_from), kept under the pending row's restored id. What a bank row
// stood for (a file's row it superseded or that names it) is worked out again
// on every read (lib/user-restore/restored.ts), never written.
//
// THE ORDER. Categories, tags and rules first, then the accounts, then the
// rows, then what was said about them, budgets and goals, the history, and
// the rest (PART_ORDER), so the app's own reads in another tab never build on
// what isn't there yet (a category set grown from rows that came first). The
// large parts (the bank's rows, books of rows, import records, holdings
// months) are read from the file again as they are sent, in the file's order,
// between the accounts and what was said.

import { indexTaxonomy, isTaxonomy } from '../categories';
import { legacyCopy } from '../budget-set';
import { bankFieldsOf, isRecord } from './records';
import { BATCH_BYTES, BOOK_ROWS, investmentCoverageId, investmentPartId, restoredBookId, restoredId } from './ids';
import { SEAM } from './parts';
import { turningOverIds } from '../sign-turning';

// ---- What the page read ----

export type ExportProblem = { section: string; problem: string; ids?: string[]; count?: number };

/** A bank transaction's facts, to name one a damaged entry was about. */
export type Fact = { date: string; amount: number; currency: string | null; name: string; account: string | null };

/** A large entry of a store on the seam (parts.ts SEAM `split`): its id, its
 *  other fields (`head`), and how many items its split field holds (a list's
 *  length, or a map's keys). Its items are read again as they are sent. */
export type BookEntry = { id: string; head: Record<string, unknown>; size: number };

export type Collected = {
  version: 1 | 2;
  exported_at: string;
  notes: string[];
  problems: ExportProblem[];
  /** The file's parts, in its order. */
  parts: string[];
  /** The core parts read whole or held (the bank's own rows and investment
   *  transactions are not: they are counted here, and read again to send). */
  core: Partial<Record<string, unknown>>;
  bank: {
    /** The posted rows' ids, and the pending ones a posted row names. */
    posted: Set<string>;
    replaced: Set<string>;
    pending: Set<string>;
    /** Each account's posted rows: how many, and the first and last day. */
    accounts: Map<string, { count: number; first: string; last: string }>;
  };
  /** Each connection's investment transactions, by how many. */
  investments: Map<string, number>;
  /** Stores on the seam: a value store's value (null when the file has it
   *  null), a map store's entries, and the large ones' entries. */
  values: Map<string, unknown>;
  entries: Map<string, { id: string; value: unknown }[]>;
  books: Map<string, BookEntry[]>;
  /** The facts of the transactions that damaged entries name (`problems`). */
  facts: Map<string, Fact>;
  /** Not brought back, counted: API tokens, sharing connections, and
   *  receipts and documents (absent from what was collected before them). */
  never: { api_tokens: number; sharing: number; attachments?: number };
};

// ---- Whether it can be brought back ----

/** What each damaged part means when brought back without it, in words, or
 *  null where it can't be (see restoreProblems). */
const WITHOUT_WORDS: Readonly<Record<string, string | ((n: number) => string)>> = {
  net_worth_history: (n) => `${n} ${n === 1 ? 'day' : 'days'} of net worth history: gaps in the chart, as the other copy’s chart had them`,
  account_history: (n) => `${n} ${n === 1 ? 'day' : 'days'} of account balances: gaps in those accounts’ charts`,
  estimate_flat: (n) => `the flat balances of ${n} estimated ${n === 1 ? 'day' : 'days'}: a hidden account can’t be taken out of ${n === 1 ? 'it' : 'them'}`,
  'holdings:history': (n) => `${n} ${n === 1 ? 'month' : 'months'} of holdings history: those days show no holdings`,
  'timeline-notes': (n) => `${n} timeline ${n === 1 ? 'note' : 'notes'}`,
  'import-settings': (n) => `how ${n} ${n === 1 ? 'account’s files were' : 'accounts’ files were'} last read: the next import asks again`,
  imports: (n) => `the record of ${n} ${n === 1 ? 'import' : 'imports'} into manual accounts: ${n === 1 ? 'its' : 'their'} transactions come back, but can’t be undone as one import`,
  'transaction-annotations': (n) => `what you said about ${n} ${n === 1 ? 'transaction' : 'transactions'} (notes, tags, exclusions)`,
  'transaction-splits': (n) => `${n} ${n === 1 ? 'split' : 'splits'}: ${n === 1 ? 'that transaction counts' : 'those transactions count'} whole`,
  'transaction-groups': (n) => `${n} ${n === 1 ? 'group' : 'groups'} of transactions: their transactions count on their own`,
  'transaction-approvals': (n) => `${n} ${n === 1 ? 'approval' : 'approvals'} in the review queue`,
  'carried-annotations': (n) => `what you said about the transactions of ${n} earlier ${n === 1 ? 'account' : 'accounts'}`,
  'carried-imported-twins': (n) => `which imported transactions of ${n} earlier ${n === 1 ? 'account were' : 'accounts were'} the bank’s: once linked again, they may count beside the bank’s`,
  'restored-investment-transactions': (n) => `${n} ${n === 1 ? 'record' : 'records'} of investment transactions from an earlier restore`,
  'goal-plans': (n) => `the plans of ${n} ${n === 1 ? 'goal' : 'goals'}`,
  'app-imports': (n) => `the record of ${n} ${n === 1 ? 'import' : 'imports'} from another app: ${n === 1 ? 'its' : 'their'} transactions come back, but can’t be undone as one import`,
  'user-restore': 'the record of the restore the other copy had',
  budgets: 'your budgets: the restored copy has none',
  group_budgets: 'your budgets on category groups',
  goals: 'your goals: the restored copy has none',
  'budget-months': 'your budgets by month: each budget’s past months and rollover start again',
  'income-carryover': 'your income carryover setting',
  'fire-plan': 'your Plan’s assumptions',
  'fire-plan-currency': 'the currency your Plan’s figures are in',
  'plan-scenarios': (n) => `${n} saved plan ${n === 1 ? 'scenario' : 'scenarios'}`,
  'allocation-settings': 'your allocation settings',
  'planned-items': 'your planned bills and income',
  'report-settings': 'your report settings',
  'runway-scenarios': (n) => `${n} saved runway ${n === 1 ? 'scenario' : 'scenarios'}`,
  'review-settings': 'your review queue setting',
  'weekly-summary': 'your weekly summary setting',
  'currency-settings': 'your home currency and your own exchange rates: every figure shows in its own currency until you choose again',
  'vendor-defaults': 'your merchants’ default categories',
  rules: 'your rules: transactions are filed and named as the bank and you have them',
  tags: 'your tags: transactions come back without them',
};

/** Parts a restore never brings back: what the file is missing of them
 *  changes nothing. */
const LISTED_ONLY: ReadonlySet<string> = new Set(['api_tokens', 'attachments', 'sharing', 'connection-notices', 'connection-syncs', 'connection-warnings']);

/** What the file says it is missing (`problems`), restored without or not:
 *  one damaged entry the person can do without, named with the transactions
 *  it affects, once they confirm (decision 6); never one a newer release can
 *  read (`unrecognised`), nor a part the rest is read against, whose absence
 *  would read as something else, silently. */
export type Without = { part: string; count: number; words: string; affects: Fact[] };

export function restoreProblems(c: Collected): { refuse: string | null; without: Without[] } {
  const without: Without[] = [];
  for (const p of c.problems) {
    if (LISTED_ONLY.has(p.section)) continue;
    if (p.problem === 'unrecognised') {
      return {
        refuse: `This file is missing some of your ${p.section.replace(/[_-]/g, ' ')}: the copy it came from couldn’t read them in this version of Nya, but a newer one may. Download again from that copy once it is updated; the file itself stays yours to keep.`,
        without: [],
      };
    }
    const words = WITHOUT_WORDS[p.section];
    if (!words || p.problem !== 'unreadable') {
      return {
        refuse: `This file is missing some of your ${p.section.replace(/[_-]/g, ' ')}, and the rest would read as something else without it, so it can’t be brought back. Download again once the other copy can read it; the file itself stays yours to keep.`,
        without: [],
      };
    }
    const count = p.ids?.length ?? p.count ?? 1;
    const affects = (p.ids ?? []).map((id) => c.facts.get(id)).filter((f): f is Fact => f !== undefined);
    without.push({ part: p.section, count, words: typeof words === 'string' ? words : words(count), affects });
  }
  return { refuse: null, without };
}

/** The checks across parts (see docs/data-export.md, "Bringing it back"):
 *  each restored row's account restored; each book's account in the file; no
 *  store past its bound. The first problem, or null. */
export function acrossParts(c: Collected): string | null {
  const accounts = (c.core.accounts as { account_id: string; provider: string | null; item_id: string | null }[] | undefined) ?? [];
  const institutions = (c.core.institutions as { item_id: string; provider: string }[] | undefined) ?? [];
  const plaidItems = new Set(institutions.filter((i) => i.provider === 'plaid').map((i) => i.item_id));
  const plaidAccounts = new Set(accounts.filter((a) => a.item_id !== null && plaidItems.has(a.item_id)).map((a) => a.account_id));
  for (const id of c.bank.accounts.keys()) if (!plaidAccounts.has(id)) return 'transactions: a bank transaction is on an account the file doesn’t list at one of its banks';
  const manual = new Set(((c.core.manual_accounts as { account_id: string }[] | undefined) ?? []).map((m) => m.account_id));
  for (const e of [...(c.entries.get('connector-accounts') ?? []), ...(c.entries.get('connector-ended') ?? [])]) manual.add(e.id);
  for (const b of c.books.get('manual-transactions') ?? []) if (!manual.has(b.id)) return 'manual-transactions: transactions are on an account the file doesn’t have';
  for (const [name, part] of Object.entries(SEAM)) {
    if (part.max === undefined || part.restore !== 'write') continue;
    const n = (c.entries.get(name) ?? c.books.get(name) ?? []).length;
    if (n > part.max) return `${name}: the file has ${n}, and Nya keeps at most ${part.max}, so it can’t have come from Nya`;
  }
  const manualCount = ((c.core.manual_accounts as unknown[] | undefined) ?? []).length;
  if (manualCount > 150) return `manual_accounts: the file has ${manualCount}, more than Nya keeps`;
  return null;
}

// ---- What each part becomes ----

/** The restored accounts: every account of a bank the file has through Plaid,
 *  as an earlier account (its directory entry), and its bank rows' span,
 *  in books (BOOK_ROWS each). */
export type RestoredAccountFacts = {
  account_id: string;
  item_id: string;
  institution_id: string | null;
  institution_name: string;
  name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
  rows: { first: string; last: string; count: number; books: number } | null;
  downloaded: string;
};

type ExportAccount = {
  account_id: string;
  provider: string | null;
  item_id: string | null;
  institution_name: string | null;
  institution_id: string | null;
  name: string | null;
  official_name: string | null;
  type: string | null;
  subtype: string | null;
  mask: string | null;
  currency: string | null;
  persistent_account_id: string | null;
  first_seen: string | null;
  last_seen: string | null;
};

const dayOf = (iso: string) => iso.slice(0, 10);

/** The accounts the file's Plaid banks had (see RestoredAccountFacts), and
 *  every Plaid account's directory entry, as the old copy had it, its days
 *  filled where it had none: what the links flow matches by. */
export function accountsOf(c: Collected): { restored: RestoredAccountFacts[]; directory: { id: string; value: Record<string, unknown> }[] } {
  const downloaded = dayOf(c.exported_at);
  const institutions = (c.core.institutions as { item_id: string; institution_name: string; institution_id: string | null; provider: string }[] | undefined) ?? [];
  const plaid = new Map(institutions.filter((i) => i.provider === 'plaid').map((i) => [i.item_id, i]));
  const accounts = (c.core.accounts as ExportAccount[] | undefined) ?? [];
  const spans = historySpans(c);
  const restored: RestoredAccountFacts[] = [];
  const directory: { id: string; value: Record<string, unknown> }[] = [];
  for (const a of accounts) {
    const isPlaid = a.provider === 'plaid' || (a.provider === null && a.item_id !== null && plaid.has(a.item_id));
    if (!isPlaid || a.item_id === null) continue;
    const rows = c.bank.accounts.get(a.account_id);
    const span = spans.get(a.account_id);
    const first = [a.first_seen, span?.first, rows?.first].filter((d): d is string => !!d).sort()[0] ?? downloaded;
    const lastCandidates = [a.last_seen, ...(plaid.has(a.item_id) ? [downloaded] : []), span?.last, rows?.last].filter((d): d is string => !!d).sort();
    const last = a.last_seen ?? lastCandidates[lastCandidates.length - 1] ?? downloaded;
    // An earlier account the old copy kept no entry for keeps none: nothing
    // is made up for it.
    if (a.first_seen !== null || plaid.has(a.item_id)) {
      directory.push({
        id: a.account_id,
        value: {
          provider: 'plaid',
          item_id: a.item_id,
          institution_id: a.institution_id,
          institution_name: a.institution_name ?? plaid.get(a.item_id)?.institution_name ?? 'A bank',
          name: a.name,
          official_name: a.official_name,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          persistent_account_id: a.persistent_account_id,
          first_seen: first,
          last_seen: last < first ? first : last,
          // What prices its past balances in a home currency while it isn't
          // linked again (lib/fx/known-accounts.ts), as the old copy's entry
          // or record had it.
          ...(a.currency ? { currency: a.currency } : {}),
        },
      });
    }
    const inst = plaid.get(a.item_id);
    if (!inst) continue;
    restored.push({
      account_id: a.account_id,
      item_id: a.item_id,
      institution_id: inst.institution_id,
      institution_name: inst.institution_name,
      name: a.name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      currency: a.currency,
      rows: rows ? { first: rows.first, last: rows.last, count: rows.count, books: Math.max(1, Math.ceil(rows.count / BOOK_ROWS)) } : null,
      downloaded,
    });
  }
  return { restored, directory };
}

/** The accounts a restore brings back from the file's Plaid banks
 *  (accountsOf `restored`) that the file says ended, each with its day: the
 *  file's own ends, applied through its links as every reader applies one
 *  (lib/lifecycle.ts effectiveLifecycle: an account's own entry first, else
 *  the newest of its ids'). The old copy counted their rows up to that end,
 *  so the finish answers count for them (lib/user-restore/commit.ts
 *  fileAnswers), and the preview says so. Pure. */
export function endedInFile(c: Collected, restored: readonly RestoredAccountFacts[]): { account: RestoredAccountFacts; day: string }[] {
  const links = new Map<string, string>();
  for (const e of c.entries.get('account-links') ?? []) if (isRecord(e.value) && typeof e.value.to === 'string') links.set(e.id, e.value.to);
  const rootOf = (id: string) => {
    const seen = new Set<string>();
    let at = id;
    while (links.has(at) && !seen.has(at)) {
      seen.add(at);
      at = links.get(at)!;
    }
    return at;
  };
  const best = new Map<string, { own: boolean; set_at: string; day: string | null }>();
  const entries = [...(c.entries.get('account-lifecycle') ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of entries) {
    if (!isRecord(e.value) || !isRecord(e.value.lifecycle)) continue;
    const l = e.value.lifecycle;
    const day = l.state === 'closed' || l.state === 'left' ? l.on : l.state === 'untracked' ? l.from : null;
    const root = rootOf(e.id);
    const own = root === e.id;
    const set_at = typeof e.value.set_at === 'string' ? e.value.set_at : '';
    const held = best.get(root);
    if (!held || (!held.own && (own || set_at > held.set_at))) best.set(root, { own, set_at, day: typeof day === 'string' ? day : null });
  }
  return restored.flatMap((account) => {
    const day = best.get(account.account_id)?.day;
    return day ? [{ account, day }] : [];
  });
}

/** The accounts the file's notes say were being turned over to match their
 *  kind as it was made (lib/sign-turning.ts), that the file has as a manual
 *  account or one tracked through SimpleFIN or Lunch Flow (only those are
 *  turned over), each with the name it had. In id order. Pure. */
export function turningIn(c: Collected): { account_id: string; name: string }[] {
  const ids = new Set(c.notes.flatMap((n) => turningOverIds(n) ?? []));
  if (ids.size === 0) return [];
  const names = new Map<string, string>();
  for (const m of (c.core.manual_accounts as { account_id?: unknown; name?: unknown }[] | undefined) ?? []) {
    if (typeof m.account_id === 'string') names.set(m.account_id, typeof m.name === 'string' ? m.name : 'An account');
  }
  for (const e of c.entries.get('connector-accounts') ?? []) {
    if (isRecord(e.value)) names.set(e.id, typeof e.value.name === 'string' ? e.value.name : 'An account');
  }
  return [...ids].filter((id) => names.has(id)).sort().map((account_id) => ({ account_id, name: names.get(account_id)! }));
}

/** Each account's first and last day of balance history in the file. */
function historySpans(c: Collected): Map<string, { first: string; last: string }> {
  const out = new Map<string, { first: string; last: string }>();
  for (const s of (c.core.account_history as { account_id: string; points: { date: string }[] }[] | undefined) ?? []) {
    if (s.points.length === 0) continue;
    const dates = s.points.map((p) => p.date).sort();
    out.set(s.account_id, { first: dates[0], last: dates[dates.length - 1] });
  }
  return out;
}

/** A transaction id as the restore writes what names it: a posted bank
 *  row's restored id, as it is otherwise (a manual row's, a file's), or null
 *  for a pending row's, left out with it. `approval` keeps a pending row's
 *  that a posted one replaced, under its restored id (see the header). */
export function rekey(c: Collected, id: string, opts: { approval?: boolean } = {}): string | null {
  if (c.bank.posted.has(id)) return restoredId(id);
  if (c.bank.pending.has(id)) return opts.approval && c.bank.replaced.has(id) ? restoredId(id) : null;
  return id;
}

/** The content key a carried category is kept under (lib/transactions.ts
 *  contentKey, which the page can't load: test/user-restore-plan.test.ts
 *  keeps the two equal). */
export function carriedKey(account_id: string, t: { date: string; amount: number; name: string }): string {
  const descriptor = t.name.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${account_id}|${t.date}|${Math.round(t.amount * 100)}|${descriptor}`;
}

/** The history the file has, by the layer each point is kept in
 *  (lib/history.ts): a point's `layer` where the file says it, else by the
 *  rule a file from before it was written was made by (a recorded balance on
 *  a day with a recorded total is that total's breakdown, else a partial
 *  measurement; an estimate on a day with an estimated total is its
 *  breakdown, else the extension). */
export function historyLayers(c: Collected): Map<string, Map<string, unknown>> {
  const layers = new Map<string, Map<string, unknown>>();
  const put = (layer: string, date: string, value: unknown) => {
    const m = layers.get(layer) ?? new Map<string, unknown>();
    m.set(date, value);
    layers.set(layer, m);
  };
  const totals = (c.core.net_worth_history as { points: { date: string; total: number; kind: string }[] } | undefined)?.points ?? [];
  const recordedTotal = new Set<string>();
  const estimatedTotal = new Set<string>();
  for (const p of totals) {
    put(p.kind === 'recorded' ? 'net-worth' : 'net-worth:est', p.date, p.total);
    (p.kind === 'recorded' ? recordedTotal : estimatedTotal).add(p.date);
  }
  const maps = new Map<string, Map<string, Record<string, number>>>();
  const add = (layer: string, date: string, id: string, balance: number) => {
    const byDay = maps.get(layer) ?? new Map<string, Record<string, number>>();
    const m = byDay.get(date) ?? {};
    m[id] = balance;
    byDay.set(date, m);
    maps.set(layer, byDay);
  };
  for (const s of (c.core.account_history as { account_id: string; points: { date: string; balance: number; kind: string; layer?: string }[] }[] | undefined) ?? []) {
    for (const p of s.points) {
      const layer =
        p.kind === 'recorded'
          ? p.layer === 'partial' || (p.layer === undefined && !recordedTotal.has(p.date))
            ? 'accounts:partial'
            : 'accounts'
          : p.layer === 'extended' || (p.layer === undefined && !estimatedTotal.has(p.date))
            ? 'accounts:est:ext'
            : 'accounts:est';
      add(layer, p.date, s.account_id, p.balance);
    }
  }
  for (const [layer, byDay] of maps) for (const [date, m] of byDay) put(layer, date, m);
  const flat = c.core.estimate_flat as { days: { date: string; balances: Record<string, number> }[]; before_days: Record<string, number> | null } | undefined;
  for (const d of flat?.days ?? []) put('accounts:est:flatd', d.date, d.balances);
  if (flat?.before_days) put('accounts:est:flat', 'before', flat.before_days);
  return layers;
}

/** The days of history the file brings back, recorded or estimated, or null. */
export function historySpan(c: Collected): { first: string; last: string } | null {
  const days = [...historyLayers(c)].flatMap(([layer, m]) => (layer === 'accounts:est:flat' ? [] : [...m.keys()])).sort();
  return days.length > 0 ? { first: days[0], last: days[days.length - 1] } : null;
}

/** A batch's records for one part, and its name: see PART_ORDER. */
export type PartRecords = { part: string; records: unknown[] };

const byId = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** A map store's entries re-keyed (see the header): what a record keyed by a
 *  transaction says, under the id the restore writes it. */
function rekeyedEntries(c: Collected, name: string): { records: unknown[]; dropped: number } {
  const out: { id: string; value: unknown }[] = [];
  let dropped = 0;
  for (const e of c.entries.get(name) ?? []) {
    if (name === 'transaction-groups') {
      const g = e.value as { members?: unknown };
      if (!isRecord(g) || !Array.isArray(g.members)) {
        out.push(e);
        continue;
      }
      const members = (g.members as string[]).map((m) => rekey(c, m)).filter((m): m is string => m !== null);
      // A group of a pending row and one other is no group without it.
      if (members.length < 2) {
        dropped++;
        continue;
      }
      out.push({ id: e.id, value: { ...g, members } });
      continue;
    }
    const id = rekey(c, e.id, { approval: name === 'transaction-approvals' });
    if (id === null) {
      dropped++;
      continue;
    }
    out.push({ id, value: e.value });
  }
  return { records: byId(out), dropped };
}

const TXN_KEYED = new Set(['transaction-annotations', 'transaction-splits', 'transaction-groups', 'transaction-approvals']);

/** The parts written from what is held in memory, before the large parts
 *  (`before`) and after them (`after`), each part's records in a fixed order,
 *  and what each left out. */
export function smallParts(c: Collected, restoredAt: { restored: RestoredAccountFacts[]; directory: { id: string; value: Record<string, unknown> }[] }): {
  before: PartRecords[];
  after: PartRecords[];
  left_out: Record<string, number>;
} {
  const left_out: Record<string, number> = {};
  const value = (name: string): PartRecords[] => {
    if (!c.values.has(name) || SEAM[name]?.restore !== 'write') return [];
    const v = c.values.get(name);
    return v === null || v === undefined ? [] : [{ part: `store:${name}`, records: [{ value: v }] }];
  };
  const entries = (name: string): PartRecords[] => {
    if (SEAM[name]?.restore !== 'write') return [];
    if (TXN_KEYED.has(name)) {
      const { records, dropped } = rekeyedEntries(c, name);
      if (dropped > 0) left_out[`${name}:pending`] = dropped;
      return records.length > 0 ? [{ part: `store:${name}`, records }] : [];
    }
    const list = byId(c.entries.get(name) ?? []);
    return list.length > 0 ? [{ part: `store:${name}`, records: list }] : [];
  };
  const legacy = (part: string, records: unknown[]): PartRecords[] => (records.length > 0 ? [{ part, records }] : []);

  // Accounts.
  const manual = ((c.core.manual_accounts as Record<string, unknown>[] | undefined) ?? []).map((m) => ({
    id: m.account_id as string,
    value: {
      account_id: m.account_id,
      name: m.name,
      institution_name: m.institution_name,
      type: m.type,
      subtype: m.subtype,
      balance: m.balance,
      // "No time" reads back as no time (lib/manual.ts fills in the epoch).
      updated_at: (m.updated_at as string | null) ?? new Date(0).toISOString(),
      ...(typeof m.currency === 'string' ? { currency: m.currency } : {}),
    },
  }));
  const restored = restoredAt.restored.map((a) => ({
    id: a.account_id,
    value: {
      version: 1,
      item_id: a.item_id,
      institution_id: a.institution_id,
      institution_name: a.institution_name,
      name: a.name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      currency: a.currency,
      rows: a.rows,
      downloaded: a.downloaded,
    },
  }));
  const hidden = ((c.core.hidden_accounts as { account_id: string; type: string; hidden_at: string | null }[] | undefined) ?? []).map((h) => ({
    id: h.account_id,
    value: { type: h.type, hidden_at: h.hidden_at ?? new Date(0).toISOString() },
  }));
  const links = c.core.account_links as
    | {
        links: { earlier_account_id: string; account_id: string; linked_at: string; evidence: Record<string, unknown> }[];
        declined_suggestions: { earlier_account_id: string; account_id: string | null; declined_at: string }[];
        carried_categories: { earlier_account_id: string; rows: { date: string; amount: number | null; description: string; category: string | null }[] }[];
      }
    | undefined;
  const linkRecords = (links?.links ?? []).map((l) => ({ id: l.earlier_account_id, value: { to: l.account_id, linked_at: l.linked_at, evidence: l.evidence } }));
  const declined = (links?.declined_suggestions ?? []).map((d) => ({ id: `${d.earlier_account_id}>${d.account_id ?? '*'}`, value: d.declined_at }));
  let carriedOut = 0;
  const carried = (links?.carried_categories ?? []).flatMap((e) => {
    const rows: Record<string, string | null> = {};
    for (const r of e.rows) {
      if (r.amount === null) {
        carriedOut++;
        continue;
      }
      rows[carriedKey(e.earlier_account_id, { date: r.date, amount: r.amount, name: r.description })] = r.category;
    }
    return Object.keys(rows).length > 0 ? [{ id: e.earlier_account_id, value: rows }] : [];
  });
  if (carriedOut > 0) left_out.carried_categories_without_amount = carriedOut;

  const before: PartRecords[] = [
    ...value('categories'),
    ...value('tags'),
    ...value('rules'),
    ...legacy('manual-accounts', byId(manual)),
    ...legacy('directory', byId(restoredAt.directory)),
    ...legacy('restored-accounts', byId(restored)),
    ...entries('restored-accounts'),
    ...entries('connector-connections'),
    ...entries('connector-accounts'),
    ...entries('connector-ended'),
    ...legacy('hidden', byId(hidden)),
    ...entries('account-lifecycle'),
    // What was answered about the accounts restored there (lib/user-restore/
    // answers.ts): beside the accounts, ends and connector accounts it names.
    ...entries('restored-answers'),
    ...legacy('links', byId(linkRecords)),
    ...legacy('declined', byId(declined)),
  ];

  // What was said.
  let overridesOut = 0;
  const overrides = ((c.core.category_overrides as { transaction_id: string; category: string }[] | undefined) ?? []).flatMap((o) => {
    const id = rekey(c, o.transaction_id);
    if (id === null) {
      overridesOut++;
      return [];
    }
    return [{ id, value: o.category }];
  });
  if (overridesOut > 0) left_out['category_overrides:pending'] = overridesOut;
  const renames = ((c.core.merchant_renames as { vendor_key: string; name: string }[] | undefined) ?? []).map((r) => ({ id: r.vendor_key, value: r.name }));

  // Budgets and goals.
  const budgetRecords: unknown[] = [];
  const budgetRows = c.core.budgets as { category: string | null; monthly_amount: number; category_id: string | null }[] | null | undefined;
  const groupRows = c.core.group_budgets as { group: string | null; monthly_amount: number; group_id: string | null }[] | null | undefined;
  if (Array.isArray(budgetRows)) {
    const taxonomy = c.values.get('categories');
    if (isTaxonomy(taxonomy)) {
      const categories: Record<string, { amount: number }> = {};
      for (const b of budgetRows) if (b.category_id !== null) categories[b.category_id] = { amount: b.monthly_amount };
      const groups: Record<string, { amount: number }> = {};
      for (const g of groupRows ?? []) if (g.group_id !== null) groups[g.group_id] = { amount: g.monthly_amount };
      const copy = legacyCopy({ categories, groups }, indexTaxonomy(taxonomy));
      budgetRecords.push({ set: { version: 1, categories, groups, mirror: copy, mirror_before: null }, copy });
    } else {
      // Categories never stored: the budgets by name alone, which the app's
      // first read moves to categories (lib/budget-store.ts), as it does for
      // any copy that predates them.
      const copy: Record<string, number> = {};
      for (const b of budgetRows) if (b.category !== null) copy[b.category] = (copy[b.category] ?? 0) + b.monthly_amount;
      if (Object.keys(copy).length > 0) budgetRecords.push({ set: null, copy });
    }
  }
  const goals = c.core.goals as { id: string; name: string; target: number; account_id: string | null }[] | null | undefined;
  const goalRecords = Array.isArray(goals) && goals.length > 0 ? [{ value: goals.map((g) => ({ id: g.id, name: g.name, target: g.target, account_id: g.account_id })) }] : [];

  // History, a layer at a time, by day.
  const history: PartRecords[] = [];
  for (const [layer, m] of historyLayers(c)) {
    if (layer === 'accounts:est:flat') {
      history.push({ part: 'history:accounts:est:flat', records: [{ value: m.get('before') }] });
      continue;
    }
    const records = [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, v]) => ({ date, value: v }));
    if (records.length > 0) history.push({ part: `history:${layer}`, records });
  }
  // Each day's breakdowns before its totals, as recordSnapshot writes them
  // (lib/history.ts restoreHistoryDays): a total read beside its day's
  // balances never finds them missing.
  const order = ['accounts', 'accounts:partial', 'accounts:est', 'accounts:est:ext', 'accounts:est:flatd', 'accounts:est:flat', 'net-worth', 'net-worth:est'];
  history.sort((a, b) => order.indexOf(a.part.slice('history:'.length)) - order.indexOf(b.part.slice('history:'.length)));

  const after: PartRecords[] = [
    ...entries('import-settings'),
    ...entries('app-imports'),
    ...legacy('overrides', byId(overrides)),
    ...legacy('renames', byId(renames)),
    ...legacy('carried-categories', byId(carried)),
    ...entries('transaction-annotations'),
    ...entries('carried-annotations'),
    ...entries('imported-twins'),
    ...entries('carried-imported-twins'),
    ...entries('transaction-splits'),
    ...entries('transaction-groups'),
    ...entries('transaction-approvals'),
    ...value('vendor-defaults'),
    ...value('review-settings'),
    ...legacy('budgets', budgetRecords),
    ...value('budget-months'),
    ...value('income-carryover'),
    ...legacy('goals', goalRecords),
    ...entries('goal-plans'),
    ...value('planned-items'),
    ...history,
    ...entries('timeline-notes'),
    ...value('fire-plan'),
    ...value('fire-plan-currency'),
    ...entries('plan-scenarios'),
    ...value('allocation-settings'),
    ...value('report-settings'),
    ...entries('runway-scenarios'),
    ...value('currency-settings'),
    ...value('weekly-summary'),
    // The accounts the file says were being turned over to match their kind
    // (lib/sign-turning.ts), last: the finish plans each one's repair from
    // the history written by then (lib/sign-repair.ts planRestoredRepairs).
    ...legacy('sign-turning', turningIn(c).map(({ account_id }) => ({ id: account_id }))),
  ];
  if (c.bank.pending.size > 0) left_out.pending_transactions = c.bank.pending.size;
  if (c.never.api_tokens > 0) left_out.api_tokens = c.never.api_tokens;
  if ((c.never.attachments ?? 0) > 0) left_out.attachments = c.never.attachments!;
  if (c.never.sharing > 0) left_out.sharing_connections = c.never.sharing;
  // The other copy's record of what its API tokens changed: about that copy,
  // whose tokens don't come back (lib/user-restore/parts.ts), counted so the
  // preview says it.
  const changes = c.entries.get('api-changes')?.length ?? 0;
  if (changes > 0) left_out.api_changes = changes;
  return { before, after, left_out };
}

/** A restored bank row as the batch carries it (lib/user-restore/check.ts
 *  `restored-rows`): the server gives it its import and its time. */
export const restoredRowOf = (t: Record<string, unknown>): { id: string; account_id: string; bank: Record<string, unknown> } => ({
  id: restoredId(t.transaction_id as string),
  account_id: t.account_id as string,
  bank: bankFieldsOf(t) as unknown as Record<string, unknown>,
});

/** An investment transaction's part, and its coverage, as kept for its
 *  connection (lib/user-restore/store.ts restored-investment-transactions). */
export { investmentPartId, investmentCoverageId, restoredBookId };

// ---- Batches ----

/** UTF-8 bytes of a string, without encoding it. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** A batch's body, exactly the bytes the page hashes and the server reads. */
export const batchBody = (part: string, records: readonly string[]): string => `{"part":${JSON.stringify(part)},"records":[${records.join(',')}]}`;

/** Gathers one part's records, each its JSON, into batches under
 *  BATCH_BYTES: a record alone past it is a batch of its own (the route
 *  takes a little more, MAX_BATCH_BODY). */
export class Batcher {
  private part: string | null = null;
  private records: string[] = [];
  private bytes = 0;
  constructor(private readonly emit: (part: string, body: string, count: number) => void | Promise<void>) {}
  async add(part: string, record: unknown): Promise<void> {
    const json = JSON.stringify(record);
    const size = utf8Bytes(json) + 1;
    if (this.part !== null && (this.part !== part || this.bytes + size > BATCH_BYTES - 100)) await this.flush();
    this.part = part;
    this.records.push(json);
    this.bytes += size;
  }
  async flush(): Promise<void> {
    if (this.part === null || this.records.length === 0) return;
    const part = this.part;
    const records = this.records;
    this.part = null;
    this.records = [];
    this.bytes = 0;
    await this.emit(part, batchBody(part, records), records.length);
  }
}
