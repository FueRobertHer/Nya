'use client';

// Parts of the dashboard whose code is loaded when they are first needed, not
// with Home: the Budgets tab (components/BudgetsTabLoader.tsx), the sheets
// Home never opens itself (components/LazySheets.tsx) and Settings' cards
// (components/SettingsCardsLoader.tsx). Home's first load then carries only
// what Home draws, so it is ready sooner on a phone.
//
// Not next/dynamic, for the reasons components/PlanTabLoader.tsx gives: a
// failed import here is forgotten, so trying again fetches it again, and a
// part that can't be loaded or stops while it runs says so in its own place,
// with the rest of the dashboard working as before.
//
// Once Home has its figures, preloadParts fetches each part in turn, so a
// sheet opens at once and, since the service worker keeps every file a kept
// page can load (public/service-worker.js), the parts open offline too, as
// they did when they came with Home. The Plan tab isn't among them: it
// carries the projection engine, the largest code there is, and is fetched
// when it opens.

import { Component, Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type LazyPart<M> = {
  /** The part's module, imported once and shared; a failed import is
   *  forgotten, so the next call tries again. */
  load: () => Promise<M>;
  /** The module, once it has arrived. */
  loaded: () => M | null;
  /** Calls `listener` when the module arrives, whoever asked for it: so
   *  every place a part is drawn (Settings' cards share one) has it once one
   *  of them tried again. Returns how to stop. */
  onArrival: (listener: (mod: M) => void) => () => void;
};

export function lazyPart<M>(importer: () => Promise<M>): LazyPart<M> {
  let mod: M | null = null;
  let loading: Promise<M> | null = null;
  const waiting = new Set<(mod: M) => void>();
  return {
    load: () =>
      (loading ??= importer().then(
        (m) => {
          mod = m;
          for (const listener of waiting) listener(m);
          return m;
        },
        (err) => {
          loading = null;
          throw err;
        }
      )),
    loaded: () => mod,
    onArrival: (listener) => {
      waiting.add(listener);
      return () => void waiting.delete(listener);
    },
  };
}

const shown = new Set<() => void>();

/** Calls `listener` each time a part's code arrives and the part is drawn,
 *  with no render of the dashboard around it: so something waiting for an
 *  element inside it (the dashboard's focus after a Needs attention row) can
 *  look again. Returns how to stop. */
export function onPartShown(listener: () => void): () => void {
  shown.add(listener);
  return () => void shown.delete(listener);
}

/** The part's module once `wanted`: at once if it has arrived already (a
 *  part opened again, or fetched in the background since this one was
 *  drawn), so it draws in the same render. `retry` after a failed load. */
export function useLazyPart<M>(part: LazyPart<M>, wanted = true): { mod: M | null; failed: boolean; retry: () => void } {
  const [arrivedMod, setMod] = useState<M | null>(() => part.loaded());
  const mod = wanted ? (arrivedMod ?? part.loaded()) : null;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // Here when it arrives, from this load or another place's.
    const stop = part.onArrival((m) => {
      setMod(m);
      setFailed(false);
    });
    const now = part.loaded();
    if (now) setMod(now);
    return stop;
  }, [part]);
  useEffect(() => {
    if (mod || !wanted) return;
    let live = true;
    part.load().catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [part, mod, wanted, attempt]);
  const arrived = useRef(mod !== null);
  useEffect(() => {
    if (!mod || arrived.current) return;
    arrived.current = true;
    for (const listener of shown) listener();
  }, [mod]);
  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((n) => n + 1);
  }, []);
  return { mod, failed: failed && !mod, retry };
}

let preloading = false;

/** Fetches each part's code in turn while the browser is idle, once per
 *  page: one at a time, since each import runs as one long task. A part
 *  that fails here tries again when it is opened. */
export function preloadParts(parts: LazyPart<unknown>[]): void {
  if (preloading) return;
  preloading = true;
  const idle = (run: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 5000 }) : setTimeout(run, 1000));
  const next = (i: number) => {
    if (i < parts.length) idle(() => void parts[i].load().then(() => next(i + 1), () => next(i + 1)));
  };
  next(0);
}

/** What a part says in its place when its code couldn't be loaded, or when
 *  it ran into a problem and stopped. `what` names it ("The Budgets tab",
 *  "This card"); `after`, what still works. */
export function PartUnavailable({ what, after, reason, onRetry }: { what: string; after?: string; reason: 'load' | 'crash'; onRetry: () => void }) {
  return (
    <>
      <p className="empty-note">
        {reason === 'load'
          ? `${what} couldn't be loaded. It needs a connection the first time it opens after an update.`
          : `${what} ran into a problem and stopped.`}
        {after ? ` ${after}` : ''}
      </p>
      <div className="button-pair">
        <button className="secondary" onClick={onRetry}>
          Try again
        </button>
        <button className="secondary" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      </div>
    </>
  );
}

/** Catches a failure while the part renders, so it stays in the part's
 *  place; `fallback` draws it, with how to start the part afresh. */
export class PartBoundary extends Component<{ name: string; fallback: (retry: () => void) => ReactNode; children: ReactNode }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error(`${this.props.name} failed:`, err);
  }

  render() {
    if (this.state.failed) return this.props.fallback(() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 })));
    // A new key on retry starts the part afresh rather than reusing what failed.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
