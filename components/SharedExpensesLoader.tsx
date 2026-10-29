'use client';

// Shared expenses (#49, components/SharedExpensesCard.tsx): Activity's Shared
// segment and the sheets its rows open, loaded when Activity first opens or
// once Home has its figures (components/lazy-part.tsx), not with Home. The
// segment draws its skeleton while the code is on its way; a sheet asked for
// before then opens once it is in, or without it after a moment
// (components/LazySheets.tsx). If it can't be loaded, or stops while it runs,
// it says so in its place and the rest of Activity works as before.

import type { ComponentProps } from 'react';
import { CardSkeleton } from './LoadingSkeletons';
import { LazySheet } from './LazySheets';
import { PartBoundary, PartUnavailable, lazyPart, useLazyPart } from './lazy-part';

type Module = typeof import('./SharedExpensesCard');

export const sharedExpensesPart = lazyPart(() => import('./SharedExpensesCard'));

/** The Shared segment's place when its code couldn't be loaded or it stopped. */
export function SharedUnavailable({ reason, onRetry }: { reason: 'load' | 'crash'; onRetry: () => void }) {
  return (
    <section className="card">
      <PartUnavailable what="Shared expenses" after="The rest of Activity works as before." reason={reason} onRetry={onRetry} />
    </section>
  );
}

export default function SharedExpensesCard(props: ComponentProps<Module['default']>) {
  const { mod, failed, retry } = useLazyPart(sharedExpensesPart);
  if (mod) {
    const Card = mod.default;
    return (
      <PartBoundary name="Shared expenses" fallback={(again) => <SharedUnavailable reason="crash" onRetry={again} />}>
        <Card {...props} />
      </PartBoundary>
    );
  }
  if (failed) return <SharedUnavailable reason="load" onRetry={retry} />;
  return <CardSkeleton label="Loading" />;
}

export function SharedSheets(props: ComponentProps<Module['SharedSheets']>) {
  const { open, setOpen } = props.shared;
  return (
    <LazySheet part={sharedExpensesPart} open={open !== null} title="Shared expenses" onClose={() => setOpen(null)}>
      {(m) => <m.SharedSheets {...props} />}
    </LazySheet>
  );
}
