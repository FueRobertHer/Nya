// What the Shared expenses card and its sheets say (#49), in words: a
// person's balance, how long it has been open, why a row may be a payment,
// what a row of the list is, and how a cost is split. Pure, so the words are
// tested on their own (test/shared-expenses-ui.test.tsx). Every amount goes
// through the `money` given, a formatter of lib/format.ts, so it is hidden
// while amounts are (components/hide-amounts.ts); what holds one is drawn in
// <Masked>.

import type { KnownApp, Proposal } from '@/lib/shared-expenses/match';
import { LET_GO_MONTHS, REMOVED_NAME, type SplitHow } from '@/lib/shared-expenses/model';
import { monthsBetween } from '@/lib/shared-expenses/balances';
import type { SettlesMark, SharedIou, SharedMark, SharedPart, SharedUnapplied, SettlesUnapplied } from '@/lib/shared-expenses/rows';

type Money = (amount: number) => string;
/** The names of the people, by id: a forgotten one is REMOVED_NAME. */
export type Names = ReadonlyMap<string, string>;

export const nameOf = (names: Names, id: string): string => names.get(id) ?? REMOVED_NAME;

/** A person's balance in one currency, from your side: positive, they owe
 *  you. "Alex owes you $35.00", "You owe Alex $12.00", "Settled up". */
export function balanceText(name: string, amount: number, money: Money): string {
  if (amount > 0) return `${name} owes you ${money(amount)}`;
  if (amount < 0) return `You owe ${name} ${money(-amount)}`;
  return 'Settled up';
}

/** The line under a balance open a long time: "Open for 7 months: let it
 *  go?", only for what they owe you, open LET_GO_MONTHS or more. Never sent
 *  anywhere: it is the person's own nudge, on this card. */
export function letGoText(amount: number, oldest: string | null, today: string): string | null {
  if (!(amount > 0) || !oldest) return null;
  const months = monthsBetween(oldest, today);
  if (months < LET_GO_MONTHS) return null;
  return `Open for ${months} months: let it go?`;
}

const APP_NAMES: Readonly<Record<KnownApp, string>> = { venmo: 'Venmo', cashapp: 'Cash App', zelle: 'Zelle', paypal: 'PayPal', applecash: 'Apple Cash' };
export const appName = (app: KnownApp): string => APP_NAMES[app];

const FIT_WORDS: Readonly<Record<Proposal['fit'], string>> = {
  requested: 'The amount you asked for',
  balance: 'The whole balance',
  items: 'What some of it comes to',
  part: 'Less than the balance',
  over: 'More than the balance',
  several: 'What several people owe together',
};

/** Why a row may be a payment, in words: "The amount you asked for · From
 *  Venmo · Says Alex · 2 days after you asked". */
export function reasonsText(p: Proposal, name: string, asked: boolean): string {
  const out = [FIT_WORDS[p.fit]];
  if (p.app) out.push(`From ${appName(p.app)}`);
  if (p.named) out.push(`Says ${name}`);
  out.push(asked ? `${p.days} ${p.days === 1 ? 'day' : 'days'} after you asked` : `${p.days} ${p.days === 1 ? 'day' : 'days'} after the newest`);
  if (p.choice) out.push('Other items add up to the same, so check which');
  return out.join(' · ');
}

/** Who a row could be from when it fits more than one person alike:
 *  "Could be Alex’s or Sam’s". */
export function whoseText(names: readonly string[]): string {
  const owned = names.map((n) => `${n}’s`);
  const list = owned.length <= 2 ? owned.join(' or ') : `${owned.slice(0, -1).join(', ')} or ${owned[owned.length - 1]}`;
  return `Could be ${list}`;
}

const UNAPPLIED_SHARE: Readonly<Record<SharedUnapplied, string>> = {
  group: 'it is in a group, which says how it counts',
  split: 'it was split since: share one of its parts',
  part: 'it was shared as a part of a split it no longer has',
  currency: 'its currency changed since',
  amount: 'the parts are more than it is now',
};
const UNAPPLIED_PAYMENT: Readonly<Record<SettlesUnapplied, string>> = {
  shared: 'it is shared too',
  split: 'it was split since',
  group: 'it is in a group, which says how it counts',
  currency: 'its currency changed since',
  amount: 'what it pays back no longer fits its amount',
};

/** What a row of the list says of shared expenses, under its name, or null:
 *  a shared transaction ("Shared: your part $60.00 · Alex $60.00"), a
 *  payment ("Paid back: Alex $35.00", "You paid Sam $20.50"), an IOU's row,
 *  or why one isn't applied (it counts whole then). */
export function rowLine(
  t: { shared?: SharedMark; settles?: SettlesMark; shared_iou?: SharedIou; shared_part?: SharedPart; shared_unapplied?: SharedUnapplied; settles_unapplied?: SettlesUnapplied },
  names: Names,
  money: Money
): string | null {
  if (t.shared_iou) return `Your part of what ${nameOf(names, t.shared_iou.person)} paid (an IOU)`;
  if (t.shared_part) return t.shared_part.kind === 'theirs' ? `${nameOf(names, t.shared_part.person)}’s part` : `Paid back by ${nameOf(names, t.shared_part.person)}`;
  if (t.shared_unapplied) return `Shared, but counted whole: ${UNAPPLIED_SHARE[t.shared_unapplied]}`;
  if (t.settles_unapplied) return `Confirmed as a payment, but counted as the bank shows it: ${UNAPPLIED_PAYMENT[t.settles_unapplied]}`;
  if (t.shared) {
    const others = t.shared.people.map((p) => `${nameOf(names, p.person)} ${money(p.amount)}`).join(' · ');
    return `Shared: your part ${money(t.shared.your_part)} · ${others}${t.shared.counted ? '' : ' (counted whole, as you chose)'}`;
  }
  if (t.settles) {
    const back = t.settles.people.filter((p) => p.direction === 'to_you');
    const paid = t.settles.people.filter((p) => p.direction === 'by_you');
    const said: string[] = [];
    if (back.length > 0) said.push(`Paid back: ${back.map((p) => `${nameOf(names, p.person)} ${money(p.amount)}`).join(' · ')}`);
    if (paid.length > 0) said.push(`You paid ${paid.map((p) => `${nameOf(names, p.person)} ${money(p.amount)}`).join(' · ')}`);
    return said.join('; ');
  }
  return null;
}

/**
 * The parts of a cost, in the currency's minor units, as a way of splitting
 * it gives them: half with one person; evenly among the people and you; by
 * percent each. What can't be split to the unit stays yours (your part is
 * the rest), so no part is ever more than its share. `how: amount` gives
 * nothing: the parts are typed.
 */
export function splitUnits(total: number, how: SplitHow, people: number, percents: readonly number[] = []): number[] {
  if (!(total > 0) || people < 1) return [];
  switch (how.kind) {
    case 'half':
      return [Math.floor(total / 2)];
    case 'even': {
      const each = Math.floor(total / (people + 1));
      return Array.from({ length: people }, () => each);
    }
    case 'percent':
      return Array.from({ length: people }, (_, i) => Math.floor((total * (percents[i] ?? how.percent)) / 100));
    case 'amount':
      return [];
  }
}
