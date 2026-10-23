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
export type FactAccount = {
  id: string;
  label: string;
  level: Level | null;
  investment: boolean;
  /** Its currency is one a rate of the person's own converts into their home
   *  currency (lib/share-views.ts ownRatedAccountIds): a converted figure
   *  that counts it, beside it in its own currency, gives that rate away. */
  ownRate?: boolean;
};

/** A goal shared: its name, whether it is projected (tracked against an
 *  account, so it has a when), and the account it counts. */
export type FactGoal = { name: string; projected: boolean; account_id: string | null };

export type InferenceFacts = {
  accounts: readonly FactAccount[];
  views: ShareViews;
  /** The goals the goals share names, as they are now. */
  goals?: readonly FactGoal[];
};

export type InferenceId = 'net_worth_rest' | 'income' | 'goal_contribution' | 'goal_target' | 'holdings_total' | 'budget_amounts' | 'spending_amounts' | 'own_rate';
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
  // Holdings in amounts are what the investment accounts hold together: an
  // amount of the same money as their balances, which nothing else shows
  // while some of them aren't shared at a balance.
  const investmentsUnshown = f.accounts.filter((a) => a.investment && !shows(a));
  const byHoldings = v.holdings?.detail === 'amounts' && investmentsUnshown.length > 0;

  // A net worth beside amounts of parts of it that are shown: the balances
  // of some accounts, and holdings in amounts. The total less those is what
  // the rest hold; with one account left over, that is its balance. A net
  // worth with its accounts lists only balances the accounts' own shares show
  // (lib/share-views.ts), so it gives nothing more than one without them.
  if (v.net_worth && (known.length > 0 || byHoldings)) {
    const rest = f.accounts.filter((a) => !shows(a) && !(byHoldings && a.investment));
    const seen =
      known.length > 0 && byHoldings
        ? `your net worth, ${balancesOf(known)} and your holdings in amounts`
        : known.length > 0
          ? `your net worth and ${balancesOf(known)}`
          : 'your net worth and your holdings in amounts';
    if (rest.length === 1) {
      out.push({
        id: 'net_worth_rest',
        text: byHoldings
          ? `They see ${seen}, so they can work out about the balance of ${rest[0].label}, the one account besides your investments whose balance you don’t share.`
          : `They see ${seen}, so they can work out the balance of ${rest[0].label}, the one account whose balance you don’t share.`,
      });
    } else if (rest.length > 1) {
      out.push({
        id: 'net_worth_rest',
        text: byHoldings
          ? `They see ${seen}, so they can work out about what your ${known.length > 0 ? 'other accounts' : 'accounts'} besides your investments add up to.`
          : `They see ${seen}, so they can work out what your other accounts add up to.`,
      });
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
  // scaled by it, each part, and the whole, follow. The amount is an
  // investment account's balance, or what a net worth leaves for the
  // investment accounts once every other account's balance is shown.
  if (v.holdings?.detail === 'shares') {
    const investments = known.filter((a) => a.investment);
    const leftForThem = !!v.net_worth && investmentsUnshown.length > 0 && f.accounts.every((a) => shows(a) || a.investment);
    if (investments.length > 0) {
      out.push({ id: 'holdings_total', text: `With your holdings as percentages and ${balancesOf(investments)}, they can estimate how much is in each part of your holdings, and in all.` });
    } else if (leftForThem) {
      const amount = known.length > 0 ? 'your net worth less the balances they see' : 'your net worth, which is what your investment accounts hold';
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

  // A figure converted into the home currency (decision 5) beside what it
  // converts, seen in its own currency, through a rate of the person's own:
  // the ECB's rates for everything else are public, so what is left is that
  // rate. Net worth counts every account's balance; holdings in amounts the
  // investment accounts'; spending in amounts, and budgets in amounts, the
  // transactions of an account shared with them.
  const ownSeen = known.filter((a) => a.ownRate);
  const figures = [
    ...(v.net_worth ? ['your net worth'] : []),
    ...(v.holdings?.detail === 'amounts' && ownSeen.some((a) => a.investment) ? ['your holdings in amounts'] : []),
    ...(v.spending?.detail === 'amounts' && ownSeen.some((a) => a.level === 'transactions') ? ['your spending in amounts'] : []),
    ...(v.budgets?.detail === 'amounts' && ownSeen.some((a) => a.level === 'transactions') ? ['what you spend against your budgets'] : []),
  ];
  if (ownSeen.length > 0 && figures.length > 0) {
    const one = ownSeen.length === 1;
    out.push({
      id: 'own_rate',
      text: `They see ${balancesOf(ownSeen)} in ${one ? 'its' : 'their'} own currency, and ${list(figures)} converted into your home currency with your own exchange rate for ${one ? 'it' : 'them'}: with the ECB’s rates for the rest, which are public, they may be able to work out your rate.`,
    });
  }
  return out;
}

/** What the drawer says beneath every list of these, warnings or none. */
export const RESIDUAL_NOTE =
  'Any total says something about what is in it. Nya warns about the combinations it can work out, but not every way someone could piece things together.';
