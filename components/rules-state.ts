'use client';

// Your rules on the dashboard (lib/rules.ts): the list, loaded once and
// replaced by the answer to every change (app/api/rules), and the one rule
// being made or edited in the rule drawer (components/RuleSheet.tsx), opened
// from the Rules screen under Manage, from "Create a rule from this" on a
// transaction, or from the offer to file every transaction with a name the way
// one was just filed. Rules apply on the server, on every read: after a change
// the dashboard reads the transactions again (`onChanged`).
//
// A DRAFT is a rule as its form holds it, every value as typed, so a field
// half filled in is never lost or rewritten under the person's fingers; it
// becomes a rule's input only when it is previewed or saved (draftInput).

import { useCallback, useEffect, useRef, useState } from 'react';
import { isRuleSet, type Rule, type RuleCondition, type RuleField, type RuleSet } from '@/lib/rules';

export type DraftCondition = {
  field: RuleField;
  /** contains, equals or starts_with for a name; gt, lt or between for an
   *  amount; equals for the rest. */
  op: string;
  /** As typed or chosen: a name, an amount, an account's or category's id, a
   *  source. */
  value: string;
  /** An amount's upper bound, for between. */
  value2: string;
  /** '' for either, 'out' or 'in'. */
  direction: string;
};

export type RuleDraft = {
  /** The rule being edited; absent for a new one. */
  id?: string;
  conditions: DraftCondition[];
  /** '' for no change. */
  set_category: string;
  set_name: string;
  add_tags: string[];
  hide: boolean;
  enabled: boolean;
};

/** A condition as a new row of the form starts. */
export const blankCondition = (field: RuleField = 'name'): DraftCondition => ({
  field,
  op: field === 'name' ? 'contains' : field === 'amount' ? 'gt' : 'equals',
  value: '',
  value2: '',
  direction: field === 'amount' ? 'out' : '',
});

/** A new rule's form, with what it was made from. */
export function newDraft(over: Partial<RuleDraft> = {}): RuleDraft {
  return { conditions: [blankCondition()], set_category: '', set_name: '', add_tags: [], hide: false, enabled: true, ...over };
}

/** A saved rule's form. */
export function draftFromRule(r: Rule): RuleDraft {
  return {
    id: r.id,
    conditions: r.conditions.map((c) => ({
      field: c.field,
      op: c.op,
      value: String(c.value),
      value2: c.field === 'amount' && c.value2 !== undefined ? String(c.value2) : '',
      direction: c.field === 'amount' ? (c.direction ?? '') : '',
    })),
    set_category: r.actions.set_category ?? '',
    set_name: r.actions.set_name ?? '',
    add_tags: r.actions.add_tags ?? [],
    hide: r.actions.hide === true,
    enabled: r.enabled,
  };
}

/** An amount as typed, as a number, or NaN (the server says what is wrong). */
const amountOf = (s: string) => (s.trim() === '' ? NaN : Number(s.replace(/[,\s]/g, '')));

/** The form as a rule's input (app/api/rules, app/api/rules/preview). The
 *  server checks every field; this only turns text into what it takes. */
export function draftInput(d: RuleDraft): { conditions: RuleCondition[]; actions: Record<string, unknown>; enabled: boolean } {
  const conditions = d.conditions.map((c) => {
    if (c.field === 'amount') {
      return {
        field: 'amount',
        op: c.op,
        value: amountOf(c.value),
        ...(c.op === 'between' ? { value2: amountOf(c.value2) } : {}),
        ...(c.direction ? { direction: c.direction } : {}),
      };
    }
    return { field: c.field, op: c.op, value: c.value };
  }) as RuleCondition[];
  const actions: Record<string, unknown> = {};
  if (d.set_category) actions.set_category = d.set_category;
  if (d.set_name.trim()) actions.set_name = d.set_name;
  if (d.add_tags.length) actions.add_tags = d.add_tags;
  if (d.hide) actions.hide = true;
  return { conditions, actions, enabled: d.enabled };
}

/** Whether the form says enough to preview: every condition with a value,
 *  and something to do. */
export function draftComplete(d: RuleDraft): boolean {
  const input = draftInput(d);
  return (
    d.conditions.length > 0 &&
    d.conditions.every((c) => c.value.trim() !== '' && (c.field !== 'amount' || (Number.isFinite(amountOf(c.value)) && (c.op !== 'between' || Number.isFinite(amountOf(c.value2)))))) &&
    Object.keys(input.actions).length > 0
  );
}

export type RulesState = {
  set: RuleSet | null;
  /** Why a rule can't work (a category it names was deleted), by id. */
  problems: Record<string, string>;
  /** Why the rules couldn't be loaded, while they can't. */
  error: string | null;
  load: () => Promise<void>;
  /** Takes the rules an answer carried (a change made). */
  accept: (data: unknown) => void;
  /** The form open in the rule drawer, or null. */
  draft: RuleDraft | null;
  open: (draft: RuleDraft) => void;
  close: () => void;
};

export function useRules(): RulesState {
  const [set, setSet] = useState<RuleSet | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  // Counts every answer taken, so a load that started before one isn't kept over it.
  const taken = useRef(0);

  const accept = useCallback((data: unknown) => {
    const d = data as { rules?: unknown; problems?: unknown } | null;
    if (!d || !isRuleSet(d.rules)) return;
    taken.current++;
    setSet(d.rules);
    setProblems(d.problems && typeof d.problems === 'object' ? (d.problems as Record<string, string>) : {});
    setError(null);
  }, []);

  const load = useCallback(async () => {
    const at = taken.current;
    try {
      const res = await fetch('/api/rules');
      const data = await res.json().catch(() => null);
      if (taken.current !== at) return;
      if (res.ok) accept(data);
      else setError(typeof data?.error === 'string' ? data.error : 'Your rules couldn’t be loaded.');
    } catch {
      if (taken.current === at) setError('Your rules couldn’t be loaded.');
    }
  }, [accept]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback((d: RuleDraft) => setDraft(d), []);
  const close = useCallback(() => setDraft(null), []);
  return { set, problems, error, load, accept, draft, open, close };
}
