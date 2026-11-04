// components/plan-diff.ts
//
// How a copy differs from your plan, in words: the copy's card, its row and
// its level in the Plans sheet, and compare mode (components/PlansSheet.tsx).
// Each part is one difference: the stop, a setting (the ones a scenario
// could change, lib/fire/scenarios.ts SET_FIELDS), your own FI number, each
// item by id (added, changed, left out), and for anything else that other
// settings differ. The facts (your age, how figures are measured, the
// method) are the same in every plan, so never a difference. Every amount
// goes through the `money` a caller gives (components/plan-text.ts
// wholeMoney), so hidden amounts stay hidden. No engine, no data.

import { stopOf } from '@/lib/fire/plan';
import { SET_FIELDS, type SetField } from '@/lib/fire/scenarios';
import { asEvent, asExpense, asIncome, type PlanItem } from '@/lib/fire/items';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import { SETTING_NAMES, eventText, itemText, settingText } from './plan-scenario-text';
import { lifeChoiceText, type FiWhen } from './plan-what-if';

type Money = (n: number) => string;

/** The settings said one by one: every one a scenario could change but the
 *  stop, which is said first, from stopOf. */
const SETTINGS = SET_FIELDS.filter((f): f is Exclude<SetField, 'targetAge'> => f !== 'targetAge');

/** The fields said above, or the same in every plan: anything else that
 *  differs is "Other settings differ". */
const SAID = new Set<string>([...SET_FIELDS, 'version', 'items', 'stopAtFi', 'fiNumber', 'stocksPct', 'bondsPct', 'age', 'partnerAge', 'includeCash', 'planFunding', 'method']);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function valueOf(p: FirePlanV2, field: Exclude<SetField, 'targetAge'>): unknown {
  return field === 'mix' ? { stocksPct: p.stocksPct, bondsPct: p.bondsPct } : p[field];
}

function stopText(p: FirePlanV2): string {
  if (p.stopAtFi) return 'when it reaches FI';
  const at = stopOf(p);
  return at === null ? 'not set' : `${at}`;
}

/** An item in words, when it is one the Plan's cards show; else null. */
function itemWords(x: PlanItem, money: Money): string | null {
  const income = asIncome(x);
  if (income) return itemText('income', income, money);
  const expense = asExpense(x);
  if (expense) return itemText('expenses', expense, money);
  const event = asEvent(x);
  return event ? eventText(event, money) : null;
}

/** Every way `copy` differs from `main`, a sentence each, in this order: the
 *  stop, the settings, your own FI number, the items (the copy's in its
 *  order, then those it leaves out), and other settings. */
export function copyDiffParts(main: FirePlanV2, copy: FirePlanV2, money: Money): string[] {
  const parts: string[] = [];
  if (copy.stopAtFi !== main.stopAtFi || stopOf(copy) !== stopOf(main)) parts.push(`${SETTING_NAMES.targetAge}: ${stopText(copy)} (your plan: ${stopText(main)})`);
  for (const f of SETTINGS) {
    const a = valueOf(copy, f);
    const b = valueOf(main, f);
    if (!same(a, b)) parts.push(`${SETTING_NAMES[f]}: ${settingText(f, a, money)} (your plan: ${settingText(f, b, money)})`);
  }
  if (copy.fiNumber !== main.fiNumber) {
    const fi = (v: number | null) => (v === null ? 'worked out from spending' : money(v));
    parts.push(`Your own FI number: ${fi(copy.fiNumber)} (your plan: ${fi(main.fiNumber)})`);
  }
  const mainItems = new Map(main.items.map((x) => [x.id, x]));
  const copyIds = new Set(copy.items.map((x) => x.id));
  for (const x of copy.items) {
    const was = mainItems.get(x.id);
    const words = itemWords(x, money);
    if (!was) parts.push(`Adds “${x.label}”${words ? `: ${words}` : ''}`);
    else if (!same(x, was)) {
      const before = itemWords(was, money);
      parts.push(words && before ? `“${x.label}”: ${words}, instead of ${before}` : `Changes “${x.label}”`);
    }
  }
  for (const x of main.items) {
    if (copyIds.has(x.id)) continue;
    const words = itemWords(x, money);
    parts.push(`Leaves out “${x.label}”${words ? ` (${words})` : ''}`);
  }
  const keys = new Set([...Object.keys(copy), ...Object.keys(main)].filter((k) => !SAID.has(k)));
  if ([...keys].some((k) => !same((copy as Record<string, unknown>)[k], (main as Record<string, unknown>)[k]))) parts.push('Other settings differ');
  return parts;
}

