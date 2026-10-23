// components/plan-currency-client.ts
//
// Recording the currency the Plan's typed figures are in, alone, for the plan
// as stored (POST /api/fire-plan, lib/fire/plan-currency.ts): when the person
// says which it is, or the Plan tab can tell it reliably. It never sends a
// plan: the Plan itself is saved only through the tab's store
// (components/plan-savers.ts), which records the currency with each save.

import { isFirePlan, type FirePlan } from '@/lib/fire/plan';
import { readCurrencyAnswer, type CurrencyAnswer, type TypedAmounts } from '@/lib/fire/plan-currency';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type Recorded = { ok: true; answer: CurrencyAnswer; plan: FirePlan | null } | { ok: false; error: string; stale: boolean };

/** Records `currency` for the plan whose typed amounts are `amounts` (the one
 *  the server last confirmed: a plan changed since on another device is
 *  refused, stale). `answered` when it is the person's own answer, which
 *  alone may replace a record there; without it only a plan with no record
 *  at all is recorded. */
export async function recordPlanCurrency(currency: string, amounts: TypedAmounts, answered: boolean, doFetch: Fetcher = (i, init) => fetch(i, init)): Promise<Recorded> {
  try {
    const res = await doFetch('/api/fire-plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currency, amounts, ...(answered ? { answered: true } : {}) }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { ok: true, answer: readCurrencyAnswer(body), plan: isFirePlan(body?.plan) ? body.plan : null };
    return { ok: false, error: typeof body?.error === 'string' ? body.error : 'It wasn’t recorded. Try again in a moment.', stale: body?.stale === true };
  } catch {
    return { ok: false, error: 'It wasn’t recorded: check your connection, and try again.', stale: false };
  }
}
