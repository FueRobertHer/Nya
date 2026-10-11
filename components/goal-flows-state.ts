'use client';

// The months behind each goal's pace, for the Goals card (#42): what went
// into each account over its last complete months, read once the card has
// its goals, from GET /api/goals/progress (lib/goal-flows.ts). A display
// read: nothing is saved on it, and while it loads, or if it fails, the card
// projects at the monthly targets alone and says why.

import { useEffect, useRef, useState } from 'react';
import { localMonth } from '@/lib/local-date';
import type { AccountFlow } from '@/lib/goal-projection';

export type GoalFlowsState = {
  status: 'loading' | 'ready' | 'error';
  /** By account id; null until loaded. */
  flows: Map<string, AccountFlow> | null;
  /** What the server couldn't read, in words. */
  notes: string[];
};

const isMonth = (m: unknown): boolean => {
  const v = m as { month?: unknown; amount?: unknown; gaps?: unknown } | null;
  return !!v && typeof v.month === 'string' && (v.amount === null || typeof v.amount === 'number') && (v.gaps === undefined || Array.isArray(v.gaps));
};

/** The answer's flows, each checked, or null when it isn't one: a bad answer
 *  reads as not loaded, never as months with nothing in them. */
export function readFlowsAnswer(body: unknown): { flows: Map<string, AccountFlow>; notes: string[] } | null {
  const b = body as { flows?: unknown; notes?: unknown } | null;
  if (!b || typeof b.flows !== 'object' || b.flows === null || Array.isArray(b.flows)) return null;
  const flows = new Map<string, AccountFlow>();
  for (const [id, f] of Object.entries(b.flows as Record<string, unknown>)) {
    const flow = f as { source?: unknown; months?: unknown } | null;
    if (!flow || (flow.source !== 'transactions' && flow.source !== 'balances') || !Array.isArray(flow.months) || !flow.months.every(isMonth)) return null;
    flows.set(id, flow as AccountFlow);
  }
  const notes = Array.isArray(b.notes) ? b.notes.filter((n): n is string => typeof n === 'string') : [];
  return { flows, notes };
}

/** Read once, the first time `enabled` (the goals have loaded): the months
 *  don't change with the goals, so a reload of the list (after a save that
 *  failed, say) doesn't read them again. */
export function useGoalFlows(enabled: boolean): GoalFlowsState {
  const [state, setState] = useState<GoalFlowsState>({ status: 'loading', flows: null, notes: [] });
  const requested = useRef(false);
  // Set on every mount, not only the first: React's development StrictMode
  // mounts, unmounts and mounts again, and the answer to the one request
  // must still land.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled || requested.current) return;
    requested.current = true;
    (async () => {
      try {
        const res = await fetch(`/api/goals/progress?month=${localMonth()}`);
        const read = res.ok ? readFlowsAnswer(await res.json().catch(() => null)) : null;
        if (mounted.current) setState(read ? { status: 'ready', ...read } : { status: 'error', flows: null, notes: [] });
      } catch {
        if (mounted.current) setState({ status: 'error', flows: null, notes: [] });
      }
    })();
  }, [enabled]);
  return state;
}
