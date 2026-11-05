// lib/fire/child-accounts.ts
//
// D7: accounts for a child's education aren't there for your years after work,
// so they leave invested assets, in both the flat and the detailed model, behind
// the flag 'plan-child-accounts', unless the person counts one (the tax facts'
// `countAnyway`). A 529, UTMA, UGMA, Coverdell or RESP, by Plaid's subtype.
// The browser (components/plan-inputs.ts) and invested history's route
// (app/api/invested-history) read the same rule, so Home, the Plan and Progress
// count the same accounts.
//
// Pure, importing nothing.

const CHILD_SUBTYPES = new Set(['529', 'ugma', 'utma', 'education savings account', 'resp']);

/** Whether an account's subtype says it is for a child's education. */
export const isChildAccount = (subtype: string | null | undefined): boolean => CHILD_SUBTYPES.has((subtype ?? '').toLowerCase());

/** Which accounts leave invested assets. */
export type LeaveOut = (account: { account_id: string; subtype?: string | null }) => boolean;

/** The rule, or null with the flag off: nothing is left out, and today's
 *  arithmetic runs. */
export function leftOutOf(flagOn: boolean, countAnyway: readonly string[]): LeaveOut | null {
  if (!flagOn) return null;
  const counted = new Set(countAnyway);
  return (a) => isChildAccount(a.subtype) && !counted.has(a.account_id);
}
