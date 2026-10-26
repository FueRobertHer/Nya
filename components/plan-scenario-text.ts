// components/plan-scenario-text.ts
//
// The words the Plan's scenarios are said in: each change from the Plan,
// each life event and where it counts, what a plan starts with, why one isn't
// worked out. Kept apart from the components so the exact sentences can be
// tested (test/plan-compare.test.tsx). Every amount goes through the `money`
// a caller gives (components/plan-text.ts wholeMoney), so hidden amounts
// stay hidden. No engine, no data.

import { allocationOf, type FirePlan, type PlanExpense, type PlanIncome } from '@/lib/fire/plan';
import type { EventPart, LifeEvent, LifeEventKind, Shortfall } from '@/lib/fire/events';
import type { StartsWith } from '@/lib/fire/plan-figures';
import { settingOf, type ScenarioChange, type ScenarioChanges, type SetField } from '@/lib/fire/scenarios';
import { RULE_NAMES, REBALANCE_TEXT, pct } from './plan-text';

type Money = (n: number) => string;

export const SETTING_NAMES: Record<SetField, string> = {
  targetAge: 'Retirement age',
  spending: 'Annual spending',
  savings: 'Annual savings',
  assets: 'Invested assets',
  withdrawalRate: 'Withdrawal rate',
  realReturn: 'Real return until FI',
  taxRate: 'Tax on withdrawals',
  rule: 'Withdrawal rule',
  floor: 'Floor',
  ceiling: 'Ceiling',
  start: 'Where the simulation starts',
  startBalance: 'Starting balance',
  horizon: 'Length',
  mix: 'Stock and bond mix',
  rebalance: 'Rebalancing',
  fee: 'Fund fees',
};

export const START_NAMES: Record<FirePlan['start'], string> = {
  'fi-number': 'your FI number, at the retirement age',
  assets: 'your invested assets, today',
  custom: 'a balance you typed, at the retirement age',
};

export const EVENT_NAMES: Record<LifeEventKind, string> = {
  house: 'Buying a home',
  child: 'A child',
  sabbatical: 'A sabbatical',
  'part-time': 'Part-time work',
  spending: 'A change in spending',
};

