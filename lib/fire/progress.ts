// lib/fire/progress.ts
//
// The FI figures from the Plan's automatic inputs, in one place, for the two
// screens that show them: the Plan tab (components/PlanTab.tsx) and the FI
// card on Home (components/FiProgressCard.tsx). Both get their inputs from
// the same hook (components/plan-inputs.ts) and their figures from here, on
// the same plan as the Plan tab repairs it (lib/fire/plan.ts repairPlan), so
// Home and the Plan always agree.
//
// The savings rate is new here, and Home's: the share of a year's income
// that was saved, over the same trailing year as the spending and savings
// figures. Contributions to workplace plans count on both sides, since they
// are income that never reached a bank account: (income + contributions -
// spending) / (income + contributions). It is an estimate, as the savings
// figure is: pre-tax contributions to a plan Nya can't see, and an
// employer's match, are in neither.
//
// Arithmetic only: no engine, no market history.

import { fiView, type FirePlan, type FiView, type Measured } from './plan';
import type { InvestedAssets, TrailingFlows, WorkplaceSavings } from './inputs';

/** What the Plan measures from, as the hook gathers it. */
export type FiInputs = {
  flows: TrailingFlows | null;
  /** Workplace plan contributions, null while they load. */
  workplace: WorkplaceSavings | null;
  assets: InvestedAssets;
};

/** The measured inputs a plan's figures start from (each can be typed over
 *  in the plan): spending and savings from a year of transactions, savings
 *  with workplace plan contributions added, and invested assets. */
export function measuredInputs({ flows, workplace, assets }: FiInputs): Measured {
  return {
    spending: flows?.spending ?? null,
    savings: flows ? flows.savings + (workplace?.total ?? 0) : null,
    assets: assets.total,
  };
}

/** The trailing year's savings rate (see the top of this file), or null
 *  with no year of transactions or no income to take a share of. */
export function savingsRate({ flows, workplace }: Pick<FiInputs, 'flows' | 'workplace'>): number | null {
  if (!flows) return null;
  const contributions = workplace?.total ?? 0;
  const income = flows.income + contributions;
  if (!(income > 0)) return null;
  return (flows.savings + contributions) / income;
}

/** The currency plan amounts are shown in: the accounts' own, or the
 *  transactions', or the dashboard's. */
export function planCurrency({ flows, assets }: Pick<FiInputs, 'flows' | 'assets'>, fallback: string | null): string | null {
  return assets.currency ?? flows?.currency ?? fallback;
}

/** What the figures can't add up, in a sentence, or null. Nothing is
 *  converted between currencies in this app: investments in one and spending
 *  in another can't be compared, nor added up within either. */
export function currencyNote({ flows, assets }: Pick<FiInputs, 'flows' | 'assets'>): string | null {
  if (assets.currency && flows?.currency && assets.currency !== flows.currency) {
    return `Your investments are in ${assets.currency} and your spending in ${flows.currency}. Nya doesn't convert currencies, so the FI number and your assets can't be compared.`;
  }
  if (assets.mixedCurrency || flows?.mixedCurrency) return 'Your accounts use more than one currency; amounts are added without converting them.';
  return null;
}

export type FiFigures = {
  view: FiView;
  savingsRate: number | null;
  currency: string | null;
  currencyNote: string | null;
};

/** Every figure the Plan tab and Home show from a plan and its inputs. */
export function fiFigures(plan: FirePlan, inputs: FiInputs, fallbackCurrency: string | null): FiFigures {
  return {
    view: fiView(plan, measuredInputs(inputs)),
    savingsRate: savingsRate(inputs),
    currency: planCurrency(inputs, fallbackCurrency),
    currencyNote: currencyNote(inputs),
  };
}
