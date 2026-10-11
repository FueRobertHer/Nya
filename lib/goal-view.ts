// lib/goal-view.ts
//
// Each goal as the Goals card and the read-only API show it (#42): whether
// its account can be counted at all, what it counts as saved
// (lib/goal-allocation.ts), and when it will be reached
// (lib/goal-projection.ts). One function for both, so the card and the API
// can't tell a goal's story two ways. Pure, safe to import from client code.
//
// AN ACCOUNT IS COUNTED only when it is there, hasn't ended, isn't hidden,
// holds money (a credit card's or a loan's balance is owed, not saved, so a
// goal on one shows no progress rather than reading a debt as savings) and
// has a balance. Each of the other cases says which it is: no account, ended,
// hidden, disconnected (not among the accounts, which includes one
// forgotten), owed, or no balance yet.
//
// AN ACCOUNT THAT ENDED (lib/lifecycle.ts: closed, no longer the person's, or
// no longer followed, from a day, or assumed closed once its bank stopped
// returning it) counts in nothing from that day, as everywhere in the app: a
// goal on it counts none of its balance, its allocation claims nothing, the
// account has no unallocated line, and the goal isn't projected, since
// nothing more goes into it. Its plan is kept as set: reopened, the account
// counts again, allocation and all. An end is said before hidden: it says
// more.

import { isOwedType } from './balance';
import { splitBalances, type AccountSplit, type AllocAccount, type Claim } from './goal-allocation';
import { flowGaps, measuredRate, project, shouldHave, type AccountFlow, type Measured, type MonthGap, type Projection } from './goal-projection';
import type { Goal } from './goal-model';

/** What the view needs of an account. Balances in the account's currency,
 *  by Plaid's sign (a card's or a loan's is what is owed). */
export type GoalAccount = {
  account_id: string;
  name: string;
  institution?: string;
  balance: number | null;
  currency: string | null;
  /** Plaid's type, or a manual account's. Unknown counts as money held. */
  type?: string;
  hidden?: boolean;
  /** It ended (see AN ACCOUNT THAT ENDED); null or absent while it is open. */
  ended?: GoalAccountEnd | null;
};

/** How an account ended (lib/lifecycle.ts): the day it stopped counting, and
 *  whether Nya assumed it closed, nobody having said, after its bank stopped
 *  returning it. */
export type GoalAccountEnd = { state: 'closed' | 'left' | 'untracked'; on: string; assumed?: boolean };

/** An account that ended, as the app is sent it (lib/lifecycle.ts
 *  LifecycleForClient): one per account, under its current id. */
export type EndedAccountFor = {
  account_id: string;
  lifecycle: { state: 'closed' | 'left'; on: string } | { state: 'untracked'; from: string };
  assumed?: boolean;
  label: { name: string; institution: string };
  type: string | null;
  currency?: string;
};

/**
 * The accounts as the goals know them, each that ended marked with its end:
 * one still listed (a hidden one stays listed) as it is shown, one no longer
 * listed from what its end keeps, with no balance, since from its end it
 * counts in nothing. One reopened is no longer among `ended`, and reads as
 * listed.
 */
export function withAccountEnds(accounts: readonly GoalAccount[], ended: readonly EndedAccountFor[]): GoalAccount[] {
  const endOf = (e: EndedAccountFor): GoalAccountEnd => ({
    state: e.lifecycle.state,
    on: e.lifecycle.state === 'untracked' ? e.lifecycle.from : e.lifecycle.on,
    ...(e.assumed ? { assumed: true } : {}),
  });
  const byId = new Map(ended.map((e) => [e.account_id, e]));
  const out = accounts.map((a) => {
    const e = byId.get(a.account_id);
    return e ? { ...a, ended: endOf(e) } : a;
  });
  const listed = new Set(accounts.map((a) => a.account_id));
  for (const e of ended) {
    if (listed.has(e.account_id)) continue;
    out.push({
      account_id: e.account_id,
      name: e.label.name || 'Account',
      ...(e.label.institution ? { institution: e.label.institution } : {}),
      balance: null,
      currency: e.currency ?? null,
      ...(e.type ? { type: e.type } : {}),
      ended: endOf(e),
    });
  }
  return out;
}

