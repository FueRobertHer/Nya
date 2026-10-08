'use client';

// Loads the Plan tab's code when the tab is opened, and keeps anything that
// goes wrong with it on the Plan tab: the code failing to load (opened
// offline before it was ever fetched, a flaky connection, a deploy that
// replaced it) or the tab failing while it runs. Either way the other tabs
// keep working, and the Plan tab says what happened and offers to try again.
//
// Not next/dynamic: that is React.lazy, which remembers a failed import, so
// trying again would take a page reload, and with no error boundary above it
// a failed import replaces the whole dashboard with the error page. Here the
// import is an ordinary promise, forgotten when it fails, so trying again
// fetches it again.

import { Component, Fragment, useEffect, useState, type ReactNode } from 'react';
import type { PlanTabProps } from './PlanTab';

type PlanTabModule = typeof import('./PlanTab');

let loaded: PlanTabModule | null = null;
let loading: Promise<PlanTabModule> | null = null;

/** The Plan tab's module, imported once and shared; a failed import is
 *  forgotten, so the next call tries again. */
export function loadPlanTab(importer: () => Promise<PlanTabModule> = () => import('./PlanTab')): Promise<PlanTabModule> {
  loading ??= importer().then(
    (mod) => (loaded = mod),
    (err) => {
      loading = null;
      throw err;
    }
  );
  return loading;
}

/** What the tab shows instead of itself when it can't load or has stopped. */
export function PlanUnavailable({ reason, onRetry }: { reason: 'load' | 'crash'; onRetry: () => void }) {
  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Plan</div>
      </div>
      <p className="empty-note">
        {reason === 'load'
          ? "The Plan tab couldn't be loaded. It needs a connection the first time it opens after an update. The other tabs work as before."
          : 'The Plan tab ran into a problem and stopped. The other tabs work as before.'}
      </p>
      <div className="button-pair">
        <button className="secondary" onClick={onRetry}>
          Try again
        </button>
        <button className="secondary" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      </div>
    </div>
  );
}

/** Catches a failure while the tab renders, so it stays on this tab. */
export class PlanBoundary extends Component<{ children: ReactNode }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error('Plan tab failed:', err);
  }

  render() {
    if (this.state.failed) {
      return <PlanUnavailable reason="crash" onRetry={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))} />;
    }
    // A new key on retry starts the tab afresh rather than reusing what failed.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}

export default function PlanTabLoader(props: PlanTabProps) {
  const [mod, setMod] = useState<PlanTabModule | null>(loaded);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (mod) return;
    let live = true;
    loadPlanTab().then(
      (m) => {
        if (live) setMod(m);
      },
      () => {
        if (live) setFailed(true);
      }
    );
    return () => {
      live = false;
    };
  }, [mod, attempt]);

  if (failed) {
    return (
      <PlanUnavailable
        reason="load"
        onRetry={() => {
          setFailed(false);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (!mod) {
    return (
      <div className="card">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }
  const Plan = mod.default;
  return (
    <PlanBoundary>
      <Plan {...props} />
    </PlanBoundary>
  );
}
