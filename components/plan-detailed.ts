// components/plan-detailed.ts
//
// A detailed plan's figures on the page, by one flow for every caller, the Plan's
// answer, a copy's row and a sheet's preview, and Home's line when the drawdown can
// move it, so the two say one answer:
//
//   1. Flat, as always: a plan in the flat model stops here, and costs nothing new.
//   2. Where the drawdown can't move the answer (drawdownMovesFi): the flat answer's
//      resolution, with `detail` and the bridge added.
//   3. Where it can, and nothing is searched for: worked out here and now.
//   4. Where it can, and something is: the job (lib/fire/search-job.ts). Meanwhile the
//      last answer for these same items, or the flat one, dimmed. Ages go by position,
//      so an answer found for other items is never used.
//
// Loads the law, so Home imports it only for a plan that needs it.

import { overridesOf, type AllocationSettings } from '@/lib/allocation/settings';
import { bucketsToday, type AccountYear, type BasisHolding, type BucketsToday } from '@/lib/fire/buckets-today';
import type { InvestedAssets } from '@/lib/fire/inputs';
import type { Count } from '@/lib/fire/compile';
import type { DetailWork, DetailedInput } from '@/lib/fire/plan-detail';
import { detailWork } from '@/lib/fire/plan-detail';
import { drawdownMovesFi, planFigures, type FiguresRefused, type PlanFigures } from '@/lib/fire/plan-figures';
import type { Measured } from '@/lib/fire/plan';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import { anchoredOn, type Resolution } from '@/lib/fire/steady';
import { DEFAULT_TAX_CHOICES, MAX_RATE, type TaxChoices } from '@/lib/fire/tax-choices';
import type { Owner, TaxFacts } from '@/lib/fire/tax-facts';
import { lawFor } from '@/lib/fire/tax/law';
import { HEALTH_GROWTH } from '@/lib/fire/tax/law/2026';
import { rmdAge } from '@/lib/fire/tax/rmd';
import type { PlanInputsCopy } from '@/lib/plan-inputs-store';
import { planId, yearFrom } from './plan-inputs';
import type { PlanSearch } from './plan-search';

/** What invested assets are by bucket today, from what the page holds. */
export function pageBuckets({ assets, holdings, facts, settings, rows, partner }: { assets: Pick<InvestedAssets, 'accounts' | 'childAccounts'>; holdings: readonly BasisHolding[]; facts: TaxFacts; settings: AllocationSettings | null; rows: PlanInputsCopy['rows']; partner: boolean }): BucketsToday {
  return bucketsToday({
    assets,
    holdings,
    tax: facts,
    overrides: overridesOf(settings).buckets,
    yearOf: (a): AccountYear => (a.item_id ? yearFrom(rows[planId({ item_id: a.item_id, account_id: a.account_id })]) : { income: null, contributions: null }),
    partner,
  });
}

/** What a year's yield is measured as: the last year's dividends and interest over
 *  what taxable accounts hold, for those whose year is known. Null with none. An
 *  account a yield can't be typed for (one that has just been emptied, or a reversal
 *  over the year) says nothing about what the rest pays, and is left out. */
export function measuredYield(today: Pick<BucketsToday, 'groups'>): number | null {
  let income = 0;
  let value = 0;
  for (const g of today.groups) {
    if (g.bucket !== 'taxable') continue;
    for (const a of g.accounts) {
      if (a.income !== null && a.value > 0 && a.income >= 0 && a.income / a.value <= MAX_RATE) {
        income += a.income;
        value += a.value;
      }
    }
  }
  return value > 0 ? income / value : null;
}

/** Each person's share of tax-deferred money in a 457(b), which can be drawn before
 *  59½ with no penalty once they have left that job. */
function shares457(today: Pick<BucketsToday, 'groups'>): Record<Owner, number> {
  const held = { you: 0, partner: 0 };
  const in457 = { you: 0, partner: 0 };
  for (const g of today.groups) {
    if (g.bucket !== 'tax-deferred' && g.bucket !== 'unclassified') continue;
    for (const a of g.accounts) {
      held[a.owner] += a.value;
      if (a.subtype === '457b') in457[a.owner] += a.value;
    }
  }
  return { you: held.you > 0 ? in457.you / held.you : 0, partner: held.partner > 0 ? in457.partner / held.partner : 0 };
}

/** What a plan's drawdown runs on, from what the page knows. `tax` is the plan's
 *  choices, or your plan's where it has none; `paid`, what measured spending holds of
 *  coverage over the last year. */
