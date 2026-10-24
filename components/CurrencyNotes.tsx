'use client';

// What Home says of net worth in the home currency (lib/fx/net-worth-base.ts
// NetWorthBase, from /api/net-worth): under the hero, that it is converted,
// into what, at whose rates and from what day, each currency's part and what
// it came to, what was left out and why (with the way to set a rate), and
// rates older than they should be; under the chart, the days it couldn't
// convert. And, for someone whose accounts' balances are in more than one
// currency who hasn't chosen one, the offer to show their totals in one
// (decision 1: only the person's tap ever chooses). Transactions don't bring
// the offer in this step: nothing they total converts yet, so choosing would
// change nothing on screen.

import { Masked } from './HideAmounts';
import { Sheet } from './Sheet';
import { chartGapLines, convertedHeading, convertedText, leftOutLines, staleText, unknownText } from './currency-text';
import { unusableText } from '@/lib/fx/words';
import type { NetWorthBase } from '@/lib/fx/net-worth-base';
import type { Caveat } from './TotalCaveats';

/** What the hero total says of its conversion, as caveats on it
 *  (components/TotalCaveats.tsx): that it is converted, neutral; an account
 *  left out for want of a rate, red, as the total is short; old or unusable
 *  rates, amber; accounts saying no currency, neutral. `onOpen`: the Currency
 *  card, at the form for a rate for that currency. */
export function heroCurrencyCaveats(base: NetWorthBase, main: string | null, onOpen: (rateFor: string | null) => void): Caveat[] {
  const converted = convertedText(base, base.fx.own);
  const own = base.parts.some((p) => p.rate?.source === 'own');
  const unusable = unusableText(base.rates.unusable ?? []);
  const out: Caveat[] = [];
  if (converted)
    out.push({
      key: 'converted',
      severity: 'info',
      summary: `converted into ${base.currency}`,
      body: (
        <>
          {convertedHeading(base.currency, base.rates.day, own)}: <Masked>{converted}</Masked>.
        </>
      ),
    });
  for (const line of leftOutLines(base))
    out.push({
      key: `left-out:${line.text}`,
      severity: 'critical',
      summary: 'a currency left out',
      body: (
        <>
          {line.text}
          {line.rateFor && (
            <>
              {' '}
              <button className="btn ghost" onClick={() => onOpen(line.rateFor)}>
                Set a rate for {line.rateFor}
              </button>
            </>
          )}
        </>
      ),
    });
  if (base.rates.stale) out.push({ key: 'stale-rates', severity: 'caution', summary: 'old exchange rates', body: staleText(base.rates.day) });
  if (unusable) out.push({ key: 'unusable-rates', severity: 'caution', summary: 'some rates couldn’t be read', body: unusable });
  if (base.unknown > 0) out.push({ key: 'unknown-currency', severity: 'info', summary: base.unknown === 1 ? 'an account with no currency' : 'accounts with no currency', body: unknownText(base.unknown, main) });
  return out;
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

/** What the offer suggests: the currency the budgets are read in today (the
 *  last 365 days of rows, lib/budget-month.ts, so what was typed keeps its
 *  meaning), and the accounts' main one beside it when the two differ; and
 *  why it is offered: the accounts are in more than one currency, or only
 *  the last year's transactions are (decision A, step 2: they convert now). */
export type Offer = { budgets: string | null; accounts: string | null; why?: 'accounts' | 'transactions' };

const several = (codes: readonly (string | null)[]) => new Set(codes.filter((c): c is string => !!c)).size >= 2;

/** The offer, or null when the accounts' balances are all in one currency
 *  and so are the last year's transactions: nothing is offered. `accounts`:
 *  the currency of each account with a balance, hidden ones too;
 *  `transactions`: each of the last year's transactions'. */
export function offerFor(input: { accounts: readonly (string | null)[]; budgets: string | null; main: string | null; transactions?: readonly (string | null)[] }): Offer | null {
  const accounts = several(input.accounts);
  if (!accounts && !several(input.transactions ?? [])) return null;
  return { budgets: input.budgets, accounts: input.main && input.main !== input.budgets ? input.main : null, ...(accounts ? {} : { why: 'transactions' as const }) };
}

/** The offer, as it was said on its own Home card: since rollout phase 4b,
 *  a row in Needs attention opens it in a sheet. */
export function CurrencyOfferSheet({ open, offer, onClose, onChoose, onDismiss }: { open: boolean; offer: Offer | null; onClose: () => void; onChoose: (code: string | null) => void; onDismiss: () => void }) {
  return (
    <Sheet open={open} title="Show your totals in one currency" onClose={onClose}>
      {offer && <CurrencyOfferBody offer={offer} onChoose={onChoose} onDismiss={onDismiss} />}
    </Sheet>
  );
}

export function CurrencyOfferBody({ offer, onChoose, onDismiss }: { offer: Offer; onChoose: (code: string | null) => void; onDismiss: () => void }) {
  return (
    <div className="currency-offer">
      <p className="panel-note">
        {offer.why === 'transactions'
          ? 'Your transactions over the last year are in more than one currency, and your spending totals leave out those in the others. Choose one, and Nya counts them all in it, converted at the European Central Bank’s daily rates.'
          : 'Your accounts are in more than one currency, and your net worth adds them up unconverted. Choose one, and Nya shows your net worth and spending in it, converted at the European Central Bank’s daily rates.'}{' '}
        Nothing changes until you do.
      </p>
      <div className="currency-offer-choices">
        {offer.budgets && (
          <button className="btn" onClick={() => onChoose(offer.budgets)}>
            Use {offer.budgets}
            <span className="currency-offer-why">your budgets are in it</span>
          </button>
        )}
        {offer.accounts && (
          <button className={offer.budgets ? 'btn secondary' : 'btn'} onClick={() => onChoose(offer.accounts)}>
            Use {offer.accounts}
            <span className="currency-offer-why">most of your accounts are in it</span>
          </button>
        )}
      </div>
      <div className="currency-offer-more">
        <button className="btn ghost" onClick={() => onChoose(null)}>
          Choose another
        </button>
        <button className="btn ghost" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
