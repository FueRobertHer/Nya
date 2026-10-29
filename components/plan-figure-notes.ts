// components/plan-figure-notes.ts
//
// What each figure the Plan rests on says (rollout phase 6c): annual
// spending, invested assets, annual savings, the ages and the assumptions,
// each a row of Your path's Your figures card (components/PlanTab.tsx
// InputsCard) that opens its sheet. One source for the words, so the rows,
// the sheets' Why?, the FI card's lines on the number and the Stress test's
// notice say the same thing. For each figure:
//   - its sub: where it comes from, in a few words ("A year, from
//     transactions", "2 accounts, as of Oct 6, 3:12 PM");
//   - what qualifies it, a note each, in the words and at the level the FI
//     card gave them before 6c (every warning a caution, the rest
//     information), each with a few words of its kind for the line that
//     gathers two or more (components/TotalCaveats.tsx), never an amount;
//   - how a measured figure was worked out (`why`), behind Why? in its sheet,
//     worked out whatever is typed, so the sheet explains Nya's figure either
//     way.
// Pure and client-safe. Amounts are written by the `money` it is given (the
// Plan's, through lib/format.ts), and each text is drawn through Masked.

import { KIND_WORDS } from './budget-notes';
import { PAYROLL_NOTE, dayName, pct, savingsRateText } from './plan-text';
import { formatInstantDay, onDay } from '@/lib/format';
import { missingFigureItems, type NoTransactionsView } from '@/lib/no-transactions';
import type { AssetCaveat, InvestedAssets, TrailingFlows, UnreadTransactions, WorkplaceSavings } from '@/lib/fire/inputs';
import {
  assetsGap,
  assetsLeftOut,
  gapText,
  spendingGap,
  spendingLeftOut,
  spendingOff,
  transactionCoverage,
  transactionsMissing,
  type ShareRates,
} from '@/lib/fire/progress';
import { uncategorizedNote } from '@/lib/spending';
import type { EnginePlan, FirePlan, FiView, Missing } from '@/lib/fire/plan';
import type { StartsWith } from '@/lib/fire/plan-figures';

/** One note under a figure: its level, its kind in a few words for the
 *  gathered line (never an amount), and what it says in full. Its own type,
 *  not TotalCaveats' Caveat, whose body is markup: this is drawn through
 *  Masked, which takes a string. */
export type FigureNote = { key: string; level: 'caution' | 'info'; kind: string; text: string };

/** What a figure's row says: where it comes from (`sub`), the second line
 *  under its value (measured savings' rate), how a measured figure was worked
 *  out (`why`, null when there is nothing to say), and the notes under it. */
export type FigureText = { sub: string; line: string | null; why: string | null; notes: FigureNote[] };

export type FigureNotes = { spending: FigureText; savings: FigureText; assets: FigureText; ages: FigureText; assumptions: FigureText };

/** What the figures' words are worked out from: what the FI card took for
 *  its notes before 6c. */
export type FigureArgs = {
  plan: FirePlan;
  view: FiView;
  flows: TrailingFlows | null;
  /** Institutions whose transactions couldn't all be read. */
  unread: UnreadTransactions[];
  /** Connections that bring in no transactions (lib/no-transactions.ts). */
  withoutTransactions: NoTransactionsView;
  /** How many transactions there are, entered by hand included: with any,
   *  there is spending to measure, whatever the connections bring in. */
  transactionCount: number;
  txnsLoading: boolean;
  /** The transactions couldn't be loaded at all. */
  txnsFailed: boolean;
  /** The invested assets as measured, typed over or not. */
  assets: InvestedAssets;
  balancesAsOf: string | null;
  /** Workplace plan contributions, null while they load. */
  workplace: WorkplaceSavings | null;
  /** How many workplace plans there are to measure, null while unknown. */
  workplaceCount: number | null;
  /** The names of the cash accounts the cash spending was entered on. */
  cashOn: string[];
  /** Spending was entered by hand on a manual account not marked as cash. */
  cashUnmarked: boolean;
  money: (n: number) => string;
  /** The trailing year's savings rate (lib/fire/progress.ts), as Home shows it. */
  savingsRate: number | null;
  /** The ECB's rates that weigh what is left out for its currency, without
   *  a home currency (lib/fire/progress.ts ShareRates). */
  shareRates: ShareRates | null;
};

