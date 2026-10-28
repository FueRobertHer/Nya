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
import ActivityBar, { type ActivitySegment } from './ActivityBar';
import BudgetsBar, { type BudgetsSegment } from './BudgetsBar';
import PlanBar, { type PlanSegment } from './PlanBar';
import MonthFigures from './MonthFigures';
import { CollapsibleHeader } from './Collapsible';
import { BACK_ARROW, SETTINGS_TITLES } from './Settings';
import type { SettingsView, Tab } from '@/lib/dashboard-tab';
import { SPANS } from '@/lib/cash-flow';

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

/** Home's hero while the first load is on its way: its title, then the
 *  total, its change line, the chart and the foot row as placeholders, each
 *  as tall as components/NetWorthCard.tsx draws it, on the page as it is. The dashboard shows it
 *  while it loads, and so does AppLoading, below. */
export function HomeSkeleton() {
  useInStep();
  return (
    <section className="stack net-worth-hero" aria-busy="true" aria-labelledby="net-worth-loading">
      <div>
        <h2 id="net-worth-loading" className="total-label">
          Net worth
        </h2>
        <div className="total-value" aria-hidden="true">
          <span className="skeleton home-skeleton-total" />
        </div>
        <div className="hero-line" aria-hidden="true">
          <div className="hero-delta">
            <span className="skeleton home-skeleton-delta" />
          </div>
        </div>
      </div>
      {/* The chart on its own classes (components/NetWorthChart.tsx): the
          readout with its info button, the plot edge to edge at the hero's
          height, and the row of range buttons. */}
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
        <div className="segmented compact chart-range-switch">
          <span className="home-skeleton-range">
            <span className="skeleton home-skeleton-ranges" />
          </span>
        </div>
        {/* Show as a table, one 44px line. */}
        <div className="plan-table-view">
          <div className="home-skeleton-table-line">
            <span className="skeleton home-skeleton-table" />
          </div>
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

/** What a skeleton view says to a screen reader, once: the rest is hidden. */
function Status({ label }: { label: string }) {
  return (
    <p className="visually-hidden" role="status">
      {label}
    </p>
  );
}

const nothing = () => {};

/** A list's rows while they load (`.list-rows` of `.list-row`): each row's
 *  title, the line under it and its figure as placeholders, and with `logo`
 *  the place of a transaction's logo. */
export function RowsSkeleton({ count, className = 'list-rows', logo = false }: { count: number; className?: string; logo?: boolean }) {
  return (
    <ul className={className} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i}>
          <div className={logo ? 'list-row txn-row' : 'list-row'}>
            {logo && (
              <span className="txn-logo txn-logo-fallback">
                <span className="skeleton block rows-skeleton-logo" />
              </span>
            )}
            <span className="list-row-text">
              <span className="list-row-title">
                <span className="skeleton rows-skeleton-title" />
              </span>
              <span className="list-row-sub">
                <span className="skeleton rows-skeleton-sub" />
              </span>
            </span>
            <span className="list-row-value">
              <span className="skeleton rows-skeleton-value" />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Lines of words still to come inside a card (Plan > Your path's Progress,
 *  components/PlanProgress.tsx), each a placeholder in a line of its own,
 *  with `status` said once. */
export function LinesSkeleton({ status, lines }: { status: string; lines: number }) {
  useInStep();
  return (
    <div className="stack tight" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <p key={i} aria-hidden="true">
          <span className={`skeleton ${i === lines - 1 ? 'lines-skeleton-last' : 'lines-skeleton-line'}`} />
        </p>
      ))}
      <Status label={status} />
    </div>
  );
}

/** A card of rows while they load, its title still to come: what a segment
 *  without a skeleton of its own shows (Budgets' Goals, Activity's Shared). */
function CardSkeleton({ label }: { label: string }) {
  useInStep();
  return (
    <div aria-busy="true">
      <section className="card stack" aria-hidden="true">
        <div className="card-header">
          <h3>
            <span className="skeleton rows-skeleton-title" />
          </h3>
        </div>
        <RowsSkeleton count={3} />
      </section>
      <Status label={label} />
    </div>
  );
}

