// lib/fx/known-accounts.ts
//
// Which accounts are in another currency than the one most accounts are in,
// by every id each has had: what splitting net worth's history by currency
// reads (lib/history.ts getHistoryWithSplit). Pure.
//
// FROM WHAT IS KNOWN, never guessed: the accounts listed now (hidden ones too,
// and those recovered or held at their last known balance), the accounts that
// ended (their lifecycle entry keeps the currency where it was known), and the
// account directory (which keeps it from this release on, for accounts since
// disconnected). An id an account had before a re-link takes its current
// account's currency, through the links, as hiding follows them. An account
// whose currency nothing records is counted in the main currency, as every
// chart has counted it until now, and the chart's note says so when one has a
// balance on a day it converts.

import { resolveId, type Link } from '../link-core';
import type { ForeignAccounts } from '../history';

export type KnownAccount = { account_id: string; currency: string | null; type: string | null };

/** Every id (current and earlier) to its currency and kind, the first source
 *  that knows one winning: listed now, then ended, then the directory. */
export function currenciesById(sources: Iterable<KnownAccount>[], links: ReadonlyMap<string, Pick<Link, 'to'>> | null): Map<string, { currency: string | null; type: string | null }> {
  const byId = new Map<string, { currency: string | null; type: string | null }>();
  for (const source of sources) {
    for (const a of source) {
      const seen = byId.get(a.account_id);
      if (!seen) byId.set(a.account_id, { currency: a.currency, type: a.type });
      else if (seen.currency === null && a.currency !== null) byId.set(a.account_id, { currency: a.currency, type: seen.type ?? a.type });
      else if (seen.type === null && a.type !== null) byId.set(a.account_id, { ...seen, type: a.type });
    }
  }
  if (links) {
    for (const old of links.keys()) {
      if (byId.get(old)?.currency) continue;
      const now = byId.get(resolveId(old, links));
      if (now) byId.set(old, now);
    }
  }
  return byId;
}

/** The accounts a point's split reads: every id whose currency is known and
 *  isn't `main`. */
export function foreignAccounts(byId: ReadonlyMap<string, { currency: string | null; type: string | null }>, main: string | null): ForeignAccounts {
  const out = new Map<string, { currency: string; type: string | null }>();
  for (const [id, { currency, type }] of byId) if (currency !== null && currency !== main) out.set(id, { currency, type });
  return out;
}
