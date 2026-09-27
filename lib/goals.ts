// lib/goals.ts
//
// Savings goals (Mint-style): a target amount, optionally tracked against a
// linked account's live balance. Stored as one encrypted JSON blob in Redis,
// same reasoning as budgets (rare, single-user writes). An unreadable blob is
// reported, never treated as "no goals" (see lib/stored-json.ts).

import { kc } from './storage';
import type { Ctx } from './containers';
import { readEncryptedJson, writeEncryptedJson } from './stored-json';

const GOALS_KEY = (ctx: Ctx) => kc(ctx, 'goals');

export type Goal = {
  id: string;
  name: string;
  target: number;
  account_id: string | null; // progress source; null = untracked
};

const isGoals = (v: unknown): v is Goal[] => Array.isArray(v);

/** Throws StoredDataUnreadableError if goals were saved but cannot be read. */
export async function getGoals(ctx: Ctx): Promise<Goal[]> {
  return (await readEncryptedJson(GOALS_KEY(ctx), 'goals', isGoals)) ?? [];
}

/** Refuses (StoredDataUnreadableError) to replace goals it cannot read. */
export async function setGoals(ctx: Ctx, goals: Goal[]): Promise<void> {
  await writeEncryptedJson(GOALS_KEY(ctx), 'goals', goals, isGoals);
}
