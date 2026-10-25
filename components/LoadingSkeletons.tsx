'use client';

// components/LoadingSkeletons.tsx
//
// What a screen shows while what fills it is on its way: the same cards and
// lines it will have, each the size its content will be, with placeholders
// (.skeleton, docs/design/design-system.md#skeleton) where figures and words
// will go, so nothing moves when they arrive.

import { useLayoutEffect } from 'react';
import { Brand } from './Brand';
import { HideAmountsToggle } from './HideAmounts';
import { GEAR, HeaderIcon, REFRESH } from './HeaderIcon';

// The animations kept in step: the placeholders' pulse, and Refresh turning.
const IN_STEP = new Set(['skeleton-pulse', 'spin']);
let origin: CSSNumberish | null = null;

/** Sets every placeholder's pulse, and every turning icon, to the start of
 *  the first this page showed. The same view is drawn anew as the sign-in
 *  hands over (the sign-in page's, Home's while it reads the session, the
 *  dashboard's own), and each new copy would start its animation over, so
 *  the view would seem to blink at each step. */
function keepInStep() {
  if (typeof document.getAnimations !== 'function' || typeof CSSAnimation === 'undefined') return;
  const running = document.getAnimations().filter((a): a is CSSAnimation => a instanceof CSSAnimation && IN_STEP.has(a.animationName));
  if (running.length === 0) return;
  origin ??= running.find((a) => a.startTime !== null)?.startTime ?? document.timeline.currentTime;
  if (origin === null) return;
  for (const a of running) if (a.startTime !== origin) a.startTime = origin;
}

/** Before the first paint of a view with placeholders, so a new copy never
 *  shows out of step. */
function useInStep() {
  useLayoutEffect(keepInStep, []);
}

/** Home's Net worth card while the first load is on its way: its title, then
 *  the total, its change line, the chart and the foot row as placeholders, each
 *  as tall as components/NetWorthCard.tsx draws it. The dashboard shows it
 *  while it loads, and so does AppLoading, below. */
export function HomeSkeleton() {
  useInStep();
  return (
    <section className="card stack net-worth-card" aria-busy="true" aria-labelledby="net-worth-loading">
      <div>
        <h2 id="net-worth-loading" className="total-label">
          Net worth
        </h2>
        <div className="total-value" aria-hidden="true">
          <span className="skeleton home-skeleton-total" />
        </div>
        <div className="hero-delta" aria-hidden="true">
          <span className="skeleton home-skeleton-delta" />
        </div>
      </div>
      {/* The chart on its own classes (components/NetWorthChart.tsx): the
          readout with its info button, the plot at the chart's proportions,
          and the row of range buttons. */}
      <div aria-hidden="true">
        <div className="chart-readout chart-readout-stable">
          <span className="chart-readout-value">
            <span className="skeleton home-skeleton-readout" />
          </span>
          <span className="chart-readout-date">
            <span className="skeleton home-skeleton-readout-date" />
          </span>
          <span className="chart-info-btn">
            <span className="skeleton block home-skeleton-info" />
          </span>
        </div>
        <span className="skeleton block home-skeleton-plot" />
        <div className="chart-ranges">
          <span className="chart-range">
            <span className="skeleton home-skeleton-ranges" />
          </span>
        </div>
      </div>
      {/* When it was updated, and the Chart notes button, which a phone
          wraps onto a line of its own as it does the card's. */}
      <div className="net-worth-foot" aria-hidden="true">
        <span className="helper">
          <span className="skeleton home-skeleton-as-of" />
        </span>
        <span className="btn ghost">
          <span className="skeleton home-skeleton-chart-notes" />
        </span>
      </div>
      {/* The one thing a screen reader is told while it loads. */}
      <p className="visually-hidden" role="status">
        Loading
      </p>
    </section>
  );
}

/** The app loading, as a whole page: what Home streams while the server
 *  reads who is signed in (app/page.tsx), which a sign-in's move there shows
 *  at once; the sign-in page while a demo sign-in is on its way
 *  (components/SignInFlow.tsx); and the password login once it is accepted.
 *  It is the dashboard's header and Home as the dashboard draws them while it
 *  loads, the line under the name and the header's buttons included, so the
 *  dashboard arriving changes nothing: hide amounts works, Refresh turns,
 *  unavailable, and the account menu's place holds the circle the
 *  dashboard's own keeps until Clerk draws the avatar (ClerkAccount). The
 *  Settings gear of password mode does nothing until the dashboard is in. */
export function AppLoading({ account }: { account: 'clerk' | 'password' }) {
  return (
    <main className="wrap">
      <div className="top-row">
        <div>
          <Brand />
          <p className="sub">Loading your accounts…</p>
        </div>
        <div className="top-actions">
          <HideAmountsToggle />
          <button className="secondary icon-btn" disabled aria-label="Refresh" title="Refresh">
            <HeaderIcon d={REFRESH} spin />
          </button>
          {account === 'clerk' ? (
            <div className="user-button-slot">
              <span className="skeleton user-button-skeleton" aria-hidden="true" />
            </div>
          ) : (
            <button className="secondary icon-btn" aria-disabled="true" aria-label="Settings" title="Settings">
              <HeaderIcon d={GEAR} />
            </button>
          )}
        </div>
      </div>
      <HomeSkeleton />
    </main>
  );
}

/** Clerk's sign-in form while its script loads (components/SignInFlow.tsx
 *  SignInPlaceholder, the sign-in page's <SignIn fallback>): a card of the
 *  form's width and about its height, with its title, field, button and
 *  footer as placeholders, so the form arriving moves nothing above it and
 *  little below. `status` is what a screen reader is told. */
export function SignInSkeleton({ status }: { status: string }) {
  useInStep();
  return (
    <div className="signin-skeleton" role="status">
      <span className="visually-hidden">{status}</span>
      <div className="signin-skeleton-card" aria-hidden="true">
        <div className="signin-skeleton-head">
          <span className="skeleton block" />
          <span className="skeleton block" />
        </div>
        <div className="signin-skeleton-form">
          <span className="skeleton block" />
          <span className="skeleton block" />
          <span className="skeleton block" />
        </div>
      </div>
      <div className="signin-skeleton-foot" aria-hidden="true">
        <span className="skeleton block" />
      </div>
    </div>
  );
}
