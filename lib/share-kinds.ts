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
//     ("history", one point a week); with or without the accounts behind it,
//     each with its balance (`accounts`).
//   - spending: money out by category group, or by group and category (`by`),
//     for this month so far and the five before, as percentages of each
//     month's spending ("shares") or amounts ("amounts"). Never money in, the
//     transactions behind it, or how many there were.
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

/** What a showing showed of the other kinds: each kind, at the detail it was
 *  shown at (the widest in a quarter hour, or a day). */
export type ViewsRead = Partial<Record<ViewKind, string>>;

/** Whether `v` is one: known kinds, each at a detail of its ladder. A kind or
 *  a detail this release doesn't know makes the record unrecognised, never
 *  read as less than it says (lib/access-log.ts). */
export function isViewsRead(v: unknown): v is ViewsRead {
  return isPlain(v) && Object.entries(v).every(([kind, detail]) => oneOf(kind, VIEW_KINDS) && oneOf(detail, VIEW_DETAILS[kind]));
}

/** The wider of two details of one kind: the one that shows more. */
export function widerDetail(kind: ViewKind, a: string, b: string): string {
  const ladder: readonly string[] = VIEW_DETAILS[kind];
  return ladder.indexOf(a) >= ladder.indexOf(b) ? a : b;
}

/** `a` with `b` merged in, each kind at the wider of the two. */
export function mergeViewsRead(a: ViewsRead | undefined, b: ViewsRead | undefined): ViewsRead {
  const out: ViewsRead = { ...a };
  for (const [kind, detail] of Object.entries(b ?? {}) as [ViewKind, string][]) out[kind] = out[kind] ? widerDetail(kind, out[kind]!, detail) : detail;
  return out;
}

// ---- What the viewer is shown of each (lib/share-views.ts) ----

/** A kind whose owner's data can't be read just now: it says so, never a
 *  short figure in its place. */
export type Unreadable = { unreadable: true };
export const isUnreadable = (v: unknown): v is Unreadable => isPlain(v) && v.unreadable === true;

/** One account behind a net worth: as its own share labels it, with its
 *  newest measured balance (Plaid's sign: a card's or a loan's is owed). */
export type NetWorthAccount = { label: string; balance: number; currency: string | null; debt: boolean; as_of: string | null };

export type NetWorthView = {
  detail: NetWorthShare['detail'];
  /** The currency the total is in: the one most accounts are in. */
  currency: string | null;
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
  /** With the accounts behind it: each one counted now. */
  accounts?: NetWorthAccount[];
};

/** A line of spending: its share of the month's spending (a whole percent),
 *  and, at "amounts", the amount. */
export type SpendingLine = { name: string; pct: number | null; amount?: number };
export type SpendingGroup = SpendingLine & { categories?: SpendingLine[] };
export type SpendingMonth = {
  /** YYYY-MM. */
  month: string;
  /** This month: what is spent so far. */
  so_far: boolean;
  /** At "amounts": the month's spending. */
  total?: number;
  groups: SpendingGroup[];
  /** What was left out of it for being in another currency, in words. */
  left_out: string | null;
};
export type SpendingView = {
  detail: SpendingShare['detail'];
  by: SpendingShare['by'];
  currency: string | null;
  /** Newest first. */
  months: SpendingMonth[];
  /** Some transactions aren't all in yet (a bank still bringing in its older
   *  history, or one not synced yet), so a month may be short. */
  may_be_incomplete?: true;
};

export type HoldingsLine = { slot: string; name: string; pct: number | null; amount?: number };
export type HoldingsPosition = { ticker: string | null; name: string | null; class: string; pct: number | null; amount?: number };
export type HoldingsView = {
  detail: HoldingsShare['detail'];
  currency: string | null;
  /** The newest day positions were recorded on, and the newest balance. */
  as_of: string | null;
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
export type BudgetLine = { name: string; pct: number | null; over: boolean; spent?: number; limit?: number };
export type BudgetGroup = BudgetLine & { categories?: BudgetLine[] };
export type BudgetsMonth = {
  month: string;
  total: BudgetLine;
  groups: BudgetGroup[];
  left_out: string | null;
  /** The month's transactions may be incomplete, as the Budgets tab says. */
  may_be_incomplete: boolean;
};
export type BudgetsView = {
  detail: BudgetsShare['detail'];
  by: BudgetsShare['by'];
  currency: string | null;
  /** This month, then last month. */
  months: BudgetsMonth[];
};

export type GoalLine = {
  name: string;
  /** As the Goals card says it (lib/goal-view.ts), but 'hidden', which is
   *  never shown: such a goal is left out while its account is hidden. */
  state: 'tracked' | 'untracked' | 'ended' | 'owed' | 'no_balance' | 'disconnected' | 'unavailable';
  /** Saved as a whole percent of the target; null unless tracked. */
  pct: number | null;
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

/** What a showing of these showed (ViewsRead): each kind that was read, at
 *  its detail. One that couldn't be read showed nothing, so isn't in it. */
export function viewsReadOf(views: SharedViews | undefined): ViewsRead {
  const out: ViewsRead = {};
  for (const kind of VIEW_KINDS) {
    const v = views?.[kind];
    if (v && !isUnreadable(v)) out[kind] = v.detail;
  }
  return out;
}

/** A whole percent of `part` in `whole`, or null when the whole is nothing
 *  or less (a share of it means nothing). */
export function pctOf(part: number, whole: number): number | null {
  return whole > 0 && Number.isFinite(part) ? Math.round((part / whole) * 100) : null;
}
