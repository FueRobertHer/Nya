import { MAIN_ID, factsOf, type PlanFacts } from '@/lib/fire/copies';
import { DEFAULT_PLAN_V2 } from '@/lib/fire/plan-v2';
import { DEFAULT_TAX_FACTS } from '@/lib/fire/tax-facts';

/** `plan-facts` saying everything that can be said about each of these accounts,
 *  beside a Roth amount, which is said of a person and goes with no account. A
 *  forget's test compares what is left with this for the accounts still there, so
 *  it pins the rest of the facts too. */
export const factsAbout = (...ids: string[]): PlanFacts => ({
  version: 2,
  main: MAIN_ID,
  ...factsOf(DEFAULT_PLAN_V2),
  tax: {
    ...DEFAULT_TAX_FACTS,
    rothContributions: [{ owner: 'you', amount: 45_000 }],
    owners: ids.map((account_id) => ({ account_id, owner: 'partner' })),
    basis: ids.map((account_id) => ({ account_id, amount: 105_000 })),
    countAnyway: ids,
  },
});
