// lib/demo-seed/scenarios.ts
//
// The kinds of data a demo account can be reset to (lib/demo-seed/reset.ts),
// for trying Nya as different people or testing it against different shapes
// of money. Each builds a profile (lib/demo-seed/profiles.ts) as of a day. A
// new kind of test data is one more entry here.
//
// Safe to import from the page: the list says what each is, and nothing here
// reads storage.

import { demoProfile, type DemoName, type DemoProfile } from './profiles';

export type Scenario = {
  id: string;
  title: string;
  /** One line, for the Demo data card. */
  description: string;
  /** A few words on what it holds, for the demo account's button on the
   *  sign-in page, which has room for one line under the name (34
   *  characters fit at 320px) where the card's description would take three. */
  holds: string;
  build(today: string): DemoProfile;
};

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'single-renter',
    title: 'Single renter',
    description: 'One income and a rented flat: a card, a student loan, three investment accounts, saving about half of what comes in.',
    holds: 'One income, renting, student loan',
    build: (today) => demoProfile('Alex', today),
  },
  {
    id: 'household',
    title: 'Two-income household',
    description: 'Two incomes and a child: a mortgage, a car loan, a family card and six investment accounts.',
    holds: 'Two incomes, a child, a mortgage',
    build: (today) => demoProfile('Sam', today),
  },
];

/** What each demo account is reset to unless another is chosen. */
export const DEFAULT_SCENARIO: Readonly<Record<DemoName, string>> = { Alex: 'single-renter', Sam: 'household' };

export function scenarioById(id: unknown): Scenario | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

/** What a demo account's button on the sign-in page says it holds: the
 *  scenario it is reset to unless another is chosen. Anyone may reset it to
 *  another, so this is what it is set up as, not a reading of it. */
export function demoHolds(name: string): string {
  const id = Object.hasOwn(DEFAULT_SCENARIO, name) ? DEFAULT_SCENARIO[name as DemoName] : null;
  return scenarioById(id)?.holds ?? '';
}

/** What the page is told of each. */
export type ScenarioView = { id: string; title: string; description: string };
export const scenarioViews = (): ScenarioView[] => SCENARIOS.map(({ id, title, description }) => ({ id, title, description }));
