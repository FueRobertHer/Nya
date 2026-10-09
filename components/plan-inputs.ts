// components/plan-inputs.ts
//
// The Plan's automatic inputs, gathered in one hook for the two screens that
// show FI figures: the Plan tab and the FI card on Home. A year of spending
// and income from the dashboard's transactions, the invested assets from its
// accounts, and what went into workplace plans, from one
// /api/investment-activity request per plan (as the Accounts tab makes when
// an account is opened). Both screens run this and lib/fire/progress.ts on
// the same plan, so they can't disagree.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import { localDate } from '@/lib/local-date';
import {
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
import type { FiInputs } from '@/lib/fire/progress';

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
  institutions,
  includeCash,
  planFunding,
}: {
  txns: Txn[] | null;
  txnNotes: string[];
  institutions: AssetInstitution[];
  includeCash: boolean;
  planFunding: PlanFunding[];
}): PlanInputs {
  // "Today" is the viewer's calendar day.
  const today = localDate();
  const flows = useMemo(() => (txns ? trailingFlows(txns, today) : null), [txns, today]);
  const unread = useMemo(() => unreadTransactions(txnNotes), [txnNotes]);
  const assets = useMemo(() => investedAssets(institutions, includeCash), [institutions, includeCash]);
  const contributions = useWorkplaceContributions(institutions);
  // Payments out of the bank that may have paid for a contribution, so it
  // isn't counted twice (lib/fire/inputs.ts workplaceSavings).
  const bankOut = useMemo(() => (txns ? transfersOut(txns, today) : []), [txns, today]);
  const workplace = useMemo(
    () => (contributions ? workplaceSavings(contributions, { transfersOut: bankOut, funding: planFunding }) : null),
    [contributions, bankOut, planFunding]
  );
  return { today, flows, unread, assets, contributions, workplace };
}