/** Shared with me while what is shared is read (components/Sharing.tsx
 *  SharedWithMe), when this device's last read had something: its header,
 *  open as it opens, over a sharer's card with its rows. */
export function SharedWithMeSkeleton() {
  useInStep();
  return (
    <section aria-busy="true">
      <div inert>
        <CollapsibleHeader title="Shared with me" open onToggle={nothing} controls="shared-with-me-loading" />
      </div>
      <div id="shared-with-me-loading" className="card" aria-hidden="true">
        <div className="incoming-head">
          <span className="skeleton block avatar small" />
          <h3>
            <span className="skeleton shared-skeleton-name" />
          </h3>
          <span className="pill">Read-only</span>
        </div>
        {[0, 1].map((i) => (
          <div className="incoming-account" key={i}>
            <div className="peer-row">
              <span>
                <span className="skeleton rows-skeleton-title" />
              </span>
              <span className="incoming-account-value">
                <span className="skeleton rows-skeleton-value" />
              </span>
            </div>
          </div>
        ))}
      </div>
      <Status label="Loading what is shared with you" />
    </section>
  );
}

/** The Accounts tab while the accounts are on their way: its bar with Add
 *  account (unavailable until they are in), the totals by kind as a strip of
 *  two, and two institution cards (components/InstitutionCard.tsx) with
 *  their rows. Two kinds (cash and credit) is the common case, one row on a
 *  phone; with three or more a second row of figures still comes in when the
 *  accounts do, and with one kind, or none, the strip goes. */
export function AccountsSkeleton() {
  useInStep();
  return (
    <div aria-busy="true">
      <div className="accounts-bar" inert>
        <span className="btn secondary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add account
        </span>
      </div>
      <div className="card stack" aria-hidden="true">
        <ul className="stat-strip">
          {[0, 1].map((i) => (
            <li key={i} className="stat">
              <span className="stat-label">
                <span className="skeleton accounts-skeleton-label" />
              </span>
              <span className="stat-value">
                <span className="skeleton accounts-skeleton-figure" />
              </span>
            </li>
          ))}
        </ul>
      </div>
      {[3, 2].map((rows, i) => (
        <section key={i} className="card stack" aria-hidden="true">
          <div className="card-header">
            <h2>
              <span className="skeleton accounts-skeleton-name" />
            </h2>
            <span className="money">
              <span className="skeleton accounts-skeleton-total" />
            </span>
          </div>
          <RowsSkeleton count={rows} />
        </section>
      ))}
      <Status label="Loading" />
    </div>
  );
}

/** Activity's list while the transactions load, under its bar
 *  (components/MonthBreakdown.tsx), in the order the segment draws it. On
 *  Transactions: the In, Out and Net strip (components/MonthFigures.tsx,
 *  itself, its figures still to come) with the line under it, then the
 *  list's card with its search field and rows. On Spending: the period's
 *  switch (on its first length, the bar's month alone, so the strip names
 *  no span), the same strip, and the Cash flow card with its chart. Known
 *  words and controls show as themselves, unavailable. */
