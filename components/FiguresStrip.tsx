// The four figures of an investment's range (docs/design/design-system.md
// #stat-strip): Beginning balance, Deposits & withdrawals, Investment returns
// and Ending balance, begin + dw + returns = end. Accounts > Investments
// (components/InvestmentGrowth.tsx) shows a range's; importing Vanguard's
// Performance page (components/PerformanceImport.tsx) shows the file's.

import { formatMoney, roundsToNothing, signedMoney } from '@/lib/format';
import type { Figures } from '@/lib/growth-summary';
import { Masked } from './HideAmounts';

/** Beginning balance, Deposits & withdrawals, Investment returns and Ending
 *  balance, in `currency`. */
export function Strip({ f, currency }: { f: Figures; currency: string }) {
  return (
    <ul className="stat-strip" role="list">
      <li className="stat">
        <span className="stat-label">Beginning balance</span>
        <span className="stat-value money">
          <Masked>{formatMoney(f.begin, currency)}</Masked>
        </span>
      </li>
      <li className="stat">
        <span className="stat-label">Deposits & withdrawals</span>
        <span className="stat-value money">
          <Masked>{signedMoney(f.dw, currency)}</Masked>
        </span>
      </li>
      <li className="stat">
        <span className="stat-label">Investment returns</span>
        {/* A gain in green with its sign; a loss keeps the text color with
            its minus, as on an account's sheet. */}
        <span className={`stat-value money${f.returns > 0 && !roundsToNothing(f.returns, currency) ? ' inflow' : ''}`}>
          <Masked>{signedMoney(f.returns, currency)}</Masked>
        </span>
      </li>
      <li className="stat">
        <span className="stat-label">Ending balance</span>
        <span className="stat-value money">
          <Masked>{formatMoney(f.end, currency)}</Masked>
        </span>
      </li>
    </ul>
  );
}

const STRIP_LABELS = ['Beginning balance', 'Deposits & withdrawals', 'Investment returns', 'Ending balance'];

/** The strip's place while the activity loads. */
export function StripSkeleton() {
  return (
    <ul className="stat-strip" aria-hidden="true">
      {STRIP_LABELS.map((label) => (
        <li key={label} className="stat">
          <span className="stat-label">{label}</span>
          <span className="stat-value">
            <span className="skeleton accounts-skeleton-figure" />
          </span>
        </li>
      ))}
    </ul>
  );
}
