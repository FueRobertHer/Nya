// lib/share-kinds.ts
//
// The other kinds of share (#45 step 3), beside the per-account shares of
// lib/sharing.ts: someone's net worth, spending, holdings, budgets and chosen
// goals, each opt-in and read-only, each at a level of its own. What the
// owner chooses (their settings), what the viewer is shown of each kind (the
// projections lib/share-views.ts builds), and what a record of showings keeps
// of them. Free of server imports, like lib/share-rules.ts: the Sharing
// drawer, the "Shared by" card and the access log's store all read it.
//
// THE KINDS AND THEIR LEVELS, narrowest first in each ladder:
//   - net_worth: the total now ("total"), or the total and its history
//     ("history", one point a week), always as amounts; with or without the
//     accounts in it whose balances are shared (`accounts`): an account's
//     balance is shown only where its own share shows it, never through this.
//   - spending: money out by category group, or by group and category (`by`),
//     for this month so far and the five before, as percentages of each
//     month's spending ("shares") or amounts ("amounts"). Never money in, the
//     transactions behind it, or how many there were (what another currency
//     left out is named by its currency alone).
//   - holdings: allocation by asset class and by tax bucket, as percentages
//     or amounts, with or without the positions behind it (`positions`), never
//     an account's name or number.
//   - budgets: this month's and last month's budgets by group, or by group and
//     category, as how much of each is spent ("progress") or amounts.
//   - goals: the goals chosen, by id, each with its progress and when it is
//     projected to be reached, as percentages ("progress") or amounts.
//
// SETTINGS ARE READ CLOSED. A kind is shared only when its whole setting is
// one this release knows: a kind it doesn't know, a level it doesn't know, or
// any field more or less than it expects reads as that kind not shared. A
// later release that narrows a kind with a field this one doesn't know is
// never read by this one as sharing more: this one shares none of it.
// (Storage, and what a release from before kinds reads: lib/sharing.ts.)

import type { ProjectionStatus } from './goal-projection';

export const VIEW_KINDS = ['net_worth', 'spending', 'holdings', 'budgets', 'goals'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

/** Each kind's ladder, narrowest first. */
export const VIEW_DETAILS = {
  net_worth: ['total', 'history'],
  spending: ['shares', 'amounts'],
  holdings: ['shares', 'amounts'],
  budgets: ['progress', 'amounts'],
  goals: ['progress', 'amounts'],
} as const satisfies Record<ViewKind, readonly string[]>;

export type NetWorthShare = { detail: 'total' | 'history'; accounts: boolean };
export type SpendingShare = { detail: 'shares' | 'amounts'; by: 'group' | 'category' };
export type HoldingsShare = { detail: 'shares' | 'amounts'; positions: boolean };
export type BudgetsShare = { detail: 'progress' | 'amounts'; by: 'group' | 'category' };
export type GoalsShare = { detail: 'progress' | 'amounts'; goals: string[] };

/** What one person shares on a connection beyond accounts: each kind they
 *  share, with its level; a kind left out isn't shared. */
export type ShareViews = {
  net_worth?: NetWorthShare;
  spending?: SpendingShare;
  holdings?: HoldingsShare;
  budgets?: BudgetsShare;
  goals?: GoalsShare;
};

/** The most goals one share can name: as many as anyone can have
 *  (lib/goal-model.ts MAX_GOALS). */
export const MAX_SHARED_GOALS = 20;
/** A goal id a share can name: the storage seam's characters, as long as a
 *  goal's id can be (lib/goal-model.ts MAX_GOAL_ID_CHARS). Goal ids are
 *  random, so naming one says nothing of the goal. */
export const SHARED_GOAL_ID = /^[A-Za-z0-9_.:-]{1,40}$/;

/** How many months spending is shared for: this month so far and the five
 *  before it. */
export const SPENDING_MONTHS = 6;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Exactly these keys, no more and no fewer. */
const hasKeys = (v: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
};
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);

/**
 * Why one kind's setting can't be used, or null when it can. Closed (see the
 * header): exactly the fields the kind has, each a value this release knows.
 * Goals must name at least one goal, each once.
 */
