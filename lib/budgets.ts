// lib/budgets.ts
//
// Per-category monthly budgets ({ category: dollar amount }), stored as one
// encrypted JSON blob in Redis. Budgets change rarely and only from one
// user's taps, so a single read-modify-write blob is fine here (unlike the
// Plaid items hash, which two concurrent link flows can race on). An
// unreadable blob is reported, never treated as "no budgets" (see
// lib/stored-json.ts).

import { k } from './storage';
import { readEncryptedJson, writeEncryptedJson } from './stored-json';

const BUDGETS_KEY = k('budgets');

export type Budgets = Record<string, number>;

const isBudgets = (v: unknown): v is Budgets => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws StoredDataUnreadableError if budgets were saved but cannot be read. */
export async function getBudgets(): Promise<Budgets> {
  return (await readEncryptedJson(BUDGETS_KEY, 'budgets', isBudgets)) ?? {};
}

/** Refuses (StoredDataUnreadableError) to replace budgets it cannot read. */
export async function setBudgets(budgets: Budgets): Promise<void> {
  await writeEncryptedJson(BUDGETS_KEY, 'budgets', budgets, isBudgets);
}
