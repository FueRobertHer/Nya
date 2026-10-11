// The goal editor's form (components/GoalSheet.tsx), read and checked (#42):
// what is typed, as the goal a save would send, and why it can't be saved
// yet. Every check is the server's own (lib/goal-model.ts parseGoals,
// lib/goal-save.ts), made here first on the balances the page shows, so a
// save is never refused with nothing to say why. Pure, for the tests.

import { isOwedType } from '@/lib/balance';
import { formatMoney } from '@/lib/format';
import { isCalendarDay, parseAmountInput } from '@/lib/manual-txn-input';
import { allocationRoom } from '@/lib/goal-allocation';
import { accountState, type GoalAccount } from '@/lib/goal-view';
import { LATEST_TARGET_DATE, MAX_GOAL_AMOUNT, type Goal, type GoalPlan } from '@/lib/goal-model';

/** The form's working copy: amounts as typed. */
export type Draft = { name: string; target: string; account: string; allocate: boolean; allocation: string; monthly: string; date: string };

export const draftOf = (g: Goal | null): Draft => ({
  name: g?.name ?? '',
  target: g ? String(g.target) : '',
  account: g?.account_id ?? '',
  allocate: g?.plan?.allocation !== undefined,
  allocation: g?.plan?.allocation !== undefined ? String(g.plan.allocation) : '',
  monthly: g?.plan?.monthly_target !== undefined ? String(g.plan.monthly_target) : '',
  date: g?.plan?.target_date ?? '',
});

/** An amount as typed, in the currency's smallest unit; 0 taken where
 *  `zero` allows it (an allocation of nothing is a choice). */
export function amountOf(text: string, currency: string | null, zero = false): number | null {
  if (zero && /^\s*0+([.,]0*)?\s*$/.test(text)) return 0;
  const n = parseAmountInput(text, currency || 'USD');
  return n !== null && n <= MAX_GOAL_AMOUNT ? n : null;
}

export type DraftRead = {
  /** The goal a save would send; meaningful once `ready`. */
  entry: Goal;
  account: GoalAccount | null;
  currency: string | null;
  /** The account can be counted (there, not hidden, held not owed, with a
   *  balance). */
  trackable: boolean;
  /** The most it may set aside, by the server's rule; null when the account
   *  can't be counted. */
  room: number | null;
  errors: string[];
  ready: boolean;
};

/**
 * The form, read: `goal` is the goal edited (null to add one, which gets
 * `newId`), `goals` the whole list, `today` the viewer's day.
 */
export function readDraft(d: Draft, opts: { goal: Goal | null; goals: readonly Goal[]; accounts: readonly GoalAccount[]; today: string; newId: string }): DraftRead {
  const { goal, goals, accounts, today } = opts;
  const account = accounts.find((a) => a.account_id === d.account) ?? null;
  const currency = account?.currency ?? null;
  const id = goal?.id ?? opts.newId;
  const trackable = !!account && accountState({ id, name: '', target: 1, account_id: account.account_id }, account) === 'tracked';
  const target = amountOf(d.target, currency);
  const allocation = d.allocate ? amountOf(d.allocation, currency, true) : undefined;
  const monthly = d.monthly.trim() ? amountOf(d.monthly, currency) : undefined;
  const room = trackable
    ? allocationRoom(id, account!.account_id, goals.map((g) => ({ id: g.id, account_id: g.account_id, allocation: g.plan?.allocation, archived: !!g.plan?.archived })), account!.balance!, currency)
    : null;
  const dateKept = !!goal?.plan?.target_date && d.date === goal.plan.target_date;
  const money = (n: number) => formatMoney(n, currency);

  const errors: string[] = [];
  if (d.target.trim() && target === null) errors.push('Enter a target, like 5000.');
  if (d.allocate) {
    if (!account) errors.push('Choose an account to set part of its balance aside from.');
    else if (!trackable) {
      const why = account.type && isOwedType(account.type) ? 'its balance is owed, not saved' : account.hidden ? 'it is hidden' : 'no balance is known for it yet';
      errors.push(`Nothing can be set aside from ${account.name}: ${why}.`);
    } else if (d.allocation.trim() && allocation === null) errors.push('Enter the part of the balance to set aside, like 1500, or 0.');
    else if (allocation != null && room !== null && allocation > room) errors.push(`${account.name} has ${money(room)} you can set aside for this goal.`);
  }
  if (d.monthly.trim() && monthly === null) errors.push('Enter a monthly target, like 250.');
  if (d.date && !(isCalendarDay(d.date) && d.date <= LATEST_TARGET_DATE && (d.date >= today || dateKept))) errors.push('Pick a target date from today on.');

  const plan: GoalPlan = {
    ...(d.allocate && allocation != null ? { allocation } : {}),
    ...(monthly != null ? { monthly_target: monthly } : {}),
    ...(d.date ? { target_date: d.date } : {}),
  };
  const entry: Goal = { id, name: d.name.trim(), target: target ?? 0, account_id: d.account || null, plan };
  const ready = !!d.name.trim() && target !== null && (!d.allocate || allocation != null) && errors.length === 0;
  return { entry, account, currency, trackable, room, errors, ready };
}
