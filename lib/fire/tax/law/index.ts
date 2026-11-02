// lib/fire/tax/law/index.ts
//
// Which law a plan uses. A plan's dollars are today's, so it uses the law of
// today's year: from January 1, 2027, the 2027 law in 2027 dollars. A year's
// table is used only once every part is out (D20); until then the latest
// complete one, and the plan says it is behind. Later years hold that law
// constant in today's dollars, with its scheduled changes by calendar year.
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import { LAW_2026 } from './2026';
import { LAW_2027 } from './2027';
import { LAW_PARTS, type LawPart, type PartialLaw, type TaxLaw } from './types';

/** Every law year Nya has a table for, oldest first. */
export const LAW_YEARS: readonly PartialLaw[] = [LAW_2026, LAW_2027];

/** The parts a year's table still lacks, in LAW_PARTS order. */
export function missingParts(law: PartialLaw): LawPart[] {
  return LAW_PARTS.filter((part) => law[part] === undefined);
}

/** Whether a year's table has every part. */
export function isComplete(law: PartialLaw): law is TaxLaw {
  return missingParts(law).length === 0;
}

/** The law a plan in `year` uses: that year's table if complete, else the
 *  newest complete one before it, with `behind` set. Before the first table,
 *  the first. */
export function lawFor(year: number): { law: TaxLaw; behind: boolean } {
  let found: TaxLaw | null = null;
  for (const law of LAW_YEARS) if (law.year <= year && isComplete(law)) found = law;
  if (found === null) {
    const first = LAW_YEARS[0];
    if (!isComplete(first)) throw new Error('The first law year must be complete');
    return { law: first, behind: false };
  }
  return { law: found, behind: found.year < year };
}
