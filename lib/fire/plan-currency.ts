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
//   - unknown: typed amounts and no record that holds. With no record at
//     all (every Plan saved before this release), the tab records the
//     currency it shows when that can be told reliably (shownReliably) and no
//     save is under way, and asks otherwise. With a record that no longer
//     fits (stale), or one that can't be read, it always asks, offering the
//     recorded currency first: a record is never replaced without the
//     person's word. Until then the figures are shown in the accounts'
//     currency, said to be unconfirmed, and nothing on the Plan is saved.
//
// THE FIRST AMOUNT. The save that gives a plan its first typed amount
// records the currency in its own write: the one shown, when it can be told
// reliably, else the one the person picked (the tab asks first), so this
// release never leaves typed amounts without a record.

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
 *  record holds, and why a record there doesn't (`stale`: a record of other
 *  amounts, whose currency is `was`, which only the person's answer
 *  replaces; `unreadable`: damaged bytes, likewise; `newer`: a later
 *  release's, which is never written over). No currency and no problem: no
 *  record at all, or a plan with nothing typed. */
export type CurrencyAnswer = { currency: string | null; problem: 'stale' | 'unreadable' | 'newer' | null; was: string | null };

export const NO_ANSWER: CurrencyAnswer = { currency: null, problem: null, was: null };

/** The answer as the page reads it from /api/fire-plan's body. */
export function readCurrencyAnswer(data: Record<string, unknown> | null | undefined): CurrencyAnswer {
  const code = (v: unknown) => (typeof v === 'string' && CURRENCY_CODE.test(v) ? v : null);
  const p = data?.currency_problem;
  const problem = p === 'stale' || p === 'unreadable' || p === 'newer' ? p : null;
  return { currency: code(data?.currency), problem, was: problem === 'stale' ? code(data?.currency_was) : null };
}

/** How far the accounts and transactions have loaded, as the page has it. */
export type LoadState = {
  /** When the balances were loaded; null while they load. */
  balancesAsOf: string | null;
  /** The balances are the dashboard's saved copy, shown until its own load
   *  answers: possibly from before an account was added elsewhere. */
  balancesSaved: boolean;
  /** That load failed: no longer waited for, but a problem, which asks. */
  balancesFailed?: boolean;
  institutions: number;
  txnsLoading: boolean;
  /** The transactions failed to load. */
  txnsFailed: boolean;
  /** Institutions whose transactions couldn't all be read. */
  unread: number;
};

/** Why the currency the Plan is shown in can't be told reliably now. */
export type NotReliable = 'loading' | 'failed' | 'problem' | 'empty-balance' | 'tie' | 'mixed' | 'spending' | 'none';

/**
 * Whether the currency the Plan is shown in now (lib/fire/progress.ts
 * planCurrency: the accounts', the transactions', the dashboard's) is one it
 * would be shown in on any load, so that it can be taken as the one a plan's
 * figures were typed in: the accounts have loaded from the server (never
 * the dashboard's saved copy) and the transactions too, without a problem; no
 * counted account reads empty (it could hold the other currency); the count
 * has a clear winner; and most of the year's spending is in it too (else the
 * figures would be measured from the rest, lib/fire/progress.ts
 * spendingGap). With no investment account to go by, every counted
 * transaction must be in one currency. The dashboard's own currency alone is
 * never enough.
 */