/** A setting's value in words. */
export function settingText(field: SetField, value: unknown, money: Money): string {
  if (field === 'mix') {
    const m = value as { stocksPct: number; bondsPct: number };
    const a = allocationOf({ stocksPct: m.stocksPct, bondsPct: m.bondsPct } as FirePlan);
    return `${pct(a.stocks, 0)} stocks, ${pct(a.bonds, 0)} bonds, ${pct(a.cash, 0)} cash`;
  }
  switch (field) {
    case 'targetAge':
      return value === null ? 'not set' : `${value}`;
    case 'spending':
    case 'savings':
      return value === null ? 'Nya’s measured figure' : `${money(value as number)} a year`;
    case 'assets':
      return value === null ? 'Nya’s measured figure' : money(value as number);
    case 'startBalance':
      return value === null ? 'not set' : money(value as number);
    case 'withdrawalRate':
    case 'realReturn':
    case 'taxRate':
    case 'fee':
    case 'floor':
    case 'ceiling':
      return pct(value as number);
    case 'rule':
      return RULE_NAMES[value as FirePlan['rule']];
    case 'start':
      return START_NAMES[value as FirePlan['start']];
    case 'horizon':
      return value === null ? 'to age 95' : `${value} years`;
    case 'rebalance':
      return REBALANCE_TEXT[value as FirePlan['rebalance']];
  }
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function itemText(list: 'income' | 'expenses', item: PlanIncome | PlanExpense, money: Money): string {
  if (list === 'income') {
    const x = item as PlanIncome;
    return `${money(x.amount)} a year from age ${x.fromAge}${x.inflationAdjusted ? ', rising with inflation' : ', fixed'}`;
  }
  const x = item as PlanExpense;
  return `${money(x.amount)} at age ${x.atAge}`;
}

/** One change of a scenario, in a sentence. */
export function changeText(c: ScenarioChange, base: FirePlan, s: ScenarioChanges, money: Money): string {
  switch (c.kind) {
    case 'set': {
      const value = c.field === 'mix' ? s.set.mix : s.set[c.field];
      const planValue = settingOf(base, c.field);
      const tail = same(value, planValue) ? 'the same as your plan now' : `your plan: ${settingText(c.field, planValue, money)}`;
      return `${SETTING_NAMES[c.field]}: ${settingText(c.field, value, money)} (${tail})`;
    }
    case 'left-out':
      return `Leaves out “${c.item.label}” (${itemText(c.list, c.item, money)})`;
    case 'replaced':
      return `“${c.item.label}”: ${itemText(c.list, c.item, money)}, instead of ${itemText(c.list, c.was, money)}`;
    case 'added':
      return `Adds “${c.item.label}”: ${itemText(c.list, c.item, money)}`;
    case 'orphan':
      return `“${c.item.label}” replaced an item your plan no longer has, so it is left out`;
    case 'moot':
      return 'Leaves out an item your plan no longer has, so nothing';
  }
}

const span = (years: number | null) => (years === null ? 'for good' : `for ${years} year${years === 1 ? '' : 's'}`);
const moreOrLess = (yearly: number, money: Money) => (yearly >= 0 ? `${money(yearly)} a year more` : `${money(-yearly)} a year less`);

/** A life event's figures, in a sentence. */
export function eventText(e: LifeEvent, money: Money): string {
  switch (e.kind) {
    case 'house': {
      const cost = e.cost > 0 ? `${money(e.cost)} from your investments` : 'nothing from your investments';
      const change = e.yearly !== 0 ? `, then spending ${moreOrLess(e.yearly, money)} ${span(e.years)}` : '';
      return `At ${e.atAge}: ${cost}${change}.`;
    }
    case 'child':
      return `From ${e.fromAge}: spending ${money(e.yearly)} a year more, for ${e.years} year${e.years === 1 ? '' : 's'}.`;
    case 'sabbatical':
      return `From ${e.fromAge}, for ${e.years} year${e.years === 1 ? '' : 's'}: saving ${money(e.savingsLost)} a year less.`;
    case 'part-time':
      return `From ${e.fromAge} to ${e.toAge}: ${money(e.yearly)} a year after tax.`;
    case 'spending':
      return `From ${e.fromAge}: spending ${moreOrLess(e.yearly, money)}, ${span(e.years)}.`;
  }
}

/** Where an event counts, in a sentence. */
export function eventCountsText(e: LifeEvent): string {
  if (e.kind === 'part-time') return 'In the simulation from the retirement age, as income for its years. Not in the FI date, which assumes full-time work until FI.';
  if (e.kind === 'sabbatical') return 'In the FI date: it lowers what is saved in its years.';
  if ((e.kind === 'house' || e.kind === 'spending') && e.years === null) {
    return 'In the FI date from its age, and in the simulation: in effect at the retirement age, it is part of your spending in retirement, and so of your FI number.';
  }
  return 'In the FI date in every year it covers, and in the simulation for its years from the retirement age.';
}

export const EVENT_PART_TEXT: Record<EventPart, string> = {
  past: 'Some of it is before today: it counts from today, and your measured figures may already count what has begun.',
  'no-today': 'Without your age there is no today to count from, so the FI date leaves it out; the simulation places it from the retirement age.',
  'no-age': 'Without your age or a target age it can’t be placed, so it is left out.',
  retired: 'Its years from the retirement age change nothing: by then you have stopped working.',
  'before-start':
    'Its years before the retirement age are left out: in this plan you work full time until then. For part-time work in place of full-time work, set this scenario’s retirement age to when full-time work stops.',
  'after-end': 'Some of it is after the plan ends: only the grid’s longer columns reach it.',
};

/** What a plan starts with, and what the walk says it would have then.
 *  `shortWhere` is where the shortfall that stops the walk is said: below,
 *  in compare mode; on Your path, from the simulation's card. */
export function startsWithText(sw: StartsWith, money: Money, shortWhere = 'below'): string {
  const from = sw.from === 'fi-number' ? 'your FI number' : sw.from === 'assets' ? 'your invested assets today' : 'the balance you typed';
  const at = sw.from === 'assets' ? '' : sw.atAge !== null ? ` at ${sw.atAge}` : ' at the retirement age';
  const head = `${money(sw.balance)}, ${from}${at}`;
  if (sw.from === 'assets') return `${head}.`;
  if (sw.short) return `${head}: it would never get that far (${shortWhere}).`;
  if (sw.projected === null) return `${head}.`;
  if (!sw.more) return `${head}: you’d have about ${money(sw.projected)} then.`;
  return `${head}: you’d have about ${money(sw.projected)} then, ${money(sw.balance - sw.projected)} less.`;
}

/** Why the walk stops, with no FI date. */
export function shortText(short: Shortfall, age: number | null, money: Money): string {
  const when = age !== null ? `at ${age + short.year}` : `in ${short.year} year${short.year === 1 ? '' : 's'}`;
  return short.kind === 'cost'
    ? `You’d have about ${money(short.have)} ${when}, less than the ${money(short.need)} it takes from your investments, so there is no FI date: change the cost, or when it comes.`
    : `You’d have about ${money(short.have)} ${when}, and that year takes ${money(short.need)} out, more than there is, so there is no FI date.`;
}

/** Why a scenario isn't worked out with the Plan as it is now, from the
 *  rule parsePlan says it breaks. */
export function resolveErrorText(field: string, error: string, base: FirePlan, s: ScenarioChanges): string {
  if (field === 'targetAge' && base.age !== null) {
    return `It retires at ${s.set.targetAge ?? base.targetAge}, before your age now (${base.age}). Change its retirement age, or use your plan’s.`;
  }
  if (field === 'income' || field.startsWith('income[')) return 'With your plan’s other income, it has more than a plan takes (5). Leave one out, or remove one it adds.';
  if (field === 'expenses' || field.startsWith('expenses[')) return 'With your plan’s one-off expenses, it has more than a plan takes (10). Leave one out, or remove one it adds.';
  return `It can’t be worked out with your plan as it is now: ${error}. Change it, or use your plan’s.`;
}

/** Retirement spending with lasting changes, beside the FI number. */
export function retirementText(spending: number, lasting: number, today: number, money: Money): string {
  return `${money(spending)} a year in retirement: ${money(today)} now, ${lasting >= 0 ? 'and' : 'less'} ${money(Math.abs(lasting))} a year of lasting changes from this scenario’s life events`;
}

/** Lasting changes that start after the retirement age, which the FI number
 *  leaves out and the simulation counts. */
export function laterText(later: { amount: number; fromAge: number }[], money: Money): string | null {
  if (later.length === 0) return null;
  const parts = later.map((l) => `${moreOrLess(l.amount, money)} from ${l.fromAge}`);
  return `The FI number leaves out ${parts.join(' and ')}, which the simulation counts.`;
}

export function currencyText(typedIn: string, planIn: string, known = true): string {
  if (!known) return `Its amounts were typed in ${typedIn}, and which currency your plan’s figures are in isn’t known yet (at the top of the Plan tab). Nothing is converted, so it isn’t worked out until you have said.`;
  return `Its amounts were typed in ${typedIn}, and your plan is now in ${planIn}. Nothing is converted, so it isn’t worked out: check its amounts, then say they are in ${planIn}.`;
}
