# Rollout

The order in which to build the reorganization, as pull requests that each ship on their own and leave the app working. Phases 1 (`components/Settings.tsx`), 2 (the tokens and primitives in `app/globals.css`), 3 (Accounts, in three pull requests), 4 (Home, in four), 5a (Activity's bar and segments), 5b (its filter chips) and 5c (Spending's one period) are built; the rest is not started. Effort is rough, in focused days for one person.

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
| 5e | Activity: the Transaction sheet, rule offer inside it | 1 to 2 days |
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

**Decided:** an in-app view (keeps the dashboard's loaded data, no URL), chosen over a `/settings` route (real URLs and back button, remounts the dashboard and refetches). A route can follow. With Clerk on, Settings > Account points to the account menu for the profile, Delete my account and Sign out (it had a Sign out of its own at first, which repeated the menu's and was taken out); embedding Clerk's profile there is left for later.

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

- **The FI line, as reviewed.** The review asked for "Plan defaults" on the line itself when no plan is saved, a shorter line under it ("$942,000 of $1,520,000 invested"), a row that says why when the plan can't be read, and focus after its jump. The FI part is likely to change, so these wait for that.
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

Split like phases 3 and 4, since `components/MonthBreakdown.tsx` (about 1,400 lines, drawn by a dozen test files) holds all of it: **5a** the bar and the segments, **5b** the filter chips, **5c** Spending's one period, **5d** its charts' text, **5e** the Transaction sheet. 5b and 5c were one at first and were split before 5b was built: the chips touch only Transactions' list, while one period for every Spending card changes what each card sums (all but the cash flow sum the bar's month, the cash flow's periods count back from today, a pick keeps its period, the month's notes are by month, and Income vs spend draws one month).

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
- **The rows and day bars**: 5e's Transaction sheet redraws them.

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
