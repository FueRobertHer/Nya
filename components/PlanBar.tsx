'use client';

// The Plan tab's pinned bar (docs/design/information-architecture.md#plan):
// its heading over its three segments, Your path, Drawdown and Portfolio.
// On your plan the heading is "Your plan", with the button that opens the
// Plans sheet beside it; with a copy open it is "Copy:" and the copy's name,
// after a back arrow to your plan, and the copy's card under the bar opens
// the sheet instead. The heading is where Home's FI line lands, and where
// focus goes when a copy opens. The segments are tabs, as
// Activity's and Budgets' are (components/ActivityBar.tsx). The bar has no
// amounts and saves nothing.

import { useRef, type KeyboardEvent, type Ref } from 'react';
import { chevron, LEFT, segmentKey } from './ActivityBar';
import { stopOf, type PlanCore } from '@/lib/fire/plan';

export type PlanSegment = 'path' | 'drawdown' | 'portfolio';

export const PLAN_SEGMENTS: readonly { key: PlanSegment; label: string }[] = [
  { key: 'path', label: 'Your path' },
  { key: 'drawdown', label: 'Drawdown' },
  { key: 'portfolio', label: 'Portfolio' },
];

/** The segment the Plan opens on (D2): Drawdown once the stop age is today
 *  or earlier, when "will it last?" is the live question, else Your path,
 *  as every tab opens on its first. A stop before the age is refused on
 *  save and cleared by the repair, so in practice it is the two being equal. */
export function openingSegment(plan: Pick<PlanCore, 'age' | 'targetAge' | 'stopAtFi'>): PlanSegment {
  const stop = stopOf(plan);
  return plan.age !== null && stop !== null && stop <= plan.age ? 'drawdown' : 'path';
}

/** The id of a segment's tab, which its panel is labelled by. */
export const planTabId = (s: PlanSegment) => `plan-tab-${s}`;
/** The id of a segment's panel. Each segment keeps its own, mounted, so a
 *  switch loses nothing open or typed in another. */
export const planPanelId = (s: PlanSegment) => `plan-panel-${s}`;
/** The bar's heading: where Home's FI line lands. */
export const PLAN_TITLE = 'plan-title';

/** The Plans button's words: how many plans there are, yours included, once
 *  there are two. */
export const plansText = (count: number | null) => (count !== null && count >= 2 ? `Plans (${count})` : 'Plans');

export default function PlanBar({
  ref,
  titleRef,
  plansRef,
  segment,
  onSegment,
  copy,
  plansCount,
  onPlans,
  onBack,
}: {
  ref?: Ref<HTMLDivElement>;
  /** The heading, which the tab focuses when a copy opens. */
  titleRef?: Ref<HTMLHeadingElement>;
  /** The Plans button, which the tab focuses once a copy is left. */
  plansRef?: Ref<HTMLButtonElement>;
  /** Null until the Plan has decided where it opens: no tab is selected,
   *  and the first is the tab stop. */
  segment: PlanSegment | null;
  onSegment: (s: PlanSegment) => void;
  /** The open copy's name; null with your plan shown. */
  copy: string | null;
  /** How many plans there are, yours included, once listed; null until
   *  then. Said from two. */
  plansCount: number | null;
  /** Opens the Plans sheet. Always offered: the sheet says why a copy
   *  can't be opened yet, when it can't. */
  onPlans: () => void;
  /** Back to your plan, from the copy open. */
  onBack: () => void;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = PLAN_SEGMENTS.findIndex((s) => s.key === segment);
  // With none selected, the first tab is the tab stop, and the keys move
  // from it.
  const stop = Math.max(at, 0);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = segmentKey(e.key, stop, PLAN_SEGMENTS.length);
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
        {copy !== null && (
          <button type="button" className="icon-btn" aria-label="Back to your plan" onClick={onBack}>
            {chevron(LEFT)}
          </button>
        )}
        <h2 id={PLAN_TITLE} className="plan-title" tabIndex={-1} ref={titleRef}>
          {copy === null ? 'Your plan' : `Copy: ${copy}`}
        </h2>
        {copy === null && (
          <button type="button" className="btn ghost" aria-haspopup="dialog" ref={plansRef} onClick={onPlans}>
            {plansText(plansCount)}
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
            tabIndex={i === stop ? 0 : -1}
            onClick={() => onSegment(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
