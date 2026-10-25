// components/LoadingSkeletons.tsx
//
// What a screen shows while what fills it is on its way: the same cards and
// lines it will have, each the size its content will be, with placeholders
// (.skeleton, docs/design/design-system.md#skeleton) where figures and words
// will go, so nothing moves when they arrive. No state or hooks: these render
// on the server and in client components alike.

import { Brand } from './Brand';

/** Home's Net worth card while the first load is on its way: its title, then
 *  the total, its change line, the chart and the foot row as placeholders, each
 *  as tall as components/NetWorthCard.tsx draws it. The dashboard shows it
 *  while it loads, and so does AppLoading, below. */
export function HomeSkeleton() {
  return (
    <section className="card stack net-worth-card" aria-busy="true" aria-labelledby="net-worth-loading">
      <div>
        <h2 id="net-worth-loading" className="total-label">
          Net worth
        </h2>
        <div className="total-value" aria-hidden="true">
          <span className="skeleton skeleton-total" />
        </div>
        <div className="hero-delta" aria-hidden="true">
          <span className="skeleton skeleton-delta" />
        </div>
      </div>
      {/* The chart on its own classes (components/NetWorthChart.tsx): the
          readout with its info button, the plot at the chart's proportions,
          and the row of range buttons. */}
      <div aria-hidden="true">
        <div className="chart-readout chart-readout-stable">
          <span className="chart-readout-value">
            <span className="skeleton skeleton-readout" />
          </span>
          <span className="chart-readout-date">
            <span className="skeleton skeleton-readout-date" />
          </span>
          <span className="chart-info-btn">
            <span className="skeleton block skeleton-info" />
          </span>
        </div>
        <span className="skeleton block skeleton-plot" />
        <div className="chart-ranges">
          <span className="chart-range">
            <span className="skeleton skeleton-ranges" />
          </span>
        </div>
      </div>
      {/* When it was updated, and the Chart notes button, which a phone
          wraps onto a line of its own as it does the card's. */}
      <div className="net-worth-foot" aria-hidden="true">
        <span className="helper">
          <span className="skeleton skeleton-as-of" />
        </span>
        <span className="btn ghost">
          <span className="skeleton skeleton-chart-notes" />
        </span>
      </div>
      <p className="visually-hidden" role="status">
        Loading
      </p>
    </section>
  );
}

/** The app loading, as a whole page, for the pages that hand over to it: the
 *  sign-in page while a demo sign-in is on its way and once signed in
 *  (components/SignInFlow.tsx), and the password login once it is accepted.
 *  It is the dashboard's header and Home as the dashboard draws them while it
 *  loads, the line under the name included, so the dashboard arriving moves
 *  nothing. */
export function AppLoading({ account }: { account: 'clerk' | 'password' }) {
  return (
    <main className="wrap">
      <div className="top-row">
        <div>
          <Brand />
          <p className="sub" role="status">
            Loading your accounts…
          </p>
        </div>
        {/* Where the header's buttons go: hide amounts, refresh, then the
            account menu, or the Settings gear in password mode. */}
        <div className="top-actions" aria-hidden="true">
          <span className="skeleton skeleton-icon-btn" />
          <span className="skeleton skeleton-icon-btn" />
          {account === 'clerk' ? (
            <span className="user-button-slot">
              <span className="skeleton skeleton-avatar" />
            </span>
          ) : (
            <span className="skeleton skeleton-icon-btn" />
          )}
        </div>
      </div>
      <HomeSkeleton />
    </main>
  );
}

/** Clerk's sign-in form while its script loads (the sign-in page gives it to
 *  <SignIn> as its fallback): a card of the form's width and about its height,
 *  with its title, field, button and footer as placeholders, so the form
 *  arriving moves nothing above it and little below. */
export function SignInSkeleton() {
  return (
    <div className="signin-skeleton" role="status">
      <span className="visually-hidden">Loading the sign-in form</span>
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
