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
  build(today: string): DemoProfile;
};

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'single-renter',
    title: 'Single renter',
    description: 'One income and a rented flat: a card, a student loan, three investment accounts, saving about half of what comes in.',
    build: (today) => demoProfile('Alex', today),
  },
  {
    id: 'household',
    title: 'Two-income household',
    description: 'Two incomes and a child: a mortgage, a car loan, a family card and six investment accounts.',
    build: (today) => demoProfile('Sam', today),
  },
];

/** What each demo account is reset to unless another is chosen. */
export const DEFAULT_SCENARIO: Readonly<Record<DemoName, string>> = { Alex: 'single-renter', Sam: 'household' };

export function scenarioById(id: unknown): Scenario | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

/** What the page is told of each. */
export type ScenarioView = { id: string; title: string; description: string };
export const scenarioViews = (): ScenarioView[] => SCENARIOS.map(({ id, title, description }) => ({ id, title, description }));
