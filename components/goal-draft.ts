// The goal editor's form (components/GoalSheet.tsx), read and checked (#42):
// what is typed, as the goal a save would send, and why it can't be saved
// yet. Every check is the server's own (lib/goal-model.ts parseGoals,
// lib/goal-save.ts), made here first on the balances the page shows, so a
// save is never refused with nothing to say why. Pure, for the tests.

import { isOwedType } from '@/lib/balance';
import { formatMoney } from '@/lib/format';
import { isCalendarDay, parseAmountInput } from '@/lib/manual-txn-input';
import { allocationRoom } from '@/lib/goal-allocation';
import { endedWhy } from '@/lib/goal-text';
import { accountState, type GoalAccount } from '@/lib/goal-view';
import { LATEST_TARGET_DATE, MAX_GOAL_AMOUNT, type Goal, type GoalPlan } from '@/lib/goal-model';

/** The form's working copy: amounts as typed. */
export type Draft = { name: string; target: string; account: string; allocate: boolean; allocation: string; monthly: string; date: string };

export const draftOf = (g: Goal | null): Draft => ({
  name: g?.name ?? '',
  target: g ? String(g.target) : '',
  account: g?.account_id ?? '',
  // An allocation is of an account's balance: none without one.
  allocate: g?.plan?.allocation !== undefined && !!g.account_id,
  allocation: g?.plan?.allocation !== undefined ? String(g.plan.allocation) : '',
  monthly: g?.plan?.monthly_target !== undefined ? String(g.plan.monthly_target) : '',
  date: g?.plan?.target_date ?? '',
});

/** The form with another account picked: "No account" sets nothing aside,
 *  in the same step (what was typed for it is kept, for an account picked
 *  again). */
export const pickAccount = (d: Draft, account: string): Draft => ({ ...d, account, allocate: account ? d.allocate : false });

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
  /** The account can be counted (there, open, not hidden, held not owed,
   *  with a balance). */
  trackable: boolean;
  /** The most it may set aside, by the server's rule; null when the account
   *  can't be counted. */
  room: number | null;
  errors: string[];
  /** The field each of `errors` is about, in the same order, to say it
   *  under that field. */
  errorFields: DraftField[];
  ready: boolean;
};

/** The fields a goal's form can say something is wrong with. */
export type DraftField = 'target' | 'account' | 'allocation' | 'monthly' | 'date';

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
  // Nothing is set aside without an account to set it aside from.
  const allocate = d.allocate && !!d.account;
  const allocation = allocate ? amountOf(d.allocation, currency, true) : undefined;
  const monthly = d.monthly.trim() ? amountOf(d.monthly, currency) : undefined;
  const room = trackable
    ? allocationRoom(id, account!.account_id, goals.map((g) => ({ id: g.id, account_id: g.account_id, allocation: g.plan?.allocation, archived: !!g.plan?.archived })), account!.balance!, currency)
    : null;
  const dateKept = !!goal?.plan?.target_date && d.date === goal.plan.target_date;
  const money = (n: number) => formatMoney(n, currency);

  const errors: string[] = [];
  // The field each is about, in the same order.
  const errorFields: DraftField[] = [];
  if (d.target.trim() && target === null) {
    errors.push('Enter a target, like 5000.');
    errorFields.push('target');
  }
  // What the goal has set aside already, kept as it is: the server takes it
  // whatever the balance did since (lib/goal-allocation.ts), so this does too.
  const kept = !!goal && goal.account_id === d.account && goal.plan?.allocation !== undefined && allocation === goal.plan.allocation;
  if (allocate && !kept) {
    if (!account) {
      errors.push('That account isn’t among yours any more: choose another to set part of its balance aside from.');
      errorFields.push('account');
    } else if (!trackable) {
      const why = account.ended
        ? endedWhy(account.ended)
        : account.type && isOwedType(account.type)
          ? 'its balance is owed, not saved'
          : account.hidden
            ? 'it is hidden'
            : 'no balance is known for it yet';
      errors.push(`Nothing can be set aside from ${account.name}: ${why}.`);
      errorFields.push('account');
    } else if (d.allocation.trim() && allocation === null) {
      errors.push('Enter the part of the balance to set aside, like 1500, or 0.');
      errorFields.push('allocation');
    } else if (allocation != null && room !== null && allocation > room) {
      errors.push(`${account.name} has ${money(room)} you can set aside for this goal.`);
      errorFields.push('allocation');
    }
  }
  if (d.monthly.trim() && monthly === null) {
    errors.push('Enter a monthly target, like 250.');
    errorFields.push('monthly');
  }
  if (d.date && !(isCalendarDay(d.date) && d.date <= LATEST_TARGET_DATE && (d.date >= today || dateKept))) {
    errors.push('Pick a target date from today on.');
    errorFields.push('date');
  }

  const plan: GoalPlan = {
    ...(allocate && allocation != null ? { allocation } : {}),
    ...(monthly != null ? { monthly_target: monthly } : {}),
    ...(d.date ? { target_date: d.date } : {}),
  };
  const entry: Goal = { id, name: d.name.trim(), target: target ?? 0, account_id: d.account || null, plan };
  const ready = !!d.name.trim() && target !== null && (!allocate || allocation != null) && errors.length === 0;
  return { entry, account, currency, trackable, room, errors, errorFields, ready };
}

/**
 * The goal as "Archive goal" saves it: archived, its allocation released
 * (lib/goal-save.ts), and with what is typed when the form was changed, which
 * would otherwise be lost; as saved when it wasn't. Null while what is typed
 * can't be saved: archiving waits for it rather than drop it. What is typed
 * for the allocation doesn't matter: archiving releases it.
 */
export function archivedGoal(d: Draft, opts: { goal: Goal; goals: readonly Goal[]; accounts: readonly GoalAccount[]; today: string }): Goal | null {
  const changed = JSON.stringify(d) !== JSON.stringify(draftOf(opts.goal));
  const read = changed ? readDraft({ ...d, allocate: false }, { ...opts, newId: opts.goal.id }) : null;
  if (read && !read.ready) return null;
  const base = read ? read.entry : opts.goal;
  const { allocation: _released, ...kept } = base.plan ?? {};
  return { ...base, plan: { ...kept, archived: true } };
}
