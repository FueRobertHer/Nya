'use client';

// Loads the FI card on Home (components/FiProgressCard.tsx) after Home has
// painted, as the Plan tab's own code is loaded (components/PlanTabLoader.tsx):
// the card works its figures out with the Plan's modules, and those carry the
// projection engine's code, which Home's bundle never needs. The card runs no
// simulation.
//
// The card is a glance, not a figure anything depends on, so if its code
// can't be loaded (offline before it was ever fetched) or it fails while it
// runs, Home shows nothing in its place and works as before. A failed import
// is forgotten, so the next time Home opens tries again.

import { Component, useEffect, useState, type ReactNode } from 'react';
import type { FiProgressProps } from './FiProgressCard';

type FiProgressModule = typeof import('./FiProgressCard');

let loaded: FiProgressModule | null = null;
let loading: Promise<FiProgressModule> | null = null;

/** The card's module, imported once and shared; a failed import is
 *  forgotten, so the next call tries again. */
export function loadFiProgress(importer: () => Promise<FiProgressModule> = () => import('./FiProgressCard')): Promise<FiProgressModule> {
  loading ??= importer().then(
    (mod) => (loaded = mod),
    (err) => {
      loading = null;
      throw err;
    }
  );
  return loading;
}

/** Shows nothing in place of a card that failed while it ran. */
export class QuietBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error('FI card failed:', err);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function FiProgressLoader(props: FiProgressProps) {
  const [mod, setMod] = useState<FiProgressModule | null>(loaded);
  useEffect(() => {
    if (mod) return;
    let live = true;
    loadFiProgress().then(
      (m) => {
        if (live) setMod(m);
      },
      () => {
        // Nothing to show: Home works as before.
      }
    );
    return () => {
      live = false;
    };
  }, [mod]);
  if (!mod) return null;
  const Card = mod.default;
  return (
    <QuietBoundary>
      <Card {...props} />
    </QuietBoundary>
  );
}
