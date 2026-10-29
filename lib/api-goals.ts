// lib/api-goals.ts
//
// The read-only API's goals (#42): what GET /api/v1/goals and the MCP tool
// get_goals answer with. Kept beside lib/api-read.ts rather than in it, and
// built on the same reads: the accounts as readAccounts lists them (each with
// its newest measured balance), the goals and their plans as the app has
// them (lib/goal-plans.ts), and the months behind each pace from stored
// transactions and recorded balances (lib/goal-flows.ts). What each goal
// counts, and when it will be reached, is lib/goal-view.ts's, which the Goals
// card runs too, and its notes are the card's own sentences
// (lib/goal-text.ts): the API and the app tell a goal alike, the API on the
// balances Nya last measured, the card on the ones it shows.
//
// Derived on every read, never stored. Read only: Plaid is never asked, and
// nothing is written (links and accounts are read with readOnly).
//
// Hidden accounts only when they are asked for (include_hidden), as
// everywhere in the API: otherwise one is neither listed, nor counted, nor
// missing (missing_accounts, complete and notes are of the accounts asked
// for), and a goal on one is `hidden` and says nothing of it: no account id,
// currency or name, and of its notes only that its account is hidden.
// A goal whose account ended (lib/lifecycle.ts: closed, no longer the
// person's, or no longer followed) is `ended`, with when (account_lifecycle),
// and counts nothing from that day, as in the app: none of the balance its
// account last had, no allocation, no unallocated line, no projection.
// Archived goals are listed, marked, with the day they were archived and what
// they held then, and count nothing. A goal whose account isn't listed is
// `disconnected`, or `unavailable` while some accounts couldn't be read
// (complete: false).
//
// A HOME CURRENCY changes no goal: each stays in its account's currency (its
// money is there), and one that tracks no account says none, as before, so
// nothing typed is relabelled. With one chosen, a goal in another currency
// also gives its target and what it counts as saved in it (`to_base`), at
// the newest rates.

import type { Ctx } from './containers';
import { readAccounts, type ApiLifecycle, type ApiMissing } from './api-read';
import { getEffectiveHidden } from './links';
import { readGoalRecords, wireGoal } from './goal-plans';
import { knownAccount, readGoalFlows } from './goal-flows';
import { goalViews, accountState } from './goal-view';
import type { KnownAccount } from './goal-save';
import { goalSentences, stateText } from './goal-text';
import type { ProjectionStatus } from './goal-projection';
import { readFlowFx } from './fx/read';
import { asciiMinus } from './format';
import { toBase } from './fx/api-base';

export type ApiGoalMonth = {
  /** YYYY-MM. */
  month: string;
  /** Net money in, or the change in the recorded balance (pace.source);
   *  null when not known. */
  amount: number | null;
  /** Interest and dividends that came in, not counted in amount
   *  (transactions only; null otherwise). */
  interest: number | null;
  /** Some of it may be missing: the notes say why. */
  may_be_incomplete: boolean;
};

