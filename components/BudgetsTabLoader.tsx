'use client';

// The Budgets tab's code, loaded when the tab first opens or once Home has its
// figures (components/lazy-part.tsx), not with Home: its forecast, calendar,
// goals and budget sheets are a large share of the dashboard's code. If it
// can't be loaded or stops while it runs, the tab says so and the other tabs
// keep working, as the Plan tab does (components/PlanTabLoader.tsx).

import type { ComponentProps } from 'react';
import { BudgetsSkeleton } from './LoadingSkeletons';
import { PartBoundary, PartUnavailable, lazyPart, useLazyPart } from './lazy-part';

type BudgetsTabProps = ComponentProps<typeof import('./BudgetsTab').default>;

export const budgetsTabPart = lazyPart(() => import('./BudgetsTab'));

/** What the tab shows instead of itself when it can't load or has stopped. */
export function BudgetsUnavailable({ reason, onRetry }: { reason: 'load' | 'crash'; onRetry: () => void }) {
  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Budgets</div>
      </div>
      <PartUnavailable what="The Budgets tab" after="The other tabs work as before." reason={reason} onRetry={onRetry} />
    </div>
  );
}

export default function BudgetsTabLoader(props: BudgetsTabProps) {
  const { mod, failed, retry } = useLazyPart(budgetsTabPart);
  if (mod) {
    const Budgets = mod.default;
    return (
      <PartBoundary name="Budgets tab" fallback={(again) => <BudgetsUnavailable reason="crash" onRetry={again} />}>
        <Budgets {...props} />
      </PartBoundary>
    );
  }
  if (failed) return <BudgetsUnavailable reason="load" onRetry={retry} />;
  // The tab as it will be while its code is on its way: its bar, unavailable
  // until then, over the segment's skeleton.
  return <BudgetsSkeleton segment={props.segment} />;
}
