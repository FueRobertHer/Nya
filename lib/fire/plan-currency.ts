// lib/fire/plan-currency.ts
//
// The currency the Plan's typed figures are in, and what the Plan tab does
// with it. Pure: the store is lib/fire-plan.ts (planCurrencyStore), the route
// app/api/fire-plan, the page components/PlanTab.tsx and FiProgressCard.tsx.
//
// KEPT, NEVER CONVERTED. What the person typed in the Plan (spending, savings,
// assets, a start balance, part-time income, other income, one-offs) stays in
// the currency it was typed in, as a budget keeps its own: the Plan is shown
// and worked out in that currency, and what Nya measures (invested assets, a
// year's spending, income and savings) is converted into it with a home
// currency, at the rates, or left out and named without one or without a
// rate (lib/fire/inputs.ts). Before this, the Plan's currency was the one
// most of the counted accounts were in, a count that moves on its own (a tie
// goes by account order; hiding or adding one, a balance that reads empty,
// or a load still under way changes it), and every typed figure was read in
// whatever it had become.
//
// RECORDED BESIDE THE PLAN, NOT IN IT. FirePlan's shape is closed (a field
// it doesn't know makes the reader refuse the plan), so a field there would
// make the release before read the whole Plan as unrecognised. The record is
// a store of its own, which that release never reads: the currency, and the
// typed amounts as the save that wrote the record left them. It holds only
// while those equal the stored plan's typed amounts. A save the release before
// made after a rollback, a save that stopped between its two writes, two
// devices' writes interleaved, or a plan restored without its record each
// leaves them apart, and the Plan then asks rather than guess.
//
// WHICH CURRENCY THE PLAN IS IN (planCurrencyState):
//   - recorded: the record holds; its currency, whatever the accounts are in.
//   - follows: the plan holds no typed amount, so nothing can be relabelled:
//     the accounts' currency, as before.
//   - unknown: typed amounts and no record that holds (every Plan saved
//     before this release). The tab records the currency it shows when that
//     can be told reliably (shownReliably), and asks the person otherwise.
//     Until then the figures are shown in the accounts' currency, said to be
//     unconfirmed, and nothing on the Plan is saved.

import type { FirePlan } from './plan';
import type { InvestedAssets, TrailingFlows } from './inputs';

/** The amounts typed in a plan, in its own order. */
export type TypedAmounts = {
  spending: number | null;
  savings: number | null;
  assets: number | null;
  startBalance: number | null;
  partTimeIncome: number;
  income: { id: string; amount: number }[];
  expenses: { id: string; amount: number }[];
};

export function typedAmounts(plan: FirePlan): TypedAmounts {
  return {
    spending: plan.spending,
    savings: plan.savings,
    assets: plan.assets,
    startBalance: plan.startBalance,
    partTimeIncome: plan.partTimeIncome,
    income: plan.income.map((i) => ({ id: i.id, amount: i.amount })),
    expenses: plan.expenses.map((e) => ({ id: e.id, amount: e.amount })),
  };
}

/** Whether a plan holds any amount the person typed: a figure typed over a
 *  measured one, a start balance, part-time income, other income or a
 *  one-off. */
export function hasTypedAmounts(plan: FirePlan): boolean {
  const a = typedAmounts(plan);
  return a.spending !== null || a.savings !== null || a.assets !== null || a.startBalance !== null || a.partTimeIncome !== 0 || a.income.length > 0 || a.expenses.length > 0;
}

export function sameAmounts(a: TypedAmounts, b: TypedAmounts): boolean {
  const items = (x: { id: string; amount: number }[], y: { id: string; amount: number }[]) => x.length === y.length && x.every((v, i) => v.id === y[i].id && v.amount === y[i].amount);
  return (
    a.spending === b.spending &&
    a.savings === b.savings &&
    a.assets === b.assets &&
    a.startBalance === b.startBalance &&
    a.partTimeIncome === b.partTimeIncome &&
    items(a.income, b.income) &&
    items(a.expenses, b.expenses)
  );
}

/** A currency as the record holds it: three capital letters (ISO 4217's
 *  form, which an account's unofficial code such as BTC also has). */
export const CURRENCY_CODE = /^[A-Z]{3}$/;

