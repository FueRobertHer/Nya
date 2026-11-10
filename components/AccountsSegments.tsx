'use client';

// The Accounts tab's two views, under its own row (components/Dashboard.tsx,
// docs/design/information-architecture.md#accounts): Accounts, everything the
// tab held before them, and Investments, what the investment accounts did
// together (components/InvestmentGrowth.tsx). A tablist whose tabs each control their
// own panel. The tab opens on Accounts and comes back on the last view chosen
// while the app is open, as Budgets' segments do; Home's links into the tab,
// its status pill and a notice email's link go to Accounts, where what they
// focus is. Not pinned, as Activity's and Budgets' bars are: the tab has no
// heading of its own to keep in view.

import { Segmented } from './Segmented';

export type AccountsSegment = 'accounts' | 'investments';

const OPTIONS = [
  ['accounts', 'Accounts'],
  ['investments', 'Investments'],
] as const;

/** The id of a view's tab, which its panel is labelled by. */
export const accountsTabId = (s: AccountsSegment) => `accounts-tab-${s}`;
/** The id of a view's panel. Each keeps its own, mounted once shown, so a
 *  switch loses nothing open in the other. */
export const accountsPanelId = (s: AccountsSegment) => `accounts-panel-${s}`;

export default function AccountsSegments({
  segment,
  onSegment,
}: {
  segment: AccountsSegment;
  onSegment: (s: AccountsSegment) => void;
}) {
  return (
    <Segmented
      className="accounts-segments"
      label="Accounts views"
      options={OPTIONS}
      value={segment}
      onChange={onSegment}
      tabs={{ id: accountsTabId, panel: accountsPanelId }}
    />
  );
}
