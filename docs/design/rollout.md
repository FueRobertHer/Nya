# Rollout

The order in which to build the reorganization, as pull requests that each ship on their own and leave the app working. Phases 1 (`components/Settings.tsx`) and 2 (the tokens and primitives in `app/globals.css`) are built; the rest is not started. Effort is rough, in focused days for one person.

The order puts the stated pain first. Accounts' Manage mode is what makes the app feel like a mess, so it goes before the token work, which is invisible on its own.

| Phase | What ships | Effort |
|---|---|---|
| 1 | Settings screen; Manage removed | 3 to 4 days |
| 2 | Tokens and primitives (dark only) | 3 to 4 days |
| 3 | Accounts: add sheet, institution menu, account sheet | 4 to 5 days |
| 4 | Home: net worth card, needs attention, this month | 2 to 3 days |
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
- The other 37 declarations under 12px (calendar figures, chart ticks, the plan grid, Sankey labels, tags) move to `--fs-1` with their screen's phase, where each can be checked at 320px: charts in 4 and 5, the calendar and the plan grid in 6. The guard baseline holds them meanwhile.
- The menu popover, the "Why?" disclosure and the sheet's sticky footer arrive in phase 3 with their first users (the institution ⋯ menu, the coverage disclosure, the account sheet), not as unused code.
- The cards inside the Settings sections keep their classes; each moves to the primitives when it is next changed.
- The 27 `tabular-nums` declarations in feature rules stay until their rules move to `.money`.
- The tag colors stay as they are until phase 7 gives them light values.

**Risks:** the global `button { width: 100% }` change touches every button; land it with the `.btn-block` audit in the same PR. Print reports and hide amounts (`data-amounts="hidden"`) must be checked on every changed component. Check widths 320, 375, 390 and 1280px.

## Phase 3: Accounts

- Add account sheet (connect options, manual, switching, coverage disclosure).
- Status pill and type summary line.
- Institution cards on the new primitives; ConnectorCards folded into the institution ⋯ menu; Connection details.
- Account sheet replacing the inline expansion and the row buttons (fixes buttons inside a clickable `<tr>`).
- Hidden, Accounts that ended and Shared with me as collapsible sections.
- Rewire `?view=connections` to focus the first affected card (or Settings > Connections when it has no card), since Connection health stops being a card here.
- The Payoff plan button stays (as a row under the type summary) until phase 6 moves it.

**Risks:** the honesty notices (stale balances, missing rows, unconfirmed missing, too old) must keep their wording and their red or amber; diff the rendered text before and after for each state. SimpleFIN and Lunch Flow flows (Answer, Choose accounts, undo carrying) must keep working from the menu.

## Phase 4: Home

- One Net worth card (hero, caveat line, chart, Notes button, History paused badge).
- Needs attention (the items in the IA doc), each linking to its fix; the backup instruction only for the admin. Until phases 5 and 6 land, an item whose home is a segment (Activity > Transactions, Budgets > Month) opens that tab as it is.
- This month (passive insights, one FI line).
- Timeline notes as a sheet.

**Risks:** the caveat summary must state count and kind in words and take the worst severity's color; check with several institutions failing at once.

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
