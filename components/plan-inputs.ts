// components/plan-inputs.ts
//
// The Plan's automatic inputs, gathered in one hook for the two screens that
// show FI figures: the Plan tab and the FI card on Home. A year of spending
// and income from the dashboard's transactions (by lib/fire/inputs.ts's
// rules: one currency, the Plan's, what is in another converted into it with
// a home currency chosen, excluded rows left out, cash withdrawals and the cash
// spending entered on an account marked as cash on hand counted once), the
// invested assets from its accounts, what went into workplace plans, from
// the copy of /api/plan-inputs the two screens share (lib/plan-inputs-store.ts,
// useSharedPlanInputs below), and what the connections that bring in no
// transactions mean for those figures (lib/no-transactions.ts). Both screens
// run this and lib/fire/progress.ts on the same plan, so they can't
// disagree.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { isChildAccount, type LeaveOut } from '@/lib/fire/child-accounts';
import { DEFAULT_TAX_FACTS, isTaxFacts, type TaxFactOp, type TaxFacts } from '@/lib/fire/tax-facts';
import { isTaxChoices, type TaxChoices } from '@/lib/fire/tax-choices';
import type { Txn } from './MonthBreakdown';
import { localDate } from '@/lib/local-date';
import {
  cashAccountIds,
  childSavings,
  investedAssets,
  isWorkplacePlan,
  toRetirementFunds,
  trailingFlows,
  transfersOut,
  unreadTransactions,
  workplaceSavings,
  type AssetInstitution,
  type InvestedAssets,
  type Payment,
  type PlanContributions,
  type TrailingFlows,
  type UnreadTransactions,
  type WorkplaceSavings,
} from '@/lib/fire/inputs';
import type { PlanFunding } from '@/lib/fire/plan';
import { transactionCoverage, type FiInputs, type TransactionCoverage } from '@/lib/fire/progress';
import { NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import type { FxTable } from '@/lib/fx/rates';
import type { PageFx } from '@/lib/fx/view';
import { useCurrencySettings } from './currency-state';
import { historyCount } from '@/lib/spending';
import type { PlanInputsCopy, PlanInputsStore, PlanRow } from '@/lib/plan-inputs-store';
import type { AccountYear } from '@/lib/fire/buckets-today';
import { isInvestmentType } from '@/lib/balance';

/** The workplace plans whose contributions are measured: linked (not manual)
 *  and not hidden. */
export function workplacePlansOf(institutions: AssetInstitution[]) {
  return institutions.flatMap((i) =>
    i.item_id
      ? i.accounts
          .filter((a) => !a.hidden && isWorkplacePlan(a.subtype))
          .map((a) => ({ item_id: i.item_id as string, account_id: a.account_id, name: a.name, institution: i.name }))
      : []
  );
}

/** The accounts for a child's education whose payments in come off savings (D7),
 *  measured as workplace plans are: linked and not hidden. Whether one is left out
 *  or counted is in the same answer as its row, so each is asked for either way. */
export function childPlansOf(institutions: AssetInstitution[]) {
  return institutions.flatMap((i) =>
    i.item_id
      ? i.accounts
          .filter((a) => !a.hidden && isChildAccount(a.subtype))
          .map((a) => ({ item_id: i.item_id as string, account_id: a.account_id, name: a.name, institution: i.name }))
      : []
  );
}

/** What the shared copy is asked for, by whoever loads it: one list, since the
 *  copy is for one list at a time (lib/plan-inputs-store.ts). With `childOut`
 *  off, workplace plans alone. */
export function plansAskedFor(institutions: AssetInstitution[], childOut: boolean) {
  return [...workplacePlansOf(institutions), ...(childOut ? childPlansOf(institutions) : [])];
}

/** The investment accounts whose last year the buckets' sheets ask for when they
 *  open (lib/plan-inputs-store.ts fill): linked, not hidden, with a subtype, since
 *  a connector's or SimpleFIN's account has none and no activity to read. At most
 *  what one request may ask for. */
export function planAccountsOf(institutions: AssetInstitution[]) {
  return institutions
    .flatMap((i) => (i.item_id ? i.accounts.filter((a) => !a.hidden && isInvestmentType(a.type) && !!a.subtype).map((a) => ({ item_id: i.item_id as string, account_id: a.account_id })) : []))
    .slice(0, MAX_FILLED);
}
const MAX_FILLED = 100;

/** An account's last year from its row: what isn't known yet (the row is still
 *  coming, failed, or was cached before the field) is null. */
export function yearFrom(row: PlanRow | undefined): AccountYear {
  const known = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (!row || row.pending || row.failed) return { income: null, contributions: null };
  return { income: known(row.dividends_12m), contributions: known(row.contributions_12m) };
}

/** Saves one tax fact. Through the shared copy, so a load waits for it and Home
 *  and the Plan move together: true once the server has it, or why it wasn't. */
export async function saveTaxFact(store: PlanInputsStore, op: TaxFactOp): Promise<true | string> {
  const notSaved = 'It was not saved. Try again in a moment.';
  const end = store.beginSave();
  try {
    const res = await fetch('/api/plan-facts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(op) });
    const body: unknown = await res.json().catch(() => null);
    const answer = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    if (res.ok && answer) {
      store.adopt(answer);
      return true;
    }
    return typeof answer?.error === 'string' ? answer.error : notSaved;
  } catch {
    return notSaved;
  } finally {
    end();
  }
}

/** A workplace plan's id in the Plan's inputs (lib/plan-inputs-store.ts):
 *  its item and account. */
export const planId = (p: { item_id: string; account_id: string }) => `${p.item_id}:${p.account_id}`;

/** Each workplace plan's contributions from the shared copy, in the order
 *  given (workplacePlansOf's: lib/fire/inputs.ts workplaceSavings matches
 *  transfers plan by plan, so the order counts). A plan whose row couldn't
 *  be had measures nothing. Null while any plan's row is still coming, or
 *  the copy is for other plans (one linked, hidden or shown since): never
 *  "nothing measured" for a plan not asked about yet. `key` is what the copy
 *  should be for, when it asks for more than these. */
export function contributionsFrom(copy: PlanInputsCopy, plans: ReturnType<typeof workplacePlansOf>, key = plans.map(planId).join(',')): PlanContributions[] | null {
  if (copy.key !== key) return null;
  const out: PlanContributions[] = [];
  for (const p of plans) {
    const data = copy.rows[planId(p)];
    if (!data || data.pending) return null;
    const base = { account_id: p.account_id, name: p.name, institution: p.institution };
    if (data.failed) {
      out.push({ ...base, amount: null, from: null, partial: false, rows: [], activityFrom: null, note: null });
      continue;
    }
    const rows: unknown = data.contributions_12m_rows;
    out.push({
      ...base,
      amount: typeof data.contributions_12m === 'number' ? data.contributions_12m : null,
      from: typeof data.contributions_12m_from === 'string' ? data.contributions_12m_from : null,
      partial: data.contributions_12m_partial === true,
      rows: Array.isArray(rows)
        ? rows.filter((r): r is Payment => typeof r?.date === 'string' && typeof r?.amount === 'number' && Number.isFinite(r.amount))
        : [],
      activityFrom: typeof data.contributions_12m_activity_from === 'string' ? data.contributions_12m_activity_from : null,
      note: typeof data.note === 'string' ? data.note : null,
    });
  }
  return out;
}

/** The tax facts in the plan's answer: the flat model and nothing given before
 *  any were written, or before an answer has come (useSharedPlanInputs says
 *  which: `factsKnown`). */
export function taxFactsFrom(body: { tax_facts?: unknown } | null | undefined): TaxFacts {
  const facts = body?.tax_facts;
  return isTaxFacts(facts) ? facts : DEFAULT_TAX_FACTS;
}

/** The shared copy of the Plan's inputs, and the workplace plans'
 *  contributions and the tax facts from it. Loads when the screen is shown,
 *  when its plans change and when the copy is invalidated, and at no other
 *  time: a copy that stays stale costs a request a screen, never a loop. A copy
 *  for the same plans is shown while a newer one loads. With `childOut` (D7), a
 *  child's accounts are asked for too; with it off the request is as it was. */
export function useSharedPlanInputs(
  store: PlanInputsStore,
  institutions: AssetInstitution[],
  childOut = false
): { copy: PlanInputsCopy; contributions: PlanContributions[] | null; childContributions: PlanContributions[] | null; childPending: boolean; taxFacts: TaxFacts; factsKnown: boolean; choices: TaxChoices | null } {
  const copy = useSyncExternalStore(store.subscribe, store.get, store.get);
  const plans = useMemo(() => workplacePlansOf(institutions), [institutions]);
  const children = useMemo(() => (childOut ? childPlansOf(institutions) : []), [institutions, childOut]);
  const asked = useRef<string[]>([]);
  asked.current = plansAskedFor(institutions, childOut).map(planId);
  const key = asked.current.join(',');
  useEffect(() => {
    void store.load(asked.current);
  }, [store, key, copy.asked]);
  const contributions = useMemo(() => contributionsFrom(copy, plans, key), [copy, plans, key]);
  const childContributions = useMemo(() => contributionsFrom(copy, children, key), [copy, children, key]);
  const childPending = childContributions === null && children.length > 0;
  // The last plan answered, so a failed reload moves nothing. `tax_facts: null`
  // there is a known state, none written; before any answer, or with facts this
  // page can't read (a newer release's), there is no knowing.
  const body = copy.lastPlan;
  const taxFacts = useMemo(() => taxFactsFrom(body), [body]);
  // Your plan's tax choices: a copy with none takes these.
  const choices = body && isTaxChoices(body.tax) ? body.tax : null;
  return { copy, contributions, childContributions, childPending, taxFacts, factsKnown: !!body && (body.tax_facts === null || isTaxFacts(body.tax_facts)), choices };
}

export type PlanInputs = FiInputs & {
  /** "Today", the viewer's calendar day, that the trailing year ends on. */
  today: string;
  /** Institutions whose transactions couldn't all be read. */
  unread: UnreadTransactions[];
  /** What the connections that bring in no transactions mean for the
   *  figures (lib/fire/progress.ts transactionCoverage). */
  coverage: TransactionCoverage;
  /** The names of the cash accounts cash spending was entered on, for the
   *  label beside spending. */
  cashOn: string[];
  /** Spending was entered by hand on a manual account not marked as cash:
   *  if it is the cash withdrawn, the label says how to keep the two from
   *  both counting. */
  cashUnmarked: boolean;
  /** Workplace plan contributions as measured, null while they load. */
  contributions: PlanContributions[] | null;
  /** What they add to savings with a child's accounts counted again (D7): the
   *  figure beside `workplace` for what leaving them out moved. */
  workplaceCounted: WorkplaceSavings | null;
  flows: TrailingFlows | null;
  assets: InvestedAssets;
  workplace: WorkplaceSavings | null;
  /** What one category or tag came to over the last year. */
  paidFor: (paid: NonNullable<TaxFacts['paidToday']>) => number;
};

/** Everything the Plan measures, from what the dashboard loaded, for a plan's
 *  includeCash and workplace plan settings. */
export function usePlanInputs({
  txns,
  txnNotes,
  without = NO_CONNECTIONS_WITHOUT,
  institutions,
  includeCash,
  planFunding,
  fx = null,
  balanceFx = null,
  currency = null,
  contributions,
  childContributions = null,
  leaveOut = null,
  paid = null,
}: {
  txns: Txn[] | null;
  txnNotes: string[];
  /** The connections that bring in no transactions, as /api/transactions
   *  reports them (lib/no-transactions.ts). */
  without?: NoTransactionsView;
  institutions: AssetInstitution[];
  includeCash: boolean;
  planFunding: PlanFunding[];
  /** What the transactions convert with (/api/transactions `fx`), null
   *  without a home currency. */
  fx?: FxTable | null;
  /** What balances convert with (/api/net-worth base.fx), null without one. */
  balanceFx?: PageFx | null;
  /** The Plan's own currency, the one its figures were typed in, once it is
   *  recorded (lib/fire/plan-currency.ts): everything measured is in it.
   *  Null follows the accounts, as before. */
  currency?: string | null;
  /** What went into workplace plans (useSharedPlanInputs), null while it
   *  loads. */
  contributions: PlanContributions[] | null;
  /** What went into a child's accounts (useSharedPlanInputs), null while it
   *  loads, or with `leaveOut` null. */
  childContributions?: PlanContributions[] | null;
  /** Accounts for a child's education out of invested assets, and what a bank paid
   *  into them out of savings (D7, lib/fire/child-accounts.ts); null counts them,
   *  as before. */
  leaveOut?: LeaveOut | null;
  /** The category or tag already paying for coverage, in the detailed tax model. */
  paid?: TaxFacts['paidToday'];
}): PlanInputs {
  // "Today" is the viewer's calendar day.
  const today = localDate();
  // The manual accounts marked as cash on hand, whose rows entered by hand are
  // what cash withdrawals were spent on (lib/fire/inputs.ts trailingFlows),
  // by name for the label.
  const cashAccounts = useMemo(() => cashAccountIds(institutions), [institutions]);
  // The accounts first: their currency is the Plan's, which the year's
  // flows are converted into with a home currency (lib/fire/inputs.ts),
  // unless the Plan has its own, which both are in.
  const assets = useMemo(() => investedAssets(institutions, includeCash, balanceFx, Date.now(), currency, leaveOut), [institutions, includeCash, balanceFx, currency, leaveOut]);
  const into = assets.currency;
  const flows = useMemo(
    () => (txns ? trailingFlows(txns, today, { cashAccounts, fx, into, ...(currency ? { currency } : {}), ...(paid ? { paid } : {}) }) : null),
    [txns, today, cashAccounts, fx, into, currency, paid]
  );
  const accountNames = useMemo(() => new Map(institutions.flatMap((i) => i.accounts.map((a) => [a.account_id, a.name] as const))), [institutions]);
  const cashOn = useMemo(() => (flows?.cashEnteredOn ?? []).map((id) => accountNames.get(id) ?? 'a cash account'), [flows, accountNames]);
  // Spending entered by hand on a manual account not marked as cash: if it is
  // the cash withdrawn, the label says how to keep the two from both counting.
  const cashUnmarked = useMemo(
    () => (txns ?? []).some((t) => t.source === 'manual' && t.amount > 0 && !!t.account_id && !cashAccounts.has(t.account_id)),
    [txns, cashAccounts]
  );
  const unread = useMemo(() => unreadTransactions(txnNotes), [txnNotes]);
  // Every transaction counts toward "is there spending at all", entered by
  // hand included.
  // Rows the accounts hold, never an IOU's (lib/spending.ts isHistoryRow).
  const transactionCount = txns ? historyCount(txns) : 0;
  const coverage = useMemo(() => transactionCoverage(without, transactionCount), [without, transactionCount]);
  // Payments out of the bank that may have paid for a contribution, so it
  // isn't counted twice (lib/fire/inputs.ts workplaceSavings), or that paid into
  // an account left out for a child (childSavings), which come off savings.
  const bankOut = useMemo(() => (txns ? transfersOut(txns, today) : []), [txns, today]);
  const child = useMemo(() => {
    if (!childContributions || !leaveOut) return null;
    const out = new Set(institutions.flatMap((i) => i.accounts.filter((a) => leaveOut(a)).map((a) => a.account_id)));
    return childSavings(childContributions.filter((c) => out.has(c.account_id)), bankOut, flows);
  }, [childContributions, leaveOut, institutions, bankOut, flows]);
  const workplace = useMemo(
    () => (contributions ? workplaceSavings(contributions, { transfersOut: toRetirementFunds(child?.left ?? bankOut), funding: planFunding }) : null),
    [contributions, child, bankOut, planFunding]
  );
  // The same with a child's accounts counted again, whose transfers it may then
  // match, for what leaving them out moved.
  const workplaceCounted = useMemo(
    () => (child && contributions ? workplaceSavings(contributions, { transfersOut: toRetirementFunds(bankOut), funding: planFunding }) : workplace),
    [child, contributions, bankOut, planFunding, workplace]
  );
  // Without a home currency, what is left out for its currency is weighed by
  // amount at the ECB's newest rates where they price it (lib/fire/progress.ts
  // CurrencyGap): read only when something is left out, and only to weigh.
  const weigh = !fx && !balanceFx && ((flows?.leftOut.length ?? 0) > 0 || assets.leftOut.length > 0);
  const { load } = useCurrencySettings(weigh);
  const rates = weigh && load.kind === 'ready' ? load.view.ecb.rates : null;
  const paidFor = (asked: NonNullable<TaxFacts['paidToday']>) => (txns ? (trailingFlows(txns, today, { cashAccounts, fx, into, ...(currency ? { currency } : {}), paid: asked })?.paid ?? 0) : 0);
  return { today, flows, unread, coverage, assets, contributions, workplace, workplaceCounted, child, cashOn, cashUnmarked, rates, paidFor };
}
