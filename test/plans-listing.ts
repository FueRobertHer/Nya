// test/plans-listing.ts
//
// GET /api/plans as app/api/plans answers it (lib/plan-copies.ts readPlans),
// for view tests that answer each request by path: your plan first, then its
// copies in the order they were made, every plan whole with the facts every
// plan shares. A copy is your plan with what it changes.

import { planOf, type FirePlanV2, type StoredPlan } from '@/lib/fire/plan-v2';
import { DEFAULT_PLAN } from '@/lib/fire/plan';

export type Row = { id: string; name: string; plan: StoredPlan | null; currency: string | null; created_at: string | null; updated_at: string | null };

/** A copy of `main`, made on the given day: `over` is what it changes. */
export function copyRow(main: StoredPlan | null, id: string, name: string, over: Partial<FirePlanV2> = {}, currency: string | null = 'USD', day = 1): Row {
  const at = `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  return { id, name, plan: { ...planOf(main ?? DEFAULT_PLAN), ...over }, currency, created_at: at, updated_at: at };
}

/** The answer: your plan ("First plan", saved on the first) and its copies. */
export function plansListing(main: StoredPlan | null, copies: Row[] = [], currency: string | null = 'USD'): [number, unknown] {
  const at = '2026-09-01T00:00:00.000Z';
  const mine: Row = { id: 'main', name: 'First plan', plan: main, currency, created_at: main ? at : null, updated_at: main ? at : null };
  return [200, { main: 'main', missing: false, plans: [mine, ...copies], unreadable_ids: [], unrecognised_ids: [] }];
}