/** How long the window was, for one shorter than a year: "5 months". */
function spanText(flows: TrailingFlows): string {
  return flows.days >= 300 ? `${flows.days} days` : `${Math.max(1, Math.round(flows.days / 30.4))} months`;
}

/** "your last 12 months of transactions (Oct 9, 2025 to Oct 8, 2026)", or how
 *  much shorter it was, scaled up. */
export function windowText(flows: TrailingFlows): string {
  const range = `(${dayName(flows.from)} to ${dayName(flows.to)})`;
  if (!flows.scaled) return `your last 12 months of transactions ${range}`;
  return `${spanText(flows)} of transactions ${range}, scaled up to a year`;
}

/** The local time an instant was, for "as of". */
function fmtInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The day recovered balances were observed: the local day of the instant
 *  when the server knew it, else the stored UTC day (as Dashboard.tsx does). */
function staleDay(asOf: string, at: string | null): string {
  const local = at && at.slice(0, 10) === asOf ? formatInstantDay(at, { sentence: true }) : null;
  return local ?? dayName(asOf);
}

export function names(list: string[]): string {
  const unique = [...new Set(list)];
  if (unique.length <= 1) return unique[0] ?? '';
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/** What may be missing from transaction-based figures, in a sentence, or null. */
export function unreadText(unread: UnreadTransactions[], what: 'low' | 'off'): string | null {
  if (unread.length === 0) return null;
  const named = unread.filter((u) => u.institution).map((u) => u.institution as string);
  const consequence = what === 'low' ? 'so this figure may be low' : 'so this figure may be off';
  if (named.length > 0) return `Transactions from ${names(named)} couldn't all be read (the Activity tab says why), ${consequence}.`;
  return `Your latest transactions couldn't be loaded, ${consequence} or out of date.`;
}

/** What may be wrong with the invested assets figure, one sentence per
 *  problem, each with its kind. */
export function assetCaveatItems(caveats: AssetCaveat[]): { kind: 'unreachable' | 'stale' | 'missing'; text: string }[] {
  const unreachable = caveats.filter((c) => c.kind === 'unreachable').map((c) => c.institution);
  const items: { kind: 'unreachable' | 'stale' | 'missing'; text: string }[] = [];
  if (unreachable.length) {
    items.push({ kind: 'unreachable', text: `${names(unreachable)} couldn't be reached and ${unreachable.length === 1 ? "isn't" : "aren't"} counted, so this figure may be low.` });
  }
  for (const c of caveats) {
    if (c.kind === 'stale') items.push({ kind: 'stale', text: `${c.institution}'s balances are from ${staleDay(c.asOf, c.at)}: it couldn't be reached since.` });
    if (c.kind === 'missing') items.push({ kind: 'missing', text: `${c.count} account${c.count === 1 ? '' : 's'} at ${c.institution} couldn't be shown, so this figure may be low.` });
  }
  return items;
}

/** assetCaveatItems' words alone. */
export function assetCaveatLines(caveats: AssetCaveat[]): string[] {
  return assetCaveatItems(caveats).map((i) => i.text);
}

/** Each note's kind, for the line that gathers two or more ("2 notes:
 *  payroll not set and contributions added"): a few words, never an amount,
 *  in Home's words where Home says the same (components/FiProgressCard.tsx)
 *  and Budgets' for the connections that bring in no transactions
 *  (components/budget-notes.ts). */
export const NOTE_KINDS = {
  spendingGap: 'spending not measured',
  rateGap: 'savings rate not measured',
  yearGap: 'savings not measured',
  assetsGap: 'invested assets not measured',
  otherCurrencies: 'other currencies left out',
  uncategorized: 'uncategorized transactions',
  iousBefore: 'IOUs from before your transactions',
  cashHint: 'cash that may count twice',
  unclearLoans: 'loan payments not counted',
  unreadNamed: 'transactions that couldn’t be read',
  unreadUnnamed: 'transactions not loaded',
  refused: KIND_WORDS.refused,
  no_consent: KIND_WORDS.no_consent,
  checking: 'workplace plans still being checked',
  payroll: 'pay before it reaches a bank',
  added: 'contributions added',
  matched: 'contributions not added twice',
  notSet: 'payroll not set',
  fromBank: 'plans paid from your bank',
  partial: 'a plan counted from later',
  shortHistory: 'a plan’s history starting later',
  unmeasured: 'contributions not measured',
  problems: 'plan activity not read',
  unreachable: 'an institution not reached',
  stale: 'balances from earlier',
  missing: 'accounts not shown',
  unknown: 'balances not known',
  rate: 'your savings rate',
  excluded: 'excluded transactions',
  named: 'connections with no transactions',
  failed: 'transactions not loaded',
  noSpending: 'no transactions to measure from',
  spendingLow: 'spending may be low',
  assetsLow: 'invested assets may be low',
} as const;

const TYPED = 'Typed by you';
const NOT_MEASURED = 'Not measured';
const LOADING = 'Loading your transactions…';

/** A figure's notes, in the order they are added, each keyed by the row, its
 *  kind and its place, never its text (two may say the same). A note with
 *  no text is none. */
function noteList(row: string) {
  const notes: FigureNote[] = [];
  const add = (level: FigureNote['level'], kind: string, text: string | null | undefined) => {
    if (text) notes.push({ key: `${row}:${kind}:${notes.length}`, level, kind, text });
  };
  return { notes, add };
}

/** What a figure says from its parts. */
const said = (sub: string, notes: FigureNote[], why: string | null = null, line: string | null = null): FigureText => ({ sub, line, why, notes });

/** Transactions that couldn't all be read, as a caution of its kind. */
function addUnread(add: ReturnType<typeof noteList>['add'], unread: UnreadTransactions[], what: 'low' | 'off') {
  add('caution', unread.some((u) => u.institution) ? NOTE_KINDS.unreadNamed : NOTE_KINDS.unreadUnnamed, unreadText(unread, what));
}

/** Each bank account or card a figure from transactions is missing, as a
 *  caution of its reason's kind. */
function addMissing(add: ReturnType<typeof noteList>['add'], without: NoTransactionsView, what: 'low' | 'off' | 'uncounted') {
  for (const m of missingFigureItems(without, what)) add('caution', NOTE_KINDS[m.kind], m.text);
}

/** How measured spending was worked out, past the window the sheet's
 *  measured line names: what is in it beyond the Activity tab's rule, the
 *  refunds taken off, and which cash counts. Null when nothing is. */
function spendingWhy(flows: TrailingFlows, money: (n: number) => string, cashOn: string[]): string | null {
  const parts: string[] = [];
  if (flows.loanPayments > 0) parts.push(`${money(flows.loanPayments)} of loan payments (principal counts as spending until the loan ends)`);
  // Cash withdrawn and cash spending entered by hand on an account marked
  // as cash are the same money: only the larger counts, and this says which,
  // and on which accounts (lib/fire/inputs.ts).
  // An IOU you owe settled in cash (lib/shared-expenses/rows.ts) is cash
  // spending too, the withdrawal handed over the same money.
  const ious = flows.cashIous > 0 ? `${cashOn.length > 0 ? ' and' : ''} for what you owed others and settled in cash` : '';
  const on = `${cashOn.length > 0 ? ` on ${names(cashOn)}` : ''}${ious}`;
  if (flows.cash > 0) {
    parts.push(
      flows.cashEntered > 0
        ? `${money(flows.cash)} of cash withdrawals beyond the ${money(flows.cashEntered)} of cash spending you entered${on}, taken to be the same money`
        : `${money(flows.cash)} of cash withdrawals`
    );
  }
  const cashNote =
    flows.cashWithdrawn > 0 && flows.cash === 0
      ? `Cash withdrawals (${money(flows.cashWithdrawn)}) aren't counted: the ${money(flows.cashEntered)} of cash spending you entered${on} is taken to be the same money.`
      : null;
  // Refunds are taken off, so the total and the largest are said: an odd
  // large one (a deposit returned, an insurance payout) can be seen.
  const big = flows.largestRefund;
  const refunds = flows.refunds > 0 ? `${money(flows.refunds)} of refunds${big ? ` (the largest, ${money(big.amount)} from ${big.name} ${onDay(dayName(big.date))})` : ''}` : null;
  const counted = parts.length ? `Includes ${parts.join(' and ')}${refunds ? `, less ${refunds}` : ''}.` : refunds ? `Less ${refunds}.` : null;
  return [counted, cashNote].filter((s): s is string => !!s).join(' ') || null;
}

/** How measured savings were worked out: income minus spending over the
 *  window, what was added for workplace plans, and the savings rate that
 *  makes. */
function savingsWhy(flows: TrailingFlows, workplace: WorkplaceSavings | null, money: (n: number) => string, savingsRate: number | null): string {
  const addedTo = (workplace?.plans ?? []).filter((x) => x.added > 0).map((x) => x.name);
  const plus = addedTo.length ? `, plus ${money(workplace!.total)} paid into ${names(addedTo)}` : '';
  const rate =
    savingsRate !== null ? ` That is a savings rate of ${savingsRateText(savingsRate)} of income${addedTo.length ? ', what went into those plans counted as income too' : ''}.` : '';
  return `An estimate: income minus spending over the same ${flows.scaled ? 'span' : '12 months'}${plus}.${rate}`;
}

/**
 * What each figure's row says (see the top of this file), from what the FI
 * card worked its notes out from before 6c, by the same rules, in the same
 * words and order, at the same levels.
 */
export function figureNotes(a: FigureArgs): FigureNotes {
  // A bank account or card whose transactions don't come in (Plaid doesn't
  // provide them, or they weren't allowed) leaves spending short as surely as
  // one that couldn't be read; no connection that can bring spending in at
  // all, and no transaction from anywhere else, is said in place of the
  // figure, not as waiting for it. With transactions entered by hand, the
  // connections that bring in none are named beside the figures instead. The
  // same function decides this for the FI card on Home (lib/fire/progress.ts),
  // from the same two inputs (components/plan-inputs.ts).
  const coverage = transactionCoverage(a.withoutTransactions, a.transactionCount);
  // Without a home currency, a year that would rest on a part of the
  // spending is no figure at all (lib/fire/progress.ts spendingGap); one
  // with only its income left out still measures the spending (spendingOff).
  const flowsGap = spendingGap(a.flows, a.shareRates);
  return {
    spending: spendingText(a, coverage, flowsGap),
    savings: savingsText(a, coverage, flowsGap),
    assets: assetsText(a),
    ages: said(
      a.plan.age !== null || a.plan.targetAge !== null ? `${a.plan.age ?? '?'} now, stop at ${a.plan.targetAge ?? '?'}` : 'Add them for Coast FI and to place income by age',
      []
    ),
    assumptions: said(
      `${pct(a.plan.withdrawalRate)} withdrawal · ${pct(a.plan.realReturn)} growth after inflation until FI · ${pct(a.plan.taxRate)} tax${a.plan.partTimeIncome > 0 ? ` · ${a.money(a.plan.partTimeIncome)} part-time` : ''}`,
      []
    ),
  };
}

type Coverage = ReturnType<typeof transactionCoverage>;
type Gap = ReturnType<typeof spendingGap>;

/** Spending: the window, what is in it beyond the Activity tab's rule, and
 *  what may be missing. */
function spendingText(a: FigureArgs, coverage: Coverage, flowsGap: Gap): FigureText {
  const { view, flows, unread, withoutTransactions, money } = a;
  const { notes, add } = noteList('spending');
  const noSpending = coverage.noSpending;
  // Said beside the figure's source, not as a warning: nothing is missing.
  const namedWithout = coverage.named;
  const why = flows && !spendingOff(flowsGap) ? spendingWhy(flows, money, a.cashOn) : null;
  if (view.spending.source === 'typed') return said(TYPED, notes, why);
  if (spendingOff(flowsGap)) {
    add('caution', NOTE_KINDS.spendingGap, gapText(flowsGap!));
    return said(NOT_MEASURED, notes);
  }
  if (!flows) {
    if (a.txnsLoading) return said(LOADING, notes);
    if (a.txnsFailed) {
      add('info', NOTE_KINDS.failed, "Your transactions couldn't be loaded; type your spending, or try again later.");
      return said("Couldn't be loaded", notes);
    }
    if (noSpending) {
      add('info', NOTE_KINDS.noSpending, `${noSpending.lead}, so there are no bank or card transactions to measure spending from. Type your own.`);
      return said('No transactions to measure from', notes);
    }
    addMissing(add, withoutTransactions, 'uncounted');
    add('info', NOTE_KINDS.named, namedWithout);
    return said('Not enough transactions yet', notes);
  }
  // Withdrawals counted beside spending entered on an account not marked as
  // cash: both count, so if that is the same cash, say how to stop it.
  const cashHint =
    flows.cashWithdrawn > 0 && flows.cashEntered === 0 && a.cashUnmarked
      ? "Cash withdrawals count as spent, and so does what you entered by hand. If what you entered is the cash you withdrew, mark its account as cash on hand (Update the account), so it isn't counted twice."
      : null;
  // Transactions the person left out of budgets and reports count in no
  // figure here either (lib/fire/inputs.ts), which the label says, and so
  // do those in another currency: in the words the FI card on Home uses
  // (lib/fire/progress.ts spendingLeftOut).
  const leftOut = spendingLeftOut(flows);
  // Loan payments not counted, by where they came from (lib/fire/inputs.ts).
  const unclearElsewhere = flows.unclearLoansElsewhere ?? 0;
  const unclearFromPlaid = flows.unclearLoans - unclearElsewhere;
  add('caution', NOTE_KINDS.otherCurrencies, leftOut.otherCurrencies);
  add('caution', NOTE_KINDS.uncategorized, uncategorizedNote(flows.uncategorized ?? 0));
  // IOUs you owe typed for days before the earliest transaction: outside
  // the span measured, so left out here rather than scaled up (they
  // still count in budgets and reports; lib/fire/inputs.ts).
  add(
    'caution',
    NOTE_KINDS.iousBefore,
    flows.iousBefore
      ? `${flows.iousBefore.count === 1 ? 'An IOU' : `${flows.iousBefore.count} IOUs`} you owe from before ${dayName(flows.from)} (${money(flows.iousBefore.amount)}) ${flows.iousBefore.count === 1 ? "isn't" : "aren't"} counted here: your spending is measured from your transactions, which begin then.`
      : null
  );
  add('caution', NOTE_KINDS.cashHint, cashHint);
  // Said by where the rows came from: Plaid gives a loan's kind when it
  // knows it; a row entered, imported or from SimpleFIN has only its
  // category.
  add(
    'caution',
    NOTE_KINDS.unclearLoans,
    unclearFromPlaid > 0.005
      ? `${money(unclearFromPlaid)} of loan payments isn't counted: Plaid doesn't say it is a mortgage, car, student or personal loan, so it may be paying off a card, which settles spending already counted.`
      : null
  );
  add(
    'caution',
    NOTE_KINDS.unclearLoans,
    unclearElsewhere > 0.005
      ? `${money(unclearElsewhere)} of loan payments you entered, imported or categorized isn't counted: nothing says it pays a mortgage, car, student or personal loan rather than a card, whose payment settles spending already counted.`
      : null
  );
  addUnread(add, unread, 'low');
  addMissing(add, withoutTransactions, 'low');
  add('info', NOTE_KINDS.excluded, leftOut.excluded);
  add('info', NOTE_KINDS.named, namedWithout);
  return said(flows.scaled ? `${spanText(flows)}, scaled up to a year` : 'A year, from transactions', notes, why);
}

/** Savings: bank income minus spending, plus workplace plan contributions. */
function savingsText(a: FigureArgs, coverage: Coverage, flowsGap: Gap): FigureText {
  const { view, flows, unread, withoutTransactions, workplace, workplaceCount, money, savingsRate } = a;
  const { notes, add } = noteList('savings');
  const noSpending = coverage.noSpending;
  const namedWithout = coverage.named;
  const why = flows && !flowsGap ? savingsWhy(flows, workplace, money, savingsRate) : null;
  if (view.savings.source === 'typed') {
    // The savings rate (Home's) is from the transactions whatever is typed
    // here, so it is said here too, as what they measure.
    if (flowsGap) {
      // The rate from the year isn't measured: said, rather than left out unsaid.
      add('caution', NOTE_KINDS.rateGap, gapText(flowsGap, 'rate'));
    } else if (flows && savingsRate !== null) {
      add('info', NOTE_KINDS.rate, `Measured from ${windowText(flows)} instead, your savings rate is ${savingsRateText(savingsRate)} of income.`);
    }
    return said(TYPED, notes, why);
  }
  // The year's own reason, whether spending is typed or not.
  if (flowsGap) {
    add('caution', NOTE_KINDS.yearGap, gapText(flowsGap, 'year'));
    return said(NOT_MEASURED, notes);
  }
  if (!flows) {
    if (a.txnsLoading) return said(LOADING, notes);
    if (noSpending) {
      add('info', NOTE_KINDS.noSpending, `${noSpending.lead}, so there are no bank or card transactions to measure income and spending from. Type your own.`);
      return said('No transactions to measure from', notes);
    }
    add('info', NOTE_KINDS.named, namedWithout);
    return said('Needs a year of transactions', notes);
  }
  // What was added for each workplace plan, what counted and what didn't,
  // so nothing is counted twice unseen (lib/fire/inputs.ts workplaceSavings).
  const plans = workplace?.plans ?? [];
  const fromBank = workplace?.fromBank ?? [];
  add('caution', NOTE_KINDS.checking, workplaceCount === null ? 'Checking contributions to workplace plans…' : null);
  add('caution', NOTE_KINDS.payroll, workplaceCount === 0 ? PAYROLL_NOTE : null);
  for (const x of plans) {
    add(
      'caution',
      NOTE_KINDS.added,
      x.added > 0
        ? x.count > 0
          ? `${x.name}: ${x.count} contribution${x.count === 1 ? '' : 's'} added, ${money(x.added)}${x.largest ? `, the largest ${money(x.largest.amount)} ${onDay(dayName(x.largest.date))}` : ''}${x.paidFrom === 'payroll' ? ', all of them, as it is set as paid through payroll' : ''}.`
          : `${x.name}: ${money(x.added)} added.`
        : null
    );
    add(
      'caution',
      NOTE_KINDS.matched,
      x.matched > 0
        ? `${money(x.matched)} more paid into ${x.name} matched transfers from your bank to investment and retirement funds, which already count as saved, so it isn't added again.`
        : null
    );
    add(
      'caution',
      NOTE_KINDS.notSet,
      x.paidFrom === null && x.added > 0 ? `How ${x.name} is paid into isn't set: if you pay into it from your bank account, say so in Annual savings, or it may count twice.` : null
    );
  }
  add(
    'caution',
    NOTE_KINDS.fromBank,
    fromBank.length
      ? `${names(fromBank)} ${fromBank.length === 1 ? 'is' : 'are'} set as paid from your bank, so nothing paid into ${fromBank.length === 1 ? 'it' : 'them'} is added again.`
      : null
  );
  for (const p of workplace?.partial ?? []) add('caution', NOTE_KINDS.partial, `${p.name} is counted from ${dayName(p.from)}, when Nya's record of it starts.`);
  for (const p of workplace?.shortHistory ?? []) add('caution', NOTE_KINDS.shortHistory, `Nya has activity for ${p.name} from ${dayName(p.from)}.`);
  add(
    'caution',
    NOTE_KINDS.unmeasured,
    workplace && workplace.unmeasured.length ? `Contributions to ${names(workplace.unmeasured)} couldn't be measured, so this figure may be low.` : null
  );
  for (const p of workplace?.problems ?? []) add('caution', NOTE_KINDS.problems, `${p.name}'s activity couldn't all be read, so this figure may be low.`);
  addUnread(add, unread, 'off');
  addMissing(add, withoutTransactions, 'off');
  add('info', NOTE_KINDS.named, namedWithout);
  // The savings rate stays in view, as Home's FI line says it: as the
  // value's second line, which no gathered line can fold away.
  return said(
    flows.scaled ? `Estimated from ${spanText(flows)}, scaled up` : 'Estimated from a year',
    notes,
    why,
    savingsRate !== null ? `${savingsRateText(savingsRate)} savings rate` : null
  );
}

/** Invested assets: what was counted, as of when, and what may be missing.
 *  No `why`: the sub says what was counted and when, and the sheet lists
 *  the accounts with their balances. */
function assetsText(a: FigureArgs): FigureText {
  const { view, plan, assets: measured, balancesAsOf, shareRates } = a;
  const { notes, add } = noteList('assets');
  const accountsGap = assetsGap(measured, shareRates);
  const addCaveats = () => {
    for (const c of assetCaveatItems(measured.caveats)) add('caution', NOTE_KINDS[c.kind], c.text);
  };
  if (view.assets.source === 'typed') return said(TYPED, notes);
  if (accountsGap) {
    add('caution', NOTE_KINDS.assetsGap, gapText(accountsGap));
    addCaveats();
    return said(NOT_MEASURED, notes);
  }
  if (view.assets.source === 'none') {
    addCaveats();
    return said('No investment accounts to measure from', notes);
  }
  if (view.assets.source === 'measured') addCaveats();
  add('caution', NOTE_KINDS.unknown, measured.unknown > 0 ? `${measured.unknown} more had no balance to count, so this figure may be low.` : null);
  add('caution', NOTE_KINDS.otherCurrencies, assetsLeftOut(measured));
  const n = measured.accounts.length;
  return said(`${n} account${n === 1 ? '' : 's'}${plan.includeCash ? ', cash included' : ''}${balancesAsOf ? `, as of ${fmtInstant(balancesAsOf)}` : ''}`, notes);
}

/** What the FI card says on its number of the figures under it ("May be
 *  low: spending is missing …", "Invested assets may be low"), and what the
 *  Stress test's notice reads: what measured spending is missing, or null,
 *  and whether measured invested assets may be low (a stale balance is
 *  still counted, so it alone leaves them as they were). */
export function inputFlags(a: Pick<FigureArgs, 'view' | 'unread' | 'withoutTransactions' | 'transactionCount' | 'assets'>): {
  spendingMissing: string | null;
  assetsShort: boolean;
} {
  const coverage = transactionCoverage(a.withoutTransactions, a.transactionCount);
  return {
    spendingMissing: a.view.spending.source === 'measured' ? transactionsMissing(a.unread, coverage) : null,
    assetsShort: a.view.assets.source === 'measured' && a.assets.caveats.some((c) => c.kind !== 'stale'),
  };
}

/**
 * The Stress test's notice (rollout phase 6c): a caution for each input the
 * simulation uses that may be low, naming the figure and what the test does
 * with it, since less spending reads safer, not lower. None while it can't
 * run ('missing' in engine), where its card says what it needs.
 *   - Spending measured and short: every rule but VPW withdraws it. VPW sets
 *     its own spending from the balance: it starts from the FI number the
 *     spending sets, or its card compares its first year's spending with it.
 *   - Invested assets measured and short: read by a start from them, or by
 *     the start note the card draws when the walk from them comes to less
 *     than the start (lib/fire/plan-figures.ts startsWith.more, a cost the
 *     walk can't pay included). Without that note nothing on the segment
 *     reads them.
 */
export function stressNotice(
  a: Pick<FigureArgs, 'plan' | 'view' | 'unread' | 'withoutTransactions' | 'transactionCount' | 'assets'>,
  engine: EnginePlan | { missing: Missing },
  startsWith: StartsWith | null = null
): FigureNote[] {
  if ('missing' in engine) return [];
  const { spendingMissing, assetsShort } = inputFlags(a);
  const { notes, add } = noteList('stress');
  const vpw = a.plan.rule === 'vpw';
  if (spendingMissing && !vpw) {
    add('caution', NOTE_KINDS.spendingLow, `Your annual spending may be low: it is missing ${spendingMissing}, and the simulation withdraws it (Your path says which).`);
  } else if (spendingMissing && a.plan.start === 'fi-number') {
    add(
      'caution',
      NOTE_KINDS.spendingLow,
      `Your annual spending may be low: it is missing ${spendingMissing}, and the simulation starts from the FI number worked out from it (Your path says which).`
    );
  } else if (spendingMissing) {
    add(
      'caution',
      NOTE_KINDS.spendingLow,
      `Your annual spending may be low: it is missing ${spendingMissing}, and the simulation compares its first year's spending with it (Your path says which).`
    );
  }
  if (assetsShort && (a.plan.start === 'assets' || startsWith?.more)) {
    add('caution', NOTE_KINDS.assetsLow, "Your invested assets may be low: some couldn't be counted (Your path says which).");
  }
  return notes;
}
