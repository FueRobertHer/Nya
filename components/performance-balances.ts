// The balances now of every investment account at a Vanguard connection
// (by Plaid's institution id), for checking a Performance page against them
// (lib/import/performance-review.ts): a file whose balance is all of them
// together is a print of every account, never one account's. Apart from
// components/PerformanceImport.tsx, so the dashboard doesn't load pdf.js's
// reader to work it out.

import type { Institution } from './accounts-format';
import { isInvestmentType } from '@/lib/balance';
import { isVanguard } from '@/lib/investment-months';

export function vanguardBalances(institutions: readonly Institution[]): number[] {
  return institutions
    .filter((i) => !i.manual && isVanguard(i.institution_id))
    .flatMap((i) => i.accounts.filter((a) => isInvestmentType(a.type) && typeof a.balance === 'number').map((a) => a.balance as number));
}
