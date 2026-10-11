// lib/goal-text.ts
//
// What a goal says about itself, in words (#42): the Goals card shows these
// sentences, and the read-only API gives the same ones as each goal's notes,
// so the two never tell it differently. Pure, safe to import from client
// code. Amounts are in the goal's account's currency (lib/format.ts), and
// nothing here converts one currency to another.

import { formatMoney } from './format';
import type { MonthGap } from './goal-projection';
import type { AccountSplit } from './goal-allocation';
import type { GoalAccountEnd, GoalView } from './goal-view';
import type { Goal } from './goal-model';

/** "March 2027" for 2027-03. */
export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "Jun 1, 2027" for 2027-06-01. */
export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** "Sep 12" for an instant, on the viewer's calendar. */
function instantLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const lastMonths = (n: number) => (n === 1 ? 'the last month' : `the last ${n} months`);

/** How an account ended, from its day: "it closed on Mar 12, 2026". */
export function endedWhy(end: GoalAccountEnd): string {
  const day = dayLabel(end.on);
  switch (end.state) {
    case 'closed':
      return end.assumed ? `it is assumed closed from ${day}` : `it closed on ${day}`;
    case 'left':
      return `it isn’t yours from ${day}`;
    case 'untracked':
      return `it isn’t followed from ${day}`;
  }
}

/** An account that ended, in a word or two, beside its name in a list. */
export function endedTag(end: GoalAccountEnd): string {
  switch (end.state) {
    case 'closed':
      return end.assumed ? 'assumed closed' : 'closed';
    case 'left':
      return 'no longer yours';
    case 'untracked':
      return 'not followed';
  }
}

/** Why a goal on an account that ended counts nothing, with the day, and,
 *  when Nya assumed the closure, where to say whether it did. */
function endedText(view: GoalView): string {
  const end = view.account?.ended;
  if (!end) return 'Its account has ended, so it counts nothing';
  if (end.assumed) {
    return `Its account is assumed closed from ${dayLabel(end.on)}, as ${view.account?.institution || 'its bank'} stopped reporting it, so it counts nothing from then. Say whether it closed under Accounts that ended, on the Accounts tab`;
  }
  return `${endedWhy(end).replace(/^it /, 'Its account ')}, so it counts nothing from then`;
}

/** Why a goal shows no progress, for every state but tracked. */
export function stateText(view: GoalView): string | null {
  switch (view.state) {
    case 'untracked':
      return 'No account linked';
    case 'hidden':
      return 'Tracked account is hidden';
    case 'disconnected':
      return 'Linked account disconnected';
    case 'ended':
      return endedText(view);
    case 'owed':
      return 'Tracks a credit card or loan, whose balance is owed, not saved, so no progress is shown. Choose a savings account for it, or plan a payoff with the debt payoff planner.';
    case 'no_balance':
      return 'No balance is known for its account yet';
    case 'tracked':
      return null;
  }
}

/**
 * The goal's one-line outlook: reached, when it will be, how far short of its
 * date it is, or why it can't say. `nameOf` names another goal (for an
 * account several goals share). Null unless tracked.
 */
export function outlookText(view: GoalView, nameOf: (id: string) => string): string | null {
  const p = view.projection;
  if (!p) return null;
  const money = (n: number) => formatMoney(n, view.currency);
  const date = view.goal.plan?.target_date;
  const atTarget = p.rateFrom === 'monthly_target' ? ` at your ${money(p.rate!)} monthly target` : '';
  switch (p.status) {
    case 'complete':
      return 'Reached';
    case 'no_recent_contributions': {
      const months = lastMonths(view.measured?.months ?? 3);
      const where = view.account?.name ?? 'its account';
      if (view.measured?.source === 'balances') return `No recent contributions: ${where}’s recorded balance hasn’t grown over ${months}`;
      return (p.rate ?? 0) < 0
        ? `No recent contributions: more went out of ${where} than came in over ${months}`
        : `No contributions in ${months}`;
    }
    case 'no_rate':
      if (view.sharing.length > 0) {
        return `${view.account?.name ?? 'Its account'} is shared with ${view.sharing.map(nameOf).join(' and ')}, so this goal’s own pace isn’t known: set a monthly target to see when it will be reached`;
      }
      // Months its connection didn't bring in are not "no history": the gap
      // note says why they aren't known.
      if (view.gaps.length > 0) return `What went into ${view.account?.name ?? 'its account'} lately isn’t known, so neither is its pace: a monthly target projects it meanwhile`;
      return 'No history to go by yet: set a monthly target to see when it will be reached';
    case 'on_track':
    case 'behind': {
      if (p.beyond) return `Not within 50 years at this pace${date ? `, and its date is ${dayLabel(date)}` : ''}`;
      const when = monthLabel(p.completion!);
      if (!date) return `On track for ${when}${atTarget}`;
      if (p.datePassed) return `Its date, ${dayLabel(date)}, has passed; at this pace, reached in ${when}`;
      const due = monthLabel(date.slice(0, 7));
      if (p.status === 'on_track') {
        return p.completion! < date.slice(0, 7) ? `On track for ${when}${atTarget}, ahead of ${due}` : `On track for ${due}${atTarget}`;
      }
      return `${money(p.short!)} a month short of ${due}${p.rateFrom === 'monthly_target' ? ' at your monthly target' : ''}; at this pace, reached in ${when}`;
    }
  }
}