export function shownReliably(
  shown: string | null,
  inputs: { assets: InvestedAssets; flows: TrailingFlows | null },
  load: LoadState
): { ok: true } | { ok: false; why: NotReliable } {
  const { assets, flows } = inputs;
  if (load.balancesFailed && (!load.balancesAsOf || load.balancesSaved)) return { ok: false, why: 'failed' };
  if (!load.balancesAsOf || load.balancesSaved || load.txnsLoading) return { ok: false, why: 'loading' };
  if (load.institutions === 0 && !flows) return { ok: false, why: 'none' };
  if (load.txnsFailed || load.unread > 0 || assets.caveats.length > 0) return { ok: false, why: 'problem' };
  if (assets.unknown > 0) return { ok: false, why: 'empty-balance' };
  if (!shown) return { ok: false, why: 'none' };
  const counts = assets.byCurrency ?? [];
  if (counts.length > 0) {
    if (counts.length > 1 && counts[1].count === counts[0].count) return { ok: false, why: 'tie' };
    if (counts[0].currency !== shown) return { ok: false, why: 'mixed' };
    if (flows?.mostIn && flows.mostIn !== shown) return { ok: false, why: 'spending' };
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
  | { kind: 'unknown'; shown: string | null; problem: CurrencyAnswer['problem']; was: string | null };

/** From the plan the server last confirmed (never one a save has yet to
 *  write) and its answer. */
export function planCurrencyState(stored: FirePlan | null, answer: CurrencyAnswer, shown: string | null): PlanCurrencyState {
  if (answer.currency) return { kind: 'recorded', currency: answer.currency };
  if (!stored || !hasTypedAmounts(stored)) return { kind: 'follows', currency: shown };
  return { kind: 'unknown', shown, problem: answer.problem, was: answer.was };
}

/** The currency the Plan is worked out and shown in, in any state. */
export const currencyOfState = (s: PlanCurrencyState): string | null => (s.kind === 'unknown' ? s.shown : s.currency);

/** The currencies to offer when asking which one the figures are in: the
 *  one a record that no longer fits said, first; the one shown; then the
 *  others in sight (the accounts', most first, the transactions', and the
 *  home currency), each once. Any other is in the list of every code. */
export function candidates(shown: string | null, inputs: { assets: InvestedAssets; flows: TrailingFlows | null }, more: { was?: string | null; home?: string | null } = {}): string[] {
  const out: string[] = [];
  const add = (c: string | null | undefined) => {
    if (c && CURRENCY_CODE.test(c) && !out.includes(c)) out.push(c);
  };
  add(more.was);
  add(shown);
  for (const c of inputs.assets.byCurrency ?? []) add(c.currency);
  add(inputs.flows?.mostIn);
  add(inputs.flows?.currency);
  add(more.home);
  return out;
}

/** Where the shown currency came from, for saying so truly. */
export function shownFrom(shown: string | null, inputs: { assets: InvestedAssets; flows: TrailingFlows | null }): 'accounts' | 'transactions' | 'dashboard' | null {
  if (!shown) return null;
  if ((inputs.assets.byCurrency ?? [])[0]?.currency === shown) return 'accounts';
  if (inputs.flows?.mostIn === shown || inputs.flows?.currency === shown) return 'transactions';
  return 'dashboard';
}

const FROM_TEXT = { accounts: 'the currency most of your invested accounts are in', transactions: 'the currency most of your transactions are in', dashboard: 'your accounts’ main currency' } as const;

/** Why the shown currency can't be taken for the figures', after "They're
 *  shown in USD, ...". */
const UNRELIABLE_TEXT: Record<Exclude<NotReliable, 'loading'>, string> = {
  failed: 'your accounts couldn’t be loaded just now, so what is shown may be out of date',
  problem: 'your accounts haven’t all loaded without a problem, so it may read otherwise for now',
  'empty-balance': 'an account’s balance reads empty just now, so it may read otherwise once it doesn’t',
  tie: 'as many of your invested accounts are in another currency, so it could as well be that one',
  mixed: 'your accounts and transactions are in more than one currency',
  spending: 'most of your spending is in another currency',
  none: 'there are no accounts or transactions to tell it from',
};

const shownText = (shown: string | null, from: ReturnType<typeof shownFrom>, why: NotReliable | null) => {
  if (!shown || !from) return '';
  const reason = why && why !== 'loading' ? `, but ${UNRELIABLE_TEXT[why]}` : '';
  return ` They’re shown in ${shown} for now, ${FROM_TEXT[from]}${reason}.`;
};

/** The question, when the Plan's currency isn't known: true to why. */
export function askText(state: Extract<PlanCurrencyState, { kind: 'unknown' }>, why: NotReliable | null, from: ReturnType<typeof shownFrom>): string {
  if (state.problem === 'newer') {
    return `The currency your plan’s figures are in was recorded by a newer version of Nya, so it can’t be read here.${state.shown ? ` They’re shown in ${state.shown} for now.` : ''} Nothing on the Plan can be saved until that version is back.`;
  }
  const start =
    state.problem === 'stale'
      ? `Nya recorded your plan’s figures as ${state.was ?? 'another currency'}, but they were changed since in a way that didn’t record a currency (an older version of Nya, a page open since before the update, or a save that didn’t finish), so whether they’re still in ${state.was ?? 'it'} can’t be told.`
      : state.problem === 'unreadable'
        ? 'The record of the currency your plan’s figures are in couldn’t be read.'
        : 'Your plan’s figures were saved before Nya kept the currency they were typed in.';
  return `${start}${shownText(state.shown, from, why)} Which currency are they in? Nothing on the Plan can be saved until you say, and once you do they stay in it, whatever your accounts are in.`;
}

/** Before a plan's first typed amount, when the currency can't be told from
 *  the accounts: which one the person will type in. */
export function firstText(shown: string | null, why: NotReliable, from: ReturnType<typeof shownFrom>): string {
  return `Which currency will you type your plan’s figures in? Nya keeps them in it, whatever your accounts are in.${shownText(shown, from, why)} Say which before you type an amount.`;
}

/** Home's FI card, while the currency isn't known. */
export function unconfirmedText(shown: string | null, from: ReturnType<typeof shownFrom>): string {
  const lead = shown && from ? `Shown in ${shown}, ${FROM_TEXT[from]}: which currency your plan’s figures were typed in isn’t known yet.` : 'Which currency your plan’s figures were typed in isn’t known yet.';
  return `${lead} The Plan tab settles it, or asks you.`;
}

/** While the tab waits on the accounts to tell the currency. */
export const WAITING_TEXT = 'Nya is waiting for your accounts to load to tell which currency your plan’s figures are in. Nothing on the Plan is saved until it can.';

/** Once recorded, the line the tab always shows. */
export const recordedText = (currency: string) => `Your plan’s figures are in ${currency}, the currency they were typed in.`;

/** What a change of the recorded currency means, before it is made. */
export function relabelText(from: string, to: string, scenariosIn: number): string {
  const scenarios = scenariosIn > 0 ? ` ${scenariosIn} scenario${scenariosIn === 1 ? '' : 's'} with amounts typed in ${from} then aren’t worked out until you say their amounts are in ${to} too.` : '';
  return `Every figure you typed in your plan is then read in ${to}, exactly as typed: nothing is converted. That is right only if you typed them in ${to}, not ${from}.${scenarios}`;
}

const join = (list: readonly string[]) => (list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** Whether most of what is measured is in `currency` already: the accounts
 *  by a clear count (or none), and most of the year's rows (or none). */
function measuredIn(currency: string, inputs: { assets: InvestedAssets; flows: TrailingFlows | null }) {
  const counts = inputs.assets.byCurrency ?? [];
  const top = counts[0];
  const accounts = counts.length === 0 || (top.currency === currency && (counts.length === 1 || counts[1].count < top.count));
  const spending = inputs.flows?.mostIn ?? null;
  return { counts, accounts, spending, spendingIn: spending === null || spending === currency };
}

/**
 * What the Plan tab says about its currency once it is recorded and what Nya
 * measures isn't mostly in it, or null: the figures you typed stay in
 * theirs, and what is measured is converted into it (with a home currency)
 * or left out (without one). Never an amount.
 */
export function keptText(currency: string, inputs: { assets: InvestedAssets; flows: TrailingFlows | null }, converts: boolean): string | null {
  const m = measuredIn(currency, inputs);
  if (m.accounts && m.spendingIn) return null;
  const otherAccounts = m.accounts ? [] : m.counts.filter((c) => c.currency !== currency).map((c) => c.currency);
  const someIn = m.counts.some((c) => c.currency === currency);
  const parts = [
    ...(otherAccounts.length > 0 ? [`${someIn ? 'some of your accounts are' : 'your accounts are'} in ${join(otherAccounts)}`] : []),
    ...(!m.spendingIn ? [`your spending is mostly in ${m.spending}`] : []),
  ];
  const others = [...new Set([...otherAccounts, ...(!m.spendingIn && m.spending ? [m.spending] : [])])];
  const what = join(parts);
  const then = converts
    ? `what is in ${join(others)} is converted into ${currency} (below).`
    : `without a home currency nothing is converted, so what is in ${join(others)} isn’t counted (below). Choose one on the Currency card under Manage on the Accounts tab to convert it.`;
  return `Your plan’s figures are in ${currency}, the currency they were typed in, and stay in it. ${what[0].toUpperCase()}${what.slice(1)}: ${then}`;
}

/** Once recorded, the one other currency everything measured is in, if
 *  there is one (no account in the Plan's, and the rest in one other), to
 *  offer for saying the figures were typed in it after all. */
export function relabelOffer(currency: string, inputs: { assets: InvestedAssets; flows: TrailingFlows | null }): string | null {
  const m = measuredIn(currency, inputs);
  const elsewhere = [...new Set([...m.counts.map((c) => c.currency), ...(m.spending ? [m.spending] : [])])];
  return elsewhere.length === 1 && elsewhere[0] !== currency ? elsewhere[0] : null;
}
