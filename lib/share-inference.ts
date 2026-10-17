// lib/share-inference.ts
//
// What someone could work out from what is shared with them, beyond what it
// shows (#45 step 3). Each share can be reasonable on its own and still give
// away more beside another: a net worth with one account's balance gives what
// the rest add up to, a goal's projection gives what goes into it each month.
// Worked out here from everything one person shares on a connection
// together, never one share alone, so a share added beside others is judged
// with them: the Sharing drawer says it of what is being chosen, before it is
// saved, and the preview of what they see says it of what they are shown
// (lib/sharing.ts previewShare). Never a refusal: the person decides.
//
// Only arithmetic Nya can be sure of is said, in plain words, each rule once.
// Sharing any total always says something about what is in it; the drawer
// says that too, so a list without a warning isn't taken for a promise.
//
// Pure, with no server imports: the drawer runs it on the device as choices
// change.

import type { Level } from './share-rules';
import type { ShareViews } from './share-kinds';

/** One of the person's accounts that counts in their net worth, with what
 *  the other person sees of it: a level, or null when it isn't shared (or is
 *  shared but shows no balance just now: paused, ended, or waiting for one). */
export type FactAccount = { id: string; label: string; level: Level | null; investment: boolean };

/** A goal shared: its name, whether it is projected (tracked against an
 *  account, so it has a when), and the account it counts. */
export type FactGoal = { name: string; projected: boolean; account_id: string | null };

export type InferenceFacts = {
  accounts: readonly FactAccount[];
  views: ShareViews;
  /** The goals the goals share names, as they are now. */
  goals?: readonly FactGoal[];
};

export type InferenceId = 'net_worth_rest' | 'income' | 'goal_contribution' | 'goal_target' | 'holdings_total' | 'budget_amounts' | 'spending_amounts';
export type Inference = { id: InferenceId; text: string };

/** A balance is shown: the account is shared at a level above "exists". */
const shows = (a: FactAccount) => a.level === 'balance' || a.level === 'transactions';

/** "A", "A and B", "A, B and C". */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "the balance of A", "the balances of A and B", or a count past three. */
function balancesOf(accounts: readonly FactAccount[]): string {
  if (accounts.length === 1) return `the balance of ${accounts[0].label}`;
  if (accounts.length <= 3) return `the balances of ${list(accounts.map((a) => a.label))}`;
  return `the balances of ${accounts.length} of your accounts`;
}

/** Everything they could work out from all of it together, rule by rule, in
 *  the order below. Empty when Nya knows of nothing beyond what is shown. */
export function inferences(f: InferenceFacts): Inference[] {
  const out: Inference[] = [];
  const v = f.views;
  const known = f.accounts.filter(shows);

  // A net worth without its accounts, beside balances that are shown: the
  // total less those is what the others hold. With one left over, that is
  // its balance exactly.
  if (v.net_worth && !v.net_worth.accounts && known.length > 0) {
    const rest = f.accounts.filter((a) => !shows(a));
    if (rest.length === 1) {
      out.push({
        id: 'net_worth_rest',
        text: `They see your net worth and ${balancesOf(known)}, so they can work out the balance of ${rest[0].label}, the one account whose balance you don’t share.`,
      });
    } else if (rest.length > 1) {
      out.push({ id: 'net_worth_rest', text: `They see your net worth and ${balancesOf(known)}, so they can work out what your other accounts add up to.` });
    }
  }

  // Net worth with what is spent each month: what net worth gained in a
  // month plus what was spent in it is about what came in.
  const spent = v.spending?.detail === 'amounts' ? 'your spending each month' : v.budgets?.detail === 'amounts' ? 'what you spend against your budgets' : null;
  if (v.net_worth && spent) {
    out.push({
      id: 'income',
      text:
        v.net_worth.detail === 'history'
          ? `With your net worth over time and ${spent}, they can estimate your income: about what your net worth gained in a month plus what you spent in it.`
          : `With your net worth and ${spent}, they can estimate your income if they note your net worth from month to month: about what it gained in a month plus what you spent.`,
    });
  }

  // A goal's progress and when it will be reached: what is left over the
  // months to then is what goes in each month.
  if (v.goals) {
    const projected = (f.goals ?? []).filter((g) => g.projected);
    if (projected.length > 0) {
      const one = projected.length === 1;
      const names = list(projected.map((g) => g.name));
      const what =
        v.goals.detail === 'amounts'
          ? `about how much goes into ${one ? 'it' : 'each'} a month`
          : `about what share of ${one ? 'its' : 'each one’s'} target goes in a month`;
      out.push({ id: 'goal_contribution', text: `From the progress of ${names} and when ${one ? 'it is' : 'each is'} projected to be reached, they can work out ${what}.` });
    }
    // A goal shown as a percentage, on an account whose balance is shown:
    // when the goal counts that whole balance, its target follows.
    if (v.goals.detail === 'progress') {
      const shown = new Map(known.map((a) => [a.id, a]));
      const onShown = (f.goals ?? []).filter((g) => g.account_id !== null && shown.has(g.account_id));
      if (onShown.length > 0) {
        const one = onShown.length === 1;
        const accounts = [...new Set(onShown.map((g) => g.account_id!))].map((id) => shown.get(id)!);
        out.push({
          id: 'goal_target',
          text: `From the progress of ${list(onShown.map((g) => g.name))} and ${balancesOf(accounts)}, they may be able to work out ${one ? 'its target' : 'their targets'}.`,
        });
      }
    }
  }

  // Holdings as percentages, beside an amount they know of the same money:
  // scaled by it, each part, and the whole, follow.
  if (v.holdings?.detail === 'shares') {
    const investments = known.filter((a) => a.investment);
    const listed = v.net_worth?.accounts === true && f.accounts.some((a) => a.investment);
    if (investments.length > 0 || listed) {
      const amount = investments.length > 0 ? balancesOf(investments) : 'the balances of your investment accounts in your net worth';
      out.push({ id: 'holdings_total', text: `With your holdings as percentages and ${amount}, they can estimate how much is in each part of your holdings, and in all.` });
    }
  }

  // How much of each budget is spent, beside the spending itself: the
  // budget is what was spent over its share.
  if (v.budgets?.detail === 'progress' && v.spending?.detail === 'amounts') {
    out.push({ id: 'budget_amounts', text: 'With how much of each budget is spent and your spending in amounts, they can work out how much your budgets are.' });
  }
  // The other way round: what was spent against budgets, beside spending as
  // percentages, scales them to amounts.
  if (v.spending?.detail === 'shares' && v.budgets?.detail === 'amounts') {
    out.push({
      id: 'spending_amounts',
      text: 'With what you spent against your budgets and your spending as percentages, they can work out about how much you spent in all, and in each group.',
    });
  }
  return out;
}

/** What the drawer says beneath every list of these, warnings or none. */
export const RESIDUAL_NOTE =
  'Any total says something about what is in it. Nya warns about the combinations it can work out, but not every way someone could piece things together.';