export function viewProblem(kind: ViewKind, v: unknown): string | null {
  if (!isPlain(v)) return 'must be an object';
  switch (kind) {
    case 'net_worth':
      if (!hasKeys(v, ['detail', 'accounts'])) return 'takes detail and accounts';
      if (!oneOf(v.detail, VIEW_DETAILS.net_worth)) return 'has an unknown detail';
      return typeof v.accounts === 'boolean' ? null : 'takes accounts as true or false';
    case 'spending':
    case 'budgets':
      if (!hasKeys(v, ['detail', 'by'])) return 'takes detail and by';
      if (!oneOf(v.detail, VIEW_DETAILS[kind])) return 'has an unknown detail';
      return oneOf(v.by, ['group', 'category'] as const) ? null : 'takes by as group or category';
    case 'holdings':
      if (!hasKeys(v, ['detail', 'positions'])) return 'takes detail and positions';
      if (!oneOf(v.detail, VIEW_DETAILS.holdings)) return 'has an unknown detail';
      return typeof v.positions === 'boolean' ? null : 'takes positions as true or false';
    case 'goals': {
      if (!hasKeys(v, ['detail', 'goals'])) return 'takes detail and goals';
      if (!oneOf(v.detail, VIEW_DETAILS.goals)) return 'has an unknown detail';
      const ids = v.goals;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SHARED_GOALS) return `names between 1 and ${MAX_SHARED_GOALS} goals`;
      if (!ids.every((id) => typeof id === 'string' && SHARED_GOAL_ID.test(id))) return 'names a goal by an id that isn’t one';
      return new Set(ids).size === ids.length ? null : 'names a goal twice';
    }
  }
}

/**
 * A change's kinds, as a route takes them: an object naming known kinds,
 * each a setting viewProblem accepts or null (not shared). The words of the
 * first problem, or null when there is none.
 */
export function viewsChangeProblem(raw: unknown): string | null {
  if (!isPlain(raw)) return 'views must be an object of kinds';
  for (const [kind, v] of Object.entries(raw)) {
    if (!oneOf(kind, VIEW_KINDS)) return `${kind.slice(0, 40)} isn’t a kind of share`;
    if (v === null) continue;
    const problem = viewProblem(kind, v);
    if (problem) return `${KIND_NAME[kind]} ${problem}`;
  }
  return null;
}

/** The kinds a change names, as settings (null: not shared). Assumes
 *  viewsChangeProblem found nothing. */
export function viewsOfChange(raw: Record<string, unknown>): ShareViews {
  const out: Record<string, unknown> = {};
  for (const kind of VIEW_KINDS) {
    const v = raw[kind];
    if (v === null || v === undefined) continue;
    out[kind] = kind === 'goals' ? { detail: (v as GoalsShare).detail, goals: [...(v as GoalsShare).goals] } : { ...(v as object) };
  }
  return out as ShareViews;
}

/**
 * The kinds a stored share holds, read closed (see the header): each kind
 * this release knows whose setting it can use, and nothing else, so what it
 * can't read is shared as nothing. Never throws.
 */
