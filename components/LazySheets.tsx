'use client';

// Sheets whose code is loaded when they are first opened, or once Home has its
// figures (components/lazy-part.tsx), not with Home: the payoff planner, the
// switch from another app, and the file and history imports with their
// parsers. Each is mounted the first time it is opened and stays mounted, so
// what was typed into it lasts until a reload, as when it came with Home.
//
// The code is usually there before the sheet is asked for. When it isn't, the
// sheet opens without it after a moment, its rows still to come, rather than
// leave the tap with no answer. If it can't be loaded, or the sheet stops
// while it runs, the sheet says so and the rest of the dashboard works as
// before.

import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { RowsSkeleton } from './LoadingSkeletons';
import { Sheet } from './Sheet';
import { PartBoundary, PartUnavailable, lazyPart, useLazyPart, type LazyPart } from './lazy-part';

export const debtPayoffPart = lazyPart(() => import('./DebtPayoff'));
export const migrationSheetPart = lazyPart(() => import('./MigrationSheet'));
export const importSheetPart = lazyPart(() => import('./ImportSheet'));
export const historyImportSheetPart = lazyPart(() => import('./HistoryImportSheet'));

/** How long a sheet waits for its code before opening without it. */
export const SLOW_MS = 300;

export function LazySheet<M>({ part, open, title, onClose, children }: { part: LazyPart<M>; open: boolean; title: string; onClose: () => void; children: (mod: M) => ReactNode }) {
  const [asked, setAsked] = useState(open);
  if (open && !asked) setAsked(true);
  const { mod, failed, retry } = useLazyPart(part, asked);
  const waiting = open && !mod && !failed;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  const unavailable = (reason: 'load' | 'crash', onRetry: () => void) => (
    <Sheet open title={title} onClose={onClose}>
      <PartUnavailable what="This" after="The rest of the app works as before." reason={reason} onRetry={onRetry} />
    </Sheet>
  );
  if (mod) {
    return (
      <PartBoundary name={title} fallback={(again) => (open ? unavailable('crash', again) : null)}>
        {children(mod)}
      </PartBoundary>
    );
  }
  if (!open) return null;
  if (failed) return unavailable('load', retry);
  if (slow) {
    return (
      <Sheet open title={title} onClose={onClose}>
        <RowsSkeleton count={3} />
      </Sheet>
    );
  }
  return null;
}

type DebtPayoffProps = ComponentProps<typeof import('./DebtPayoff').default>;
export function DebtPayoff(props: DebtPayoffProps) {
  return (
    <LazySheet part={debtPayoffPart} open={props.open} title="Payoff plan" onClose={props.onClose}>
      {(m) => <m.default {...props} />}
    </LazySheet>
  );
}

type MigrationSheetProps = ComponentProps<typeof import('./MigrationSheet').default>;
export function MigrationSheet(props: MigrationSheetProps) {
  return (
    <LazySheet part={migrationSheetPart} open={props.open} title="Switching from another app" onClose={props.onClose}>
      {(m) => <m.default {...props} />}
    </LazySheet>
  );
}

type ImportSheetProps = ComponentProps<typeof import('./ImportSheet').default>;
export function ImportSheet(props: ImportSheetProps) {
  return (
    <LazySheet part={importSheetPart} open={!!props.target} title="Import a file" onClose={props.onClose}>
      {(m) => <m.default {...props} />}
    </LazySheet>
  );
}

type HistoryImportSheetProps = ComponentProps<typeof import('./HistoryImportSheet').default>;
export function HistoryImportSheet(props: HistoryImportSheetProps) {
  return (
    <LazySheet part={historyImportSheetPart} open={!!props.target} title="Import history" onClose={props.onClose}>
      {(m) => <m.default {...props} />}
    </LazySheet>
  );
}