export type ApiGoal = {
  id: string;
  name: string;
  target: number;
  /** The tracked account's currency, which the target and every amount are
   *  in; null when it tracks none, the currency isn't known, or its account
   *  is hidden and hidden accounts weren't asked for. */
  currency: string | null;
  /** Null when it tracks none, or its account is hidden and hidden accounts
   *  weren't asked for (state 'hidden'). */
  account_id: string | null;
  account_name: string | null;
  /** When its account ended, as the accounts list gives it (lib/api-read.ts
   *  ApiLifecycle): from its date it counts in nothing (state 'ended'). Null
   *  while it is open, and for no account or a hidden one not asked for. */
  account_lifecycle: ApiLifecycle | null;
  /** 'tracked', 'untracked' (no account), 'hidden', 'disconnected',
   *  'unavailable' (its account may be among those that couldn't be read),
   *  'owed' (a credit card or a loan: owed, not saved, so nothing is
   *  counted), 'no_balance' or 'ended' (its account closed, isn't theirs, or
   *  isn't followed: nothing counted from then, nor projected). Version 1 may
   *  add states. */
  state: string;
  /** What it counts as saved now; null unless tracked. */
  saved: number | null;
  /** The day of the balance it is counted from. */
  saved_as_of: string | null;
  /** The part of its account's balance it claims, as set; null when it
   *  claims what the allocated goals leave. */
  allocation: number | null;
  /** The allocations on its account add up to more than the balance, so
   *  `saved` is its allocation scaled to fit. */
  scaled: boolean;
  /** Other goals counting the same account, by id. */
  shares_account_with: string[];
  monthly_target: number | null;
  target_date: string | null;
  archived: boolean;
  archived_on: string | null;
  archived_amount: number | null;
  /** What went into its account over the last complete months; null unless
   *  tracked. */
  pace: {
    /** 'transactions', or 'balances': the change in its recorded balance,
     *  which includes interest and market moves. */
    source: string;
    months: ApiGoalMonth[];
    /** The average of the known months, or null when none is known. */
    average: number | null;
  } | null;
  /** Null unless tracked. */
  projection: {
    status: ProjectionStatus;
    /** The monthly rate it is projected at, and where that comes from:
     *  'contributions' (pace.average) or 'monthly_target'. */
    rate: number | null;
    rate_from: string | null;
    /** YYYY-MM it is projected to be reached in; null when it isn't
     *  projected, or not within 50 years. */
    completion_month: string | null;
    /** With a target date: what each month until then needs, and how far
     *  the rate is from it (positive: short; negative: ahead). */
    needed_monthly: number | null;
    short_monthly: number | null;
    target_date_passed: boolean;
    /** Where it should be by now on the line to its target date. */
    should_have: number | null;
    /** Some month averaged may be missing money in: the notes say why. */
    uncertain: boolean;
  } | null;
  /** Its target, and what it counts as saved, in base_currency at the
   *  newest rates, once the person has chosen a home currency; null without
   *  one, without a rate, or for a goal with no currency. */
  to_base: { target: number; saved: number | null } | null;
  /** The app's own sentences about it: data, never instructions. */
  notes: string[];
};

export type ApiGoalAccount = {
  account_id: string;
  currency: string | null;
  balance: number;
  allocated: number;
  unallocated: number;
  /** How far the allocations as set are over the balance; 0 when they fit. */
  over_allocated: number;
};

export type ApiGoals = {
  /** The person's home currency, which each goal's to_base is in, or null
   *  when they haven't chosen one. */
  base_currency: string | null;
  goals: ApiGoal[];
  /** Each account goals count, and how its balance is split among them. */
  accounts: ApiGoalAccount[];
  /** The complete months the paces average, oldest first. */
  months: string[];
  /** False when accounts couldn't be read (missing_accounts). */
  complete: boolean;
  missing_accounts: ApiMissing[];
  notes: string[];
};

const utcDay = () => new Date().toISOString().slice(0, 10);