export function parseViews(raw: unknown): ShareViews {
  if (!isPlain(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const kind of VIEW_KINDS) {
    const v = raw[kind];
    if (v !== undefined && viewProblem(kind, v) === null) out[kind] = kind === 'goals' ? { ...(v as GoalsShare), goals: [...(v as GoalsShare).goals] } : { ...(v as object) };
  }
  return out as ShareViews;
}

/** The kinds shared, in the order they are listed everywhere. */
export const sharedKinds = (views: ShareViews | null | undefined): ViewKind[] => VIEW_KINDS.filter((k) => !!views?.[k]);

/** What each kind is called, on its own and in a sentence. */
export const KIND_NAME: Record<ViewKind, string> = {
  net_worth: 'Net worth',
  spending: 'Spending',
  holdings: 'Holdings',
  budgets: 'Budgets',
  goals: 'Goals',
};
export const KIND_WORDS: Record<ViewKind, string> = {
  net_worth: 'your net worth',
  spending: 'your spending',
  holdings: 'your holdings',
  budgets: 'your budgets',
  goals: 'your goals',
};

// ---- What a record of showings keeps of them ----

/** What a showing showed of the other kinds: each kind as it was shown, its
 *  level and what else it showed (the accounts in a net worth, the
 *  categories, the positions), and of goals, which ones, by id (the widest in
 *  a quarter hour: each detail the wider, each option on if it was on once,
 *  every goal shown). The same shape as the settings, so a record answers
 *  exactly what a setting chose. */
export type ViewsRead = ShareViews;

/** The most goal ids a record's quarter hour keeps: far past the goals
 *  anyone can have (MAX_SHARED_GOALS), for goals deleted and made again in
 *  one quarter hour. A merge never keeps more, so every record this release
 *  writes is one it reads. */
export const MAX_RECORDED_GOALS = 200;

/** Whether `v` is one: known kinds, each closed as a setting is, at a level
 *  of its ladder; goals by ids that can be ones, each once. A kind, a level
 *  or a field this release doesn't know makes the record unrecognised, never
 *  read as less than it says (lib/access-log.ts). */
export function isViewsRead(v: unknown): v is ViewsRead {
  if (!isPlain(v)) return false;
  return Object.entries(v).every(([kind, read]) => {
    if (!oneOf(kind, VIEW_KINDS)) return false;
    if (kind !== 'goals') return viewProblem(kind, read) === null;
    if (!isPlain(read) || !hasKeys(read, ['detail', 'goals']) || !oneOf(read.detail, VIEW_DETAILS.goals)) return false;
    const ids = read.goals;
    return Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_RECORDED_GOALS && ids.every((id) => typeof id === 'string' && SHARED_GOAL_ID.test(id)) && new Set(ids).size === ids.length;
  });
}

/** The wider of two details of one kind: the one that shows more. */
export function widerDetail(kind: ViewKind, a: string, b: string): string {
  const ladder: readonly string[] = VIEW_DETAILS[kind];
  return ladder.indexOf(a) >= ladder.indexOf(b) ? a : b;
}

const widerBy = (a: 'group' | 'category', b: 'group' | 'category') => (a === 'category' || b === 'category' ? 'category' : 'group');

/** `a` with `b` merged in, each kind as the wider of the two: the wider
 *  detail, each option on if either had it, and the goals of both. */
export function mergeViewsRead(a: ViewsRead | undefined, b: ViewsRead | undefined): ViewsRead {
  const out: ViewsRead = { ...a };
  const x = b ?? {};
  if (x.net_worth) {
    const o = out.net_worth;
    out.net_worth = o ? { detail: widerDetail('net_worth', o.detail, x.net_worth.detail) as NetWorthShare['detail'], accounts: o.accounts || x.net_worth.accounts } : { ...x.net_worth };
  }
  if (x.spending) {
    const o = out.spending;
    out.spending = o ? { detail: widerDetail('spending', o.detail, x.spending.detail) as SpendingShare['detail'], by: widerBy(o.by, x.spending.by) } : { ...x.spending };
  }
  if (x.holdings) {
    const o = out.holdings;
    out.holdings = o ? { detail: widerDetail('holdings', o.detail, x.holdings.detail) as HoldingsShare['detail'], positions: o.positions || x.holdings.positions } : { ...x.holdings };
  }
  if (x.budgets) {
    const o = out.budgets;
    out.budgets = o ? { detail: widerDetail('budgets', o.detail, x.budgets.detail) as BudgetsShare['detail'], by: widerBy(o.by, x.budgets.by) } : { ...x.budgets };
  }
  if (x.goals) {
    const o = out.goals;
    const ids = [...new Set([...(o?.goals ?? []), ...x.goals.goals])].sort().slice(0, MAX_RECORDED_GOALS);
    out.goals = { detail: (o ? widerDetail('goals', o.detail, x.goals.detail) : x.goals.detail) as GoalsShare['detail'], goals: ids };
  }
  return out;
}

/** The kinds shown on a day of a record, as the drawer is sent them
 *  (lib/share-rules.ts ShownDay): as ViewsRead, but how many goals rather
 *  than which, as a day counts accounts rather than naming them. */
export type DayViews = Omit<ViewsRead, 'goals'> & { goals?: { detail: GoalsShare['detail']; count: number } };

/** A day's ViewsRead as DayViews. */
export function dayViewsOf(read: ViewsRead): DayViews {
  const { goals, ...rest } = read;
  return goals ? { ...rest, goals: { detail: goals.detail, count: goals.goals.length } } : rest;
}

// ---- What the viewer is shown of each (lib/share-views.ts) ----

/** A kind whose owner's data can't be read just now: it says so, never a
 *  short figure in its place. */
export type Unreadable = { unreadable: true };
export const isUnreadable = (v: unknown): v is Unreadable => isPlain(v) && v.unreadable === true;

/** A figure converted into the owner's home currency (decision 5): at the
 *  ECB's daily rates alone, never the owner's own (lib/share-views.ts), and
 *  never a rate's value. */
export type SharedConversion = { rates: 'ecb' };

/** One account behind a net worth: as its own share labels it, with its
 *  newest measured balance (Plaid's sign: a card's or a loan's is owed). */
export type NetWorthAccount = {
  label: string;
  balance: number;
  currency: string | null;
  debt: boolean;
  as_of: string | null;
};

export type NetWorthView = {
  detail: NetWorthShare['detail'];
  /** The currency the total is in: the one most accounts are in, or the
   *  owner's home currency once they chose one (`converted`). */
  currency: string | null;
  /** The total, and the history, converted into it at the ECB's rates, as
   *  the owner's own net worth is but never at their own rates;
   *  `other_currencies` are then the ones with no public rate. */
  converted?: SharedConversion;
  /** Each account's newest measured balance added up, in `currency`. Null
   *  with no account to count. */
  total: number | null;
  /** The newest and the oldest day among the balances added up. */
  as_of: string | null;
  from: string | null;
  /** Accounts left out of the total for being in another currency, by currency. */
  other_currencies: { currency: string; accounts: number }[];
  /** Accounts left out of it for having no balance yet. */
  without_balance: number;
  /** At "history": one point a week (the last day of each with one), oldest
   *  first, as the owner's chart draws them; `estimated` for a point
   *  reconstructed from transactions rather than recorded. */
  history?: { date: string; value: number; estimated?: true }[];
  /** The history adds accounts in other currencies as they are, as the
   *  owner's own chart does. */
  history_mixed?: true;
  /** With its accounts: each one counted now whose balance the share of
   *  accounts shows (at Balance, or Balance and transactions). */
  accounts?: NetWorthAccount[];
};

// Every percentage is sent with `label`, the words it is shown in, worked
// out on the server, which knows the amount at every level: money that is
// there never reads 0% ("<1%"), and a share short of the whole never reads
// 100% (">99%"), the rule the Plan tab's allocation follows
// (lib/allocation/allocation.ts shareLabel). `pct` is the bar's length.

/** A line of spending: its share of the month's spending (a whole percent),
 *  and, at "amounts", the amount. */
export type SpendingLine = { name: string; pct: number | null; label: string | null; amount?: number };
export type SpendingGroup = SpendingLine & { categories?: SpendingLine[] };
export type SpendingMonth = {
  /** YYYY-MM. */
  month: string;
  /** This month: what is spent so far. */
  so_far: boolean;
  /** At "amounts": the month's spending. */
  total?: number;
  groups: SpendingGroup[];
  /** What was left out of it for being in another currency, by currency
   *  alone, in words: never how many, nor any money in. */
  left_out: string | null;
  /** Whether the owner left some of the month's transactions out of their
   *  totals couldn't be read: those are counted, as the owner's own Activity
   *  tab counts them, and it says so. */
  exclusions_unknown?: true;
};
export type SpendingView = {
  detail: SpendingShare['detail'];
  by: SpendingShare['by'];
  /** The one most transactions are in, or the owner's home currency. */
  currency: string | null;
  /** Converted into the owner's home currency, as their Activity tab counts
   *  it: each month's `left_out` is then what has no rate. */
  converted?: SharedConversion;
  /** Newest first. */
  months: SpendingMonth[];
  /** Some transactions aren't all in yet (a bank still bringing in its older
   *  history, one not synced yet, or a bank account or card whose
   *  transactions don't come in), so a month may be short. */
  may_be_incomplete?: true;
  /** The exclusions the owner carried across a reconnected account couldn't
   *  be read: the transactions may count. */
  exclusions_unread?: true;
  /** Some of how the owner files transactions couldn't be read just now (see
   *  FilingUnread): some spending may be filed otherwise than they file it. */
  filing_unread?: true;
};

// FilingUnread: what files a row that couldn't be read, so the read layer
// (lib/activity.ts finishActivity) files the row without it, and the owner's
// own screens say so in their notes: the categories they chose for rows,
// their merchants' default categories (lib/vendor-default-store.ts), or
// their approvals of rows in the review queue (lib/review-store.ts), which
// keep a row where it was approved. A total is then whole, but some of it
// may be under another category than the owner's.

export type HoldingsLine = { slot: string; name: string; pct: number | null; label: string | null; amount?: number };
export type HoldingsPosition = { ticker: string | null; name: string | null; class: string; pct: number | null; label: string | null; amount?: number };
export type HoldingsView = {
  detail: HoldingsShare['detail'];
  /** The one most accounts are in, or the owner's home currency. */
  currency: string | null;
  /** Converted into the owner's home currency at the newest rates. */
  converted?: SharedConversion;
  /** The newest and the oldest day among the positions last recorded and the
   *  balances counted. */
  as_of: string | null;
  from: string | null;
  /** At "amounts": everything counted. */
  total?: number;
  classes: HoldingsLine[];
  buckets: HoldingsLine[];
  /** With positions: each security across the accounts, largest first. */
  positions?: HoldingsPosition[];
  /** What it can't classify or count, in words that name no account. */
  notes: string[];
};

/** A budget: how much of what is available is spent (a whole percent; null
 *  when nothing is available), whether it is over, and at "amounts" the two. */
export type BudgetLine = { name: string; pct: number | null; label: string | null; over: boolean; spent?: number; limit?: number };
export type BudgetGroup = BudgetLine & { categories?: BudgetLine[] };
export type BudgetsMonth = {
  month: string;
  total: BudgetLine;
  groups: BudgetGroup[];
  /** As spending's: by currency alone. */
  left_out: string | null;
  /** What is spent in the month may be off, as the Budgets tab says: some of
   *  its transactions may not all be in, or what was said of some couldn't
   *  be read. */
  may_be_incomplete: boolean;
};
export type BudgetsView = {
  detail: BudgetsShare['detail'];
  by: BudgetsShare['by'];
  /** The currency the budgets are in, as the owner typed them. */
  currency: string | null;
  /** With the owner's home currency: spending in other currencies counts
   *  against them converted into `currency`, as their Budgets tab counts it. */
  converted?: SharedConversion;
  /** This month, then last month. */
  months: BudgetsMonth[];
  /** As spending's (FilingUnread): what is spent may count against another
   *  budget than the owner's filing would. */
  filing_unread?: true;
};

export type GoalLine = {
  name: string;
  /** As the Goals card says it (lib/goal-view.ts), but 'hidden', which is
   *  never shown: such a goal is left out while its account is hidden. */
  state: 'tracked' | 'untracked' | 'ended' | 'owed' | 'no_balance' | 'disconnected' | 'unavailable';
  /** Saved as a whole percent of the target; null unless tracked. */
  pct: number | null;
  label: string | null;
  currency: string | null;
  /** At "amounts". */
  saved?: number;
  target?: number;
  target_date: string | null;
  /** When it is projected to be reached; null unless tracked. Never the
   *  monthly rate behind it. */
  outlook: { status: ProjectionStatus; completion: string | null; beyond: boolean; date_passed: boolean } | null;
  /** The day of the balance it counts. */
  as_of: string | null;
  /** The day its account ended, for 'ended'. */
  ended_on?: string;
};
export type GoalsView = { detail: GoalsShare['detail']; goals: GoalLine[] };

/** Each kind shared, as the viewer is shown it. */
export type SharedViews = {
  net_worth?: NetWorthView | Unreadable;
  spending?: SpendingView | Unreadable;
  holdings?: HoldingsView | Unreadable;
  budgets?: BudgetsView | Unreadable;
  goals?: GoalsView | Unreadable;
};

/** What a showing of these showed (ViewsRead): each kind that was read, as
 *  its setting chose it, and of goals the ones shown (`goalsShown`, by id).
 *  One that couldn't be read showed nothing, so isn't in it. */
export function viewsReadOf(views: SharedViews | undefined, settings: ShareViews, goalsShown: readonly string[] = []): ViewsRead {
  const out: Record<string, unknown> = {};
  for (const kind of VIEW_KINDS) {
    const v = views?.[kind];
    const s = settings[kind];
    if (!v || isUnreadable(v) || !s) continue;
    if (kind === 'goals') {
      if (goalsShown.length > 0) out.goals = { detail: (s as GoalsShare).detail, goals: [...new Set(goalsShown)].sort() };
    } else out[kind] = { ...s };
  }
  return out as ViewsRead;
}

/** A whole percent of `part` in `whole`, or null when the whole is nothing
 *  or less (a share of it means nothing). */
export function pctOf(part: number, whole: number): number | null {
  return whole > 0 && Number.isFinite(part) ? Math.round((part / whole) * 100) : null;
}