/** What went in, as the rate was measured, and what it can't tell apart.
 *  Null when nothing was measured. */
export function paceText(view: GoalView): string | null {
  const m = view.measured;
  if (!m || view.state !== 'tracked') return null;
  const money = (n: number) => formatMoney(n, view.currency);
  const months = lastMonths(m.months);
  const target = view.goal.plan?.monthly_target;
  const versus = target !== undefined ? ` (your target is ${money(target)})` : '';
  const where = view.account?.name ?? 'Its account';
  if (m.source === 'balances') {
    return `${where}’s recorded balance changed by ${money(m.average)} a month on average over ${months}${versus}: that includes interest and market moves, which can’t be told apart from what you put in`;
  }
  const growth = m.growth > 0 ? `, plus ${money(m.growth)} of interest and dividends, not counted` : '';
  return `${money(m.average)} a month went into ${where} on average over ${months}${versus}${growth}`;
}

/** Each reason in a list of gaps, once, in words. */
function gapReasons(gaps: readonly MonthGap[]): string[] {
  const said = new Set<string>();
  for (const g of gaps) {
    switch (g.kind) {
      case 'missing':
        said.add(`${g.institution}’s transactions couldn’t be loaded`);
        break;
      case 'importing':
        said.add(`${g.institution} is still importing older transactions`);
        break;
      case 'stopped':
        said.add(g.since ? `${g.institution} hasn’t synced since ${instantLabel(g.since)}` : `${g.institution} isn’t syncing`);
        break;
      case 'begins':
        said.add(`its transactions in Nya begin on ${dayLabel(g.on)}, so ${monthLabel(g.on.slice(0, 7))} may be short`);
        break;
    }
  }
  return [...said];
}

/** Why the measured months may be short, or null when nothing says so. */
export function gapsText(gaps: readonly MonthGap[]): string | null {
  const said = gapReasons(gaps);
  return said.length === 0 ? null : `The pace may be off: ${said.join('; ')}.`;
}

/** What the goal says of its months' gaps: that its pace may be off, when it
 *  is projected from them or some of them are known (a shared account's pace
 *  is still said, though not projected from); otherwise, with none it can go
 *  by, that what went in lately isn't known, and why (a connection that
 *  stopped before the months began). Null when nothing says either. */
export function gapNote(view: GoalView): string | null {
  if (view.projection?.status === 'complete') return null;
  const m = view.measured;
  if (m && (view.projection?.rateFrom === 'contributions' || !m.allUncertain)) return gapsText(m.gaps);
  const said = gapReasons(view.gaps);
  return said.length === 0 ? null : `What went into ${view.account?.name ?? 'its account'} lately isn’t known: ${said.join('; ')}.`;
}

/** Why it is paced by its recorded balance rather than its transactions,
 *  when that is because they couldn't be read; null otherwise. */
export function fallbackText(view: GoalView): string | null {
  if (!view.fallback) return null;
  const where = view.account?.name ?? 'its account';
  return view.fallback === where
    ? `${where}’s transactions couldn’t be read, so this goal is paced by its recorded balance instead.`
    : `${view.fallback}’s transactions couldn’t be read, so this goal is paced by ${where}’s recorded balance instead.`;
}

/** Where it should be by now on the way to its target date, in words. */
export function shouldHaveText(view: GoalView): string | null {
  const date = view.goal.plan?.target_date;
  if (view.shouldHave === null || !date) return null;
  return `To reach it by ${dayLabel(date)}, it would have ${formatMoney(view.shouldHave, view.currency)} by now`;
}

