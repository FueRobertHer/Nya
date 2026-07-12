// lib/budgets.ts
//
// Per-category monthly budgets ({ category: dollar amount }), stored as one
// encrypted JSON blob in Redis. Budgets change rarely and only from one
// user's taps, so a single read-modify-write blob is fine here (unlike the
// Plaid items hash, which two concurrent link flows can race on).

import { redis } from './storage';
import { encrypt, decrypt } from './crypto';

const BUDGETS_KEY = 'budgets';

export type Budgets = Record<string, number>;

export async function getBudgets(): Promise<Budgets> {
  try {
    const blob = await redis().get<string>(BUDGETS_KEY);
    if (!blob) return {};
    return JSON.parse(await decrypt(blob)) as Budgets;
  } catch {
    return {};
  }
}

export async function setBudgets(budgets: Budgets): Promise<void> {
  await redis().set(BUDGETS_KEY, await encrypt(JSON.stringify(budgets)));
}
