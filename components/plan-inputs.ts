// components/plan-inputs.ts
//
// The Plan's automatic inputs, gathered in one hook for the two screens that
// show FI figures: the Plan tab and the FI card on Home. A year of spending
// and income from the dashboard's transactions (by lib/fire/inputs.ts's
// rules: one currency, excluded rows left out, cash withdrawals and the cash
// spending entered on an account marked as cash on hand counted once), the
// invested assets from its accounts, what went into workplace plans, from
// one /api/investment-activity request per plan (as the Accounts tab makes
// when an account is opened), and what the connections that bring in no
// transactions mean for those figures (lib/no-transactions.ts). Both screens
// run this and lib/fire/progress.ts on the same plan, so they can't
// disagree.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import { localDate } from '@/lib/local-date';
import {
  cashAccountIds,
  investedAssets,
  isWorkplacePlan,
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

/** One workplace plan contributions request per account, as the Accounts tab
 *  makes when an account is opened. Null until every answer is in. */
export function useWorkplaceContributions(institutions: AssetInstitution[]): PlanContributions[] | null {
  const plans = workplacePlansOf(institutions);
  const key = plans.map((p) => `${p.item_id}:${p.account_id}`).join(',');
  const plansRef = useRef(plans);
  plansRef.current = plans;
  const [state, setState] = useState<{ key: string; plans: PlanContributions[] } | null>(null);
  useEffect(() => {
    const wanted = plansRef.current;
    let live = true;
    Promise.all(
      wanted.map(async (p): Promise<PlanContributions> => {
        const base = { account_id: p.account_id, name: p.name, institution: p.institution };
        const none = { ...base, amount: null, from: null, partial: false, rows: [], activityFrom: null, note: null };
        try {
          const res = await fetch(`/api/investment-activity?id=${encodeURIComponent(p.account_id)}&item_id=${encodeURIComponent(p.item_id)}`);
          if (!res.ok) return none;
          const data = await res.json();
          const rows: unknown = data?.contributions_12m_rows;
          return {
            ...base,
            amount: typeof data?.contributions_12m === 'number' ? data.contributions_12m : null,
            from: typeof data?.contributions_12m_from === 'string' ? data.contributions_12m_from : null,
            partial: data?.contributions_12m_partial === true,
            rows: Array.isArray(rows)
              ? rows.filter((r): r is Payment => typeof r?.date === 'string' && typeof r?.amount === 'number' && Number.isFinite(r.amount))
              : [],
            activityFrom: typeof data?.contributions_12m_activity_from === 'string' ? data.contributions_12m_activity_from : null,
            note: typeof data?.note === 'string' ? data.note : null,
          };
        } catch {
          return none;
        }
      })
    ).then((answers) => {
      if (live) setState({ key, plans: answers });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return state && state.key === key ? state.plans : null;
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
  flows: TrailingFlows | null;
  assets: InvestedAssets;
  workplace: WorkplaceSavings | null;
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
}: {
  txns: Txn[] | null;
  txnNotes: string[];
  /** The connections that bring in no transactions, as /api/transactions
   *  reports them (lib/no-transactions.ts). */
  without?: NoTransactionsView;
  institutions: AssetInstitution[];
  includeCash: boolean;
  planFunding: PlanFunding[];
}): PlanInputs {
  // "Today" is the viewer's calendar day.
  const today = localDate();
  // The manual accounts marked as cash on hand, whose rows entered by hand are
  // what cash withdrawals were spent on (lib/fire/inputs.ts trailingFlows),
  // by name for the label.
  const cashAccounts = useMemo(() => cashAccountIds(institutions), [institutions]);
  const flows = useMemo(() => (txns ? trailingFlows(txns, today, { cashAccounts }) : null), [txns, today, cashAccounts]);
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
  const transactionCount = txns?.length ?? 0;
  const coverage = useMemo(() => transactionCoverage(without, transactionCount), [without, transactionCount]);
  const assets = useMemo(() => investedAssets(institutions, includeCash), [institutions, includeCash]);
  const contributions = useWorkplaceContributions(institutions);
  // Payments out of the bank that may have paid for a contribution, so it
  // isn't counted twice (lib/fire/inputs.ts workplaceSavings).
  const bankOut = useMemo(() => (txns ? transfersOut(txns, today) : []), [txns, today]);
  const workplace = useMemo(
    () => (contributions ? workplaceSavings(contributions, { transfersOut: bankOut, funding: planFunding }) : null),
    [contributions, bankOut, planFunding]
  );
  return { today, flows, unread, coverage, assets, contributions, workplace, cashOn, cashUnmarked };
}
