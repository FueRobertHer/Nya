// "Scenario: Retire at 50", at the top of every card of the Plan tab while a
// scenario is open (components/PlanScenarios.tsx), so a card scrolled to, or
// in a screenshot, can't be taken for the Plan's own.

export function ScenarioTag({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return <div className="plan-scenario-tag">Scenario: {name}</div>;
}
