// lib/goals.ts
//
// Savings goals (Mint-style): a target amount, optionally tracked against a
// linked account's live balance. Stored as one encrypted JSON blob in Redis,
// same reasoning as budgets (rare, single-user writes). An unreadable blob is
// reported, never treated as "no goals" (see lib/stored-json.ts).

import { kc } from './storage';
import type { Ctx } from './containers';
import { readEncryptedJson, writeEncryptedJson, readStoredValue } from './stored-json';
import { openStoredJson } from './repo';

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

/**
 * The goals, for a reader that names what it can't use instead of stopping
 * (the download of my data, lib/user-export.ts): null, with why (`problem`),
 * when they were saved but can't be used, by the storage seam's rules
 * (lib/repo.ts openStoredJson). Never saved is no goals. What says nothing
 * about the value throws as it is, as getBudgetsReport's does.
 */
export async function getGoalsReport(ctx: Ctx): Promise<{ goals: Goal[] | null; problem: 'unreadable' | 'unrecognised' | null }> {
  const stored = await readStoredValue(GOALS_KEY(ctx));
  if (stored === null) return { goals: [], problem: null };
  const opened = await openStoredJson(stored, isGoals);
  return opened.ok ? { goals: opened.value, problem: null } : { goals: null, problem: opened.flaw };
}

/** Refuses (StoredDataUnreadableError) to replace goals it cannot read. */
export async function setGoals(ctx: Ctx, goals: Goal[]): Promise<void> {
  await writeEncryptedJson(GOALS_KEY(ctx), 'goals', goals, isGoals);
}