/** What the store holds (lib/fire-plan.ts planCurrencyStore). */
export type PlanCurrencyRecord = {
  version: 1;
  /** The currency the plan's typed figures are in. */
  currency: string;
  /** The plan's typed amounts as the save that wrote this left them. */
  amounts: TypedAmounts;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const closed = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const amount = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const amountOrNull = (v: unknown) => v === null || amount(v);
const AMOUNT_KEYS = ['spending', 'savings', 'assets', 'startBalance', 'partTimeIncome', 'income', 'expenses'] as const;

/** Whether a value is typed amounts, as a record holds them or the page
 *  sends them: the shape and types only (the plan's own ranges are
 *  lib/fire/plan.ts's). */
export function isTypedAmounts(v: unknown): v is TypedAmounts {
  if (!isObject(v) || !closed(v, AMOUNT_KEYS)) return false;
  const item = (x: unknown) => isObject(x) && closed(x, ['id', 'amount']) && typeof x.id === 'string' && x.id.length <= 200 && amount(x.amount);
  const list = (x: unknown) => Array.isArray(x) && x.length <= 100 && x.every(item);
  return amountOrNull(v.spending) && amountOrNull(v.savings) && amountOrNull(v.assets) && amountOrNull(v.startBalance) && amount(v.partTimeIncome) && list(v.income) && list(v.expenses);
}

/** The store's check (isValid): version 1, exactly these fields. Anything
 *  else is a later release's, read as not understood, never as damage. */
export function isPlanCurrencyRecord(v: unknown): v is PlanCurrencyRecord {
  return isObject(v) && closed(v, ['version', 'currency', 'amounts']) && v.version === 1 && typeof v.currency === 'string' && CURRENCY_CODE.test(v.currency) && isTypedAmounts(v.amounts);
}

/** The record a save of `plan` in `currency` writes. */
export function currencyRecord(plan: FirePlan, currency: string): PlanCurrencyRecord {
  return { version: 1, currency, amounts: typedAmounts(plan) };
}

/** The currency the record says `plan`'s typed figures are in, or null when
 *  it says nothing about them: no record, a plan with nothing typed, or a
 *  record of other amounts than the plan's (see the top of this file). */
export function recordedCurrency(plan: FirePlan | null, record: PlanCurrencyRecord | null): string | null {
  if (!plan || !record || !hasTypedAmounts(plan)) return null;
  return sameAmounts(typedAmounts(plan), record.amounts) ? record.currency : null;
}

/** What the route answers beside the plan: the recorded currency when the
 *  record holds, and why a record there can't be read (`unreadable`: damaged
 *  bytes, which only the person's answer replaces; `newer`: a later
 *  release's, which is never written over). */
export type CurrencyAnswer = { currency: string | null; problem: 'unreadable' | 'newer' | null };

export const NO_ANSWER: CurrencyAnswer = { currency: null, problem: null };

/** The answer as the page reads it from /api/fire-plan's body. */
export function readCurrencyAnswer(data: Record<string, unknown> | null | undefined): CurrencyAnswer {
  const c = data?.currency;
  const p = data?.currency_problem;
  return {
    currency: typeof c === 'string' && CURRENCY_CODE.test(c) ? c : null,
    problem: p === 'unreadable' || p === 'newer' ? p : null,
  };
}

/** How far the accounts and transactions have loaded, as the page has it. */
export type LoadState = {
  /** When the balances were loaded; null while they load. */
  balancesAsOf: string | null;
  institutions: number;
  txnsLoading: boolean;
  /** The transactions failed to load. */
  txnsFailed: boolean;
  /** Institutions whose transactions couldn't all be read. */
  unread: number;
};

/** Why the currency the Plan is shown in can't be told reliably now. */
export type NotReliable = 'loading' | 'problem' | 'empty-balance' | 'tie' | 'mixed' | 'none';

/**
 * Whether the currency the Plan is shown in now (lib/fire/progress.ts
 * planCurrency: the accounts', the transactions', the dashboard's) is one it
 * would be shown in on any load, so that it can be taken as the one a plan's
 * figures were typed in: everything has loaded without a problem, no counted
 * account reads empty (it could hold the other currency), and the count has a
 * clear winner. With no investment account to go by, every counted
 * transaction must be in one currency. The dashboard's own currency alone is
 * never enough.
 */
export function shownReliably(
  shown: string | null,
  inputs: { assets: InvestedAssets; flows: TrailingFlows | null },
  load: LoadState
): { ok: true } | { ok: false; why: NotReliable } {
  const { assets, flows } = inputs;
  if (!load.balancesAsOf || load.txnsLoading) return { ok: false, why: 'loading' };
  if (load.institutions === 0 && !flows) return { ok: false, why: 'none' };
  if (load.txnsFailed || load.unread > 0 || assets.caveats.length > 0) return { ok: false, why: 'problem' };
  if (assets.unknown > 0) return { ok: false, why: 'empty-balance' };
  if (!shown) return { ok: false, why: 'none' };
  const counts = assets.byCurrency ?? [];
  if (counts.length > 0) {
    if (counts.length > 1 && counts[1].count === counts[0].count) return { ok: false, why: 'tie' };
    if (counts[0].currency !== shown) return { ok: false, why: 'mixed' };
    return { ok: true };
  }
  // No investment account: the transactions', only when all are in it.
  if (flows && flows.currency === shown && flows.leftOut.length === 0 && (flows.conversion?.from.length ?? 0) === 0) return { ok: true };
  return { ok: false, why: flows ? 'mixed' : 'none' };
}

/** The Plan's currency, and how it is known (see the top of this file). */
export type PlanCurrencyState =
  | { kind: 'recorded'; currency: string }
  | { kind: 'follows'; currency: string | null }
  | { kind: 'unknown'; shown: string | null; problem: CurrencyAnswer['problem'] };

export function planCurrencyState(stored: FirePlan | null, answer: CurrencyAnswer, shown: string | null): PlanCurrencyState {
  if (answer.currency) return { kind: 'recorded', currency: answer.currency };
  if (!stored || !hasTypedAmounts(stored)) return { kind: 'follows', currency: shown };
  return { kind: 'unknown', shown, problem: answer.problem };
}

/** The currency the Plan is worked out and shown in, in any state. */
export const currencyOfState = (s: PlanCurrencyState): string | null => (s.kind === 'unknown' ? s.shown : s.currency);

/** The currencies to offer when asking which one the figures are in: the
 *  one shown first, then the others in sight (the accounts', most first,
 *  and the transactions'), each once. */
export function candidates(shown: string | null, inputs: { assets: InvestedAssets; flows: TrailingFlows | null }): string[] {
  const out: string[] = [];
  const add = (c: string | null | undefined) => {
    if (c && CURRENCY_CODE.test(c) && !out.includes(c)) out.push(c);
  };
  add(shown);
  for (const c of inputs.assets.byCurrency ?? []) add(c.currency);
  add(inputs.flows?.currency);
  return out;
}

/** Why the shown currency can't be taken for the figures', after "They're
 *  shown in USD, ...". */
const UNRELIABLE_TEXT: Record<Exclude<NotReliable, 'loading'>, string> = {
  problem: 'your accounts haven’t all loaded without a problem, so it may read otherwise for now',
  'empty-balance': 'an account’s balance reads empty just now, so it may read otherwise once it doesn’t',
  tie: 'as many of your invested accounts are in another currency, so it could as well be that one',
  mixed: 'your accounts and transactions are in more than one currency',
  none: 'there are no accounts to tell it from',
};

/** The question, when the Plan's currency isn't known. */
export function askText(state: Extract<PlanCurrencyState, { kind: 'unknown' }>, why: NotReliable | null): string {
  if (state.problem === 'newer') {
    return `The currency your plan’s figures are in was recorded by a newer version of Nya, so it can’t be read here. They’re shown in ${state.shown ?? 'no currency'} for now, and nothing on the Plan can be saved until that version is back.`;
  }
  const start = state.problem === 'unreadable' ? 'The record of the currency your plan’s figures are in couldn’t be read.' : 'Your plan’s figures were saved before Nya kept the currency they were typed in.';
  if (!state.shown) return `${start} Which currency are they in? Nothing on the Plan can be saved until you say.`;
  const shownAs = `They’re shown in ${state.shown} for now, the currency most of your accounts are in`;
  const reason = why && why !== 'loading' ? `, but ${UNRELIABLE_TEXT[why]}` : '';
  return `${start} ${shownAs}${reason}. Which currency are they in? Nothing on the Plan can be saved until you say, and once you do they stay in it, whatever your accounts are in.`;
}

/**
 * What the Plan tab says about its currency once it is recorded and differs
 * from what the accounts or transactions are in, or null: the figures you
 * typed stay in theirs, and what Nya measures is converted into it (with a
 * home currency) or left out (without one). Never an amount.
 */
export function keptText(currency: string, inputs: { assets: InvestedAssets; flows: TrailingFlows | null }, converts: boolean): string | null {
  const accounts = inputs.assets.byCurrency?.[0]?.currency ?? null;
  const spending = inputs.flows?.mostIn ?? null;
  const others = [...new Set([accounts, spending].filter((c): c is string => c !== null && c !== currency))];
  if (others.length === 0) return null;
  const what =
    accounts && accounts !== currency && spending && spending !== currency
      ? accounts === spending
        ? `your accounts and spending are mostly in ${accounts}`
        : `your accounts are mostly in ${accounts} and your spending in ${spending}`
      : accounts && accounts !== currency
        ? `your accounts are mostly in ${accounts}`
        : `your spending is mostly in ${spending}`;
  const then = converts
    ? `what is in ${others.join(' and ')} is converted into ${currency} (below)`
    : `without a home currency nothing is converted, so what is in ${others.join(' and ')} isn’t counted (below): choose one on the Currency card under Manage on the Accounts tab to convert it`;
  return `Your plan’s figures are in ${currency}, the currency they were typed in, and stay in it: ${what}, so ${then}.`;
}