export function ActivityListSkeleton({ segment }: { segment: ActivitySegment }) {
  useInStep();
  const spending = segment === 'spending';
  // The strip hides itself from a screen reader with no figures: the one
  // status below says it is loading.
  const summary = (
    <MonthFigures totals={null} title="In and out">
      <div className="chart-note">
        <span className="skeleton activity-skeleton-note" />
      </div>
    </MonthFigures>
  );
  return (
    <div aria-busy="true">
      {spending ? (
        <>
          {/* The period's switch as MonthBreakdown draws it (Segmented), on
              its first length, as plain markup under inert: nothing to
              press yet, and nothing dimmed, so it doesn't change look when
              the real one arrives. */}
          <div className="segmented spending-period" inert>
            {SPANS.map((s, i) => (
              <button key={s.key} type="button" role="radio" aria-checked={i === 0} tabIndex={-1}>
                {s.short}
              </button>
            ))}
          </div>
          {summary}
          <div className="card" aria-hidden="true">
            <div className="inst-header">
              <div className="inst-name">Cash flow</div>
              <div className="inst-total">
                <span className="skeleton activity-skeleton-caption" />
              </div>
            </div>
            <span className="skeleton block activity-skeleton-chart" />
          </div>
        </>
      ) : (
        <>
          {summary}
          <div className="card" inert>
            <div className="card-header">
              <h2>Transactions</h2>
              <span className="meta">
                <span className="skeleton rows-skeleton-value" />
              </span>
            </div>
            <input className="text-input search-input" type="search" placeholder="Search transactions" readOnly />
            <RowsSkeleton count={6} className="list-rows txn-list" logo />
          </div>
        </>
      )}
      <Status label="Loading transactions" />
    </div>
  );
}

/** The Activity tab while the dashboard loads: its bar (unavailable until
 *  then, the month still to come) over the list's skeleton. */
export function ActivitySkeleton({ segment = 'transactions' }: { segment?: ActivitySegment }) {
  return (
    <>
      <div inert>
        <ActivityBar month={null} monthPending={segment !== 'shared'} segment={segment} onSegment={nothing} menu={[]} />
      </div>
      {segment === 'shared' ? <CardSkeleton label="Loading" /> : <ActivityListSkeleton segment={segment} />}
    </>
  );
}

/** Budgets' Month while it loads (components/BudgetsTab.tsx): the Spent card
 *  with its figure and meter, and the budgets' rows under it. */
export function BudgetsMonthSkeleton() {
  useInStep();
  return (
    <div className="stack loose" aria-busy="true">
      <section className="card stack" aria-hidden="true">
        <div className="card-header">
          <h3>Spent</h3>
          <span className="meta money">
            <span className="skeleton budgets-skeleton-spent" />
          </span>
        </div>
        <span className="skeleton block budgets-skeleton-meter" />
      </section>
      <RowsSkeleton count={4} className="card list-rows budget-rows" />
      <Status label="Loading budgets" />
    </div>
  );
}

/** Budgets' Upcoming while it loads (components/UpcomingPanel.tsx): the Cash
 *  forecast card with its chart, and the rows of what is coming. */
export function UpcomingSkeleton() {
  useInStep();
  return (
    <div className="stack loose" aria-busy="true">
      <section className="card stack" aria-hidden="true">
        <div className="card-header">
          <h3>Cash forecast</h3>
          <span className="badge">Estimate</span>
        </div>
        <span className="skeleton block upcoming-skeleton-chart" />
        {/* The chart's Show as a table, its known words in its 44px line,
            under inert: nothing to open yet. */}
        <details className="plan-table-view" inert>
          <summary>Show as a table</summary>
        </details>
      </section>
      <RowsSkeleton count={4} className="card list-rows" />
      <Status label="Loading what is coming" />
    </div>
  );
}

/** The Budgets tab while the dashboard loads: its bar (unavailable until
 *  then, the month still to come) over the segment's skeleton. */
export function BudgetsSkeleton({ segment = 'month' }: { segment?: BudgetsSegment }) {
  return (
    <>
      <div inert>
        <BudgetsBar segment={segment} onSegment={nothing} month={null} />
      </div>
      {segment === 'month' ? <BudgetsMonthSkeleton /> : segment === 'upcoming' ? <UpcomingSkeleton /> : <CardSkeleton label="Loading goals" />}
    </>
  );
}

/** A Plan segment while the saved plan loads (components/PlanTab.tsx): a
 *  card with its title, its chart and its figures' rows still to come. */
