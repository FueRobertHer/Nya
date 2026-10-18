'use client';

// The person's currency settings as the page reads them (GET /api/currency,
// lib/fx/settings.ts): the home currency, their own rates, and the ECB's
// newest publication beside them, for the Currency card and the sheet that
// chooses a home currency. Read when one of them opens: nothing on Home
// waits for it (the hero's figures come with /api/net-worth's `base`).

import { useCallback, useEffect, useState } from 'react';
import type { OwnRate } from '@/lib/fx/rates';

export type CurrencySettingsView = {
  home: string | null;
  own: OwnRate[];
  /** 'unreadable' (damaged: removable), 'unrecognised' (a newer release's:
   *  kept), or null. */
  problem: 'unreadable' | 'unrecognised' | null;
  removable: boolean;
  ecb: { date: string | null; rates: Record<string, string>; stale: boolean; fetch_ok: boolean | null };
};

export type CurrencyLoad = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; view: CurrencySettingsView };

/** What a failed answer says, or `fallback`. */
export async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return typeof data?.error === 'string' ? data.error : fallback;
}

/** The settings, read while `active`, again on reload(). */
export function useCurrencySettings(active: boolean): { load: CurrencyLoad; reload: () => void; accept: (v: Partial<CurrencySettingsView>) => void } {
  const [load, setLoad] = useState<CurrencyLoad>({ kind: 'loading' });
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!active) return;
    let gone = false;
    fetch('/api/currency')
      .then(async (res) => {
        if (gone) return;
        if (!res.ok) {
          setLoad({ kind: 'error', message: await errorOf(res, 'Your currency settings couldn’t be loaded. Try again.') });
          return;
        }
        const data = await res.json();
        if (!gone) setLoad({ kind: 'ready', view: data as CurrencySettingsView });
      })
      .catch(() => {
        if (!gone) setLoad({ kind: 'error', message: 'Nya could not be reached. Check your connection and try again.' });
      });
    return () => {
      gone = true;
    };
  }, [active, reads]);
  const reload = useCallback(() => setReads((n) => n + 1), []);
  // A write's answer, taken at once, before the read again lands.
  const accept = useCallback((v: Partial<CurrencySettingsView>) => setLoad((l) => (l.kind === 'ready' ? { kind: 'ready', view: { ...l.view, ...v } } : l)), []);
  return { load, reload, accept };
}

/** The currencies Intl knows (ISO 4217), or none on a runtime without the
 *  list. */
export function everyCurrency(): string[] {
  const list = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    return typeof list === 'function' ? list('currency') : [];
  } catch {
    return [];
  }
}

/** A currency's name in this locale ("Euro"), or the code itself. */
export function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** What one unit of `from` is worth in `to` from the ECB's newest rates
 *  (units per euro), for showing beside a rate of the person's own; null
 *  when the ECB publishes either not. */
export function ecbCross(rates: Record<string, string>, from: string, to: string): number | null {
  const per = (c: string) => (c === 'EUR' ? 1 : Object.hasOwn(rates, c) ? Number(rates[c]) : NaN);
  const value = per(to) / per(from);
  return Number.isFinite(value) && value > 0 ? value : null;
}