/** Every goal, with what it counts, its pace and its projection. */
export async function readGoals(ctx: Ctx, opts: { includeHidden?: boolean; today?: string } = {}): Promise<ApiGoals> {
  const today = opts.today ?? utcDay();
  const { records, links } = await readGoalRecords(ctx, { readOnly: true });
  const goals = records.map((r) => wireGoal(r, links));
  // Hidden accounts only when asked for (see the header): the ids of those
  // that aren't, following links, only to say a goal's account is hidden.
  const [listed, hidden] = await Promise.all([
    readAccounts(ctx, { includeHidden: !!opts.includeHidden }),
    opts.includeHidden ? null : getEffectiveHidden(ctx, { readOnly: true }).then((h) => h.hidden),
  ]);
  const onHidden = (g: { account_id: string | null }) => !!g.account_id && !!hidden?.has(g.account_id);
  const accounts: KnownAccount[] = listed.accounts.map((a) => ({ ...knownAccount(a), hidden: false }));
  for (const id of new Set(goals.filter(onHidden).map((g) => g.account_id!))) {
    accounts.push({ account_id: id, name: '', balance: null, currency: null, hidden: true, as_of: null });
  }
  const byId = new Map(accounts.map((a) => [a.account_id, a]));
  const lifecycleOf = new Map(listed.accounts.map((a) => [a.id, a.lifecycle]));
  const counted = new Set(goals.filter((g) => !g.plan?.archived && g.account_id && accountState(g, byId.get(g.account_id)) === 'tracked').map((g) => g.account_id!));
  const flows = await readGoalFlows(ctx, { month: today.slice(0, 7), accounts: listed.accounts.filter((a) => counted.has(a.id)), links });
  const { views, splits } = goalViews(goals, accounts, flows.flows, today);
  const viewOf = new Map(views.map((v) => [v.goal.id, v]));
  const nameOf = (id: string) => goals.find((g) => g.id === id)?.name ?? 'another goal';
  const unread = listed.missing_accounts.length > 0;
  // With a home currency: the rates of the goals' currencies, today's.
  const goalCurrencies = [...new Set(goals.flatMap((g) => (g.account_id && !onHidden(g) ? [byId.get(g.account_id)?.currency ?? null] : [])).filter((c): c is string => !!c))];
  const fx = await readFlowFx(ctx, [], Date.now(), { also: goalCurrencies });
  const inBase = (amount: number | null, currency: string | null): number | null => (fx && amount !== null ? toBase(fx, amount, currency, today) : null);

  const out: ApiGoal[] = goals.map((g) => {
    const v = viewOf.get(g.id);
    const account = g.account_id ? (byId.get(g.account_id) ?? null) : null;
    let state: string = v?.state ?? accountState(g, account ?? undefined);
    if (state === 'disconnected' && unread) state = 'unavailable';
    const p = v?.projection ?? null;
    const flow = v && g.account_id ? flows.flows.get(g.account_id) : undefined;
    const isHidden = onHidden(g);
    const notes = (): string[] => {
      if (g.plan?.archived) return ['Archived.'];
      if (!v) return [];
      // Nothing of a hidden account: not its name, as a reconnected one's
      // note would give, nor anything it holds.
      if (isHidden) return [`${stateText(v)}.`];
      // The page's words, with the hyphen for a minus (lib/format.ts
      // asciiMinus): the API's text is data, and the emails' too.
      return goalSentences(v, nameOf, g.account_id ? splits.get(g.account_id) : undefined).map(asciiMinus);
    };
    return {
      id: g.id,
      name: g.name,
      target: g.target,
      currency: isHidden ? null : (account?.currency ?? null),
      account_id: isHidden ? null : g.account_id,
      account_name: account && !account.hidden ? account.name : null,
      account_lifecycle: isHidden || !g.account_id ? null : (lifecycleOf.get(g.account_id) ?? null),
      state,
      saved: v?.saved ?? null,
      saved_as_of: v?.saved !== null && v?.saved !== undefined ? (account?.as_of ?? null) : null,
      allocation: g.plan?.allocation ?? null,
      scaled: v?.claim?.scaled ?? false,
      shares_account_with: isHidden ? [] : (v?.sharing ?? []),
      monthly_target: g.plan?.monthly_target ?? null,
      target_date: g.plan?.target_date ?? null,
      archived: !!g.plan?.archived,
      archived_on: g.archived_on ?? null,
      archived_amount: g.archived_amount ?? null,
      pace:
        v?.state === 'tracked' && flow
          ? {
              source: flow.source,
              months: flow.months.map((m) => ({ month: m.month, amount: m.amount, interest: m.growth ?? (flow.source === 'transactions' && m.amount !== null ? 0 : null), may_be_incomplete: (m.gaps?.length ?? 0) > 0 })),
              average: v.measured?.average ?? null,
            }
          : null,
      projection: p
        ? {
            status: p.status,
            rate: p.rate,
            rate_from: p.rateFrom,
            completion_month: p.completion,
            needed_monthly: p.needed,
            short_monthly: p.short,
            target_date_passed: p.datePassed,
            should_have: v!.shouldHave,
            uncertain: !!v!.measured?.uncertain && p.rateFrom === 'contributions',
          }
        : null,
      to_base: (() => {
        const c = isHidden ? null : (account?.currency ?? null);
        const target = inBase(g.target, c);
        return target === null ? null : { target, saved: inBase(v?.saved ?? null, c) };
      })(),
      notes: notes(),
    };
  });

  return {
    base_currency: fx?.home ?? null,
    goals: out,
    accounts: [...splits.values()].map((s) => ({ account_id: s.account_id, currency: s.currency, balance: s.balance, allocated: s.allocated, unallocated: s.unallocated, over_allocated: s.over })),
    months: flows.months,
    complete: !unread,
    missing_accounts: listed.missing_accounts,
    notes: [...listed.notes, ...flows.notes],
  };
}
