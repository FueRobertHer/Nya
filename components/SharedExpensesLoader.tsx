'use client';

// Shared expenses (#49, components/SharedExpensesCard.tsx): Activity's Shared
// segment and the sheets its rows open, loaded when Activity first opens (its
// sheets are mounted on every segment) or once Home has its figures
// (components/lazy-part.tsx), not with Home. The segment draws the card as it
// is while its figures load; a sheet asked for before the code is in opens
// once it is, or without it after a moment (components/LazySheets.tsx), with
// the title it opens with. If it can't be loaded, or stops while it runs, it
// says so in its place and the rest of Activity works as before.

import { useEffect, type ComponentProps } from 'react';
import type { SharedExpenses, SharedOpen } from './shared-expenses-state';
import { REMOVED_NAME } from '@/lib/shared-expenses/model';
import { LazySheet } from './LazySheets';
import { PartBoundary, PartUnavailable, lazyPart, useLazyPart } from './lazy-part';

type Module = typeof import('./SharedExpensesCard');

export const sharedExpensesPart = lazyPart(() => import('./SharedExpensesCard'));

/** The Shared segment's place when its code couldn't be loaded or it stopped. */
export function SharedUnavailable({ reason, onRetry }: { reason: 'load' | 'crash'; onRetry: () => void }) {
  return (
    <div className="card stack">
      <div className="inst-header">
        <div className="inst-name">Shared expenses</div>
      </div>
      <PartUnavailable what="Shared expenses" after="The rest of Activity works as before." reason={reason} onRetry={onRetry} />
    </div>
  );
}

/** The card while its code is on its way, as it is while its figures load. */
function SharedLoading() {
  return (
    <div className="card stack">
      <div className="inst-header">
        <div className="inst-name">Shared expenses</div>
      </div>
      <p className="empty-note">Loading…</p>
    </div>
  );
}

/** The title the sheet for `open` opens with, for its stand-in, from what
 *  the page already has (the card, `card`): the usual one where it depends
 *  on more than that (a row already shared, a payment already confirmed,
 *  which way a handoff goes). */
export function sheetTitle(open: SharedOpen | null, card: SharedExpenses['card']): string {
  switch (open?.kind) {
    case 'paid':
      return (open.t.shared_was ?? open.t.amount) < 0 ? 'This paid back…' : 'This paid…';
    case 'settle':
      return open.letGo ? 'Let it go' : 'Mark settled';
    case 'person':
      return open.id ? (card?.people.find((x) => x.id === open.id)?.name ?? REMOVED_NAME) : 'Add someone';
    case 'iou':
      return open.id ? 'IOU' : 'Add an IOU';
    case 'handoff':
      return 'Ask for it';
    default:
      return 'Share the cost';
  }
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
  return <SharedLoading />;
}

export function SharedSheets(props: ComponentProps<Module['SharedSheets']>) {
  const { open, setOpen } = props.shared;
  // Mounted on every segment of Activity, so its rows' sheets are on their
  // way from when Activity opens.
  useEffect(() => void sharedExpensesPart.load().catch(() => {}), []);
  return (
    <LazySheet part={sharedExpensesPart} open={open !== null} title={sheetTitle(open, props.shared.card)} onClose={() => setOpen(null)}>
      {(m) => <m.SharedSheets {...props} />}
    </LazySheet>
  );
}