export function PlanPanelSkeleton() {
  useInStep();
  return (
    <div aria-busy="true">
      <section className="card stack" aria-hidden="true">
        <div className="card-header">
          <h3>
            <span className="skeleton rows-skeleton-title" />
          </h3>
        </div>
        <span className="skeleton block plan-skeleton-chart" />
        <RowsSkeleton count={3} />
      </section>
      <Status label="Loading your plan" />
    </div>
  );
}

/** The Plan tab before its code is in (components/PlanTabLoader.tsx) or while
 *  the dashboard loads: its bar, unavailable until then, over a segment's
 *  skeleton. */
export function PlanSkeleton({ segment = 'path' }: { segment?: PlanSegment }) {
  return (
    <>
      <div inert>
        <PlanBar segment={segment} onSegment={nothing} scenario={null} scenariosCount={null} onScenarios={nothing} onBack={nothing} />
      </div>
      <PlanPanelSkeleton />
    </>
  );
}

/** Settings while the dashboard's first load is on its way, when the address
 *  has it open (a reload there, lib/dashboard-tab.ts): its bar with the title
 *  it will have, then its list's rows, or a section's first card, still to
 *  come (components/Settings.tsx). `sharing`: whether its list has Sharing,
 *  which it has only with Clerk, so the rows are as many as it will draw. */
export function SettingsSkeleton({ view, sharing = true }: { view: SettingsView; sharing?: boolean }) {
  useInStep();
  return (
    <section className="settings" aria-busy="true" aria-labelledby="settings-loading-title">
      <div className="settings-bar" inert>
        <button className="icon-btn" aria-label={view === 'list' ? 'Close Settings' : 'Back to Settings'}>
          {BACK_ARROW}
        </button>
        <h2 id="settings-loading-title">{view === 'list' ? 'Settings' : SETTINGS_TITLES[view]}</h2>
      </div>
      {view === 'list' ? (
        <RowsSkeleton count={Object.keys(SETTINGS_TITLES).length - (sharing ? 0 : 1)} className="card list-rows" />
      ) : (
        <section className="card stack" aria-hidden="true">
          <div className="card-header">
            <h3>
              <span className="skeleton rows-skeleton-title" />
            </h3>
          </div>
          <RowsSkeleton count={3} />
        </section>
      )}
      <Status label="Loading" />
    </section>
  );
}

/** The open tab while the dashboard's first load is on its way, on the
 *  segment it will open on. */
export function TabSkeleton({
  tab,
  segments = {},
}: {
  tab: Tab;
  segments?: { activity?: ActivitySegment; budgets?: BudgetsSegment; plan?: PlanSegment };
}) {
  switch (tab) {
    case 'accounts':
      return <AccountsSkeleton />;
    case 'activity':
      return <ActivitySkeleton segment={segments.activity} />;
    case 'budgets':
      return <BudgetsSkeleton segment={segments.budgets} />;
    case 'plan':
      return <PlanSkeleton segment={segments.plan} />;
    default:
      return <HomeSkeleton />;
  }
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
 *  Settings gear of password mode does nothing until the dashboard is in.
 *  With Settings in the address, Settings' loading view in place of the tab's. */
export function AppLoading({ account, tab = 'home', settings = null }: { account: 'clerk' | 'password'; tab?: Tab; settings?: SettingsView | null }) {
  return (
    <main className="wrap">
      <div className="top-row">
        <Brand />
        <div className="top-actions">
          <HideAmountsToggle />
          <button className="icon-btn" disabled aria-label="Refresh" title="Refresh">
            <HeaderIcon d={REFRESH} spin />
          </button>
          {account === 'clerk' ? (
            <div className="user-button-slot">
              <span className="skeleton user-button-skeleton" aria-hidden="true" />
            </div>
          ) : (
            <button className="icon-btn" aria-disabled="true" aria-label="Settings" title="Settings">
              <HeaderIcon d={GEAR} />
            </button>
          )}
        </div>
      </div>
      {settings ? <SettingsSkeleton view={settings} sharing={account === 'clerk'} /> : <TabSkeleton tab={tab} />}
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
