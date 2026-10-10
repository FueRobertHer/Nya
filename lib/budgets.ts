// lib/budgets.ts
//
// Per-category monthly budgets ({ category: dollar amount }), stored as one
// encrypted JSON blob in Redis. Budgets change rarely and only from one
// user's taps, so a single read-modify-write blob is fine here (unlike the
// Plaid items hash, which two concurrent link flows can race on). An
// unreadable blob is reported, never treated as "no budgets" (see
// lib/stored-json.ts).

import { kc } from './storage';
import type { Ctx } from './containers';
import { readEncryptedJson, writeEncryptedJson, readStoredValue } from './stored-json';
import { openStoredJson } from './repo';

const BUDGETS_KEY = (ctx: Ctx) => kc(ctx, 'budgets');

export type Budgets = Record<string, number>;

const isBudgets = (v: unknown): v is Budgets => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws StoredDataUnreadableError if budgets were saved but cannot be read. */
export async function getBudgets(ctx: Ctx): Promise<Budgets> {
  return (await readEncryptedJson(BUDGETS_KEY(ctx), 'budgets', isBudgets)) ?? {};
}

/**
 * The budgets, for a reader that names what it can't use instead of stopping
 * (the download of my data, lib/user-export.ts): null, with why (`problem`),
 * when they were saved but can't be used, by the storage seam's rules
 * (lib/repo.ts openStoredJson): `unreadable`, damaged; `unrecognised`,
 * intact, in a form this code does not know. Never saved is no budgets.
 * What says nothing about the value throws as it is: storage out of reach, a
 * key this deployment can't load, a failed decrypt under k0.
 */
export async function getBudgetsReport(ctx: Ctx): Promise<{ budgets: Budgets | null; problem: 'unreadable' | 'unrecognised' | null }> {
  const stored = await readStoredValue(BUDGETS_KEY(ctx));
  if (stored === null) return { budgets: {}, problem: null };
  const opened = await openStoredJson(stored, isBudgets);
  return opened.ok ? { budgets: opened.value, problem: null } : { budgets: null, problem: opened.flaw };
}

/** Refuses (StoredDataUnreadableError) to replace budgets it cannot read. */
export async function setBudgets(ctx: Ctx, budgets: Budgets): Promise<void> {
  await writeEncryptedJson(BUDGETS_KEY(ctx), 'budgets', budgets, isBudgets);
}