export type GoalState = 'tracked' | 'untracked' | 'hidden' | 'disconnected' | 'ended' | 'owed' | 'no_balance';

export type GoalView = {
  goal: Goal;
  state: GoalState;
  /** The account it tracks, when it is among the accounts. */
  account: GoalAccount | null;
  /** The currency its target, allocation and amounts are in: its account's. */
  currency: string | null;
  /** What it counts as saved; null unless tracked. */
  saved: number | null;
  claim: Claim | null;
  /** Other active goals on the same account, by id. */
  sharing: string[];
  /** The account's rate, from its last complete months. */
  measured: Measured | null;
  /** Every gap over those months, known or not: why the pace may be short,
   *  or isn't known at all. */
  gaps: MonthGap[];
  /** Whose transactions couldn't be read, when it is paced by its recorded
   *  balance for that reason (AccountFlow.fallback). */
  fallback: string | null;
  /** Null unless tracked. */
  projection: Projection | null;
  /** Where it should be by now on the way to its target date. */
  shouldHave: number | null;
};

const archived = (g: Goal) => g.plan?.archived === true;

/** The state of a goal's account (see the header). */
export function accountState(goal: Goal, account: GoalAccount | undefined): GoalState {
  if (!goal.account_id) return 'untracked';
  if (!account) return 'disconnected';
  if (account.ended) return 'ended';
  if (account.hidden) return 'hidden';
  if (account.type && isOwedType(account.type)) return 'owed';
  if (account.balance === null) return 'no_balance';
  return 'tracked';
}

/**
 * Every active (unarchived) goal's view, in the order given, and how each
 * tracked account's balance is split among its goals. `flows` are the
 * accounts' last complete months by account id (lib/goal-flows.ts); null
 * while they aren't known, which projects at the monthly targets alone.
 * `today` is YYYY-MM-DD: the viewer's own day in the app, the UTC day in the
 * API.
 */
export function goalViews(
  goals: readonly Goal[],
  accounts: readonly GoalAccount[],
  flows: ReadonlyMap<string, AccountFlow> | null,
  today: string
): { views: GoalView[]; splits: Map<string, AccountSplit> } {
  const byId = new Map(accounts.map((a) => [a.account_id, a]));
  const active = goals.filter((g) => !archived(g));
  const states = new Map(active.map((g) => [g.id, accountState(g, g.account_id ? byId.get(g.account_id) : undefined)]));
  const tracked = new Map<string, AllocAccount>();
  for (const g of active) {
    if (states.get(g.id) !== 'tracked') continue;
    const a = byId.get(g.account_id!)!;
    tracked.set(a.account_id, { balance: a.balance!, currency: a.currency });
  }
  const { claims, accounts: splits } = splitBalances(
    active.map((g) => ({ id: g.id, account_id: g.account_id, allocation: g.plan?.allocation })),
    tracked
  );
  const views = active.map((goal): GoalView => {
    const state = states.get(goal.id)!;
    const account = goal.account_id ? (byId.get(goal.account_id) ?? null) : null;
    const currency = account?.currency ?? null;
    const sharing = goal.account_id ? active.filter((o) => o.id !== goal.id && o.account_id === goal.account_id).map((o) => o.id) : [];
    const base: GoalView = { goal, state, account, currency, saved: null, claim: null, sharing, measured: null, gaps: [], fallback: null, projection: null, shouldHave: null };
    if (state !== 'tracked') return base;
    const claim = claims.get(goal.id)!;
    const flow = flows?.get(goal.account_id!) ?? null;
    const measured = measuredRate(flow, currency);
    const projection = project({
      target: goal.target,
      saved: claim.amount,
      monthlyTarget: goal.plan?.monthly_target,
      targetDate: goal.plan?.target_date,
      measured,
      shared: sharing.length > 0,
      today,
      currency,
    });
    return {
      ...base,
      saved: claim.amount,
      claim,
      measured,
      gaps: flowGaps(flow),
      fallback: flow?.fallback?.unreadable ?? null,
      projection,
      shouldHave: projection.status === 'complete' ? null : shouldHave(goal.plan_start, goal.target, goal.plan?.target_date, today, currency),
    };
  });
  return { views, splits };
}