/** The progress meter in words, for a screen reader: what it shows, and the
 *  "where you should be" marker when there is one. */
export function meterLabel(view: GoalView): string {
  const saved = view.saved ?? 0;
  const pct = Math.floor((Math.max(saved, 0) / view.goal.target) * 100);
  const marker = shouldHaveText(view);
  return `${formatMoney(saved, view.currency)} of ${formatMoney(view.goal.target, view.currency)} saved, ${pct}%.${marker ? ` ${marker}.` : ''}`;
}

/** A sentence a goal says beside its outlook, and whether it warns (a figure
 *  that may be off, or money shown other than as set) or only informs. */
export type GoalNote = { text: string; warn: boolean };

/**
 * What a goal says beside its outlook, in order: why its pace may be off or
 * isn't known, why it is paced by its balance, the money it counts (scaled to
 * fit, counted by another goal too, an allocation it no longer applies), that
 * it follows a reconnected account, and where it should be by now.
 */
export function goalNotes(view: GoalView, nameOf: (id: string) => string, split: AccountSplit | undefined): GoalNote[] {
  const notes: GoalNote[] = [];
  const money = (n: number) => formatMoney(n, view.currency);
  const where = view.account?.name ?? 'its account';
  const gap = gapNote(view);
  if (gap) notes.push({ text: gap, warn: true });
  const fallback = fallbackText(view);
  if (fallback) notes.push({ text: fallback, warn: true });
  if (view.claim?.scaled && split) {
    notes.push({
      text: `Allocations on ${where} add up to ${money(split.allocated)}, more than its ${money(split.balance)} balance, so each is shown scaled to fit. Lower them to match.`,
      warn: true,
    });
  }
  if (view.claim && view.claim.kind === 'remainder' && view.claim.sharedWith.length > 0) {
    notes.push({
      text: `Counts the same ${money(view.claim.amount)} as ${view.claim.sharedWith.map(nameOf).join(' and ')}: give ${view.claim.sharedWith.length === 1 ? 'each' : 'them'} an allocation to split it.`,
      warn: false,
    });
  }
  if (view.goal.earlier_allocation !== undefined) {
    notes.push({
      text: `Its allocation of ${money(view.goal.earlier_allocation)} was set on the account it tracked before, so here it counts what isn’t allocated. The next save drops it.`,
      warn: true,
    });
  }
  if (view.goal.relinked) notes.push({ text: `Follows ${where}, which was reconnected.`, warn: false });
  const should = shouldHaveText(view);
  if (should) notes.push({ text: `${should}.`, warn: false });
  return notes;
}

/** Every sentence a goal says, in order: for the API's notes. */
export function goalSentences(view: GoalView, nameOf: (id: string) => string, split: AccountSplit | undefined): string[] {
  const out = [stateText(view), outlookText(view, nameOf), paceText(view)];
  return [...out.filter((s): s is string => !!s).map((s) => (/[.!?]$/.test(s) ? s : `${s}.`)), ...goalNotes(view, nameOf, split).map((n) => n.text)];
}

/** One account's line above the goals: what no allocation claims, or how
 *  far the allocations are over its balance. */
export function splitText(split: AccountSplit, name: string): string {
  const money = (n: number) => formatMoney(n, split.currency);
  if (split.over > 0) return `${name}: allocations are ${money(split.over)} more than its ${money(split.balance)} balance`;
  return `${name}: ${money(split.unallocated)} unallocated of ${money(split.balance)}`;
}

/** Where the pace comes from, when it isn't the account's transactions: a
 *  label the outlook carries, so a change in balance is never read as
 *  contributions. Null otherwise. */
export function sourceNote(view: GoalView): string | null {
  if (view.projection?.rateFrom !== 'contributions' || view.measured?.source !== 'balances') return null;
  return 'Paced by its recorded balance, which includes interest and market moves';
}

/** An archived goal in a line: reached or not, what it held, and when it was
 *  archived. `currency` is its account's. */
export function archivedText(goal: Pick<Goal, 'target' | 'archived_on' | 'archived_amount'>, currency: string | null): string {
  const on = goal.archived_on ? `archived ${dayLabel(goal.archived_on)}` : 'archived';
  const held = goal.archived_amount;
  if (held === undefined) return on[0].toUpperCase() + on.slice(1);
  if (held >= goal.target) return `Reached ${formatMoney(goal.target, currency)} · ${on}`;
  return `Had ${formatMoney(held, currency)} of ${formatMoney(goal.target, currency)} · ${on}`;
}