export function detailedInput({ plan, tax, facts, today, paid, calendarYear }: { plan: Pick<FirePlanV2, 'age' | 'partnerAge'>; tax: TaxChoices | null; facts: TaxFacts; today: BucketsToday; paid: number; calendarYear: number }): DetailedInput {
  const choices = tax ?? DEFAULT_TAX_CHOICES;
  const { law, behind } = lawFor(calendarYear);
  const birth = (owner: Owner, age: number | null) => facts.birthYears.find((b) => b.owner === owner)?.year ?? (age === null ? null : calendarYear - age);
  const ageOfRmd = (year: number | null) => rmdAge(year ?? calendarYear, law.statute);
  const you = ageOfRmd(birth('you', plan.age));
  const state = choices.state;
  return {
    calendarYear,
    filing: facts.filing,
    dependents: facts.dependents,
    rmdAges: { you, partner: plan.partnerAge === null ? you : ageOfRmd(birth('partner', plan.partnerAge)) },
    buckets: { groups: today.groups, roth: today.roth, total: today.total },
    savingsSplit: choices.savingsSplit,
    share457: shares457(today),
    inflation: choices.inflation,
    taxableYield: choices.taxableYield ?? measuredYield(today) ?? 0,
    health: {
      coverage: choices.health.beforeMedicare,
      medicareExtra: choices.health.medicareExtra,
      meetsRule: choices.health.meetsMedicaidRule,
      countMedicaid: choices.health.countMedicaid,
      acaLaw: choices.health.acaLaw,
      growth: choices.health.growth ?? HEALTH_GROWTH.overPrices,
      incomeGrowth: HEALTH_GROWTH.incomeOverPrices,
    },
    state,
    stateRate: state !== null && !law.stateIncomeTax[state] ? 0 : choices.stateRate,
    paidToday: paid,
    law,
    lawYear: { year: law.year, behind },
  };
}

/** A plan's figures, and how far along they are: `working` while a job is out, so the
 *  answer is dimmed and the stress test waits; `failed` where it couldn't be run. */
export type DetailedAnswer = { figures: PlanFigures | FiguresRefused; working: boolean; failed: boolean };

/** Whether the plan searches for its stop or for FI. */
const searches = (plan: FirePlanV2) => plan.stopAtFi || anchoredOn(plan, 'fi');

const MAX_REMEMBERED = 32;

/** The flow, for one page: keeps each plan's figures by what they rest on, since a
 *  tab renders often and a plan's drawdowns cost several times what its flat figures do. */
export function createDetailedFigures(search: Pick<PlanSearch, 'answer' | 'drop'>) {
  const works = new Map<string, DetailWork>();
  const figures = new Map<string, PlanFigures | FiguresRefused>();
  const last = new Map<string, { items: string; resolution: Resolution }>();

  return (slot: string, plan: FirePlanV2, measured: Measured, count: Count, input: DetailedInput, flat: PlanFigures | FiguresRefused): DetailedAnswer => {
    if ('refused' in flat) {
      search.drop(slot);
      return { figures: flat, working: false, failed: false };
    }
    const inputKey = JSON.stringify({ ...input, law: undefined });
    let work = works.get(inputKey);
    if (!work) {
      if (works.size >= MAX_REMEMBERED) works.clear();
      work = detailWork(input);
      works.set(inputKey, work);
    }
    const detailed = work;
    const worked = (resolved?: Resolution) => {
      const key = JSON.stringify([plan, measured, count, resolved ?? null, inputKey]);
      const kept = figures.get(key);
      if (kept) return kept;
      const made = planFigures(plan, measured, { count, detailed, ...(resolved ? { resolved } : {}) });
      if (figures.size >= MAX_REMEMBERED) figures.clear();
      figures.set(key, made);
      return made;
    };
    if (!drawdownMovesFi(plan, flat.walk, flat.view.savings.value ?? 0, flat.view.stopAge)) {
      search.drop(slot);
      return { figures: worked(flat.resolution), working: false, failed: false };
    }
    if (!searches(plan)) {
      search.drop(slot);
      return { figures: worked(), working: false, failed: false };
    }
    const items = plan.items.map((x) => x.id).join(',');
    const result = search.answer(slot, { plan, measured, count, detailed: input });
    if (result === null) {
      const held = last.get(slot);
      return { figures: worked(held && held.items === items ? held.resolution : flat.resolution), working: true, failed: false };
    }
    if (!result.ok) return { figures: worked(flat.resolution), working: false, failed: true };
    if ('refused' in result.answer) return { figures: result.answer, working: false, failed: false };
    last.set(slot, { items, resolution: result.answer });
    return { figures: worked(result.answer), working: false, failed: false };
  };
}
