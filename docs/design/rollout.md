# Rollout

The order in which to build the reorganization, as pull requests that each ship on their own and leave the app working. Phases 1 (`components/Settings.tsx`), 2 (the tokens and primitives in `app/globals.css`), 3 (Accounts, in three pull requests), 4 (Home, in four), 5a (Activity's bar and segments), 5b (its filter chips), 5c (Spending's one period), 5d (its charts' text), 5e (the Transaction sheet), 6a1 (Budgets' bar and segments), 6a2 (Budgets' sheets and notices), 6a3 (Budgets' Upcoming), 6a4 (Budgets' charts and the calendar's figures), 6b (the Plan's scenario bar and segments), 6c (the Plan's inputs as rows) and 6d (the Plan's assumptions, labels, words and charts) are built; the rest is not started. Effort is rough, in focused days for one person.

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
| 4d | Home: reconnected accounts to link, in Needs attention | 1 day |
| 5a | Activity: pinned month bar, the three segments, the analysis moved to Spending | 1 to 2 days |
| 5b | Activity: filter chips, the review count as a heading | 1 day |
| 5c | Activity: one period on Spending | 1 to 2 days |
| 5d | Activity: its charts drawn at their width, their text at 12px | 1 day |
| 5e | Activity: the Transaction sheet, rule offer inside it; the rows redrawn as list rows | 1 to 2 days |
| 6a1 | Budgets: Month, Upcoming and Goals segments under a pinned bar; debt payoff moved in | 1 day |
| 6a2 | Budgets: add and edit a budget, and irregular income, in sheets; one completeness notice per segment | 1 to 2 days |
| 6a3 | Budgets: Upcoming as one dated list or a calendar, with one completeness notice; the threshold in a sheet | 2 days |
| 6a4 | Budgets: the forecast's and the payoff plan's charts at their width, the calendar's figures at 12px | 1 day |
| 6b | Plan: Your path, Stress test and Portfolio segments; the scenario bar | 1 day |
| 6c | Plan: the inputs as rows, their caveats on one line each | 1 to 2 days |
| 6d | Plan: one assumptions sheet, a label on each result, plain words, its charts drawn at their width | 1 to 2 days |
| 8a | Plan: the path, year by year, as a pure function | 1 day |
| 8b | Plan: the headline against the stop age, the path chart, Home's FI line | 2 days |
| 8c | Plan: the What if… card | 2 days |
| 8d | Plan: new life event kinds | 2 to 3 days |
| 8e | Plan: progress against your plan | 3 to 4 days |
| 7 | Light theme and the theme setting | 1 to 2 days |

Phase 8, the Plan track, comes before phase 7: the Plan tab was the screen people found most confusing (decided 2026-10-25).

## Phase 1: Settings screen, Manage removed

- Add the Settings screen and its six sections ([information-architecture.md](information-architecture.md#settings)); move the 13 Manage cards, AccountLinks and AdminUnusedItems into them as they are (no restyling yet). Preferences holds currency and the weekly summary; its theme row arrives in phase 7. Reports already has a home on Activity, so it simply leaves Manage.
- Avatar menu: Settings first. Password mode: a gear instead of "Log out" and "Sign out everywhere" in the header.
- Hide, Close... and Delete move into the account's existing expanded area (its own table row, so no button sits inside the clickable row); phase 3 replaces this with the account sheet.
- "Add or remove accounts" and Disconnect move to an institution "Options" button that opens an action list in the existing `Sheet.tsx` (the menu popover comes in phase 3).
- All-hidden institutions listed in Settings > Connections with Disconnect.
- Rewire `openCurrency`, `openRestore`, `#bring-back`; update the Hidden card's wording. `?view=connections` keeps working unchanged, since Connection health stays on Accounts until phase 3.
- The Payoff plan button stays on Accounts until phase 6.
- Delete `manageMode`.

**Decided:** an in-app view (keeps the dashboard's loaded data, no URL), chosen over a `/settings` route (real URLs and back button, remounts the dashboard and refetches). A route can follow. With Clerk on, Settings > Account points to the account menu for the profile, Delete my account and Sign out (it had a Sign out of its own at first, which repeated the menu's and was taken out); embedding Clerk's profile there is left for later.

**Also done in phase 1:** every message, email, page and doc that sent people "under Manage" now names the Settings section or the account's Options instead.

**Risks:** an action that was only reachable under Manage becomes unreachable (check every element gated on `manageMode` has a new home; the list is in the IA doc); RestoreCard must stay mounted with its id for `#bring-back`; admin-only items must stay admin-only (they are decided on the server in `app/page.tsx`).

## Phase 2: Tokens and primitives

- Move [tokens.css](tokens.css) into `app/globals.css` with the aliases, so existing rules keep working; one source for the palette shared with Clerk and `themeColor` in `app/layout.tsx`.
- Add the primitives: `.card-header` with headings, `.list-row`, `.btn` variants with auto width and `.btn-row`, `.segmented`, `.badge` and `.chip`, `.notice`, helper text and the "Why?" disclosure, the menu popover, sheet sticky footer.
- Global: focus ring, reduced motion, nothing under 12px, tabular money.
- Migrate the shell and Settings to the primitives; delete replaced classes as each last user goes.
- Optional, once stable: split `globals.css` into layers (tokens, base, primitives, features, print).

**Built:** the scales and the dark theme at the top of `app/globals.css`, with the aliases; `lib/theme.ts` for Clerk and `themeColor`; the guard test holds it, the web manifest and the app's copy of the tokens to `tokens.css`, and checks contrast on the app's own dark tokens. The app's bare buttons fill with `--accent-fill` and danger with `--danger-fill`, so their white labels pass AA. Clerk's own primary button keeps `--accent` (white on it is 3.23:1), since Clerk uses one color for its buttons and its links and `--accent-fill` as link text would fail (3.43:1); since the look and feel's step 1 its primary button alone takes `--accent-fill` through `elements.formButtonPrimary` (below). One `:focus-visible` ring in `--focus` and one reduced-motion rule for everything. The primitives as CSS: `.money`, `.card-header`, `.list-rows` and `.list-row`, `.btn` (secondary, ghost, danger, block) and `.btn-row`, `.segmented`, `.badge`, `.chip`, `.notice` (critical, caution, info, done), `.helper`. The header's icon buttons are 44px with 20px icons; the tab bar is on `--glass` with 12px labels; the Settings list is `.list-rows` of `.list-row`, and the `.settings-row` and `.settings-list` classes are gone.

**Kept narrow, and where each piece went:**

- `button { width: 100% }` stays. `.btn` sets its own width, so nothing changes for a button until it takes the class; the global rule flips once no bare `<button>` relies on it, with the `.btn-block` audit then.
- The other 37 declarations under 12px (calendar figures, chart ticks, the plan grid, Sankey labels, tags) move to `--fs-1` with their screen's phase, where each can be checked at 320px: charts in 4 and 5, the calendar and the plan grid in 6. The guard baseline holds them meanwhile. (35 after phase 3a, which deleted two with the expanded account row.)
- The menu popover, the "Why?" disclosure and the sheet's footer arrive in phase 3 with their first users (the account sheet's ⋯, the coverage disclosure, the account sheet), not as unused code. Built in 3a.
- The cards inside the Settings sections keep their classes; each moves to the primitives when it is next changed.
- The 27 `tabular-nums` declarations in feature rules stay until their rules move to `.money`.
- The tag colors stay as they are until phase 7 gives them light values. (Done in phase 7.)

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

Split in three pull requests, as phase 3 was: **4a** the Net worth card (its first bullet and the notes sheet), **4b** Needs attention (the action insights, CurrencyOffer and the admin's instructions move into it), **4c** This month (Insights' passive half and one FI line). The reconnected accounts to link, which 4b left out, became 4d.

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

**Built in 4b:** `components/NeedsAttention.tsx` is Home's second card, under the Net worth card, shown only when it has a row. `components/attention.ts` builds the rows from what the Accounts tab and Settings > Connections already show (the cards' colors from `connectionSeverity`, the cardless connections from `cardlessSeverity`), the review count, the payments and budgets (`paymentAlerts` and `budgetAlerts`, moved out of Insights with their words), the offer of a home currency and the restore hold; the list in the IA doc says each one's color, words and place. Rows sort worst first. A row is a `.list-row` button led by `.list-row-icon` (a shape per level, the alert for critical and the clock for caution as the mockup draws a caution, and a word for a screen reader) and goes where it is fixed: a card heading on Accounts or in Settings > Connections, the account sheet over Home, the Budgets tab's month, Activity's review count, Settings > Your data, or the offer in a sheet (`CurrencyOfferSheet`; choosing closes it and opens the sheet that confirms, never one over the other). The focus waits for its target, since the Budgets tab shows a spinner first. The admin's instructions for the nightly jobs moved off the Net worth card into an Admin card under it (`AdminAttention`), as plain rows. Insights keeps idle cash, the bills, the pace, the biggest purchase and the low balance until 4c.

**Decided in 4b:**

- **Each row in its object's color and words.** A connection's row is its card's color, one per connection; a SimpleFIN or Lunch Flow connection failing as a whole says the same on every bank's card, so it is one row. Accounts a connector stopped sending are amber, as the card, not "accounts you haven't added" (which is what a new Plaid account or a connection with none chosen is). An alert's sentence becomes a row as the alert builds it, a title and the line after its colon: "Over your Food budget" over "$320.00 of $300.00". Built apart, so a name holding a colon is never cut.
- **Over budget is amber, not red text.** Red means a number is wrong or short; an over budget is a true number the person may act on. An overdue payment stays red: it costs money until it is paid. Budgets keep Insights' worst two, with "N more budgets over or nearly over" so none is dropped silently; payments and connections ending soon lose their cap of two, since each has its own place to go.
- **The currency offer is amber while the total adds currencies unconverted**, as its caveat on the total has been since 4a, and neutral when only transactions are in several. It opens as a sheet, not Settings > Preferences, so its quick choices and Not now keep a home.
- **Rows go to the card, not to the fix.** Reconnect, Review accounts and an account's question are on its card beside the words that explain them; Home doesn't open Plaid Link itself.
- **Transactions to review lands on the count, not a filter.** The count is the year's; Activity's Needs review filter (the To review chip since 5b) lists one month, so forcing it could show "Nothing listed needs review" under a count of 12.
- **The restore banner stays on every tab, Home's too.** It says what a row can't ("what you see is only part of your data"), so an unfinished restore has no row; a bank a restore brought back that isn't connected (red) and a restore that can't be read (amber) have.
- **The spending notes go with the figures they qualify.** What the month may be missing follows the budget rows in Needs attention, and stays under the pace and biggest purchase in Insights.
- **The Admin card, as the mockup draws it**, rather than admin rows in Needs attention: its rows have nothing to tap, and rows that go somewhere and rows that don't would mix.

**Kept narrow in 4b:**

- **Reconnected accounts to link** (the IA's information row). The dashboard doesn't hold them (`components/AccountLinks.tsx` reads `/api/account-links` in Settings > Connections), and listing them would add a request to every Home load. They are phase 4d (below).
- **A low balance** stays in Insights: it has no fix and no "not now", and a small savings account would sit in the list for good. 4c decides it with the rest of Insights.
- **The focus targets that aren't headings yet:** the review count on Activity and the month title on Budgets become real headings in phases 5 and 6.

**Built in 4c:** Insights draws Home's **This month** card: a `<section class="card this-month">` with an `<h2>`, its insights as plain `div.list-row` rows (nothing to tap, no color of its own: each says what it is in words), what the month may be missing after the pace and the biggest purchase (the block 4b made, now `SpendingNotes` and `.row-notes`), and the FI line last, passed in as `fi` and still loaded after Home paints (`components/FiProgressLoader.tsx`). The FI card became that line (`FiProgressView` returns an `<li>`): a `button.list-row` that opens the Plan tab, its title years and how far ("FI in about 11.4 years · 62% there"; "You're at FI"; "FI not reached at this savings rate"; "36% of the way to FI" when years aren't worked out; the FI number when neither is; "FI isn't worked out" with why when spending isn't measured), the FI number, what is invested and the savings rate under it, and every note the card had under the row through `TotalCaveats` (4a's), in its words and level: amber where a figure may be off or isn't measured, neutral where it explains. A card with no row yet is hidden (`.this-month:not(:has(li))`). The old `.insight*` and `.fi-*` rules are gone.

**Decided in 4c:**

- **The FI line keeps the figures its notes speak of.** The FI number, what is invested and the savings rate stay, under the title, so "May be low: spending is missing ..., so the savings rate may be off too" and the rest keep their words and still point at something on screen. Nothing the card said leaves Home: the estimates and payroll notes, the excluded transactions and what was typed sit in the gathered line, which names the worst kinds first (so an amber line names what made it amber) and, with no plan saved, says the figures are from the Plan's defaults. The meter is gone; the percentage says the same.
- **No color on This month's rows.** The pace's red and green, the low balance's red and idle cash's amber are gone: amber means something needs the person and red a number that is short (design-system.md), and every row says what it is in words. The mockup draws them plain.
- **The low balance stays in This month.** It has no fix to go to and no way to set it aside, so in Needs attention a deliberately small account would sit there for good.
- **The notes go under the FI row, outside its button**, not as a badge on its line as the mockup first drew it: a `<details>` can't sit inside a button.

**From a UX review of Home, in 4c** (an independent review read Home as a person would, checked against the redesign mockups):

- **Rows lead with what to do, as the mockups draw them.** A connection the person must fix at Nya reads "Reconnect Chase" over "Balances as of Oct 21" ("Connect SimpleFIN again" for a whole connector); one with nothing to do there keeps its name and badge. A payment reads "Amex due tomorrow" over "Minimum $35.00". The Admin card reads "Nightly backup failed" over "Last saved Oct 20 · timeout · Check the backup cron in Vercel.", the fact in full staying on the Net worth card.
- **An empty Needs attention never claims too much.** When Plaid's warnings or the SimpleFIN and Lunch Flow connections couldn't be read on this load, a row says so, in the color of the Accounts tab's notice about it (amber, and red for the connections), and goes to that notice.
- **This month keeps its own figures.** Its rows are ordered pace, biggest purchase, bills, low balance, idle cash before the cap of six, and low balances are one row ("and 3 more accounts"), so small accounts kept on purpose can't push the month off the card.
- **Notices say their level.** Each notice and gathered line starts with a visually hidden "Critical:", "Caution:" or "Note:".

**Kept narrow in 4c:**

- **The FI line, as reviewed.** The review asked for "Plan defaults" on the line itself when no plan is saved, a shorter line under it ("$942,000 of $1,520,000 invested"), a row that says why when the plan can't be read, and focus after its jump. The FI part is likely to change, so these wait for that (phase 8b, which gives the line the Plan tab's new words). (Landed in 8b; focus after the jump was already built in 6b.)
- **From the same review, for later:** Needs attention can sit below the fold at 320px under the chart (a "2 things need you" jump under the delta); caution's clock fits "due soon" but not "over budget" (one caution shape for rows and notices); a low balance smaller than a bill due within the week belongs in Needs attention; the month's missing transactions said once, gathered, rather than twice; tab jumps pushed to history, so back returns to Home.

- **Focus after the FI line's jump.** The Plan tab has no heading to land on until phase 6 gives it one; the line scrolls to its top, as it did.
- **The month's missing transactions said twice on Home** when a budget row and the pace are both shown: once after each, since each card says what qualifies its own figures.

## Phase 4d: Reconnected accounts to link

Needs attention's information row "A reconnected account may continue an earlier one: link its history", going to Settings > Connections.

**Built in 4d:** `linkOfferForDisplay` (`lib/links.ts`) names the pairs Settings > Connections suggests (`suggestLinks`' suggestions, not the earlier accounts offered by hand), as that card names them. `/api/net-worth` applies them to its answer as `link_offer` on every load, cached or live (a live one once the reconnected account is in the directory), and never stores them in the cache, as it does Plaid's warnings. The row reads "Chase Checking ••4821 may continue an earlier account" over "Link its history" ("2 reconnected accounts may continue earlier ones" over "Link the history of ..."), and lands on the Reconnected accounts card's title, now a heading. Each time that card loads, it tells Home what it suggests, which ends the row for a pair declined there without reloading anything (it only ever narrows the row); a link reloads Home live, as before. The nightly snapshot now records the directory before it returns on a day a connection is broken, as `/api/net-worth` does, so an account's last day there keeps pace with its history.

**Decided in 4d:**

- **From the directory alone, on every load, instead of a stored record.** The plan was to store the offered pairs when a reconnect adds directory entries or the account-links POST runs, since working them out read every account's balance history (`historySpans`). Two things changed it. A suggestion needs both accounts in the directory, which holds the first and last days the matching compares; the history only adds the balances the card shows as evidence, and is written by the same healthy loads (a restore brings both back together). And the stored record would have missed the usual reconnect: an earlier account stays live while its broken connection is stored, so the pair exists only once that connection is removed, which neither hook sees (nor an unlink, a forget or a restore). Reading the directory, the links and the declines costs a few reads per load and is right at once.
- **Failing closed where a lenient read would offer the wrong thing.** A connection whose record of its accounts can't be read, or declines that can't be read, offer nothing on Home: read leniently, its accounts would look like earlier ones, or a declined pair would come back.
- **No expiry.** A suggestion doesn't age (its window is the gap between the earlier account's last day and the new one's first), so Settings offers it until it is linked or declined, and the row stays as long. Declining is "Not the same", as there.

## Phase 5: Activity

- Pinned month bar and the three segments.
- One In / Out / Net strip on Transactions; filter chips.
- Spending segment with one period control (keeping the cash flow chart's ranges).
- Transaction sheet replacing the inline editor; rule offer inside it.
- Shared segment.

**Risks:** Card Mode and keyboard review must keep working; a cash-flow selection must still filter the list; split and group rows still show under their transaction.

Split like phases 3 and 4, since `components/MonthBreakdown.tsx` (about 1,400 lines, drawn by a dozen test files) holds all of it: **5a** the bar and the segments, **5b** the filter chips, **5c** Spending's one period, **5d** its charts' text, **5e** the Transaction sheet and the rows that open it. 5b and 5c were one at first and were split before 5b was built: the chips touch only Transactions' list, while one period for every Spending card changes what each card sums (all but the cash flow sum the bar's month, the cash flow's periods count back from today, a pick keeps its period, the month's notes are by month, and Income vs spend draws one month).

**Built in 5a:** `components/ActivityBar.tsx` is the tab's pinned bar (`.activity-bar`, sticky under the status bar): **‹ October 2026 ›**, whose arrows step through the months listed (the last 12 with transactions, as Net by month lists them) and stop at either end; the ⋯ with Add a transaction and Import a file while there are transactions and a manual account takes them; and `.segmented` Transactions · Spending · Shared, a WAI-ARIA tablist over one tabpanel. `MonthBreakdown` draws each segment from what it computes today: Transactions has the month's In / Out / Net card (its sentence of what it leaves out and its month notes, in their words and colors) over the list, unchanged; Spending has the cash flow, Net by month, Income vs spend, the same In / Out / Net card, top spending, spending by tag, online vs in-store, where you spent and Reports at its foot; Shared has the Shared expenses card, passed in. The dashboard keeps the segment, so the tab comes back on the last one chosen, and the review jump from Home lands on Transactions. A pick on the cash flow switches to Transactions, where the list shows it and focus goes to the line saying so; choosing a month with the arrows ends a pick, as a column of Net by month does. The Shared sheets (`SharedSheets`) moved out of the card and stay mounted on every segment, since a row on Transactions opens Share the cost, This paid back and an IOU. A jump's target stops under the bar (`scroll-margin-top`), and a segment chosen while the bar is pinned opens at its top. The month arrows stay focusable at either end (`aria-disabled`), and the month is announced as it changes.

**Decided in 5a:**

- **The In / Out / Net card on both segments**, as the IA's feature table has it ("summary strip also on Transactions"): Spending's month cards need the month's notes beside them, and each segment is its own screen, so the figures are never twice on one.
- **The load's notes go with the figures on each segment.** The cash flow says them on Spending, the list on Transactions; with no cash flow drawn (categories not loaded), Spending says them in the In / Out / Net card.
- **No month on Shared**: its balances aren't by month. The bar keeps the ⋯ there.
- **Adding stays in view while there is nothing to list**: the empty card keeps its two buttons and what adding does to a balance, since a closed ⋯ is easy to miss on an empty screen. With transactions, the ⋯ has them, as the IA says.
- **Shared doesn't wait for the transactions**: its card reads its own, so it shows while the list loads. Nor does Reports: it is at Spending's foot while the list loads and when there is none, since the runway and what the accounts held need no transactions (it is the app's only way to `/reports`).
- **The load's notes beside the In / Out / Net card wherever the cash flow isn't on the screen**: on Transactions (and still under the list, where they explain an empty or short list) and on Spending before the categories load. Before 5a the chart said them at the top of the one screen.
- **The review keys work on Transactions**, where the review bar is: N and Shift+A act on what is listed, so they have nothing to act on elsewhere. Card Mode is unchanged.

**Kept narrow in 5a:**

- **Three time controls on Spending until 5c**: the bar's month, Net by month's columns (which choose it) and the cash flow's own period. 5c gives Spending one period control and the cash flow loses its own; until then, a pick from a longer period lists that period's rows under the bar's month, and the line over them names the period.
- **The filters as they are**: the tag select, the receipt select and the review bar's filter become chips in 5b, with Card Mode opening from the To review chip. The review count becomes a heading then, since 5b redraws the review bar. (Built in 5b, with Card Mode beside the count instead: see Decided in 5b.)
- **The charts' axis text and range buttons** (4a's chart pass) go with 5c's period control. (5c built the period as chips; the charts' text is 5d: see Kept narrow in 5c.)
- **Card titles** ("Top spending by group", not the IA's "Spending by group"), and Shared's settings behind a gear: with each card's redraw, not a move.
- **What a segment switch drops**: a draft in a transaction's note or the shared settings, and the review bar's undo, as leaving the tab does today.

**Built in 5b:** the list's filters are a row of chips under the search (`.chip-row`, a labelled group, shown only when a chip is in it): **To review** (`button.chip`, `aria-pressed`) while the review queue is on, the review bar's Needs review button moved here, still turned on and off by the N key; **Tag** while there are tags and **Receipt** while a file store is connected, each a `ChipSelect` (`components/ChipSelect.tsx`): a native select laid unseen over the chip's 44px hit area, showing its word and the choice ("Tag: Groceries", "Receipt: has one", "Receipt: none"), "on" while a choice is made. "No receipt, money out over…" adds the amount field after the chips, as before. The review bar (`components/ReviewBar.tsx`) is under the chips: its count is a heading (`h3#review-count`, still where Home's jump and Card Mode's return land) beside **Review one at a time**, then Approve listed, its question and Undo, all `.btn`. The list card's title is a heading (`.card-header`, `<h2>Transactions</h2>` with its count), so the count's `h3` sits under it. An empty list says what narrowed it (`emptyListWords`): one filter names what it looked for ("No transaction listed has that tag." is new), the search or more than one say nothing matches them; before, two filters together could name only one, and a tag alone was "your search".

**Decided in 5b:**

- **Card Mode stays beside the count**, not on the To review chip as 5a's note and the mockup's caption had it: a chip that filters and also opens a full-screen mode would do two things on one tap. The IA's line already put Card Mode in the review bar; the mockup's caption is changed.
- **No count on the To review chip.** The heading counts the queue (the year's, as Home's row says it) and Approve listed counts what is listed; a third number on the chip, for the month through the other filters, would sit beside both, and a group with one member to review lists all its members, so the chip and the list's "N of M" would differ.
- **Native selects drawn as chips** for Tag and Receipt, rather than a menu: a phone opens its own picker, the chip says the choice in words, and focus and Escape are the browser's. The ⋯ menu (`Menu`) is for actions and has no checked state.
- **The chips show a fixed word first** ("Tag: Groceries"), and the select is named by that word, so speech input can name the control by what it shows (WCAG 2.5.3); the options are the tags' names, under a select named Tag.

**Kept narrow in 5b:**

- **Over an amount** as a filter of its own (the mockup's fourth chip, in the IA's list): the amount narrows only the transactions without a receipt, as before. A filter by amount for every row is new behavior.
- **The cash-flow pick stays a line** over the list (`FlowShown`), not a chip: it says the period and a node no longer in the cash flow, and focus lands on it.
- **The keyboard shortcuts' toggle** keeps its link-like look: Card Mode shares it.
- **The rows and day bars**: 5e's Transaction sheet redraws them. (Built in 5e.)

**Built in 5c:** Spending has one period, which every card there sums. Chips at its top (a labelled radio group: **Month**, **3 months**, **12 months**, **Year to date**; arrows, Home and End) set its length; it ends with the bar's month, so the bar's arrows, and a column of Net by month, move it and keep the length. The cash flow lost its own select (`CashFlowSankey` takes the length and the end month); Income vs spend (`MonthFlowChart`) runs over the period's days, with the year in its labels when the period reaches into another year, "to date" only when it holds today and "through" its last day otherwise; the In / Out / Net card, top spending, spending by tag, online vs in-store and where you spent sum the period, and each card names it ("August to October"). Net by month presses the month the period ends with and marks the others in it. A pick keeps the month its period ended with (`FlowPick.month`), so it is marked, listed and named in that period; choosing a length or a month ends it, as before. Transactions is unchanged: its strip and list are the bar's month. What may be missing from the period is said once: beside the cash flow, or, before the categories load, in the In / Out / Net card (`periodGapNotes`, the cash flow's gap notes, which needs no chart). A period reaching before the 365 days loaded says "the part of this period before then isn't in it" (it said "first days", which a 12-month period ending months ago understated).

**Decided in 5c:**

- **The bar's month ends the period**, rather than periods counted back from today: one period can't count from two places, and the bar is pinned over every segment. So "Last month" is the bar's ‹ with Month, and "This month" is Month; the four lengths are the cash flow's other ranges. By default the end is the bar's month, the latest with transactions, so on the 1st, before the month has any, Spending opens on the month before, as the bar does.
- **Chips, not a segmented row**, as the mockup draws them: four lengths as long as "Year to date" wrap in a segmented row at 320px. A radio group, so one is chosen and the arrows move it.
- **The In / Out / Net card stays on Spending, summing the period.** It says what the cash flow's notes don't (other people's parts of shared transactions, the conversion and why a currency had no rate), so the figures are twice on Spending, in the cash flow's row and the card; its notes of what may be missing are said only where the cash flow isn't drawn.
- **A column of Net by month moves the period's end and keeps its length**, as the bar's arrows do; only the end month is pressed, and the others in the period say so to a screen reader.
- **On Spending, what may be missing speaks of the period, in the cash flow's words**: "so October may be incomplete", "so August to October may be missing some of its transactions", a stopped bank to a sentence, the load's notes first as sentences. Before 5c the In / Out / Net card there said the month's ("so this month may be incomplete"). Each keeps its level (a stale notice), and none is dropped; Transactions keeps the month's words.
- **The In / Out / Net card on Spending is headed "In and out"** with the period, as every card there names it.
- **A pick keeps the bar on its month**, so a reload that brings a later month doesn't move the period under the list.

**Kept narrow in 5c:**

- **The charts' text** (4a's chart pass): SVG text scales with its viewBox (Income vs spend's 10px ticks draw at 7 to 8.5px on a phone), so 12px means drawing each chart at its own width rather than a class change. Activity's charts (Income vs spend, the cash flow's labels, Net by month's figures) are 5d; the charts on Home, Budgets, Plan and Reports, which share the classes, follow with phase 6.
- **The figures twice on Spending**, in the cash flow's row and the In / Out / Net card: merging them means the cash flow saying the card's notes.
- **A row dated after today** counts in the period's totals but isn't drawn in Income vs spend, which stops at today, as it did for this month.

**Built in 5d:** Activity's charts are drawn at their own width, so their text is 12px (`--fs-1`) on a phone and on a wide card. `components/drawn-width.ts` (`useDrawnWidth`) reads the width a chart's svg is laid out at as it mounts, before it is painted, and follows it with a ResizeObserver; it rounds down to a whole pixel, keeps the last width while the svg isn't laid out, and draws at 340 (or what a `DrawnWidth` provider says) where nothing can be measured. A viewBox unit is then a CSS pixel. **Income vs spend** keeps its shape (150 to 340) at every width, with 4px more under its baseline for the 12px dates and 2px more over its top tick; its ticks and dates take `.at-width .chart-tick` and `.at-width .chart-xlabel`, so the charts still on a fixed viewBox keep their look until phase 6. **The cash flow** is laid out at its width (up to its 560px) with 12px labels a 14px line apart, taller on a wide card in the shape it had. Where a label between two columns has no room for about seven letters beside the widest amount the currency writes, as on a phone, it draws **three columns**: payers, everything counted and the groups; the table under it lists their categories, each a button as a tap on the chart is, and the chart's notes say so. **Net by month**'s figures and months are 12px, its columns as wide as the widest month's figure the currency writes (a CSS custom property, `--trend-col`), so no figure widens its own. A card's header (`.inst-header`) wraps a hint too long to sit beside its title, with a gap, rather than running them together (Net by month's "tap a month to end on it" did at 320px).

**Decided in 5d:**

- **Drawn at its width, not counter-scaled text.** Scaling only the font against the viewBox would make the text 12px, but the cash flow fits its labels in JavaScript (`fitBeside`, `amountRoom`), which needs the width they are drawn at; text drawn as HTML over the svg would repeat the labels' halos, cuts, masks and tap areas.
- **Three columns on a phone** (chosen over four columns with every label on two lines, which still can't fit a euro or yen amount in 64px, and over a chart scrolling sideways). At 12px a four-column label on a 320px phone has 64px, of which a dollar amount takes 53, and a euro amount (81px) doesn't fit at all. Which is drawn is worked out from the width and the currency, never the amounts, so hiding them changes nothing.
- **Net by month's columns grow** from 42 to 64px (in dollars, euros or yen, the widest figure each writes, up to billions), so a phone shows about four months at once rather than six; the row already scrolls, the newest month pinned at its right.

**Kept narrow in 5d:**

- **The other charts** (net worth, forecast, runway, the plan's fan, debt payoff, allocation) keep their fixed viewBox and 10px text: phase 6 moves them to `useDrawnWidth`, after which `.at-width` folds into `.chart-tick` and `.chart-xlabel`. So do `.chart-note` (11px, under many charts) and the gridlines' two hex colors in Income vs spend. (The forecast and debt payoff: built in 6a4.)
- **The cash flow's In / Out / Net row** runs past a 320px phone when the figures reach six digits ($259,080.00), as it does on `main`: its own fix.
- **Income vs spend's lowest tick** ("$0") sits on the lines where they start, as its ticks always have, now at 12px.

**Built in 5e:** a tap on a transaction opens its sheet (`components/TransactionSheet.tsx`) in place of the editor that opened inside its row. The sheet has the amount, the day, the account and where the row came from, its badges and notes; its review; its **Category**, a field holding the category list; tags and note; Split, Group with others and the rest of the split and group actions; Share the cost and This paid back; whether it counts in budgets and reports; the rules it matches and **Create a rule from this**; its receipts; and the bank's details last, under a heading. Its ⋯, in the footer, has **Rename vendor** (a second level of the sheet, with Back) and, for a row entered by hand, **Edit or delete**. After a category is chosen the sheet stays open on the row as it now is, and the offer to make a rule of it ("Do the same for every transaction named...") shows under the field, with **Make a rule** (which closes the sheet and opens the rule drawer) and **No thanks**; before, the editor closed and the offer showed above the list. The list is now a card's `.list-rows` (`components/MonthBreakdown.tsx`), a line for each day with what its rows come to, then each transaction a `button.list-row`: its logo, its name with its tags, one line (its category, or a split's parts and a group's size; the account; where it came from) with its provenance as chips (Pending, Check category, To review, Excluded or Hidden by a rule, Note, a paperclip for a receipt), the notes that bear on what it counts as under that line, and its amount. A split's parts and a group's transactions are rows of their own under it (`components/SplitRows.tsx`), and open the sheet on themselves: a part's category, Leave this part out (or Count this part again) and Edit split; a group's transaction, Take it out of the group. An IOU's row opens the IOU, as before. The pure words a row and its sheet share (`pairedWords`, `nameForRules`, `exclusionOffer`, the low-confidence test) moved to `components/txn-words.ts`, still exported from `MonthBreakdown`.

**Decided in 5e:**

- **One pull request for the sheet and the rows**, chosen over a separate 5f for the rows: the rows are touched once.
- **The category is a field in the sheet**, not the mockup's "Category  Groceries ›" row opening a second level: a native select opens the phone's own picker, with the browser's focus and Escape (as 5b chose for the filter chips), a drawn list of categories would be a new pattern, and the offer to make a rule needs to sit beside it. The mockup's sheet is redrawn to match, with the ⋯ in the footer, where `Menu` belongs in a sheet (design-system.md#menu), and the bank's details under a heading.
- **Open on what changes at once, closed on what changes later.** A category, an exclusion, tags and a note, and a review are shown at once (the dashboard changes the row before the server answers), so the sheet stays open on them. A part's or a group's change, taking a transaction out of a group, Ungroup and a rename show only once the list is read again, so each closes the sheet, as the editor closed: an open sheet would show the old category until then. A group's row's category is one of those, so it offers no rule.
- **The sheet follows its row, not the list's filters.** It finds its row again among every row loaded, put back whole (a split one with all its parts), so a change that takes it out of a filter (a tag taken off under the Tag chip, a category changed in a cash flow pick, an approval under To review) leaves the sheet open on it. It closes when the row is gone (posted under a new id, deleted), with focus on the list's heading, and when the list is read again with a spinner (after a change the server refused), and doesn't come back on its own.
- **Each opening starts afresh**: an offer not taken, or a name half typed under Rename vendor, doesn't come back when the row is opened again.
- **Errors in the sheet are only its own**: a change refused while it is open is said at its top, in red; one said before it opened stays above the list, where it was, until it clears (the same words refused again after that are said in the sheet).
- **Where focus goes**: back to its row when it closes; to the list's heading when the row has left the list (gone, or a filter took it out, as an approval does under To review); to the Category field after **No thanks**, whose button goes with the offer.
- **The notes stay on the row.** An exclusion that couldn't be read, a pair worked out between two SimpleFIN accounts, a split or group notice (a group counted before what is shown, a split the bank's amount no longer fits), how it is shared and a file's amount the bank changed all bear on what the row counts as, so they stay under its line, in their words, and are said in its sheet too ("never only in a sheet", design-system.md#status-and-honesty). The design system's one subtitle line is the category and account; these are the notes it allows.
- **Provenance in a word.** "Excluded from budgets and reports" and "Hidden by a rule: out of budgets and reports" on the row become the chips **Excluded** and **Hidden by a rule**, its amount quieter as before, and its sheet says them in full under its amount, with its Pending and Check category chips; "· check category", "· note" and "· to review" become **Check category**, **Note** and **To review** chips, To review and Check category in amber as before.
- **An IOU's row is a button only where it opens something** (with Shared expenses on), else a plain row.

**Kept narrow in 5e:**

- **`Sheet` has no focus trap**: it takes focus and gives it back, and is `aria-modal`, but Tab can leave it for the page behind. True of every sheet; its own fix.
- **A pending transaction's sheet closes when it posts** (the bank gives the posted one a new id), as the editor did.
- **The other lists' rows** (Recurring, Planned, investment activity) keep their tables and `.acct-row` until their own phases.

## Phase 6: Budgets and Plan

Split in pull requests: four for Budgets (6a1 to 6a4, about 4,700 lines of components between them, split as phase 5 was; 6a3's charts became 6a4 once its layout was built, as 5d followed 5c), three for the Plan tab's layout. All are layout only: no saved plan, scenario, budget or goal changes shape.

**6a**, Budgets:

- **6a1**: Month, Upcoming (forecast, calendar, recurring, planned) and Goals as segments under a pinned bar. Debt payoff moves from Accounts to Budgets > Goals in the same PR, so it is never without a home.
- **6a2**: add and edit a budget in a sheet, and "My income is irregular" as a row that opens its setting; one completeness notice per segment.
- **6a3**: Upcoming's bills, income, planned items and card payments as one dated list, or a calendar of the same, with one notice at the top for what they may be missing (moved from 6a2); the forecast's "Warns below" in a sheet.
- **6a4**: the forecast's chart drawn at its width (`useDrawnWidth`), the calendar's figures and weekday letters at 12px (an HTML grid, so its figures have to fit a 34px cell at 320px: "+$3.5K" is 37px at 12px), and the payoff plan's chart at its width. Its day cells were 34px wide there (39px since 6a4), under the 44px target. Split from 6a3 (decided 2026-10-25).

**Built in 6a1:**

- **The bar** (`components/BudgetsBar.tsx`), pinned like Activity's and reusing its tab keys: on Month the month is the heading, "‹ October 2026 ›", with a native select laid unseen over the name to pick any month back to the first with transactions; on Upcoming and Goals the segment's name. Under it Month · Upcoming · Goals as tabs.
- **Three panels, all mounted**, the two not shown `hidden`. Nothing typed in one (a budget being added, the forecast's what-if, a planned item, a goal) is lost by looking at another, and a save under way finishes where it started.
- **Home's budget alerts** open Month and land on the month's heading, which the bar draws before anything has loaded.
- **Goals doesn't wait for transactions**: Month and Upcoming show the spinner while they load, Goals its goals.
- **Debt payoff** is a card on Goals holding the Payoff plan row, shown by the same rule Accounts used (a card or loan that isn't hidden); the sheet is still mounted once outside the tabs, so what was typed in it lasts.
- The segment is kept by the dashboard, as Activity's is: the tab comes back on it while the app is open.

**Decided in 6a1:**

- **Arrows and a pick, not arrows alone.** Budgets reach back up to ten years, and each month is read from the server, so stepping back three years a month at a time would be 36 reads. The arrows take the month either side; a tap on the name picks any month.
- **"Upcoming", not "Next 30 days"**, as the bar's heading: the forecast has three ranges.
- **The panels stay mounted** rather than one drawn at a time, as Activity does: Budgets' segments hold forms (Activity's hold filters).

**Kept narrow in 6a1:**

- **Card titles under the bar**: the month's card keeps "October budgets" and Goals' card its "Goals" title under the bar's heading; 6a2 redraws the month's card ("Spent", as the mockup has it) and can drop Goals' title. (Both built in 6a2.)
- **The payoff card's summary line** ("Paid off by May 2027", interest) needs the plan worked out on Goals; the row opens the plan as Accounts' did.
- **Charts still owed a pass before `.at-width` folds into `.chart-tick` and `.chart-xlabel`**: Home's net worth chart and Reports' runway chart, besides the Budgets and Plan charts these phases take. (Budgets' were drawn at their width in 6a4 and the Plan's fan chart in 6d; the allocation chart has no phase yet.)

**Built in 6a2:**

- **The month's notice.** Month opens with one notice of what the month may be missing (`components/budget-notes.ts`, drawn by `TotalCaveats`): a connection that stopped syncing, transactions that couldn't be loaded or are still importing, bank accounts Plaid doesn't cover or you didn't allow, a past month's own reasons, and why rollover may be off. One shows in full; two or more are one line that says how many and of what, and opens in place to each. The words are the ones the card said under the budgets, each still amber. `monthGapItems` (`lib/month-coverage.ts`) and `missingMonthItems` (`lib/no-transactions.ts`) give each sentence its kind; the notes Activity and Home say are their texts.
- **Spent** in place of the "October budgets" title: the month's total as the card's figure, a "May be incomplete" badge when the month has gaps of its own, the meter, and what the figure counts (converted, left out, split amounts changed, a bank with no accounts, budgets by month since) gathered the same way, as information.
- **Available to allocate** is a card of its own above it while the income pool is on; Show how it built up is a ghost button.
- **The budgets as rows.** Each group is a row that opens and closes on its categories, its meter under its name and its figures on the right; "For Food as a whole" and each category are rows that open the budget's sheet (`components/BudgetSheet.tsx`). A past month's rows open nothing.
- **A budget's sheet**: its figures, the amount, the suggestion ("Use $325.00"), and a Rollover row opening a second level (on from a month, or off, with Reset carryover... a third level that asks first). Remove... asks first. A budget left on a deleted category or group opens a sheet holding Remove budget.
- **+ Add budget** opens a sheet (`AddBudgetSheet`) with the category or group, the limit and the suggestion. **My income is irregular** is a row with On or Off that opens its setting in a sheet.
- **A refused save keeps the sheet open** with what was typed and says why. The card stays drawn from the last saved budgets while they are read again, and the dashboard pauses the month's rollover and suggestions meanwhile rather than dropping them.
- **Goals** says a gap note that two or more goals share once, at its top, with a badge on each of them ("Pace may be off", or "Pace not known" where the goal's own line says what went in lately isn't known); a note only one goal has stays on it. What the card says once already (paces at monthly targets only when the flows couldn't be read, and the server's notes) joins the same notice, in its words and level. Its "Goals" title, under the bar's, is gone.

**Decided in 6a2:**

- **Over is amber**, the badge and the meter past the limit, as 4b made an over budget on Home: a true number the person may act on, not a number that is wrong. It was red. The word tells over from nearly over, so it is never color alone.
- **A group's row opens and closes in place** rather than opening a sheet: it holds its categories' budgets, each with a sheet of its own.
- **One way to commit on the sheet's first level.** Rollover is a level of its own, so a rollover change never drops a typed amount; while the amount differs from the saved one, the Rollover row says to save it first.
- **Remove asks first**: removing a budget ends its rollover (its carry starts again from zero), so adding it back doesn't undo it.
- **Each opening starts afresh**, as 5e's sheet does: a budget half added isn't kept once the sheet closes. 6a1's "nothing typed is lost by looking at another segment" still holds, since nothing else can be looked at while a sheet is open.
- **Errors in a sheet are only its own**, as in 5e, and keep their level: a refused save stays amber. A rollover or income change keeps its error in its own sheet.
- **The month's badge is on Spent only.** Rule 3 asks for a badge on each card a gap affects; the budgets' rows rest on the same month but have no header to hold one, and each carry that may be off already says so on its row.
- **Reset carryover keeps a plain button**, as before: it can be undone (turned off and on again from the month it began, the carry comes back), so it isn't a danger button. Remove is one.
- **A goal's gap note stays on the goal unless several share it**: it names a bank, not a goal, so at the top it couldn't say which goal it is about.

**Kept narrow in 6a2:**

- **Upcoming's one notice** moves to 6a3, which merges the calendar, recurring and planned items into one list: what repeats there is load states, three of them critical (which are never gathered), and connection gaps only the forecast says.
- **`Sheet` has no focus trap** (5e's note): Tab can reach the bar's month arrows behind it, and choosing another month closes the sheet.
- **A reload that fails after a refused save** still replaces the card with its error, which closes the sheet.
- **The meter tracks** became token tints, on every meter (accounts, goals, the Plan, shared expenses): a small change of tone.

**Built in 6a3:**

- **The segment** (`components/UpcomingPanel.tsx`): one notice at the top, the cash forecast, **List · Calendar** (a tablist of two over the same entries, both views mounted and the other hidden, so the calendar keeps its month and day), Recurring and Planned. The forecast and the list share the range (30, 60 or 90 days).
- **The notice** (`components/upcoming-notes.tsx`, drawn by `TotalCaveats`): what the bills, income, planned items and payments may be missing. Transactions that couldn't be loaded (critical, in full) or are still loading, planned items not loaded, then the forecast's notes on them: a connection not syncing or whose transactions couldn't be loaded or are still importing, a bank whose transactions Plaid doesn't provide or you didn't allow, a card's payment due that isn't in it, pay that stopped or varies, amounts left out for their currency, an account of unknown type. Two or more cautions are one line that says how many and of what. `forecastNoteItems` (`lib/forecast.ts`) gives each of the forecast's notes its kind and whether it is about where the forecast starts; `forecastNotes` is their texts, unchanged. A badge says the notice bears on a card: "May be incomplete", or "Incomplete" when transactions couldn't be loaded, on the forecast, and on the list and the calendar when the notice says entries may be missing.
- **The forecast's card**: its notes on where it starts under "Starts from", gathered the same way; its range a radio group drawn as `.segmented`; its answer (below zero, below the warning) as notices at their levels; **Warns below** a row that opens the low-balance warning's sheet (`aria-disabled` while the planned items can't be saved); What if I buy… a button; how it counts behind How this works.
- **The list** (`components/UpcomingList.tsx`, `upcomingDays` in `lib/calendar.ts`, built from `calendarMonth` so both views list the same entries): from today over the range, Activity's day bars over plain rows in the calendar's words, a payment due led by a **Due** badge, an amount not in the day's figure quieter.
- **The calendar**: 44px month arrows that stay focusable at either end, Today beside the month's name, its day's list as the same rows.
- **Recurring**: bills and income as rows that open a series' sheet (what it was seen as, what the forecast makes of it, Not recurring, and why it is off when it is); the marked list behind one row that opens in place, each with Restore.
- **Planned**: items as rows that open the item's sheet; Delete asks first, as a level; Money out or in as a radio group.
- **A refused save keeps the sheet open** with what was typed and says why. The planned items, their dismissals and the warning are held through the store's reload (`plannedDrawn` in `components/BudgetsTab.tsx`, as 6a2 held the budgets), so the forecast, the list and Warns below don't drop them meanwhile, and Warns below stays a button focus can return to.

**Decided in 6a3:**

- **The forecast's notes on where it starts stay on its card** (rule 1): only it rests on that balance. The notice at the top holds what the list and the calendar rest on too.
- **Those notes stay amber**, as before, those that say cash is left out of where it starts included (a bank not reached, accounts not shown, an account with no balance, cash in another currency): two or more fold into one amber line, as every caution does since 4a. Raising them to red, as Home's total is when it is short, was weighed and not taken (decided 2026-10-25).
- **Badges only where entries may be missing**: not for pay that varies, an account of unknown type, another currency or a card's payment due, which the list and the calendar already show, each saying why it isn't in the day's figure.
- **Each card's own words stay, at their levels**: the calendar's line for days gone by ("what posted isn't shown", critical) and Recurring's empty states say why their cards are empty, so they aren't left to the notice.
- **With no cash accounts** there is no forecast and no notice: the list says the load states itself, in Recurring's, the calendar's and the forecast's words, so with transactions not loaded the list and Recurring both say Recurring's sentence.
- **The calendar keeps its own months**: a month a page, a year back and a year ahead, with what posted on days gone by, another shape of the same entries; the forecast and the list share the range.
- **No headings on the list and the calendar**: their tabs name them.
- **The planned items' save error where it was said**: on Recurring and on Planned (each card's own sheet saying it instead while it arose there), and in the warning's sheet, at their levels (caution, and critical in a planned item's sheet, as before).

**Kept narrow in 6a3:**

- **The list's rows open nothing**, as the mockup draws them: Recurring's and Planned's rows, at the foot, open their sheets.
- **The range and the List · Calendar choice** start afresh when the Budgets tab mounts again, as the forecast's range did.
- **`Sheet` has no focus trap** (5e's note).
- **A sheet open on what a reload took away**, as before: a planned item's sheet stays open on an item another device deleted meanwhile (Save then saves the list unchanged and closes), and a series' sheet keeps the series as it was when it opened if transactions are read again under it.
- **The charts** (the forecast's and the payoff plan's at their width, the calendar's figures at 12px): 6a4. (Built in 6a4.)
- **Recurring's subtitle** (where, how often, how many times, when next) runs to three or four lines at 320px, and the list's to three where it says why an entry isn't in the day's figure: the design system's one subtitle line, shortened when those rows are next redrawn.

**Built in 6a4:**

- **The cash forecast's chart** (`components/ForecastChart.tsx`) is drawn at its width (`useDrawnWidth`), on its card and in What if I buy…, in the shape it had (150 to 340), with 2px more over its top tick and 4px more under its baseline for the 12px figures and dates, as Income vs spend took in 5d. Its ticks, "Now" and its last day are 12px at every width.
- **The payoff plan's chart** (`PayoffChart` in `components/DebtPayoff.tsx`) the same, in its shape (140 to 340).
- **Fewer gridlines where a chart is short.** At 12px on a phone's plot (71px tall on the forecast's card at 320px), five to seven ticks drew their figures 10 to 17px apart, a gridline cutting into the figure over the one below. Both charts now widen the step through 1, 2 and 5 until gridlines are at least 20px apart (`MIN_TICK_GAP`): two or three on a phone, and on a wide card what they drew.
- **The calendar's figures, weekday letters and legend are 12px.** A cell's figure keeps its sign and drops the currency, which the legend names once on a line of its own ("Day figures in USD, rounded"): whole units under a thousand ("−143"), then two significant figures and K, M, B or T ("+3.5K", "+13K", "+890K", "+1.3M"), in the viewer's digits. With amounts hidden it is the sign and the mask ("+•••"), the sign taken before rounding, so a few cents don't read as "•••" beside the others' "+•••". Each cell's label still says its amounts in full, with the currency, and the day's list has the cents.
- **The calendar's grid runs to the card's edges**, as the day's list's rows do, with no padding at a cell's sides: a cell is 39px wide at 320px (it was 34px) and 44px or more from a 360px phone. Its focus ring is drawn inside, so the outer columns' ring stays on the card.
- **The source scan** (`test/amount-sources.ts`) reads a number written with significant digits as an amount, as it reads one written with fraction digits or compact notation.

**Decided in 6a4:**

- **No currency in the calendar's cells, and a wider grid** (decided 2026-10-25). At 12px "+$3.5K" takes 37px, "-$12.5K" 40px and "+CA$3.5K" 52px, where a cell had 30px inside its padding. Keeping the symbol on the wider grid fits a 320px phone only for dollars, euros, pounds and yen under a hundred thousand, and never a code such as CA$; dots alone on phones would show figures only from about 430px.
- **K and M, not Intl's compact notation**: in other locales it doesn't shorten thousands or writes a word ("13.000" in German, "13 mil" in Spanish), so a figure under a million would fit only in English. The app's words are English; the digits and the decimal sign are the viewer's.
- **Two significant figures from a thousand**, rounded before the suffix is chosen, so 999,999 is "1M" and the widest figures under a million are three digits and K, as "+890K" (36px). "-$12.5K" becomes "−13K"; the day's list has the cents.

**Kept narrow in 6a4:**

- **A day of a hundred million or more** ("+890M" is 39px at 12px, as wide as a cell at 320px) can be cut with an ellipsis on a face wider than Segoe UI, at 320px only; such days are ordinary in rupiah, dong or won. Its cell's label and the day's list say it in full.
- **A chart in a panel hidden as it mounts** (Upcoming's forecast while Budgets opens on Month) draws at 340 until it is shown, then at its width on the next frame: the same shape, its text scaled for that frame. A `flushSync` in `useDrawnWidth`'s observer was weighed and not taken: the hook is shared, and a redraw inside the observer that changes what it watches (the rounded height, the cash flow's height) raises the ResizeObserver loop error.
- **`.at-width` stays, and so do the charts' hex colors** (`#262a33`, `#3a4150`, the payoff baseline's `#6b7080`). Home's net worth, Reports' runway and the Plan's fan and allocation charts are still on a fixed viewBox, and the colors move to tokens in one pass over every chart. The baseline's gray was chosen for its contrast with the surface and the accent, which its token has to keep.
- **The calendar's cells are under the 44px target on the narrowest phones** (39px at 320px).

**6b**, the Plan tab's segments:

- The scenario bar pinned at the top ("Your plan" or the open scenario, Scenarios, Back to your plan) and the Scenarios sheet with Compare.
- Three segments: **Your path** (the first, renamed from FI and timeline), **Stress test**, **Portfolio**. The cards move as they are; nothing is reworded yet.
- The Plan tab gets a heading for Home's FI line to land on.

**Built in 6b:**

- **The scenario bar** (`components/PlanBar.tsx`), pinned like Activity's and Budgets': "Your plan" with **Scenarios (3)**, or, with a scenario open, a back arrow ("Back to your plan") and "Scenario: Sabbatical 2029", the name wrapping, never cut; under it Your path · Stress test · Portfolio as tabs.
- **Three panels, all mounted**, the two not shown `hidden`: Your path (the FI card, income and one-off expenses, and an open scenario's life events), Stress test (the simulation, the grid, About these numbers), Portfolio (the allocation). The repair and load-error notices stay above the bar, as the information architecture has them, and so does the currency card until it becomes the badge on Your path. The tab is one tree while the plan loads, so the bar and its heading are never drawn twice.
- **The Scenarios sheet** (`ScenariosSheet` in `components/PlanScenarios.tsx`): the Scenarios card's list and Compare, with New scenario, Rename, Duplicate and Delete as its second level (a sheet over a sheet isn't a pattern the app has). It opens from the bar on your plan and from the open scenario's card.
- **The open scenario's card** (`ScenarioCard`) under the bar, above every segment: its heading and Back are the bar's now; it keeps what it changes, why it isn't worked out, a currency mismatch and a save notice, and gains **Scenarios (3)**. While its lasting changes are refused, the life events card that fixes them sits under it.
- **Home's FI line** opens Your path and lands on the bar's heading, also on a first visit, while the Plan's code is still loading: the tab lands itself, since the dashboard's landing looks only once per dashboard render.
- The segment is kept by the dashboard, as Activity's and Budgets' are.

**Decided in 6b:**

- **A back arrow, not "Back to plan" in words** (Fue's choice): at 320px the words leave the heading 154px, two lines for "Scenario: Sabbatical 2029"; the arrow leaves it 236px.
- **Scenarios from inside a scenario too** (Fue's choice), on the scenario's card: switching, renaming or comparing doesn't need going back first.
- **Words that say where something is changed with the cards**, and only those: a sentence that pointed above or below at a card now on another segment, or at the page behind the sheet, names the place. On Stress test: "Type it on Your path", "(the FI card on Your path says why)", "it would never get that far (on Your path)", "as the Life events card on Your path says", "The figures on Your path and Portfolio don't depend on it". On Your path: "the simulation on Stress test shows how much that matters". On the currency card: "(on Your path)". On the scenario card: "N life events, on Your path." (", below." while the card that fixes them is under it, and no place when none is drawn). In the Scenarios sheet: "(the FI card on Your path says why)", "try again at the top of the Plan tab", "values to fix first (at the top of the Plan tab)", "isn't known yet (at the top of the Plan tab)". Their level is unchanged.
- **Notices that moved into the sheet**, with what they are about: the scenarios' load error with Try again, a damaged scenario's error with Delete it, the note on scenarios saved by a newer version, and why scenarios can't be opened yet.
- **Compare runs only once your saved plan has loaded**: before, the card's compare also ran during a load error and while a refused save reloaded the plan.

**Kept narrow in 6b:**

- **The open scenario's card sits between the tabs and the panels**, so Tab from the tabs reaches its buttons before the panel, and it isn't pinned: from deep in a segment, Scenarios inside a scenario is a scroll up. A switch of segment lands on the panel, or on the card while it says something is wrong. 6c's per-segment notice and 8c's What if card may move it.
- **The currency card stays above the bar**: the badge on Your path is still to come. (The inputs as rows were built in 6c, and the fan chart at its width in 6d.)

**6c**, the figures the plan rests on:

- Spending, saving, invested, and ages and assumptions as rows that open their edit sheets. Each source sentence moves into its sheet behind Why?.
- Under each figure, its critical caveats in full and the lesser ones as one line that says how many and what kind ("2 notes: a month missing, payroll not set") and opens in place to every note in its words, as `TotalCaveats` does on Home (guidelines.md allows it). The caveats on the FI number stay on it.
- Stress test opens with one amber notice when an input it uses may be incomplete (decided 2026-10-26; it was each segment).

**Built in 6c:**

- **Your figures** (`InputsCard` in `components/PlanTab.tsx`), a card under the FI card on Your path: Annual spending, Invested assets, Annual savings, Ages and Assumptions, each a list row that opens its sheet. A row is its title, where the figure comes from in a few words ("A year, from transactions", "5 months, scaled up to a year", "Estimated from a year", "2 accounts, as of Oct 6, 3:12 PM", "2 accounts, cash included, as of …", "Typed by you", "Not measured", "Not enough transactions yet"), the figure, and a chevron; measured savings has its rate under the figure ("43% savings rate", Home's words), so no gathered line can hide it. Ages and Assumptions have their figures as the subtitle ("40 now, 55 target"; "4% withdrawal · 5% real return until FI · 0% tax · $28,000 part-time").
- **What qualifies a figure is under its row**, outside the button, through `TotalCaveats`, as under Home's FI line: one note in full, two or more as one line that says how many and what kind ("2 notes: pay before it reaches a bank and transactions that couldn’t be read") and opens in place to every note in its words. A sentence that was too long for a subtitle and says more than where the figure came from (transactions that couldn't be loaded, no connection that brings in spending) is a note too.
- **How a measured figure was worked out is in its sheet, behind Why?**: spending's loan payments, cash and refunds (the sheet's measured line already gives the dates); savings' estimate, what was added for workplace plans, and its rate. Invested assets have none: their row has the date, and their sheet lists the accounts and balances.
- **One source for what a figure says** (`components/plan-figure-notes.ts`): the rows, the sheets' Why?, the FI card's "may be low" lines and Stress test's notice read the same notes, built from what the FI card said, sentence for sentence. The words checked across 25 situations against `main`'s card: every sentence found, at its level, but for the changes below.
- **Stress test's notice**, first in the segment: "Your annual spending may be low: it is missing transactions that couldn't be read, and the simulation withdraws it (Your path says which).", and "Your invested assets may be low: some couldn't be counted (Your path says which)." when the simulation starts from them, or its card says it starts with more than they would come to by then (the start note, a cost the walk can't pay included). Under VPW, which sets its own spending, the spending clause says what the test does with it instead: "… and the simulation starts from the FI number worked out from it …" from the FI number, else "… and the simulation compares its first year's spending with it …", as its card does. Nothing while the simulation is missing an input: its card says what it needs.
- **Rows open while editing is paused**, where the Edit buttons were disabled, and the sheet says why it can't be saved yet above its buttons: the saved plan couldn't be read (and the sheet shows the defaults, when nothing was loaded), its currency isn't known yet, or it has values to fix first. While the plan is read again (Try again, a stale currency record) a row is held: in the tab order, and a press opens nothing, since a sheet opened then would build its form from the plan the load replaces. A sheet open when the plan is read again behind it keeps what it shows and can't save it ("Your saved plan was read again since this opened, so this can't be saved: close it and open it again."), so a sheet opened on the defaults, or on a version since changed, never writes it over the plan read; and a save that ends after its sheet was dismissed closes only that sheet, never one opened since.
- **Focus comes back to the row** when its sheet closes, also when the row wasn't focused as it was pressed (Safari), as 6a3's rows do, and to the row drawn now when the one pressed was drawn again meanwhile; closing another sheet never sends it to a figure row. A row's notes describe it (`aria-describedby`), so moving from row to row a screen reader says a note in full too.
- Each segment's cards are in a `.stack.loose`, as Budgets' are.

**Decided in 6c:**

- **The notice opens Stress test only** (Fue's choice). Your path opens with the FI card, whose "May be low: spending is missing … (below)." and "Invested assets may be low (below)." already sit on the number, with every note under the rows below it; Portfolio's allocation reads holdings, not these inputs, and says what it is short of on its own card. The notice names the figure and what the test does with it, since the FI card's lines had the FI number as their subject, and less spending makes a simulation read safer, not lower.
- **Ages and Assumptions stay two rows** (Fue's choice), each opening its own sheet: 6d makes one Assumptions sheet of every setting the stress test uses, which would redo a merged form now. The mockup's one "Ages and assumptions" row waits for it. (6d kept them two rows: Decided in 6d.)
- **No caveat changes its level.** Every warning the rows said was amber and is a caution; none is raised to critical, though design-system.md's table would make "couldn't be reached and isn't counted" and "couldn't be shown" critical. The payroll note is a caution here, as it was, and information on Home.
- **Words that change, and only these**: "Type it under Edit." is "Type your own."; "say so under Edit" is "say so in Annual savings"; "(the FI card on Your path says why)" is "(Your path says why)" (Stress test, Compare) and "(the FI card says where they come from)" is "(Your path says where they come from)" (Compare), since the reason is now under the row; the failed sentence starts with a capital and ends with a period, as each note does; the subtitles, the savings rate line and the Assumptions subtitle are new words, and Ages' "typed by you" and "Not set", the "From" label and the five Edit buttons are gone. The sheets' paused lines and Stress test's notice are new.
- **The card is called Your figures**: the mockup's "From your last 12 months" is wrong for invested assets and ages.

**Kept narrow in 6c:**

- **No badge on the cards the notice is about** (design-system rule 3 asks for one on each affected card): the notice sits directly above them, and their headers are redrawn in 6d. (Built in 6d.)
- **Refunds, loan payments and cash are behind Why?** although they were beside the figure so an odd large refund could be seen: it is one tap away, in the sheet where it can be typed over.
- **The row titles keep today's labels** ("Annual spending", not the mockup's "Spending"): 6d's plain words. (Kept in 6d: Decided in 6d.)
- **Known and unchanged**: savings says "Needs a year of transactions" when the transactions couldn't be loaded at all; with every figure typed, Home's "The Plan tab says which" has nothing on the Plan to point to.

**6d**, the assumptions and the words:

- One Assumptions sheet holds every setting the stress test uses (withdrawal rate, return, tax, mix, rule, method, fee), so each sits with what it changes; the mix is set in one place.
- Each result keeps a short label ("Hypothetical, from US history: not a prediction, and not advice."); the full text and the data sources are said once, in About these numbers.
- Plain words, with the FI terms as labels (see [information-architecture.md](information-architecture.md#vocabulary)): "growth after inflation", "how much you'd draw each year", "you could stop saving now". Never "retire early".
- The fan chart and the rate grid drawn at their width (`useDrawnWidth`), their text at 12px.

**Built in 6d:**

- **One Assumptions sheet** (`AssumptionsForm` in `components/PlanForms.tsx`, which replaces it and `SimulationForm`): every rate and setting the plan uses, under two headings. **FI number**: the withdrawal rate, growth after inflation until FI, tax on withdrawals, part-time income for Barista FI. **Stress test**: method, withdrawal rule (with floor and ceiling), start with (and the balance typed), length, stocks and bonds, rebalancing, fund fees. Most fields have a line under them on what they change, cut from the old intro paragraph and the old forms' notes (the length, floor and ceiling, rebalancing and fees say it in their labels); one Save saves the whole plan. The sentences that read the rate say it as typed: the rule at the rate the simulation withdraws at (the withdrawal rate when it starts with the FI number, else what your spending is of the balance it starts with), the start choice's consequence, and the FI number in its option, worked out from the spending at the typed rate and tax (`lib/fire/fi.ts`), only while the plan shown is worked out. With a scenario open the method and the part-time income stay the plan's, disabled with their line.
- **Opened from**: Your figures' Assumptions row (at the top), Stress test's Assumptions row (scrolled to its Stress test heading), the scenario card's "Change it" (at the part with the field), and Portfolio's **Use my allocation in the plan** (at the mix, filled in with the allocation as it was when pressed). The sheet scrolls its own body there, never the page. The mix is set in one place: the allocation card's confirm sheet (`UseMixForm`), and the savers' `allocationMix` and `method` paths, are gone. The sheet says "Your plan's simulation uses 75% stocks, 25% bonds, 0% cash until you save." while the mix typed differs, and keeps the confirm's "The plan keeps this mix until you change it…". When the plan takes the mix and the button goes, focus comes back to Portfolio's "For your plan" heading.
- **Will it last?** has a heading and its method as meta ("Historical cycles" or "Monte Carlo"); the History · Monte Carlo switch and Change are gone, both in the sheet. The short label is a line of its own under the definition (`HYPOTHETICAL_LABEL` in `components/plan-text.ts`), the worst starting years are behind a disclosure, and its Assumptions list is gone: method, mix, rule, withdrawals once a year, fee and tax are in the sheet, the data sources in About these numbers. What it takes from Your path (placed income, placed one-offs, a scenario's life events) stays, under "From Your path".
- **The grid** has a heading; it keeps the label. It runs to the card's edges, as the calendar's days do, its column heads in sentence case at 12px and a flexible rule's "low 85%" at 12px, wrapping after "low" where a cell is narrower than it (a 320px phone, where six columns are 46px).
- **Badges**: while Stress test's notice is shown, "An input may be low" (or "Inputs may be low" with two notes) on Will it last? and the grid, on a line of its own under the title (at 320px the title, a badge and "Monte Carlo" don't fit one row).
- **Stress test's last card** (`StressRows`): **Assumptions**, its sub what is set ("Historical cycles · 75/25/0 · Constant · 0.1% fee"), and **About these numbers**, a row opening a sheet with the full statement, the data and what the numbers can't say, in the About card's words. Shown whatever the plan's state, as the About card was. Focus comes back to the row as its sheet closes.
- **Compare's notes** keep the short label, and say About these numbers, on Stress test, says more.
- **The fan chart** (`components/PlanFanChart.tsx`) is drawn at its width (`useDrawnWidth`), in its shape (160 to 340), 4px more under its baseline for 12px ages; gridlines widen their step until 20px apart (`MIN_TICK_GAP`), the ages step 5, 10 or 20 years until their labels are apart, and the money gutter is sized from the tick values (never from the figures written, which hide amounts masks).
- **`.plan-heading`**, a 13px heading for a part of a Plan card or sheet, in sentence case, used by the sheet's two parts, "From Your path" and Portfolio's "For your plan" (an h3, where it replaces `.plan-subhead`'s 11px capitals).

**Decided in 6d:**

- **Plain words**, with the FI terms as labels (information-architecture.md's vocabulary). "Real return" is "growth after inflation" everywhere it is said (the FI card's notes, Coast FI, the projection, the sheet's field, Your figures' Assumptions sub "5% growth after inflation until FI", the repair card, a scenario's changes, VPW's rule, and Home's FI line: "a 4% withdrawal rate and 5% growth after inflation"). "Target age" and "retirement age" are "stop age" (the Ages sheet's field and its intro, now "Your stop age is when you would like to stop working: the stress test starts there (unless it starts with what you have today), and Coast FI counts the years to it.", the Ages sub "40 now, stop at 55", Coast FI's need, scenario changes and problems, life events' notes, the scenario store's one error). "Retire(s)" is "stop(s) working" in the simulation's setup ("Stop working at 65 with…") and the start choice ("Stops working at your stop age…"), and a scenario's name suggestion is "Stop at 50". The withdrawal rate's line says "how much you'd draw each year", and Coast FI's note "With this much invested today you could stop saving now: growing 5% a year after inflation, it reaches your FI number by age 55." Kept: "financial independence", "FI number", "Coast FI", "Barista FI", "withdrawal rate" as labels; "in retirement" (spending in retirement); the rule and method names. Nothing says "retire early".
- **Ages stays its own row** beside Assumptions (as the mockup draws them): the ages are facts and a goal, not assumptions, and the sheet is long enough.
- **The row titles keep their labels** ("Annual spending"), as the mockup now draws them.
- **About these numbers is a row that opens a sheet**, as the mockup draws it, rather than a disclosure on the page: it is read once, and its 461px of prose is what made Stress test long.
- **The grid stays a card**, not the mockup's "By withdrawal rate and length" row: its figures are the point, and a sheet would hide them a tap away.
- **One name for a method**: "Historical cycles" on the card, its row and in the sheet, where the switch said "History".
- **Words that changed because a place did**: "start from your FI number (Change)" and "Type the balance to start with (Change)." say "(Assumptions, below)"; the grid's "everything else as above" is "everything else as your Assumptions set it"; the FI card's "Can't be worked out from the saved withdrawal, tax or return rate" is "…withdrawal rate, tax or growth after inflation". The card's "The method is your plan's: every scenario uses it, so they compare. Change it with your plan open." is gone with the switch: the sheet says "The method is the same in every scenario: change it with your plan open." beside the field. No caveat changed its level.

**Kept narrow in 6d:**

- **The sheet's buttons are at the end of its body**, as every Plan form's are, not in `Sheet`'s footer: on a phone Save is a scroll down. Moving the Plan's forms to the footer is one change to all of them.
- **A save of one part re-reads the other**: the form keeps every field as text, so a stored value off the forms' precision (a fee of 0.123%) is saved as the field shows it, as the simulation form did. A stored value no field takes is repaired before any sheet can save.
- **`.at-width` stays**, with the charts' hex gridline colors: Home's net worth, Reports' runway and the Plan's allocation charts are still on a fixed viewBox.

**Risks:** the plan's saved inputs and scenarios are unchanged (layout only); the forecast's threshold and what-if keep their behavior; every caveat the Plan tab shows keeps its words and level, and each PR that moves one says so (diff the rendered text before and after, as 3b did).

## Phase 8: The Plan track

Runs after phase 6 and before phase 7. The engine is built (`lib/fire/`); what holds the tab back is that it never draws your path, and life events are hard to find. The phones are in [mockups/index.html](mockups/index.html#plan).

**Decided (2026-10-25):**

- **The first answer is against your stop age**: "Around age 39, 16 years before you stop at 55", or "3 years after". With no age typed, the card asks for it first. Home's FI line says the same words.
- **The first chart is one line**: invested assets from today to your stop age at a steady return, the FI number as a flat line, an FI marker and the stop age, with "Show as a table" and a text summary. No band, no actual history and no event pins on it yet: the band stays on Stress test, snapshots keep no daily invested total (and are in nominal dollars, the plan in today's), and pins can't be 44px targets at four pixels a year.
- **Life events stay in scenarios.** A **What if…** card on Your path offers templates; picking one asks for your own figures, shows how it moves your FI age, and "Try it" creates a scenario named after it ("Buy a home at 38") and opens it. The card lists the scenarios as life choices, each with its FI age. Your plan stays what you have locked in.
- **No suggested amounts** in templates: nothing is filled in, and nothing suggests what a home or a child usually costs (as [features.md](../features.md) already says of life events).

**8a**, the path as a pure function: the year-by-year balances the walk already computes and discards (`walkBalanceAt` in `lib/fire/events.ts`), returned as a series, with property tests (no value from nowhere, the series meets `view.atTargetAge`). Nothing stored changes.

**Built in 8a:** `planPath` (`lib/fire/path.ts`) gives one plan's invested assets a year a point, from today's age to the stop age (or as many years as asked for), with the stop age, the FI number and the FI age. With life events that change the walk, the points are the walk's (`walkPath` in `lib/fire/events.ts`, which `walkBalanceAt` now reads); otherwise `projectBalance` at each whole year, the closed form `fiView` uses. `projectFrom` (`lib/fire/plan.ts`) is the one gate for what a balance is projected from, which `fiView`, `planFigures` and the path share, so the point at the stop age is `atTargetAge` to the bit. `test/fire-path.test.ts` holds it by hand and over 600 generated plans: no balance from nowhere (each year of the walk is the one before, less its cost, grown, plus its savings; never below zero), the point at the stop age is `atTargetAge` and is there exactly when it is, every point is the walk's or the closed form's, it stops where the FI date's walk stops within it, and it reaches the FI number by the year the FI date says.

**Fixed in 8a:** a scenario's balance at the stop age ignored its life events when there was no FI number (no spending): a home bought from investments at 42 left "At age 55" where it would be without the home. It now comes from the walk whenever an event changes it. Where the walk can't get there, the At age row says why ("You'd have about $653,750 at 42, less than the $900,000 it takes from your investments, so nothing is projected at 55: change the cost, or when it comes.") instead of going without a word.

**For 8b, from 8a's review** (each settled in 8b, below):

- **Below zero.** With no life events and savings below zero, the closed form goes below zero ("At age 55" can say -$7,893 today), where the walk stops with words. Decide whether the projection stops there too, or the chart's axis takes negatives. (It stops there too.)
- **The path can stop where the FI date doesn't.** A plan already at FI whose savings are below zero for good has an FI date today, and its walk runs out before the stop age: the path ends early with `short`, and `atTargetAge` is null. The chart and the headline say both. (They do.)
- **The Plan's own stored ages aren't range-checked** until a repair. (They are: the tab works from `repairPlan`'s plan, which `parsePlan` range-checks, so the tab runs `planPath` for the Plan too.)
- **The path ends at the stop age**, as decided; `planPath` takes a length, so a marker after it ("3 years after you stop at 55") can be drawn by asking for more, if 8b decides to. (It doesn't: the words say it.)

**8b**, the headline and the path chart:

- The headline and progress, with the caveats that sit on the FI number today kept there, critical ones in full.
- The chart (a new component pattern: design-system.md gains it in this PR), drawn with `useDrawnWidth` and through `lib/format.ts`, added to the hide-amounts render test, with a `role="img"` summary and a table.
- Home's FI line takes the same words in the same PR, so Home and the Plan agree; the review's FI-line items from 4c land here.

**Built in 8b:** the FI card opens with the answer (`fiHeadline` in `components/plan-text.ts`, one function for the Plan and Home): "Financial independence", then "Around age 53" and "2 years before you stop at 55" ("3 years after", "Right when you stop at 55"); "In about 13 years" without an age; "You're at FI", and under any answer "At these savings it runs out at 71 (below)" when the projection runs out before the stop age (at FI already, or after a scenario reaches it); "Not reached at this savings rate"; "Not before age 100 at this savings rate" past 100 (the row's note still gives the years); "No FI date" when the walk can't pay a cost; "--" when it isn't worked out. While an age is missing, a button under the answer opens the Ages sheet ("Add your age and when you'd like to stop", "Add your age", "Add when you'd like to stop"); focus comes back to it, or to the Ages row once it has gone. Then the meter and "$250,000 of $1,000,000 invested · 25% of the way" ("$2,000,000 invested · 200% of the FI number" past it), the FI number's own line ("FI number $1,000,000: $40,000 a year ÷ 4% withdrawal rate") and the caveats that were on it, in their words and levels. Then `components/PlanPathChart.tsx`: one line from today to the stop age (`planPath`), the FI number dashed, a marker where it is reached, the stop age, its ages spaced by width, a summary through `spoken()`, "At a steady 5% a year after inflation. Real markets don't move steadily; Stress test shows how much that matters." and every year behind Show as a table. Home's FI line: "FI around age 53, 2 years before you stop at 55" over "$250,000 of $1,000,000 invested (25%) · 43% savings rate, last 12 months"; "Plan defaults" on the line with no plan saved; a line when the saved plan can't be read (the store says so, or this release can't take its shape), never for a request that failed.

**Decided in 8b:**

- **The projection never goes below zero.** `projectionShort` (`lib/fire/fi.ts`) finds the first year a steady projection would end below zero (by halving, since it is monotone, so any stored span is cheap), and `fiView`'s `atTargetAge`, `planPath` and `startsWith` all stop there, as the walk does; the At age row says where, for the Plan as for a scenario ("You'd have about $2,007 at 54, and that year takes $10,000 out, more than there is, so nothing is projected at 55."), and a plan started from its FI number at such a stop age "would never get that far". Nothing compounds below zero: invested assets below zero, with savings that don't lift them over zero by the end of the first year, stop the projection at once ("Your invested assets are below zero"), as the walk does; savings that do lift them are drawn climbing out.
- **Without an age, the answer is the years**, with the ask right under it (Home says the years too, so the two agree); the ask shows whatever the years are.
- **Home's title is the whole answer**, since `.list-row-title` wraps.
- **No marker past the stop age**: the line ends there and the words say "3 years after you stop".

**Kept narrow in 8b:**

- Coast FI and Will it last? stay rows of the FI card and Stress test, not the mockup's rows on Your path.
- The Years to FI row's note keeps its own words ("Around age 1139") under a headline that says "Not before age 100".
- No band, no actual history (8e draws it on this chart: it takes points from any first age, with today apart) and no event pins.

**8c**, the What if… card: templates for the kinds that exist (house, child, sabbatical, part-time, spending change) that create a named scenario; the effect shown as you type; the scenarios listed with their FI age. Nothing stored changes shape: a template makes an ordinary scenario.

**Built in 8c:** `components/PlanWhatIf.tsx`, a What if… card on Your path under Your figures, with its words in `components/plan-what-if.ts`. A chip per template (Buy a home, Travel or a big expense, A child, A career break, Part-time work, A change in spending) opens the life event's own form (`EventForm` in `components/PlanEvents.tsx`) in a sheet, with nothing filled in but the event's name. As it is typed, an info notice says how it moves the FI age, from the same `planFigures` the scenario opens with ("In this what-if, FI moves from around 52 to around 56 (4 years later).", the one line announced as it changes), what of the event is left out and why (the Life events card's words), and the scenario Try it makes. **Try it** creates your plan with that one event as an ordinary scenario, named after it ("Buy a home at 45", "Part-time work from 55", " (2)" when the name is taken), and opens it, focus on the bar's heading. Under the chips, every scenario is a row with its FI age against your plan's ("FI around 47, 5 years sooner", "No FI date: a cost it can't pay from its investments", "Not worked out: open it to see why"); a row opens it. `EventForm` gained optional props for this (the starting name, the button's words, where it saves, and a preview drawn from the event as it would be saved); the Life events card passes none and is unchanged. `test/plan-what-if-view.test.tsx` holds it in the tab.

**Decided in 8c:**

- **On your plan only.** A template makes a scenario of your plan, and each row's "later" or "sooner" is against your plan, so inside a scenario the card would read as changes to the open one, whose Life events card is already there. Opening a scenario hides it; Back to your plan brings it back.
- **The ages as the FI card says them.** Each FI age is rounded as "Around age 52" is, and the difference is between the rounded ages, so "FI around 56, 4 years later" adds up on its face. Compare mode keeps its tenths of a year. A plan with no age to set against another says the FI card's own headline (8b's `fiHeadline`: "You're at FI", "Not reached at this savings rate", "Not before age 100 at this savings rate"); the move itself is against your plan, not the stop age, so the headline's "before you stop at 55" isn't reused.
- **What the preview can't say as a move.** Part-time work counts from the stop age, never in the FI date: the preview says it stays, and why. A cost the walk can't pay says so with its amounts, masked when amounts are hidden. Lasting changes below zero say that nothing is worked out.
- **Two templates for one kind.** Travel or a big expense and A change in spending are both the spending kind: the first a cost for a while, the second the lasting or lower change, as the rollout named it.
- **The home template is the home kind's form**: one change in yearly spending, for some years or for good, not the mockup's two (costs that end and a lasting change), which no kind holds yet. The mockup's template phone now draws the form as built.
- **Nothing to place without an age.** With no age typed the chips are off, and the card says to type it first, as it does while your plan has no currency for a scenario's amounts; with ten scenarios stored (unreadable ones count, as the server counts them) they are off and it says why. The card is drawn only once your saved plan has loaded, never over the defaults.

**Kept narrow in 8c:**

- **No More… sheet.** Six chips wrap at 320px; the mockup's More… sheet, every template as a row with a line under it, arrives when 8d's four templates (a car, a raise, a windfall, a loan ends) make them too many.
- **`EventForm` keeps its classes.** Its note (`.panel-note` with an inline margin) and its buttons (`.button-pair` in the body, not the sheet's footer) are as the Life events card has them; the form moves to the primitives with the next change that takes the whole of it, so 8d's edits to the same file stay small.
- **No icons on the rows.** The mockup's letter in a circle beside each scenario stands for its kind, and a scenario can hold several kinds or none: the rows are name, FI age and chevron.
- **No record of the template.** A scenario made from one is an ordinary scenario; nothing stored says which template made it.

**8d**, new kinds, each a new shape in the scenario store:

- A car, once or every few years, saying that car loan payments are already in measured spending.
- A raise: more saved each year until FI (never a change to retirement spending).
- A windfall: money in at an age, with its own path in the walk and the simulation (both take only positive costs today).
- A loan ends: spending falls for good at an age.

Ship each kind's shape once: an older release reads a scenario with a kind it doesn't know as "not understood".

**Built in 8d:** four kinds in `lib/fire/events.ts`, each a closed shape: `car` (`atAge`, `cost` from investments, `every` null and `times` 1 for one car, or every 2 to 30 years, 2 to 20 in all, the last within the ages a plan takes), `raise` (`fromAge`, `yearly` more saved), `windfall` (`atAge`, `amount` after tax) and `loan-end` (`atAge`, `yearly` less spent, for good). An older release's `isLifeEvent` refuses a kind it doesn't know, so it lists such a scenario as not understood (`unrecognised_ids`), never as damaged; `test/plan-scenarios-routes.test.ts` holds that for a kind this release doesn't know. Money in is its own path: the walk's `moneyIn`, at the start of its year, before that year's costs (a windfall can pay a cost in its own year, and a shortfall's "you'd have" includes it); `walkPath`'s balances stay before both, so a simulation starting then takes the windfall itself, as income for its one year. A raise is a span of more savings for good, in the walk only; a loan paid off is a lasting change of less spending (before the start age, in the FI number). A one-time event wholly before today is left out with a note (`already`): today's measured figures may count it, and a raise or a paid-off loan counted again from today would count twice. Forms in `components/PlanEvents.tsx` beside the existing ones, unchanged. 8a's properties are extended to generate the new kinds: "no value from nowhere" and "meets the FI date" now count each year's money in, a new one says the only money in is the windfalls', and another that each new kind moves the FI date one way only (a windfall, a raise or a loan paid off never later, a car never sooner).

**With 8b's chart:** where the FI date is reached on the day a windfall comes in, it is a whole year, and the path's point for that year is the balance before the windfall (as before a cost), below the FI line at the FI age, so the marker floated off the line. A point in a year with money in now says what is in hand then (`inHand`: plus the money in, less that year's costs, where they can be paid), the chart's line steps up to it at that age, with the marker on the step, and its table row says both. The point at the stop age stays `atTargetAge`. 8b's closed-form stop (`projectionShort`) never meets money in: any event makes the path the walk's. **With 8c's card:** 8d merged second, so its kinds are templates on the What if… card too (`WHAT_IF_TEMPLATES` in `components/plan-what-if.ts`): Buy a car ("Buy a car at 45"), A raise, A windfall and Pay off a loan, each opening its own form with nothing filled in but the event's name, held in `test/plan-what-if-view.test.tsx`.

**8e**, progress against your plan: when you say "this is my plan", save its assumptions (never a result) and draw actual invested assets against it, through a route that sums each day's invested accounts by the Plan's rules (hidden accounts, include cash, currency). A new store, so it is in the download, the deletion and the privacy page from the first PR.

**Decided for 8e (Fue, 2026-10-26):** snapshots are in each day's money and the plan in today's, so saving a plan also saves an inflation rate (3% unless changed in the save sheet) and the plan is raised by it to compare; the saved plan stays as it was until it is saved again, and a change to what the comparison rests on is said, with a confirmed resave; the card is the last on Your path, with the line on 8b's chart; it keeps the annual savings the Plan used and no invested assets: the start is added up again from that day's recorded balances by today's rules, so an account hidden since counts the same at both ends.

**Built in 8e:** the `fire-plan-saved` value store (`lib/saved-plan.ts`, shape and `plannedAt` in `lib/fire/saved-plan.ts`) through `/api/saved-plan`, a compare-and-set against its `rev`; in the download, the deletion, restores as `data`, the inventory on Your data (which the privacy page points to: it lists no store by name, and its "Your data" retention row holds), data-export.md and operations.md. `POST /api/invested-history` sums each day's measured balances by the saved plan's rules (include cash, currency, the day), following links with one balance per account a day, leaving hidden accounts out by every id, counting an ended account before its end, converting at each day's rate with a home currency, and marking a day missing an account short; it answers the first whole day, the newest day and the last whole day of each month. The Progress card (`components/PlanProgress.tsx`) holds the save, its sheets, the words about progress and Stop comparing.

**And on 8b's chart** (8b merged while 8e was built, so it is in the same PR): with the Plan shown, two lines before today, where the path starts: what was recorded (the start and the last whole day of each month, `progressOverlay` in `components/PlanProgress.tsx`) and where the saved plan had you on those days (`plannedAt`), the axis reaching back to the start's age; the Progress card and the chart read one `useProgress` in the tab. Kept narrow: one saved plan (no history of earlier ones), nothing on Home, and nothing in the API or the MCP server.

**Later (the master plan's ProjectionLab track):** milestones that events can start or end at, a home as an asset with a mortgage, balances by tax bucket and a drawdown order, a flat tax per bucket, a year sheet, and the band along the whole path.

**Risks:** money math (8a, 8d and 8e get an independent review before they merge); Home and the Plan must agree on every figure and word; the rule that every result says it is hypothetical; hide amounts on every new figure.

## Phase 7: Light theme

- Turn on the light token block and the theme setting in Settings > Preferences.
- Charts, tag colors, the Sankey and print checked in light.
- Rerun the contrast check on the final tokens.

**Built:**

- The light theme in `app/globals.css`: `tokens.css`'s two light blocks, after the dark one (both light selectors outrank dark's `:root`). Dark when the device is dark or says nothing, light when it is light.
- **Settings > Preferences > Theme** (`components/ThemeCard.tsx`, first in the section): System, Dark or Light, a radio group drawn as a segmented control. The choice is a cookie (`nya-theme`, `components/theme.ts`) that the root layout reads, so a page is sent in it: `data-theme` on `<html>`, the chrome color, `color-scheme` and iOS's status bar style (`lib/theme.ts`). No script runs before paint, and nothing changes under the nonce-based policy. A change applies at once; other open tabs follow on their next load.
- Every dark-only color in the app's CSS and charts is a token now, and the guard's raw-color baseline is empty:
  - borders and dividers went to `--border-subtle` and `--border-strong`, and a text field's edge to `--border-input`, which also brings it to 3:1 in dark (the one change dark shows);
  - accent washes went to `--accent-tint`;
  - the backdrop went to `--scrim`, and the sheet's shadow to the new `--shadow`;
  - the attachment viewer is on `--canvas`;
  - the chart gridlines are `--border-subtle`, their crosshairs `--border-strong`, and the comparison lines `--text-3`;
  - the idle-cash chip's and the danger outline's softer edges are `--warn` and `--neg` at 45% and 35%, through `color-mix`;
  - the Plan grid's heat map is `--accent` through `color-mix`;
  - hide amounts' dots in a field are drawn in `--text-1`;
  - the select chevron is one gray at 3:1 on every surface in both themes.
- **Tag colors** are tokens (`--tag-<color>`, `--tag-<color>-tint`): dark keeps its colors, with each tint made solid, and light has a deep step on a pale tint. The Tags screen's swatch is the text step.
- **Print** is the light theme with black and white over it, whichever theme is on screen, under `:root:not([data-theme]), :root[data-theme]` (as specific as the light blocks, after them).
- **Clerk** is styled with the tokens (`var(--accent)`, ...), so it follows the theme; its primary button takes `--accent-fill` (look and feel, step 1).
- **The contrast check** runs on both themes as the app has them, tags included. The guard also holds the app's three light copies (system, chosen, print) to `tokens.css`, `lib/theme.ts`'s `LIGHT` to the app, and the allocation colors at 3:1 on a card in both themes.

**Checked in light**, on a static page with `app/globals.css` at 320px, with the device set to light and to dark:

- the theme card (44px choices), buttons, fields, the select, hide amounts' dots, chips and badges, notices of all four levels, tags and swatches, the sheet and backdrop, and the attachment viewer;
- the cash-flow Sankey: its labels are 11.8:1 on a ribbon; the ribbons are 1.6:1 on a card, against 1.9:1 in dark, and are left as they are, since each node's bar carries it at full strength;
- the path chart;
- print, with the print rules forced on, with no theme, Dark and Light: black on white, with light's meaning colors, in every case.

**Decided:**

- A cookie, not an account setting or localStorage. A theme is a device's display, like hide amounts. The layout already renders per request, so a cookie needs no script before paint.
- The allocation views keep their class colors: each already passes 3:1 on a card in both themes, so there are no light copies to keep in step.
- Clerk takes `var()` in every theme, not hex palettes per choice. Clerk's docs advise direct values for older browsers, which a pinned palette would only have helped those who pin a theme.

**Kept narrow:**

- No light app icon or install splash: the manifest stays dark. (The header's logo had a light version for a while, `public/icons/icon-light.svg`; since the look and feel's step 4 it is a two-ink mark in `--brand-mark`, gold on dark and navy on light, and that file is gone. The favicon and the installed icon are still the filled coin.)
- With System, an iOS home-screen app keeps the white status bar text. iOS has no setting that follows the device's mode, so on a light device the clock reads poorly until you choose Light, which sends the light bar. This needs checking on a device.
- No sync of the choice across devices or open tabs.

## After the rollout: controls and states without color

An audit of the primitives against the design system found what the token check can't see: rules using a token too faint for what it marks, and states told only by color. Each fix is in how a token is used; no token's value changed.

**Built:**

- **Control edges at 3:1.** A plain field (the `:where(input, select, textarea)` rule, so every `.field` input), the invite link's box, `button.secondary` and `.btn.secondary`, `.chip` and the ⋯ button are edged in `--border-input` (3.6:1 or more on every surface), not `--border-strong` (about 1.4:1, which read as no edge). Only `.text-input` had it.
- **Critical and caution told apart by shape.** In light, `--neg` and `--warn` are about 1.1:1 apart, and both notices drew the same triangle. A caution notice now has the clock that Needs attention's caution rows use (`CAUTION` in `components/ConnectionStatus.tsx`; `levelIcon()` where the level is decided at run time), and a critical notice has an edge in its own color. Every notice has a 1px edge, transparent unless critical, so the two stay the same size.
- **The Plan's notices said in full.** Progress's (`components/PlanProgress.tsx`) and What if…'s error had no icon and no level for a screen reader; they are TotalCaveats' `Notice` now, with both.
- **Selected states more than a color.** The selected segment has an inset `--border-input` edge and semibold label (its `--surface` is about 1.1:1 from the track). The current tab has a 3px `--accent` bar over it and a bold label (`--accent` is about 1.1:1 from `--text-2` in dark). A chip that is on has an `--accent` edge and leads with a check, drawn in CSS so no component changed.
- **Cards have an edge.** `--surface` is about 1.07:1 from `--canvas` in both themes, so a card is edged in `--border-strong`, as the Color table always said, at `--r-lg`.
- **The scales, where the base rules strayed:** a bare button's radius is `--r-md` (was 10px), a plain field's and `.text-input`'s `--r-sm` (10px), a sheet's corners `--r-lg` (20px), a card's `--r-lg` (14px).
- **A sheet's title wraps** instead of being cut with an ellipsis: a scenario's name is up to 40 characters.
- **Table headers** are `--fs-1` in sentence case, not 11px uppercase (the small-type baseline falls to 16).
- **The guard** checks the rules above use what they must (`design guard: controls and states read without color`), and that no caution notice draws the critical triangle.
- **Since the look and feel's step 2a**, buttons have no edge and the selected segment is an underline: WCAG 1.4.11 asks no edge of a control its label or icon names, so the edge on `button.secondary`, `.btn.secondary`, the ⋯ and the selected segment went, and the guard checks what took its place. Fields, chips and the invite link keep `--border-input`, as does a secondary on a fill of its own.

**Kept narrow:**

- `.link-btn` (84 uses in 24 files, about 15px tall) stays until each screen's actions move to `.btn.ghost`.
- `button { width: 100% }` stays, as phase 2 left it.
- Card padding stays `--sp-5` on phones: rows run to a card's edges by a `--sp-5` margin, so `--sp-4` would move with them.
- Empty states keep `.empty-note`: a title and an action for each needs its own words.
- The select chevron stays one gray in a data URI: it passes 3:1 on every surface in both themes.

## After the rollout: look and feel

A look and feel review (2026-10-26) found that Nya read like a starter template, and its direction, ink and brass, was approved and recorded in the design system artifact (its `audit.md`, findings L1 to L11). The app takes it in five steps, one pull request each, in this order:

1. **Details**: logo tiles, readable bank names, the repeated account type, the two notices the Budgets and Plan tabs opened on, and Clerk's primary button. No palette change.
2. **Fewer boxes**, in three pull requests: 2a, bare icon buttons, tonal secondary buttons, one underline view switch and no header subtitle; 2b, one month control (2b1) shared by Activity and Budgets (2b2); 2c, Clerk's profile in a sheet.
3. **Type**: Red Hat Text and Display through `next/font`, and the hero's small cents.
4. **Ink and brass**: the new token values in `tokens.css`, `app/globals.css`, `lib/theme.ts`, the manifest and Clerk; the guard's pairs; the header logo as a two-ink mark; underlined links.
5. **The hero**: net worth out of its card, a full-width chart without money ticks, scrubbing.

### Step 1: details

**Built:**

- **Logo tiles.** A merchant's logo (`.txn-logo`) sits on `--logo-tile`, white in both themes, with an inset `--border-strong` hairline, 32px at `--r-sm`: it sat on `--surface`, so a black logo vanished in dark. Its letter fallback stays on `--elevated` in `--text-2`. Split parts and group members are set in past the 32px tile.
- **Readable bank names.** A row whose name is the bank's own descriptor (Plaid gave no merchant name) carries `name_from_bank` (`lib/transactions.ts`, taken off when a rename or a rule's name replaces it), and Activity's rows, a group's members, a transaction's sheet and its menu, the split, group and shared cost sheets, and Card Mode (its card and what it announces) show it through `shownName` (`lib/merchant-name.ts`): "CREDIT CARD 3333 PAYMENT *//" reads "Credit Card 3333 Payment". Search, rules, the rename field, the API and exports keep the bank's text.
- **No repeated account type.** An account's subtitle leaves out its type when the bank's own name already says it ("Plaid Gold Standard 0% Interest Checking", not "... Checking · checking"; `accountKind`, `components/accounts-format.ts`).
- **Budgets' starter-sets offer** is a card of primitives: an `<h3>` in its `.card-header`, one `.helper` line and a `.btn-row` (`components/TemplateOffer.tsx`), in place of five lines of text and bare buttons.
- **The Plan's currency** is one line (`.plan-currency-quiet`) while the accounts, the spending and the last answer all agree with it, and the card otherwise. It is the same element in every mode, so focus moved to it after an answer stays (`components/PlanCurrency.tsx`).
- **Clerk's primary button** takes `--accent-fill` through `elements.formButtonPrimary`, so its white label passes (5.17:1); `colorPrimary` stays `--accent`, which Clerk also uses for its links (phase 2's reason, above).

**Kept narrow:**

- The net worth chart's money ticks, drawn over its plot at the left, stay until step 5 takes them off the plot.
- Recurring bills, the calendar, Upcoming and Home's This month still show the bank's text: their rows don't say whether a name is the bank's or one the person typed.
- "1 institution connected" under the header went in step 2a.
- A row stored before Plaid's merchant name was kept apart from its descriptor holds the two merged, with no merchant name, so an all-capitals merchant name there (IKEA) shows in title case. Only old rows are stored that way.

### Step 2a: edges off controls

Step 2 is three pull requests: 2a takes the edges off controls; 2b gives Activity and Budgets one month control and one month; 2c puts Clerk's account screens in a Nya sheet, after a prototype (which failed its gate, so 2c shipped the fallback: below).

**Built:**

- **Bare icon buttons.** `.icon-btn` is bare: no edge or fill, its icon in `--text-2`, `--elevated` on hover, and a transparent 1px edge that forced colors draw. The header's Hide amounts and Refresh, the password mode's gear, Settings' back, the month's arrows, the Plan's back and a card's ⋯ (whose own outlined rule went) are all one. Hide amounts on is its crossed-out eye in `--accent`. A sheet's close and back stay filled circles.
- **Tonal secondary buttons.** `button.secondary` and `.btn.secondary` are an `--elevated` fill with a `--text-1` label and a transparent edge, `--border-subtle` on hover (`--raised` is `--elevated`, no step). A ghost is underlined on hover, so it never looks like a secondary at rest. On a fill of its own (a notice, the rule offer and its preview) a secondary keeps its `--border-input` edge on no fill, since the same fill on the same fill vanishes. Open reports and Download as CSV (`.report-link-button`) are tonal too.
- **One underline switch.** `.segmented` has no track: a 1px `--border-strong` rule, 44px items, the current one semibold over a 3px `--accent` bar (a bottom border, so forced colors keep it). `.segmented.compact` (12px labels, items narrower than 44px) fits the net worth chart's eight ranges at 320px. `Segmented` (`components/Segmented.tsx`) draws it as a radio group or tabs, with one tab stop and the arrow keys, for the net worth range and Runway's window (`.chart-ranges` of `aria-pressed` buttons before), the Plan's `Choice`, the kind of report (a primary and a pressed secondary before), and, as tabs over one panel, Allocation's two views and which report shows. The Plan's compare pick, which chooses several, is chips; one that would leave fewer than two plans or more than four stays focusable and says why. `.chart-ranges` and `.chart-range` are gone.
- **No header subtitle.** "N institutions connected" left the header; with nothing connected the connect card says it, and with every account hidden Home's total says so in an information note. The header row is centered and keeps `--sp-6` under it.
- **The guard** changed with the design (below, under controls and states without color): a secondary and an icon button must keep their transparent edge, a secondary on a fill of its own its `--border-input` edge, the current item of a switch its `--accent` bar and its weight, and every icon button an `aria-label`.

**Kept narrow:**

- Month controls stay as they are until 2b (2b1 gave them one control).
- `.link-btn` stays, as before.
- Spending's period chips stay chips: four labels as long as "Year to date" don't fit one row at 320px.

### Step 2b1: one month control

2b is two pull requests: 2b1 gives the three places that change a month one control, each keeping its own month; 2b2 has Activity and Budgets share the month.

**Built:**

- **`MonthStepper`** (`components/MonthStepper.tsx`, `.month-stepper`): bare arrows labelled Earlier month and Later month that stay focusable at either end, the month's name with a native select laid over it and its chevron alone (the return button is never under it), and a ghost return button after the name while another month shows. Pressing that moves focus to the list (or the name, which takes `tabIndex={-1}`) before it goes.
- **Activity** gains the list of its months, the newest 12 with transactions, and **This month**; while this month has no transactions yet, the tab opens on the latest month with transactions and the button says **Latest month**.
- **Budgets** keeps its months, back to the first with transactions, ten years at most, and gains **This month**. `#budgets-month-title` stays the name's id, for Home's alerts.
- **The calendar** says Earlier month and Later month (it said Previous and Next), **This month** (it said Today, and still takes focus to today's cell), and gains a list of its months, named "Calendar month" apart from Budgets' bar.
- **At 320px** the return button doesn't fit beside the name (on Activity, beside the ⋯, the name would get 45px of the 132px "September 2026" needs) and wraps under it, as the calendar's Today did; the arrows and the ⋯ keep to the first line. While the button shows, the panels' jump offset is one 44px row more (`:has(.month-stepper-back)`), a gap where it doesn't wrap, never a target hidden under the bar.
- `.budgets-month-pick`, `.activity-month-name`, `.cal-head` and `.cal-title` are gone; `chevron`, `LEFT` and `RIGHT` move to MonthStepper, and ActivityBar passes them on.

**Kept narrow:**

- Each tab keeps its own month, and loses it on leaving the tab, until 2b2 (built: below).
- The select's own name and the name's live region both say a month chosen from the list.
- The fit at 320px has 12px to spare on Activity at the month the tab opens on: measure again after step 3's font change.

### Step 2b2: one month

**Built:**

- **The shared month** (`components/view-month-state.ts`): the dashboard holds the month Activity and Budgets show for the session, as it holds their segments, never in the address. Null is each tab's own default; a tab writes null when it lands on its default (Activity's month it opens on, Budgets' this month), so a stored month never goes stale on the 1st, and the return button and the arrows agree. Only navigation writes it: the arrows, the list, the return button and Activity's Net by month.
- **Activity** shows the month asked for when it has transactions, else the latest month with transactions before it (never a later one, which could be its default while a past month is shared), else its oldest. A cash-flow pick holds its month locally, so a pick never moves Budgets.
- **Budgets** shows the month asked for, this month for a later one, ten years back at most. It is never moved to the first month with transactions: a bank's stored rows that couldn't be read make that later than months Activity lists. The list runs from the earlier of the two, so the month shown is always on it.
- **A past month says it is read only**, at the top of the Month panel (not the pinned bar, whose height sets the jump offsets): "September is shown as it was. To change a budget, go to this month." (`.helper`).
- **Home's links reset it**: `resetsMonth` in `view-month-state.ts` says, for every kind of link, whether it does (budget alerts and the review count do), so a new kind doesn't typecheck until someone decides.

**Kept narrow:**

- The calendar on Upcoming keeps its own month: it runs a year ahead.
- Each Activity-to-Budgets visit on a past month reads that month from the server, as picking it on Budgets does.
- The two tabs can name different months for one shared month (Activity's nearest with transactions, Budgets' this month for a later one).

### Step 2c: Clerk's account window

2c was to put Clerk's account screens in a Nya sheet, after a throwaway prototype. The prototype (Clerk 7.9.7, the Alex demo account on the dev server) failed its gate, so 2c ships the fallback.

**What the prototype found:**

- **The layout:** Clerk lays its profile out by the window's width, not the space it is given. In the 440px panel on a desktop window it draws its 880px layout, its menu of pages beside the page, and overflows. Narrowing it took about ten overrides, some into wrappers with only internal class names, in a script that loads from Clerk's CDN and can change without Nya changing.
- **On a phone** its narrow layout fits, but its own page switcher is a second header under the sheet's.
- **What worked:** hash routing kept the address; Clerk's popovers sit above the sheet and close on Escape without closing it. Clerk adds its own Manage account back to the menu when it is left out, which one `appearance` rule hides.

**Built:**

- **Manage account in Settings > Account** (`AccountSettings`, the section's card): it opens Clerk's account window with Nya's Data & privacy page (`ProfileWindow`: `openUserProfile` with a custom page drawn through a portal from Nya's own tree, so `DeleteAccount` keeps Clerk's context). Before, the section only pointed at the avatar menu, since `openUserProfile()` alone left the page out. Sign out stays the avatar menu's alone.
- **Clerk's radius** is 8px (`--r-sm`), not 10px.
- **The account menu's rows** take `.menu-item`'s metrics (44px, `--sp-2` by `--sp-3`, `--fs-3`), Clerk's own rows and those Nya adds alike.

**Kept narrow:**

- Clerk's account window stays Clerk's own, centered.
- The avatar's initials, in place of Clerk's gradient picture, are a setting in Clerk's dashboard (Customization, Avatars), not code.

### Step 3: type

**Built:**

- **Red Hat Text and Display** through `next/font/google` in `app/layout.tsx`: fetched when the app is built, served from the app, latin preloaded for both (Display draws Home's total). No italic file, which next/font would preload on every page: the two places that slant (an excluded tag, an estimated day) take the browser's slant. `--font-ui` and the new `--font-display` name the family after next/font's variable, so `tokens.css` holds the same lines and a static check page still gets Red Hat.
- **Display** for titles and figures, in one rule beside the tokens (design-system.md, Type); the guard holds it there. A heading drawn as a label keeps Text.
- **Clerk** takes `var(--font-ui)`; `FONT_UI` in `lib/theme.ts` is gone, and the guard checks Clerk's font is the token.
- **The hero's cents** at half size in `--text-2` (`moneyRuns` in `lib/format.ts`; `fullMoney` is now its runs joined, so the two can't differ). The amount scans know `moneyRuns` as a formatter.
- **Measured at 320px** against main, on the Alex demo account. Both families have true tabular figures. The hero, the chart's ranges, the month stepper (8px to spare on both), the period chips, Budgets and the Plan fit as before. Two places changed:
  - **In / Out / Net** overflowed its card on main already (by 8px) and by 26px in Display. Its figures are now `clamp(15px, 4.6vw, 17px)`, 17px from a 370px screen, and the row wraps its last figure under rather than past the edge.
  - **A badge in a row's second line** (an account's "$12,461.24 uninvested") was cut off at the edge on main and more so now. It wraps inside the row instead.

**Kept narrow:**

- The type scale is unchanged: it already matched the artifact.
- The print footer's page boxes keep the system stack, which they spell out (next/font's family names are hashed).
- The hero stays in its card until step 5.
- An institution's name beside its total can take a line more at 320px (Red Hat's figures are wider): it wraps, nothing is cut.

### Step 4: ink and brass

**Built:**

- **The palette** from the design system artifact, in `tokens.css`, `app/globals.css` (dark, light by system, light chosen, print's copy), `lib/theme.ts` and the manifest: an ink canvas (`#0b1019`) and a cool paper (`#f4f5f8`), brass for action (`#d4b680` dark, `#846326` light), orange for caution (`#fb9a4b`, `#a3410b`), and the text, line, tint and meaning steps that go with them. Tags and the danger fill keep their colors.
- **The primary** is brass under an ink label in dark and the logo navy under white in light: `--accent-fill` with the new `--on-accent-fill` (8.98:1 and 15.46:1; white on the brass fill would be 2.12:1). Clerk's primary states take the same label. Danger keeps `--on-fill`.
- **Links inside a sentence are underlined** (`a:not([class])`): brass is 1.65:1 from body text in dark and 3.21:1 in light. Bare links had the browser's blue outside five places that set the accent; those five rules went. The one `.link-btn` inside a sentence (switching from another app) and Clerk's "Sign up" and "Forgot password?" are underlined too.
- **The header logo is a two-ink mark** (`BrandLogo`, one inline SVG): the ring and the cat's face in `--brand-mark`, gold on dark (7.82:1 on the page) and navy on light and in print (14.18:1), the rest cut away by a mask so the page is its disc. Its mask id comes from `useId`. In forced colors it takes the forced text color. `public/icons/icon-light.svg` and the theme toggles for two images are gone; the favicon and installed icons stay the coin.
- **What brass and orange would have left to hue alone** (about 1.1:1 apart in dark), each given a second cue:
  - a budget's meter from 85%, which has no word until Over, is hatched in `--warn` on `--warn-tint`;
  - the forecast's what-if is a `--text-2` dotted line (`0 4`, round caps) beside the forecast's brass dashes, its scrub dot and its low point with it, and no longer `--warn`, which means caution;
  - Runway's without income is dotted beside with income's dashes (brass and coral, 1.26:1);
  - those two legends show each line's sample (`LegendLine`, `components/LegendLine.tsx`), not a dot;
  - the calendar's planned dot is a brass ring and a payment due an orange square.
- **The Plan grid's "low" line** is `--text-1`: `--text-2` on its strongest cell was 2.89:1 on main and would have been 2.39:1.
- **The guard** pairs `--on-accent-fill` on `--accent-fill` and on `--accent`, and `--brand-mark` on the page and a card; checks that every rule filling with `--accent-fill` labels it `--on-accent-fill`, and Clerk's foreground; and needs the underline, the hatch, the calendar's shapes and the mark's `forced-color-adjust`.

**Measured:** every pair in the guard passes in both themes (the tightest is `--pos` on `--elevated` in light, 4.81:1); the allocation colors are 3.07:1 or more on a card; the Plan grid's own-cell outline goes from 2.55:1 to 3.09:1 against its strongest cell. Checked on the dev server as the Alex demo account at 320px and desktop, in both themes (Home, Accounts, Activity, Budgets, Upcoming's calendar, the Plan, Clerk's menu, the theme-color meta and the manifest), and on a static page with `app/globals.css` for the meter's three states, the forecast with a what-if, the calendar's legend, the grid's cells, links and buttons.

**Kept narrow:**

- Income and bill dots stay told apart by hue, as before.
- `.link-btn` in a row stays as it is until those actions move to `.btn.ghost`.
- The net worth chart turns brass with the token; its layout is step 5.
- Forced colors and print weren't seen in a browser: the guard holds the mark's `forced-color-adjust: none` and its `--brand-mark` color, and print's copy of the tokens; the forced text color it takes there is unchecked.
- The caution hatch also reaches an account's credit-utilization meter, which turns to caution from 50%.

### Step 5: the hero

**Built:**

- **Out of its card.** Home's net worth (`NetWorthCard`) is `section.stack.net-worth-hero` on the page: what it holds and its order are as they were, `--sp-6` under it where the card's margin was. A notice there keeps a `--border-subtle` edge (an information notice's fill is about 1.0:1 from the canvas in light).
- **The figure** is at `--fs-hero` (32px on a 320px phone, 40px from about 445px; it was a fixed 40px), never wrapping, its cents at half size as since step 3.
- **The chart** (`NetWorthChart` with `hero`): drawn at its own width (`useDrawnWidth`), through `.wrap`'s gutter (now `--sp-4`) to the screen's edges (`.hero-chart`), 120px of plot over 12px months kept inside the gutter and spaced by their widths; no gridlines and no money ticks; a 12% wash; the today dot ringed in `--canvas`; `touch-action: pan-y`, so a vertical drag still scrolls the page. Its readout keeps the range's change, and **Show as a table** lists every day in the range, newest first, once opened. The account and shared net worth charts are as they were.
- **Scrubbing moves the figure.** A pointer's day (a mouse over the plot at once; a finger or pen once it has gone 6px sideways, more than up or down, so the start of a scroll never flashes a day into the figure) goes to the hero through a context (`components/hero-scrub.ts`), from a layout effect, so the figure changes in the plot's frame and only the hero re-renders. The change line's place says the day ("Jul 1 · estimated", and the day's note), its height kept, so the chart under the finger never moves (measured: its top the same before and during). Lifting, a cancelled touch or leaving the plot brings back today; a measurement, a note chosen from the list, new points or the chart going never leave a day behind. The chart is now in the hero's currency, as the figure it moves is.
- **The skeleton** is the hero's shape: on the page, the change line's place, its plot placeholder bled and 140px tall, and a 44px line for Show as a table.
- **Show as a table**'s summary is a 44px target, here and wherever `.plan-table-view` is used (the fan and path charts, and Allocation's two).
- **The guard** needs the hero's notice edge, the figure's `nowrap`, the chart's bleed and `pan-y`, and the 44px summary.

**Measured** on the dev server as the Alex demo account: at 320px the figure is 288px on a 288px line and the chart runs 0 to 320 with no sideways scroll; at desktop width it spans the wrap's full width; scrubbing by mouse moves the figure and keeps the chart's top; light and dark. At 320px, at the figure's full size: -$999,999.99 is 207px, ₩12,345,678,901 248px, -IDR 1,234,567,890 280px.

**Kept narrow:**

- The line's draw-in on first load is left for a change of its own: `clip-path` on an SVG group differs between engines, and only Chromium could be checked. A dash-offset draw-in (`stroke-dasharray` and `stroke-dashoffset`) was considered since and set aside too: on an estimated stretch it replaces the 5 4 dashes while it draws, or slides them along the line, so the estimate would not read as one until it ends.
- A figure past about 280px at 320px (an IDR total over about 10 billion) overflows its line by a few pixels on the narrowest phones; at 40px it overflowed more before.
- Activity's month figure isn't a hero yet. Keyboard scrubbing came later: the plot is a slider in the tab order (`role="slider"`, named by its summary), the arrows move the figure a day at a time, Home and End go to the ends, Escape or leaving the plot brings back today, and its value (`aria-valuetext`) follows the day once the keys rest for half a second, so a screen reader says the new figure once movement stops. Every net worth chart takes it; away from the hero it moves the readout, as a pointer does.
- The account and shared charts keep their ticks and fixed viewBox.
- The plot starts at the screen's edge, where a phone's own back gesture takes a swipe first; `touch-action` can't stop that.

With step 5, the look and feel's five steps are built.

## After the screen review: charts

A review of the screens after step 5 found money ticks still on the card charts' plots, a hero that never looked solid, brass behind the Plan grid's figures, and a fourth kind of switch on Spending. One PR, branch `fix/charts`.

**Built:**

- **No money on the plot, every net worth chart.** The account sheet's chart, a link's preview and a shared net worth take the hero's rules in their card's shape (150 to 340): drawn at their width (`at-width`, so their months are 12px, as the hero's now are too), no gridlines and no money ticks, the end dot ringed in `--surface`, and **Show as a table** under each. `hero` keeps only the bleed, the gutter for its months, the `--canvas` ring, `pan-y` and moving the figure. The account chart's loading box grows by the table's 44px line and the 8px over it.
- **The cash forecast** likewise: no gridlines or ticks; its zero and warning rules named in words at their left end ("Zero", "Warning", 12px `--text-2`, `.chart-rule-label`), over the lines with a `--surface` halo, the warning's over its rule and zero's under when the two are close, and kept a line apart in any arrangement; **Show as a table** with each day's low and end (and, under a what-if, the line with the purchase and each day's end without it, as the readout gives them). Upcoming's skeleton keeps the table's line.
- **Every month that fits.** `axisTicks`, which capped a range at about five labels, is now a ladder of whole steps (`axisTickLadder` in `lib/chart-range.ts`); a chart takes the densest whose labels sit 12px apart by their widths (twice `MIN_LABEL_GAP`, as Red Hat at 12px runs wider than the estimate), leaving out a label pushed in from either edge that would crowd its neighbour rather than giving up the step (twelve years at 320px: every second year). Six months get every month start outside the hero's gutter (Apr to Sep at 375px, May to Sep at 320px, where Apr 1 falls in the gutter); a year gets every second month at 320 and 375px and every month at 760px.
- **All estimate, drawn solid.** A history with no recorded stretch in the range (no segment, however long, joins two recorded points) is one solid line, and says once that it is estimated: "Past 6 months · estimated" in the readout, "Estimated, not recorded" in the label and the info (a bridged day is a straight line, not from transactions), with ", except Oct 27" (or "except 3 recorded days") when some days are. A shared net worth's weekly recorded points never turn solid through an estimated week or an estimated Sunday beside a recorded Monday.
- **The Plan grid** shades its cells on a neutral ramp, `--elevated` to `--border-strong` by `--shade` (`.plan-grid-cell.scored`), brass only for the plan's own outline; it runs to 8px inside the card's border instead of meeting it. The guard checks `--text-1`, `--text-2` and the outline on `--border-strong`, and that the shade uses it.
- **Spending's period** is the underline switch: `1M · 3M · 12M · YTD`, named "1M, 1 month" ... "YTD, year to date" (`Segmented` takes an item's name as a third element), held to 240px (`.spending-period`) so it doesn't read as a second row of tabs, its skeleton the same markup under `inert`.

**Kept narrow:**

- Runway's chart and the allocation chart stay on a fixed viewBox with 10px text, so `.chart-tick` and `.chart-xlabel` keep their 10px rules (the allocation card is in another change).
- The card charts keep `touch-action: none`: inside a card or sheet there is a gutter to scroll from.
- The cash forecast's own 30, 60 and 90 days stay hand-drawn `.segmented` markup.
- A shared net worth stays dashed between its weekly points, and its note under the chart keeps its words.

## After the screen review: answers first

The same review found two answers said after their reasons, and one said twice: the Plan's answer boxed, under a full-width age button, with a Years to FI row repeating it and Coast FI as "--"; What if… with ten dimmed choices before why; and Runway with a seven-line "What it can't see" box before its months, which sat in a strip of three. One PR, branch `fix/answers-first`.

**Built:**

- **One hero shell.** `components/Hero.tsx` and `.hero` hold what Home's hero had to itself: the label a real heading, the figure at the hero size, an edge on every notice that isn't critical. Home's markup is the same but for the class; its no-wrap and scrub stay its own.
- **The Plan's answer is its hero,** on the page: against the stop age, how it is worked out in one line (the old Years to FI row's note, without the age again), and a ghost "Add your age" line under it. No Years to FI row. An answer, Coast FI or the balance at the stop age that isn't worked out names what it needs ("Needs your invested assets", "Needs your age", "Needs other assumptions"), never "--"; the line on the FI number still says why. What qualifies the answer is gathered under it as Home's caveats are.
- **What if… says why first:** your age, with the same ask opening the same Ages sheet, and every other reason the choices are off, before them. Once the age is saved focus goes to the first choice, or the card's title when the choices are still off.
- **Runway's months are its hero,** with what it can't see right under them: every note a caution, as the amber box said them (the cash forecast's notes are too), one in full and more on one line that opens to each, each kind in a few words (`runwayCaveatItems`, `note_items` beside the read's `notes`, which the read-only API keeps word for word). Then the cash and the line with income, the chart, and the what-if, moved from above the report into its first part. On paper every note prints in full in a box under the months.

**Kept narrow:**

- The accountant's report and Year over year keep their "may be missing" box first: an accountant reads the gaps before any figure.
- The Plan's path chart stays inside the gutter; only Home's runs to the edges.
- Your figures' rows keep their "--" for a figure not measured, with its reason under it.

## After the screen review: Activity and Budgets

The same review found Activity saying In, Out and Net three times (Out unsigned), bars whose segments moved as the view changed, empty screens with no first step, and Budgets opening on an offer whose button was the screen's only filled one. One PR, branch `fix/activity-budgets`.

**Built:**

- **In, Out and Net once, signed** (`components/MonthFigures.tsx`): one strip under the bar on Transactions and Spending, on the page, In "+$1,000.00", Out "-$4,391.92", Net with its sign, each rounded to the currency's unit first. Transactions' sums the bar's month; Spending's the period, under its switch, naming the span when it is longer than the month. The Cash flow card's own row and Spending's In and out card are gone; each keeps its qualifier lines in its words. The skeleton draws the strip itself.
- **The bars hold their row.** Activity's month row stays on Shared and with no transactions (the ⋯, or nothing); Budgets' on Upcoming and Goals is empty on screen, its heading (the segment's name) read alone.
- **Empty states with a first step** (`components/EmptyState.tsx`, `.empty-state`): Budgets with no budget this month (one card in place of Spent, Add budget filled), Goals with none, Shared with no one. Focus goes to the tonal Add once the first is added, and to the empty state's after the last budget is removed.
- **The starter sets' offer is one row** with a × beside it, as the look and feel review's L11 asked; nothing in it is filled.

**Kept narrow:**

- The strip keeps today's figure size (15 to 17px, labels 13px), not the stat strip's `--fs-6` (design-system.md, Stat strip): three signed figures don't fit 320px at 20px.
- At 320px on another month, This month wraps under the name; that second line isn't held on the segments without a month.
- Activity's own empty screen, a past month with no budget, and the Budgets and Goals skeletons (which can't know a month will be empty) are as before.
- The strip's "Transfers and loan payments excluded" and Cash flow's "Transfers, cash withdrawals and loan payments are left out" say nearly the same thing in different words; rewording either is a follow-up.

## After the screen review: the month row

On Activity and Budgets the month row still changed as the months stepped: at 320px This month wrapped under the name and the bar grew by a 44px line on some months and not others; at 375px the name slid aside to make room for it; and Activity's ⋯ on the same line put its arrows and name 24px left of Budgets', popping in after the list loaded. One PR, branch `fix/month-row`.

**Built:**

- **This month's line is always held** (`components/MonthStepper.tsx`, `.month-stepper`): the stepper is a grid, the arrows and the name on the first line and the return button on the second, at every width, in the order they are seen. On a tab's bar the second line is there, empty, on the month the tab returns to; the bar is 32px taller, chosen over a row that changes size. The return button is a small ghost on that line (a return arrow before 13px words, the line 32px, the hit area still 44px), so the held line costs less than a full row. The calendar holds it too, so its days don't drop 44px stepping off this month on a wide screen, where before the button sat beside the name.
- **The rows without a month are as tall** (`.activity-month`, `.budgets-heading`, the month's 44px and This month's 32px), so switching segments moves nothing either, and a jump stops under the bar at one height (the `:has(.month-stepper-back)` scroll margin is gone).
- **Activity's ⋯ is in the Transactions card's header**, after the count, named "Options for transactions", as an institution card's is in its header: the month row is the same on Activity, Budgets and the calendar. Spending and Shared have none. The header is 44px tall with or without it, and so is its skeleton. A sheet it opened gives focus to the list's heading when an import has drawn the card anew meanwhile (`focusInsteadOf` in `components/Sheet.tsx`, Menu's `focusInstead`).

**Kept narrow:**

- Upcoming, Goals and Shared open with the empty two-line row, to keep the segments still.
- Budgets' past-month notice and the starter sets' offer at the top of the Month panel still differ by month, on purpose: warnings keep their words.

## After the light accent review

A review of the light theme on 2026-10-28 (the design system artifact's audit.md, "Light accent review") found the logo's navy only in the small header mark and the primary button, so light read as gold on grey while dark is gold on navy. The accent now acts and gold measures: every control in light is navy, gold keeps the measures, and both logo inks show in both themes. Dark looks the same apart from the solid washes, the unfaded estimates and the measured slice. One PR, branch `design/light-accent`.

**Built:**

- **The tokens.** Light's `--accent` and `--focus` are navy `#22488a` (a brighter step of the logo navy `#18243d`, which is 1.15:1 from body text and 1.00:1 from the primary's fill), on an `--accent-tint` of `#dde4f1`. New `--data` and `--data-tint`: brass `#d4b680` on `#2a2a24` in dark, gold `#96732c` on `#f5eedf` in light, in `tokens.css`, `app/globals.css` and every light copy.
- **Measures on `--data`.** The net worth line and its dots, Your path's line, the plan fan's median and bands, Runway's line with income, the forecast's main line, the payoff plan's line, the cash flow's out side (ribbons, bars and its legend dot), `.cat-bar`, `.meter-fill` (its track on `--data-tint`), the plan legend, and the calendar's planned ring. What you act on or select stays `--accent`.
- **Solid washes.** A wash under a line is the solid `--data-tint`, since gold seen through over the cool light canvas mixes to a muddy grey beige; the fan's inner band is `--data` at 22% over it. A solid tint hides what is under it, so Your path draws its area before the baseline, FI line and label, and the plan fan its bands before its gridlines.
- **Estimates unfaded.** The net worth line's estimated stretches are dashed at full strength, no longer faded to 75%.
- **The measured slice.** A measurement between two days on a net worth chart is a deeper gold slice of the area under the line (`--data` at 16%), not a full-height band.
- **The plan legend's swatches** are the solid tint and a `color-mix` of the inner band, as the fan draws them.
- **The guard's new pairs:** `--data` at 3:1 on canvas, surface, elevated and `--data-tint`, in both themes.

**Checked**, on a static page with `app/globals.css` and the real charts rendered to markup, at 340px in both themes:

- the hero with an estimated last month (dashed at full strength over the solid wash), its range switch's navy bar in light;
- Your path with its FI line and label over the wash, and the plan fan with its gridlines over its bands and its legend swatches matching them;
- a meter on track (gold on its tint) and at caution (hatched orange), the calendar's planned ring and due square, a link in a sentence and the view switch, with no sideways scroll;
- the measured slice by the hero's view test (drawn after the wash, no full-height band), since it needs a gesture.

**Kept narrow:**

- The blue tag suggestion (`.tag-suggestion.chosen`) has no edge or check and now sits closer to a selected chip; it is left for when it is next touched.
- The hero draw-in stays deferred (see step 5's Kept narrow: a clip differs between engines, and a dash offset breaks the estimated stretches' dashes while it draws).

## After the design system update (2026-10-29)

The design system artifact was checked rule by rule against the app, its tokens, the brand book's sections and each component's notes and reference styles. The tokens already matched; the rest was brought in line, or recorded here where the repo decided otherwise later. One PR, branch `fue/clever-thompson-j55oms`.

**Built:**

- **States:** a primary keeps its fill on hover; a secondary deepens to `--border-strong` and a ghost raises to `--elevated`; anything disabled or held with `aria-disabled` is at 60%; the focus ring is drawn inside tabs and a switch's items, and the invite link draws it round its box.
- **Sheet:** Tab and Shift+Tab stay inside it (`components/Sheet.tsx`); its edge is `--border-strong` on `--surface`; a wrapped title keeps the close button by its first line; the footer's buttons sit at its end; it and the tab bar take the `--z-*` layers.
- **Menu** edged in `--border-input`; **view switch** over a `--border-subtle` rule, its current item bold.
- **Notices:** every notice starts with its level for a screen reader (`LevelWord`, now with "Done:"); the Plan's two information notices are `Notice`s with their icon; a critical error after an action is `role="alert"`.
- **Meters** are `role="meter"` with their values, on `--r-pill`; a card's credit meter is red only past its limit (caution from half).
- **Fields:** an invalid field is edged in `--neg` and says what to do under it (`FieldError`, tied with `aria-describedby`): the shared-expense and IOU amounts, Planned's sheet, the forecast's two sheets, the runway and Debt payoff. The typing errors that were critical notices keep their words. Clerk's fields take `--border-input`, and its primary keeps its fill on hover.
- **Type** in rem, so it follows the person's text size; the 14px sizes moved to the scale (13 or 15px); the hero's cents are half the figure at every width, the figure tracked -0.025em; the change line's change is the bold, colored part.
- **Color:** a holding's loss in its table is in the text color with its minus; quieter amounts are `--text-2`, never `--text-3`; radii and motion on their tokens; the stat strip's one row from 720px, the one breakpoint.
- **Money and dates:** the true minus sign (U+2212) on screen, ASCII kept where text is parsed or downloaded (the API, the MCP server, emails, OFX); four bullets for a hidden figure; full amounts in tables, labels and summaries (axis ticks and the calendar's cells keep K and M); "Today" and "Yesterday" in Activity's day headings and the account sheet's dates.
- **Tables** carry `scope` on every header and a caption (visually hidden where a heading says it); Income vs spend and the runway have Show as a table.
- **Net worth chart** read by the keys: it is a slider, arrows a point at a time, Home and End, Escape or leaving it back to today, the value said once the keys rest.
- **The other charts read by the keys:** Income vs spend, the cash forecast, the payoff plan, the plan's fan, the runway and the allocation's history take the net worth chart's keys through one hook (`useChartKeys`, `components/chart-keys.ts`), driving the state a finger drives, so their readout moves; each rests where its readout does (the latest, now, the lowest, the month the plan is done), and Escape with nothing moved is the page's. `test/chart-keys-view.test.tsx`.
- **Skeletons for the spinners left in empty cards:** an investment account's activity, Settings' Defaults, Sharing's "What they see", the Scenarios sheet's rows (two spinners), the accountant's report, year over year, the runway, and Delete my account, each on its real classes with one status (`components/LoadingSkeletons.tsx`). An account's history keeps its spinner in the chart's box, and the waits whose content can't be known yet (a connection's sheet before it knows its step, reading a migration's file) keep theirs.
- **Words:** a budget and an IOU are deleted, a connection that can't be repaired is disconnected.
- **Header icons** at stroke 2, as everything at 20px is; the brand's name at `--fs-5`.
- **Gold is never see-through:** a group's category bars are the solid wash with a gold edge, not gold at 55%.
- **Signs:** the hero's change carries its sign as well as its arrow ("▲ +$10.00 (+1.0%)"); percentages take the true minus too.
- **Dates:** every day read on screen goes through `formatDay`, or `formatInstantDay` for an instant's local day (`lib/format.ts`): "Today" and "Yesterday", "Aug 7" this year and "Aug 7, 2025" outside it, lower case mid sentence and never "on today" (`onDay`). The days that always carried a year (timeline notes, imports, restores, connections, sharing, the Plan's notes) and the instants said through `instantDay`, which never said today, moved to it; Upcoming's day bars, the calendar's day, Card Mode and the transaction sheet keep their weekday. Month names, times, chart axes, the API, MCP, emails, downloads, printed report dates and UTC days stay as they were.
- **Offline:** a caution on Home's total while the device is offline, "Offline. Showing balances from 9:41 AM.", with the time of the numbers shown (`components/online.ts`, through the hero's caveats), gone once it is back online. Disabling the actions that need the network waits for a single place to do it: there is none yet.

**Kept as the repo decided later** (the artifact still says otherwise): Activity has no hero; the month stepper's layout and its 16px chevron; the hatched caution meter; no blur under a sheet; two lines on one chart told apart by dash; an empty state's heading level; the stat strip's size; 32px logo tiles; the compact switch's 12px labels; the mask keeps its sign and currency.

**Kept narrow:**

- Card padding stays `--sp-5` on phones (see "After the rollout: controls and states without color", Kept narrow).
- Critical notes with the same cause are not combined into a count: the artifact asks for it, but critical caveats never collapse here. Left for a decision.
- Clerk's `colorPrimary` stays `--accent` for its links (step 2), against the artifact's note.
- Other "Remove" actions, and the vocabulary table's Close and Hide, are left until the word list is settled.
- The hero draw-in stays deferred (see the light accent review).
- The cash flow chart keeps its see-through ribbons (each node's bar carries it at full strength, as the light theme check decided) and its node labels in K (laid out for a short figure; the table under it has every amount in full).
- Still to move, each its own change: the 147 `.error` lines to notices or field errors; disabling the actions that need the network while offline, with that as their hint.

## Left from the reviews

The look and feel review (2026-10-27) and the screen review (2026-10-28) were pages of their own, now retired. What they raised that is neither built nor recorded above:

- **Runway's Saved scenarios card** still sits after the whole report, away from "Save as a scenario" (noted in PR #165, not changed there).
- **Not reviewed yet:** what each sheet shows after Save, Clerk's own screens and its sign-in form, and what a follower sees from a share link.
- **Ideas from the look and feel review, not taken up:** category tiles tinted from their tag color, a short haptic tick (`navigator.vibrate`) where the platform has one, and a brief check as a recategorized row's chip settles.

## The contrast check

`test/design-guard.test.ts` checks the pairings in both themes (text on every surface at 4.5:1, each meaning color on its tint, each button fill's label on it, the header logo's ink on the page and a card, field borders on every surface, the focus ring, and `--data` on canvas, surface, elevated and its tint at 3:1): both from `app/globals.css` (since phase 7), with each tag color on its tint and its swatch on a card. It also fails if the light theme's copies (system setting, explicit choice and print) drift apart, or if the app's themes, `tokens.css`, `lib/theme.ts` and the web manifest disagree. It runs with the tests.

## Done means

Each phase: typecheck and tests pass; no element gated on removed state is left unreachable; the honesty notices render with the same words and severity as before; 44px targets and the focus ring on everything new; checked at phone and desktop widths, in hide amounts, and in print where it applies.
