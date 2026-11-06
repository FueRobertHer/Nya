'use client';

// Tax after you stop (the tax plan's T4): the share of tax in a detailed plan's FI
// number, from the years run from that number, by stage, how it goes into the number,
// and the way back to one flat rate.

import { useState } from 'react';
import { taxShares, type Drawdown } from '@/lib/fire/drawdown';
import type { FiShares } from '@/lib/fire/plan-figures';
import { Masked } from './HideAmounts';
import { MoneyLines } from './PlanDrawdown';
import { fiLines, sharesNote, stageTitle } from './plan-drawdown';
import { pct } from './plan-text';
import { Notice } from './TotalCaveats';

type Money = (n: number) => string;

export function PlanTaxSheet({
  shares,
  held,
  number,
  ownNumber = false,
  converts = false,
  withdrawalRate,
  realReturn,
  start,
  startBalance,
  hypothetical,
  money,
  onYears,
  onFlatRate,
  onDone,
}: {
  shares: FiShares | null;
  /** What it rests on hasn't settled. */
  held: boolean;
  /** The FI number worked out, whatever is typed beside it. */
  number: number | null;
  /** A number of your own is typed beside it. */
  ownNumber?: boolean;
  /** The plan has a conversion rule, which can move this share against its lifetime costs. */
  converts?: boolean;
  withdrawalRate: number;
  realReturn: number;
  /** The years Will it last? runs, when they aren't from the FI number itself. */
  start: Drawdown | null;
  startBalance: number | null;
  /** The sheet's last line. */
  hypothetical: string;
  money: Money;
  /** To Year by year; null where it has no years to show. */
  onYears: (() => void) | null;
  /** Back to one flat rate, for every plan; null in a copy. */
  onFlatRate: (() => Promise<true | string>) | null;
  onDone: () => void;
}) {
  const [flatting, setFlatting] = useState(false);
  const [flatError, setFlatError] = useState<string | null>(null);
  const flat = onFlatRate;
  const firstAge = shares?.drawn.years[0]?.age ?? null;
  const hasOneOffs = shares?.drawn.years.some((y) => y.oneOffs >= 0.5) ?? false;
  const differs = shares && start && startBalance !== null && pct(start.t, 1) !== pct(shares.t, 1);
  const notes = shares ? sharesNote(shares, money) : [];
  return (
    <div className="stack loose">
      <p className="total-value">{shares ? pct(shares.t, 1) : '--'}</p>
      {held && !shares && (
        <p className="plan-working-line" role="status">
          Working it out
        </p>
      )}
      {shares && (
        <p className="helper">
          {`Tax as a share of everything your years after ${firstAge} cost: spending, ${hasOneOffs ? 'one-off costs, ' : ''}health coverage and tax. Nearer years count more, since money for later years has longer to grow.`}
        </p>
      )}
      {differs && (
        <p className="helper">
          <Masked>{`This is for a plan that starts from your ${ownNumber ? 'worked-out ' : ''}FI number. Will it last? and the years on Drawdown start from ${money(startBalance)}, so their tax comes to ${pct(start.t, 1)}.`}</Masked>
        </p>
      )}
      {shares && converts && <p className="helper">Conversions pay tax and can raise health costs early, when costs count most, so your FI number can rise even when lifetime costs fall.</p>}
      {shares && (
        <section className="stack tight" aria-labelledby="plan-tax-stages">
          <h3 className="section-label" id="plan-tax-stages">
            Tax’s share, by stage
          </h3>
          <dl className="txn-detail txn-detail-wide">
            {shares.drawn.stages.map((s) => (
              <div key={s.key} className="txn-detail-row">
                <dt>{stageTitle(s)}</dt>
                <dd>{pct(taxShares(shares.drawn.years.slice(s.first, s.last), realReturn).t, 1)}</dd>
              </div>
            ))}
          </dl>
          {onYears && (
            <div>
              <button type="button" className="btn ghost" onClick={onYears}>
                See the years on Drawdown
              </button>
            </div>
          )}
        </section>
      )}
      {shares && number !== null && (
        <section className="stack tight" aria-labelledby="plan-tax-number">
          <h3 className="section-label" id="plan-tax-number">
            {ownNumber ? 'In the worked-out number' : 'In your FI number'}
          </h3>
          <MoneyLines lines={fiLines({ spending: shares.spending, paid: shares.paid, health: shares.h, t: shares.t, tText: pct(shares.t, 1), rate: withdrawalRate, worked: number, own: ownNumber }, money)} />
        </section>
      )}
      {notes.map((n) => (
        <p key={n} className="helper">
          <Masked>{n}</Masked>
        </p>
      ))}
      {shares && <p className="helper">{hypothetical}</p>}
      {flat ? (
        <ul className="list-rows">
          <li>
            <button
              type="button"
              className="list-row"
              disabled={flatting}
              onClick={async () => {
                setFlatting(true);
                setFlatError(null);
                const r = await flat();
                setFlatting(false);
                if (r === true) onDone();
                else setFlatError(r);
              }}
            >
              <span className="list-row-text">
                <span className="list-row-title">{flatting ? 'Saving…' : 'Use a flat rate instead'}</span>
                <span className="list-row-sub">Type one rate for every year, as before</span>
              </span>
            </button>
          </li>
        </ul>
      ) : (
        <p className="helper">Working tax out from your accounts is the same in every plan: change it on your plan.</p>
      )}
      {flatError && (
        <Notice level="critical" role="alert">
          {flatError}
        </Notice>
      )}
    </div>
  );
}
