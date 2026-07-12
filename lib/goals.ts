// lib/goals.ts
//
// Savings goals (Mint-style): a target amount, optionally tracked against a
// linked account's live balance. Stored as one encrypted JSON blob in Redis,
// same reasoning as budgets (rare, single-user writes).

import { redis } from './storage';
import { encrypt, decrypt } from './crypto';

const GOALS_KEY = 'goals';

export type Goal = {
  id: string;
  name: string;
  target: number;
  account_id: string | null; // progress source; null = untracked
};

export async function getGoals(): Promise<Goal[]> {
  try {
    const blob = await redis().get<string>(GOALS_KEY);
    if (!blob) return [];
    return JSON.parse(await decrypt(blob)) as Goal[];
  } catch {
    return [];
  }
}

export async function setGoals(goals: Goal[]): Promise<void> {
  await redis().set(GOALS_KEY, await encrypt(JSON.stringify(goals)));
}