/** The parts as one line: the first `most`, then how many more. */
export function diffText(parts: readonly string[], most = 2): string {
  if (parts.length === 0) return 'The same as your plan.';
  const shown = parts.slice(0, most).join('; ');
  return parts.length > most ? `${shown}; and ${parts.length - most} more.` : `${shown}.`;
}

/** A plan's row in the Plans sheet: when it reaches FI, against your plan's
 *  for a copy, and its first difference ("FI around 54, 1 year later ·
 *  Stop age: 52 (your plan: 55), and 2 more"). Your plan's is its FI age
 *  alone (`plan` null). */
export function rowText(when: FiWhen, plan: FiWhen | null, parts: readonly string[]): string {
  if (plan === null) return lifeChoiceText(when, { kind: 'none' });
  const fi = lifeChoiceText(when, plan);
  if (parts.length === 0) return `${fi} · the same as your plan`;
  return `${fi} · ${parts[0]}${parts.length > 1 ? `, and ${parts.length - 1} more` : ''}`;
}

/** An item there, in words, for Also change it in: as its card says it, or
 *  its name for one no card shows. */
export function itemValue(x: PlanItem, money: Money): string {
  return itemWords(x, money) ?? x.label;
}

/** The facts every plan shares: the same in every plan, so never a change
 *  one plan passes on to another. */
const FACTS = new Set<string>(['age', 'partnerAge', 'includeCash', 'planFunding', 'method']);

/** `target` with the change from `before` to `after` made in it too (Also
 *  change it in): each setting `after` changed, and each item it changed
 *  that `target` holds too, by id. Nothing added or removed is passed on,
 *  and the facts are the caller's. */
export function sameChange(before: FirePlanV2, after: FirePlanV2, target: FirePlanV2): FirePlanV2 {
  const next: Record<string, unknown> = { ...target };
  for (const k of Object.keys(after)) {
    if (k === 'items' || FACTS.has(k)) continue;
    const a = (after as Record<string, unknown>)[k];
    if (!same(a, (before as Record<string, unknown>)[k])) next[k] = a;
  }
  const was = new Map(before.items.map((x) => [x.id, x]));
  const changed = new Map(after.items.filter((x) => was.has(x.id) && !same(was.get(x.id), x)).map((x) => [x.id, x]));
  return { ...(next as FirePlanV2), items: target.items.map((x) => changed.get(x.id) ?? x) };
}

/** A plan Also change it in can offer: its id, its name as offered, and the
 *  plan as it is there. */
export type AlsoTarget = { id: string; name: string; plan: FirePlanV2 };

/** Also change it in's choices for a figure's sheet: every plan offered,
 *  with the figure there. */
export function figureChoices(targets: readonly AlsoTarget[], kind: 'spending' | 'savings' | 'assets', money: Money): { id: string; name: string; value: string }[] {
  return targets.map(({ id, name, plan }) => {
    const v = plan[kind];
    return { id, name, value: v === null ? 'Nya’s figure' : kind === 'assets' ? money(v) : `${money(v)} a year` };
  });
}

/** And for an item's: each plan offered that holds it (by id), with it as
 *  it is there. */
export function itemChoices(targets: readonly AlsoTarget[], itemId: string, money: Money): { id: string; name: string; value: string }[] {
  return targets.flatMap(({ id, name, plan }) => {
    const x = plan.items.find((i) => i.id === itemId);
    return x ? [{ id, name, value: itemValue(x, money) }] : [];
  });
}
