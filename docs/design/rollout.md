# Rollout

The order in which to build the reorganization, as pull requests that each ship on their own and leave the app working. Phases 1 (`components/Settings.tsx`), 2 (the tokens and primitives in `app/globals.css`), 3 (Accounts, in three pull requests) and 4a (Home's Net worth card) are built; the rest is not started. Effort is rough, in focused days for one person.

The order puts the stated pain first. Accounts' Manage mode is what makes the app feel like a mess, so it goes before the token work, which is invisible on its own.

| Phase | What ships | Effort |
|---|---|---|
| 1 | Settings screen; Manage removed | 3 to 4 days |
| 2 | Tokens and primitives (dark only) | 3 to 4 days |
| 3a | Accounts: add sheet, account sheet, collapsible sections | 2 to 3 days |
| 3b | Accounts: each connection's status on its card, institution menu, Connection details | 2 to 3 days |
| 3c | Accounts: status pill and type summary | 1 day |
| 4a | Home: the Net worth card, timeline notes as a sheet | 1 to 2 days |
| 4b | Home: Needs attention | 1 to 2 days |
| 4c | Home: This month | 1 day |
| 5 | Activity: segments, transaction sheet | 3 to 4 days |
| 6 | Budgets and Plan segments | 3 to 4 days |
| 7 | Light theme and the theme setting | 1 to 2 days |

## Phase 1: Settings screen, Manage removed

- Add the Settings screen and its six sections ([information-architecture.md](information-architecture.md#settings)); move the 13 Manage cards, AccountLinks and AdminUnusedItems into them as they are (no restyling yet). Preferences holds currency and the weekly summary; its theme row arrives in phase 7. Reports already has a home on Activity, so it simply leaves Manage.
- Avatar menu: Settings first. Password mode: a gear instead of "Log out" and "Sign out everywhere" in the header.
- Hide, Close... and Delete move into the account's existing expanded area (its own table row, so no button sits inside the clickable row); phase 3 replaces this with the account sheet.
- "Add or remove accounts" and Disconnect move to an institution "Options" button that opens an action list in the existing `Sheet.tsx` (the menu popover comes in phase 3).
- All-hidden institutions listed in Settings > Connections with Disconnect.
- Rewire `openCurrency`, `openRestore`, `#bring-back`; update the Hidden card's wording. `?view=connections` keeps working unchanged, since Connection health stays on Accounts until phase 3.
- The Payoff plan button stays on Accounts until phase 6.
- Delete `manageMode`.

**Decided:** an in-app view (keeps the dashboard's loaded data, no URL), chosen over a `/settings` route (real URLs and back button, remounts the dashboard and refetches). A route can follow. With Clerk on, Settings > Account has Sign out and points to the account menu for the profile and Delete my account; embedding Clerk's profile there is left for later.

**Also done in phase 1:** every message, email, page and doc that sent people "under Manage" now names the Settings section or the account's Options instead.

**Risks:** an action that was only reachable under Manage becomes unreachable (check every element gated on `manageMode` has a new home; the list is in the IA doc); RestoreCard must stay mounted with its id for `#bring-back`; admin-only items must stay admin-only (they are decided on the server in `app/page.tsx`).

## Phase 2: Tokens and primitives

- Move [tokens.css](tokens.css) into `app/globals.css` with the aliases, so existing rules keep working; one source for the palette shared with Clerk and `themeColor` in `app/layout.tsx`.
- Add the primitives: `.card-header` with headings, `.list-row`, `.btn` variants with auto width and `.btn-row`, `.segmented`, `.badge` and `.chip`, `.notice`, helper text and the "Why?" disclosure, the menu popover, sheet sticky footer.
- Global: focus ring, reduced motion, nothing under 12px, tabular money.
- Migrate the shell and Settings to the primitives; delete replaced classes as each last user goes.
- Optional, once stable: split `globals.css` into layers (tokens, base, primitives, features, print).

**Built:** the scales and the dark theme at the top of `app/globals.css`, with the aliases; `lib/theme.ts` for Clerk and `themeColor`; the guard test holds it, the web manifest and the app's copy of the tokens to `tokens.css`, and checks contrast on the app's own dark tokens. The app's bare buttons fill with `--accent-fill` and danger with `--danger-fill`, so their white labels pass AA. Clerk's own primary button keeps `--accent` (white on it is 3.23:1), since Clerk uses one color for its buttons and its links and `--accent-fill` as link text would fail (3.43:1); that waits for Clerk's own styling to be split, or a darker label. One `:focus-visible` ring in `--focus` and one reduced-motion rule for everything. The primitives as CSS: `.money`, `.card-header`, `.list-rows` and `.list-row`, `.btn` (secondary, ghost, danger, block) and `.btn-row`, `.segmented`, `.badge`, `.chip`, `.notice` (critical, caution, info, done), `.helper`. The header's icon buttons are 44px with 20px icons; the tab bar is on `--glass` with 12px labels; the Settings list is `.list-rows` of `.list-row`, and the `.settings-row` and `.settings-list` classes are gone.

**Kept narrow, and where each piece went:**

- `button { width: 100% }` stays. `.btn` sets its own width, so nothing changes for a button until it takes the class; the global rule flips once no bare `<button>` relies on it, with the `.btn-block` audit then.
- The other 37 declarations under 12px (calendar figures, chart ticks, the plan grid, Sankey labels, tags) move to `--fs-1` with their screen's phase, where each can be checked at 320px: charts in 4 and 5, the calendar and the plan grid in 6. The guard baseline holds them meanwhile. (35 after phase 3a, which deleted two with the expanded account row.)
- The menu popover, the "Why?" disclosure and the sheet's footer arrive in phase 3 with their first users (the account sheet's ⋯, the coverage disclosure, the account sheet), not as unused code. Built in 3a.
- The cards inside the Settings sections keep their classes; each moves to the primitives when it is next changed.
- The 27 `tabular-nums` declarations in feature rules stay until their rules move to `.money`.
- The tag colors stay as they are until phase 7 gives them light values.

**Risks:** the global `button { width: 100% }` change touches every button; land it with the `.btn-block` audit in the same PR. Print reports and hide amounts (`data-amounts="hidden"`) must be checked on every changed component. Check widths 320, 375, 390 and 1280px.

## Phase 3: Accounts

Split in two pull requests, so each leaves the app working and the one that moves the honesty notices can be reviewed on its own.

**3a**, everything that doesn't move a connection's notices:

- Add account sheet (connect options, manual, switching, coverage disclosure).
- Account sheet replacing the inline expansion and the row buttons (fixes buttons inside a clickable `<tr>`).
- Hidden, Accounts that ended and Shared with me as collapsible sections.
- The Payoff plan button stays (as a row under the + Add account bar, under the type summary, which 3c added) until phase 6 moves it.

**3b**, the connection's status and actions:

- Institution cards on the new primitives; ConnectorCards folded into the institution ⋯ menu; Connection details.
- Rewire `?view=connections` to focus the first affected card (or Settings > Connections when it has no card), since Connection health stops being a card here.

**3c**, what the tab says of all of them:

- Status pill and type summary line.

**Risks:** the honesty notices (stale balances, missing rows, unconfirmed missing, too old) must keep their wording and their red or amber; diff the rendered text before and after for each state. SimpleFIN and Lunch Flow flows (Answer, Choose accounts, undo carrying) must keep working from the menu.

**Built in 3a:** the institution card moved to `components/InstitutionCard.tsx`, and `test/institution-card-view.test.tsx` pinned the words and color of every notice on it before anything was restyled; its rows are `.list-row` buttons that open `components/AccountSheet.tsx`, with provenance as badges (a held balance's words unchanged, now amber, as design-system.md makes it a caution; Overdue red, as before). `components/AddAccountSheet.tsx` behind "+ Add account" replaced the connect block at the top of the tab (the empty state keeps its own). The primitives phase 2 left for their first users: `Menu` (the account sheet's ⋯), `Why` (Which should I use?), `Sheet`'s `footer`, and 44px sheet buttons. `CollapsibleHeader` for the three sections at the foot. Shared with me starts open, since what is shared is read only once it is on screen and each read counts as a showing in the sharer's record.

**Decided in 3a:** an action in the account sheet closes it and opens that action's own sheet (the lifecycle sheet, Update, Add transaction, Import a file, Import history, Delete), as the dashboard already does elsewhere, instead of a second level with a back button inside the account sheet. Those sheets are separate components with their own state, and making each a level of the account sheet is a refactor beyond this phase. Focus goes back to the account's row when the second sheet closes.

**Built in 3b:** each institution card carries its connection's status under its subtotal (`components/ConnectionStatus.tsx`): its own line, Plaid's or the connector's explanation, what it does to the total, when it last synced and whose side, the account questions, and each button that fixes it once. The Connection health card and the SimpleFIN and Lunch Flow cards are gone from the tab; `test/connection-words.test.tsx` holds the cards to every sentence those three showed, recorded from main for every Plaid cause and connector issue (`test/connection-words-before-3b.json`). An institution ⋯ (Connection details, Add or remove accounts, Enable payment details, Refresh and Choose accounts for a connector, Disconnect… last) replaced the Options sheet; Allow transactions stays a button on the card, beside the line that explains it, so the gap and its fix are seen together. Settings > Connections lists every connection with no card on Accounts, with its status and ⋯, and the tab says when one of them needs attention. `?view=connections` waits for the accounts from the server, then focuses the first card that needs attention, worst first. `useConnectors` reads the connections once for the whole dashboard.

**Decided in 3b:** one color for a connection's problems, from two questions (`lib/accounts-status.ts`): red when it is broken in a way only the person can fix, or the total is missing an account's money; amber for anything else that is off. The card and the Connection health card used to color the same problem differently, in both directions (a Plaid outage with nothing recovered red on the card and amber in health; a connection that must be removed amber on the card when its balances were recovered, red in health; a SimpleFIN card amber whenever a balance existed). The rule keeps the worse of the two in the common cases and settles four on purpose: a new SimpleFIN or Lunch Flow connection waiting for its first answer, and a problem only Nya can fix while balances are shown, are amber; a card or loan waiting for its sign, and an account held with no balance, are red.

**Built in 3c:** a status pill in the tab's header row (`components/AccountsStatus.tsx`) and a line by type under it (`components/AccountsSummary.tsx`, grouping in `components/account-groups.ts`). The pill counts connections, each in its card's color from `lib/accounts-status.ts` (a SimpleFIN or Lunch Flow connection's cards once, at the worst; the connections in Settings > Connections too), and jumps through the same `goToFirstToFix` as `?view=connections`. Its red and amber are `.chip` tones (`neg`, `warn`), edged and with a chevron so they read as controls. The line sums the accounts on the cards below, through `signedBalance`, converting mixed currencies as the cards do, and is shown when they fall in two or more kinds.

**Decided in 3c:**

- **The pill's words.** Red is "1 problem", not "1 needs you": a total missing money during an outage is red with nothing for the person to do. Amber is "2 to check", not "1 couldn't refresh": caution also covers an open account question, a connection ending soon, a record that couldn't be read and a new connection waiting for its first answer. With both, red shows its count and the amber count is in its label for screen readers; the click lands worst first.
- **Only from this load.** The pill shows nothing while the accounts are this device's snapshot, after a load that failed, or before the connector list is read; "All synced" also waits for Plaid's warnings to be readable and for at least one connection that syncs. A count from old data could be wrong, and the tab's notices already say what wasn't read.
- **The line says what it can't count, from the accounts themselves, in its card's color.** A kind is marked Incomplete only when an account of that kind is missing from it (held with no balance, a connector account with none on a card that is red, an account a broken card can't show, or a currency with no rate); a kind with nothing to add shows "--", not $0.00. A new SimpleFIN or Lunch Flow connection waiting for its first answer is amber here as on its card: its accounts were never in the total. When the kind is unknown (a count with no names, or a held account Nya never knew the kind of), no kind is marked, since it could be a debt anywhere: the red notice under the line names the institutions and says any total may be short. Figures that are last known, or a bank that stopped sending an account, get one amber line naming the institutions. The words of each card's notice are unchanged.

## Phase 4: Home

Split in three pull requests, as phase 3 was: **4a** the Net worth card (its first bullet and the notes sheet), **4b** Needs attention (the action insights, CurrencyOffer and the admin's instructions move into it), **4c** This month (Insights' passive half and one FI line).

- One Net worth card (hero, caveat line, chart, Notes button, History paused badge).
- Needs attention (the items in the IA doc), each linking to its fix; the backup instruction only for the admin. Until phases 5 and 6 land, an item whose home is a segment (Activity > Transactions, Budgets > Month) opens that tab as it is.
- This month (passive insights, one FI line).
- Timeline notes as a sheet.

**Risks:** the caveat summary must state count and kind in words and take the worst severity's color; check with several institutions failing at once.

**Built in 4a:** `components/NetWorthCard.tsx` is Home's one card, where the hero, the Over time card and the notes card were. Under the total, `components/TotalCaveats.tsx` draws what qualifies it: each critical caveat in full, the lesser ones in full when there is one and gathered into one line when there are more (`.notice-summary`). The total's notes come with their color from `totalCaveats` (`components/total-notes.ts`; `totalNotes` keeps their words for the tests), the accrued interest from `accruedCaveats`, the currency from `heroCurrencyCaveats`. Under the chart: history paused and notes that couldn't be read. Then the nightly backup and receipt clean-up, the fact to everyone and the instruction only to the admin. A foot row: Updated, a History paused badge, and Chart notes (N), which opens `TimelineNotesSheet` (the list, then a note's form and the question before deleting one as a second level with a back button).

**Decided in 4a:**

- **Color from the data, as the cards.** A note naming institutions takes the worst of their cards' colors (`lib/accounts-status.ts` severityOf), so a SimpleFIN connection that needs paying is red on Home as on its card, and a new connection waiting for its first answer is amber in both. A note that says the total is short is red whatever: accounts that couldn't be shown, accounts held with no balance, a bank brought back from a download that isn't connected, an account in a currency with no rate. Today all were amber or neutral; none is lowered. Accounts in several currencies with none chosen is raised from neutral to amber: the total adds them as they are, which the person settles by choosing a home currency, and the offer to choose one sits under the card. Not red: no account is missing from it, and every figure on the Accounts tab is right in its own currency. Accrued interest left out stays neutral, as it was.
- **Three groups, not one.** Only what qualifies the total is gathered under it; what qualifies the chart sits under the chart, and the nightly jobs at the card's foot, so a backup failure never pads the total's summary.
- **The admin's instructions now, not in 4b.** Moving the backup and clean-up notes onto the hero card made their "Check the cron in Vercel" louder for people who can't act on it, so the instruction shows only with `admin`, inline, until 4b moves it to Needs attention.
- **Chart notes, not Notes.** The summary line says "3 notes: ...", so the timeline's button is "Chart notes (N)", one word for one thing. "Remove this note" is now Delete, asked before it is done.
- **The foot row, not the chart's header**, as the mockup draws it: the readout row already holds the info button and six ranges fill the width at 320px.

**Kept narrow in 4a:** the chart itself. Its axis text (`.chart-tick`, `.chart-xlabel`) is SVG text in a scaled viewBox, and the classes are shared by seven charts; its range buttons (`.chart-range`) by five other components and a seven-option set. Both move to `--fs-1` and `.segmented` together in their own chart pass, checked chart by chart, with Activity's charts in phase 5.

## Phase 5: Activity

- Pinned month bar and the three segments.
- One In / Out / Net strip on Transactions; filter chips.
- Spending segment with one period control (keeping the cash flow chart's ranges).
- Transaction sheet replacing the inline editor; rule offer inside it.
- Shared segment.

**Risks:** Card Mode and keyboard review must keep working; a cash-flow selection must still filter the list; split and group rows still show under their transaction.

## Phase 6: Budgets and Plan

- Budgets: Month, Upcoming (forecast, calendar or list, recurring, planned), Goals; add budget and irregular income in sheets; one completeness notice per segment.
- Debt payoff moves from Accounts to Budgets > Goals in the same PR, so it is never without a home.
- Plan: scenario bar and Scenarios sheet with Compare; FI and timeline, Stress test, Portfolio; "Why?" on each input; currency as a badge.

**Risks:** the plan's saved inputs and scenarios are unchanged (layout only); the forecast's threshold and what-if keep their behavior.

## Phase 7: Light theme

- Turn on the light token block and the theme setting in Settings > Preferences.
- Charts, tag colors, the Sankey and print checked in light.
- Rerun the contrast check on the final tokens.

## The contrast check

`test/design-guard.test.ts` checks the pairings in both themes (text on every surface at 4.5:1, each meaning color on its tint, white on both button fills, field borders on every surface and the focus ring at 3:1): dark from `app/globals.css`, light from `tokens.css` until phase 7 moves it into the app. It also fails if the light theme's two copies (system setting and explicit choice) drift apart, or if the app's dark theme, `tokens.css`, `lib/theme.ts` and the web manifest disagree. It runs with the tests.

## Done means

Each phase: typecheck and tests pass; no element gated on removed state is left unreachable; the honesty notices render with the same words and severity as before; 44px targets and the focus ring on everything new; checked at phone and desktop widths, in hide amounts, and in print where it applies.
