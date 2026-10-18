'use client';

// What Home says of net worth in the home currency (lib/fx/net-worth-base.ts
// NetWorthBase, from /api/net-worth): under the hero, that it is converted,
// into what, at whose rates and from what day, each currency's part and what
// it came to, what was left out and why (with the way to set a rate), and
// rates older than they should be; under the chart, the days it couldn't
// convert. And, for someone whose accounts and transactions are in more than
// one currency who hasn't chosen one, the offer to show their totals in one
// (decision 1: only the person's tap ever chooses).

import { Masked } from './HideAmounts';
import { chartGapLines, convertedHeading, convertedText, leftOutLines, staleText, unknownText } from './currency-text';
import type { NetWorthBase } from '@/lib/fx/net-worth-base';

export function HeroCurrencyNote({ base, main, onOpen }: { base: NetWorthBase; main: string | null; onOpen: () => void }) {
  const converted = convertedText(base, base.fx.own);
  const left = leftOutLines(base);
  const own = base.parts.some((p) => p.rate?.source === 'own');
  return (
    <>
      {converted && (
        <div className="as-of currency-note">
          {convertedHeading(base.currency, base.rates.day, own)}: <Masked>{converted}</Masked>.
        </div>
      )}
      {left.map((line) => (
        <div className="as-of stale" key={line}>
          {line}{' '}
          <button className="link-btn" onClick={onOpen}>
            Set a rate of your own
          </button>
        </div>
      ))}
      {base.rates.stale && <div className="as-of stale">{staleText(base.rates.day)}</div>}
      {base.unknown > 0 && <div className="as-of">{unknownText(base.unknown, main)}</div>}
    </>
  );
}

/** Under the chart: the days it couldn't convert, and what it left out. */
export function ChartCurrencyNote({ base, main }: { base: NetWorthBase; main: string | null }) {
  const lines = chartGapLines(base.gaps, base.currency, main);
  if (lines.length === 0) return null;
  return (
    <div className="chart-note currency-chart-note">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

const DISMISSED = 'nya:currency-offer:dismissed';

/** Whether the offer was put away on this device. Best effort: a storage
 *  that can't be read reads as not. */
export function offerDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
}

export function dismissOffer(): void {
  try {
    localStorage.setItem(DISMISSED, '1');
  } catch {
    // Best effort: it shows again on the next load.
  }
}

/** What the offer suggests: the currency the budgets are read in today (so
 *  what was typed keeps its meaning), the accounts' main one beside it when
 *  the two differ, and whether the accounts themselves mix currencies (net
 *  worth adds them unconverted) or only the transactions do. */
export type Offer = { budgets: string | null; accounts: string | null; mixedAccounts: boolean };

/** The offer, or null when everything is in one currency: nothing is
 *  offered. */
export function offerFor(input: { accounts: readonly (string | null)[]; transactions: readonly (string | null)[]; budgets: string | null; main: string | null }): Offer | null {
  const seen = new Set([...input.accounts, ...input.transactions].filter((c): c is string => !!c));
  if (seen.size < 2) return null;
  const budgets = input.budgets;
  const accounts = input.main && input.main !== budgets ? input.main : null;
  return { budgets, accounts, mixedAccounts: new Set(input.accounts.filter(Boolean)).size > 1 };
}

export function CurrencyOffer({ offer, onChoose, onDismiss }: { offer: Offer; onChoose: (code: string | null) => void; onDismiss: () => void }) {
  return (
    <div className="card currency-offer">
      <div className="inst-header">
        <div className="inst-name">Show your totals in one currency</div>
      </div>
      <p className="panel-note">
        {offer.mixedAccounts
          ? 'Your accounts are in more than one currency, and your net worth adds them up unconverted.'
          : 'Your transactions are in more than one currency.'}{' '}
        Choose one, and Nya shows your net worth in it, converted at the European Central Bank’s daily rates. Nothing changes until you do.
      </p>
      <div className="currency-offer-choices">
        {offer.budgets && (
          <button onClick={() => onChoose(offer.budgets)}>
            Use {offer.budgets}
            <span className="currency-offer-why">your budgets are in it</span>
          </button>
        )}
        {offer.accounts && (
          <button className={offer.budgets ? 'secondary' : undefined} onClick={() => onChoose(offer.accounts)}>
            Use {offer.accounts}
            <span className="currency-offer-why">most of your accounts are in it</span>
          </button>
        )}
      </div>
      <div className="currency-offer-more">
        <button className="link-btn" onClick={() => onChoose(null)}>
          Choose another
        </button>
        <button className="link-btn" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
