'use client';

// The Plan tab's pinned bar (docs/design/information-architecture.md#plan):
// its heading over its three segments, Your path, Stress test and Portfolio.
// On your plan the heading is "Your plan", with the button that opens the
// Scenarios sheet beside it; with a scenario open it is the scenario's name,
// after a back arrow to your plan, and the scenario's card under the bar
// opens the sheet instead. The heading is where Home's FI line lands, and
// where focus goes when a scenario opens. The segments are tabs, as
// Activity's and Budgets' are (components/ActivityBar.tsx). The bar has no
// amounts and saves nothing.

import { useRef, type KeyboardEvent, type Ref } from 'react';
import { chevron, LEFT, segmentKey } from './ActivityBar';

export type PlanSegment = 'path' | 'stress' | 'portfolio';

export const PLAN_SEGMENTS: readonly { key: PlanSegment; label: string }[] = [
  { key: 'path', label: 'Your path' },
  { key: 'stress', label: 'Stress test' },
  { key: 'portfolio', label: 'Portfolio' },
];

/** The id of a segment's tab, which its panel is labelled by. */
export const planTabId = (s: PlanSegment) => `plan-tab-${s}`;
/** The id of a segment's panel. Each segment keeps its own, mounted, so a
 *  switch loses nothing open or typed in another. */
export const planPanelId = (s: PlanSegment) => `plan-panel-${s}`;
/** The bar's heading: where Home's FI line lands. */
export const PLAN_TITLE = 'plan-title';

export default function PlanBar({
  ref,
  titleRef,
  scenariosRef,
  segment,
  onSegment,
  scenario,
  scenariosCount,
  onScenarios,
  onBack,
}: {
  ref?: Ref<HTMLDivElement>;
  /** The heading, which the tab focuses when a scenario opens. */
  titleRef?: Ref<HTMLHeadingElement>;
  /** The Scenarios button, which the tab focuses once a scenario is left. */
  scenariosRef?: Ref<HTMLButtonElement>;
  segment: PlanSegment;
  onSegment: (s: PlanSegment) => void;
  /** The open scenario's name; null with your plan shown. */
  scenario: string | null;
  /** How many scenarios there are, once listed; null until then. */
  scenariosCount: number | null;
  /** Opens the Scenarios sheet. Always offered: the sheet says why a
   *  scenario can't be opened yet, when it can't. */
  onScenarios: () => void;
  /** Back to your plan, from the scenario open. */
  onBack: () => void;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = PLAN_SEGMENTS.findIndex((s) => s.key === segment);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = segmentKey(e.key, at, PLAN_SEGMENTS.length);
    if (to === null) return;
    e.preventDefault();
    onSegment(PLAN_SEGMENTS[to].key);
    tabs.current[to]?.focus();
  };

  return (
    <div className="plan-bar" ref={ref}>
      {/* The heading stays the same element whichever plan it names, so
          focus on it survives a switch. */}
      <div className="plan-heading">
        {scenario !== null && (
          <button type="button" className="secondary icon-btn" aria-label="Back to your plan" onClick={onBack}>
            {chevron(LEFT)}
          </button>
        )}
        <h2 id={PLAN_TITLE} className="plan-title" tabIndex={-1} ref={titleRef}>
          {scenario === null ? 'Your plan' : `Scenario: ${scenario}`}
        </h2>
        {scenario === null && (
          <button type="button" className="btn ghost" aria-haspopup="dialog" ref={scenariosRef} onClick={onScenarios}>
            {scenariosCount !== null && scenariosCount > 0 ? `Scenarios (${scenariosCount})` : 'Scenarios'}
          </button>
        )}
      </div>
      <div className="segmented" role="tablist" aria-label="Plan" onKeyDown={onKeyDown}>
        {PLAN_SEGMENTS.map((s, i) => (
          <button
            key={s.key}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={planTabId(s.key)}
            aria-selected={s.key === segment}
            aria-controls={planPanelId(s.key)}
            tabIndex={s.key === segment ? 0 : -1}
            onClick={() => onSegment(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
