// lib/fire-plan.ts
//
// The Plan tab's saved assumptions (lib/fire/plan.ts), one encrypted JSON
// value per container, replaced whole on every save (lib/stored-json.ts). It
// holds what the person chose and typed: ages, rates, the mix, other income,
// one-off expenses, and any figure they typed over one Nya measures.
//
// STRICT reader: a value that was saved but cannot be read (or is not a valid
// plan) throws StoredDataUnreadableError, never "no plan", because the next
// save sends the whole plan and would replace the real one with defaults.
// Never saved reads as null, which the Plan tab shows as the defaults.

import { kc } from './storage';
import type { Ctx } from './containers';
import { readEncryptedJson, writeEncryptedJson } from './stored-json';
import { isFirePlan, type FirePlan } from './fire/plan';

const PLAN_KEY = (ctx: Ctx) => kc(ctx, 'fire-plan');

/** Null when never saved. Throws StoredDataUnreadableError if saved but unreadable. */
export async function getFirePlan(ctx: Ctx): Promise<FirePlan | null> {
  return readEncryptedJson(PLAN_KEY(ctx), 'plan assumptions', isFirePlan);
}

/** Refuses (StoredDataUnreadableError) to replace a plan it cannot read. */
export async function setFirePlan(ctx: Ctx, plan: FirePlan): Promise<void> {
  await writeEncryptedJson(PLAN_KEY(ctx), 'plan assumptions', plan, isFirePlan);
}
