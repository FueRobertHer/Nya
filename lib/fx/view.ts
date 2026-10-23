// lib/fx/view.ts
//
// What the page converts with itself, from what /api/net-worth sends beside
// `base` (lib/fx/net-worth-base.ts NetWorthBase.fx): the ECB's newest
// publication, only its rates for the person's currencies, and their own
// rates. For the page's own figures, always at the newest rates, as the hero
// is: an institution's total on the Accounts tab, and connection health's
// share of net worth. By the same rule (lib/fx/net-worth.ts balancesIn), so
// they read as the hero does: each currency's subtotal converted once. Pure,
// and safe in the browser.

import { balancesIn, type BalanceRow, type BalancesIn } from './net-worth';
import type { EcbLatest, FxTable, OwnRate } from './rates';

/** What the page converts with (NetWorthBase.fx). */
export type PageFx = { home: string; latest: EcbLatest | null; own: OwnRate[] };

/** A reader's table from it: the newest publication alone, so every day
 *  converts at it. */
export function tableOf(fx: PageFx): FxTable {
  return { home: fx.home, own: fx.own, latest: fx.latest, days: {}, series: {}, missing_years: [], fetch: null };
}

/** Balances in the home currency now: each currency's subtotal converted
 *  once at the newest rates. `main` is the currency an account with none is
 *  counted in. */
export function balancesNow(rows: readonly BalanceRow[], fx: PageFx, main: string | null, now: number = Date.now()): BalancesIn {
  const today = new Date(now).toISOString().slice(0, 10);
  // Never a day before the newest publication: this device's clock may be
  // behind the server's.
  const day = fx.latest && fx.latest.date > today ? fx.latest.date : today;
  return balancesIn(rows, tableOf(fx), fx.home, day, main);
}

/** Whether a total of these rows needs converting into the home currency:
 *  one of them is in another currency. */
export function needsConverting(rows: readonly BalanceRow[], fx: PageFx | null, main: string | null): fx is PageFx {
  return !!fx && rows.some((r) => (r.currency ?? main) !== null && (r.currency ?? main) !== fx.home);
}
