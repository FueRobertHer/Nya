// components/AccountsSummary.tsx
//
// One line under the Accounts tab's bar: what is held and owed by kind
// (components/account-groups.ts), with what it can't count said under it.
// A total that is short says so in red, naming the institutions, as the
// cards do; figures that are only last known say so in amber.

import { joinNames } from '@/lib/month-coverage';
import type { PageFx } from '@/lib/fx/view';
import type { Institution } from './accounts-format';
import { fmt } from './accounts-format';
import { summarize } from './account-groups';
import { ALERT } from './ConnectionStatus';
import { Masked } from './HideAmounts';

export default function AccountsSummary({
  institutions,
  fx,
  main,
}: {
  /** The institutions on the tab, without hidden accounts. */
  institutions: readonly Institution[];
  fx: PageFx | null;
  main: string | null;
}) {
  const s = summarize(institutions, fx, main);
  // One kind would only repeat the cards' subtotals.
  if (s.groups.length < 2) return null;
  return (
    <div className="accounts-summary stack tight">
      <ul className="accounts-summary-line" aria-label="Totals by kind">
        {s.groups.map((g) => (
          <li key={g.key}>
            {g.label}{' '}
            <span className="money">{g.total == null ? 'Mixed' : <Masked>{fmt(g.total, g.currency)}</Masked>}</span>
            {g.incomplete && <span className="badge neg">Incomplete</span>}
          </li>
        ))}
      </ul>
      {s.currencyNote && <p className="helper">{s.currencyNote}</p>}
      {s.short && (
        <div className="notice critical">
          {ALERT}
          <p>
            {`These totals leave out accounts at ${joinNames(s.short.institutions)}${s.short.untyped ? ', and any of them may be short' : ''}; ${
              s.short.institutions.length === 1 ? 'its card says' : 'their cards say'
            } which.`}
          </p>
        </div>
      )}
      {s.dated.length > 0 && (
        <div className="notice caution">
          {ALERT}
          <p>{`Some figures at ${joinNames(s.dated)} aren’t current or complete yet; ${s.dated.length === 1 ? 'its card says' : 'their cards say'} what.`}</p>
        </div>
      )}
    </div>
  );
}
