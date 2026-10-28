# Information architecture

Where everything in Nya lives after the reorganization, and why. The look is in [design-system.md](design-system.md); the order of work is in [rollout.md](rollout.md). This describes `origin/main` as of October 23, 2026.

- [The problem, measured](#the-problem-measured)
- [Navigation model](#navigation-model)
- [Home](#home)
- [Accounts](#accounts)
- [Activity](#activity)
- [Budgets](#budgets)
- [Plan](#plan)
- [Settings](#settings)
- [Before anything is connected](#before-anything-is-connected)
- [Needs attention](#needs-attention)
- [Deep links](#deep-links)
- [Feature to location](#feature-to-location)
- [Vocabulary](#vocabulary)

## The problem, measured

Measured on the public Preview demo on a 375 by 812 phone screen with a single institution (a real account has more of everything), plus a read of the components on `origin/main`:

| Tab | Height | What is wrong |
|---|---|---|
| Home | 1.6 screens | Up to 10 kinds of note under the total; system alerts (backups, receipt clean-up) inside the chart card; a permanent card for timeline notes the chart already marks; the FI card repeats up to 12 caveats the Plan tab also shows. |
| Accounts | 1.4 screens; 595px before the first account | The top of the tab is onboarding (up to four connect buttons, two paragraphs about SimpleFIN, Redbark and Lunch Flow, four more buttons, an importer link). Connection status is shown three times. Tapping a row expands about 700px inline. **Manage** changes six things at once (below). |
| Activity | 3.6 screens; transactions start 1,526px down | Five to nine analysis cards before the list; four of them show money in against money out; In/Out/Net appears twice; two separate time selectors; an 11-control editor opens inside a table cell; Shared expenses and Reports come after the whole list. |
| Budgets | 4.1 screens, 47 buttons | Four jobs (budgets, goals, forecast, bills) on three time ranges; the add-budget form and income setting always open; up to 8 caveat paragraphs. |
| Plan | 4.3 screens | The scenario bar is at the top, the scenario list below the FI card, life events near the bottom; 461px of "About these numbers" prose. |

**What Manage does today.** One flag in `Dashboard.tsx` changes six layers of the Accounts tab at once:

1. Institutions whose accounts are all hidden appear in the list (and only then can be disconnected).
2. Reconnected-account linking and, for the admin, unused connections appear above the list.
3. Disconnect appears on every institution header.
4. Hide and Close... appear on every account row, Delete on manual ones; a manual row then has six text buttons.
5. "Add or remove accounts" appears on every institution.
6. Thirteen cards that are not about accounts are appended below everything: Download my data, Receipts, Your data, Bring back a download, Reports, API tokens, Weekly summary, Currency, Categories, Tags, Rules, Defaults, Review queue.

Controls on the tab go from about 19 to 55 or more. Two links elsewhere (Home's currency notes, the restore banner) switch Manage on and drop the person mid-page in edit mode, and the Hidden card has to tell people to "use Close... (under Manage)".

## Navigation model

- **Five tabs**, same names as today: Home, Accounts, Activity, Budgets, Plan. Tab count was never the problem; what is inside them was.
- **The open tab is in the address** (`/?tab=budgets`; Home is `/`), so a reload comes back to it and the first paint is that tab's loading view (`lib/dashboard-tab.ts`). The address is replaced, never pushed: a tab is not a history entry, so Back leaves the page as it always did. Segments are not kept in it: a reload opens the tab on its first segment.
- **Settings is in the address too**, beside the tab under it (`/?tab=accounts&settings=connections`; `?settings=list` for its list), so a reload in Settings comes back to it, its loading view first (since the screen review). Replaced, never pushed, as the tab is: Settings and its sections are not history entries, so Back still leaves the page. Whether Back should close a sheet or step out of a Settings section is a separate question, not taken up yet. Sharing is offered only with Clerk, so without it `?settings=sharing` opens the list.
- **Segments** split a tab into two or three views of the same subject (Activity: Transactions, Spending, Shared). The tab opens on its first segment; the last segment chosen is remembered for the session.
- **The month** is shared by Activity and Budgets and remembered for the session the same way (`components/view-month-state.ts`): step back to August on one and the other opens on August. Home's links into either (budget alerts, the review count) reset it to each tab's default. The calendar on Upcoming keeps its own.
- **Detail sheets** show one object (an account, a transaction) with everything about it and every action on it. Sheets are the existing `Sheet.tsx`: bottom on phones, side panel from 720px.
- **Menus** (⋯) hold an object's rare actions. Urgent actions stay visible.
- **Settings** is a full screen, opened from the avatar menu (or a gear in password mode). It is not a tab.
- **No modes.** Nothing toggles a screen into a different screen. Manage goes away.

Principles behind the choices: one job per screen; settings live in Settings; one home per thing (other places link to it, never copy it); act where the object is; explain on demand; honest, ranked status; same thing, same look.

## Home

**Job:** how am I doing, and does anything need me?

| Order | Block | Contents |
|---|---|---|
| 1 | **Net worth** (one card) | Total and change; under it, each critical caveat in full and the lesser ones gathered in one line that opens in place (see [design-system.md](design-system.md#status-and-honesty)); the chart with its readout and what qualifies it under it, and its range as a compact underline switch; the nightly jobs' facts (what to do about them only for the admin, in the Admin card under Needs attention); a foot row with when it was updated, a **History paused** badge while history is paused, and a **Chart notes (N)** button that opens the timeline notes sheet (a foot row, as the mockup draws it: the chart's header has no room at 320px). |
| 2 | **Needs attention** | Shown only when something does: a row per item, worst first, each with its level as an icon and a word, saying what and going where it is fixed (list [below](#needs-attention)). For the admin only, an **Admin** card under it says what to do about a nightly job that failed. |
| 3 | **This month** | The passive insights as plain rows, the month's own figures first (spending pace, biggest purchase, upcoming bills), then a low balance (one row, "and 3 more accounts"), then idle cash, with what the month may be missing after the pace and the biggest purchase, and one FI line ("FI in about 11.4 years · 62% there", the FI number, what is invested and the savings rate under it) that opens the Plan tab, with every note the FI card had under it, gathered into one line in the worst one's color when there are two or more (built in 4c). |

Moves off Home: the timeline notes card (into a sheet from the chart), the backup instruction (into the Admin card under Needs attention, for the admin only; everyone keeps the amber "backup failed" line), the CurrencyOffer card (into Needs attention, a row that opens the offer in a sheet), the FI card (into one line in This month, every note gathered under it; the Plan tab says each beside its figure).

## Accounts

**Job:** what do I have and owe, and is each number current?

**Opens on:**

- A compact header row: a status pill counting connections on the left (red "1 problem", amber "2 to check", or green "All synced"), which moves focus to the first affected card, worst first (or opens Settings > Connections when that connection has no card), and **+ Add account**, tonal, at the right (since the screen review). Red and amber are buttons; "All synced" is a badge. The pill shows only once every connection was read in this load, never from this device's snapshot or a load that failed.
- Under it, the totals by kind (Cash, Credit, Investments, Loans, Other) as a stat strip in a card, with what they can't count under the figures.
- One summary line by type: Cash, Credit, Investments, Loans, Other, with subtotals (shown when the accounts fall in two or more). A group missing an account of its kind is marked Incomplete, and what the line can't count is said under it: a red notice naming the institutions whose accounts are left out, an amber one naming those whose figures are only last known.
- **Institution cards**, grouped by institution as today. Header: name, source badge (Manual, via SimpleFIN, via Lunch Flow), subtotal, ⋯. A one-line "Synced 2h ago" (or the caveat, in its severity color). Rows: name and mask, one subtitle line (type, or the payment line on a card or loan, or a cash chip on a brokerage), balance, chevron.
- Problems stay on the card they concern: the reconnect notice and **Reconnect** button, Review accounts, account questions ("Did this close?"), missing-rows and stale-balance notices.
- Collapsible sections at the bottom: **Hidden (N)**, **Accounts that ended (N)**, **Shared with me**.

**Why grouped by institution, not by account type.** Balances fail per institution and all at once (an institution answers or it doesn't), and a missing row is announced as "this subtotal is short". Grouped by type, one bank's accounts would scatter across groups and that warning would have nowhere to sit. The type summary line answers "what do I have and owe" without that cost.

**One tap away:**

- **Add account** sheet: Connect a bank or card; Connect a brokerage or retirement account (where enabled); Connect with SimpleFIN (also for Redbark, which speaks the same protocol); Connect with Lunch Flow (where enabled); Add a manual account; Switching from another app. Each option has one line; the coverage explanation (which service reaches which countries) is a "Which should I use?" disclosure.
- **Account** sheet (tap a row): balance and its source line; balance history chart; holdings with gain or loss and the cash share; payment terms (statement balance, last payment, interest, escrow, payoff); investment activity; recent transactions with "See all in Activity". Actions in the sheet's footer: **Hide** and **Mark as closed…**, plus Update balance and Add transaction on manual accounts. In the sheet's ⋯: Import a file (manual), Import history from a file, Repair holdings history, Rename, and **Delete** (manual only, confirmed).
- **Institution ⋯ menu**: Connection details (health, last synced, whose side a problem is on, the provider's code), Add or remove accounts, Enable payment details, Allow transactions, and for SimpleFIN and Lunch Flow: Refresh, Choose accounts, Answer. Last: **Disconnect...**, confirmed by typing the name as today.
- **Payoff plan** moves to Budgets > Goals.
- **Sharing** moves to the avatar menu and Settings (since the screen review the menu's Sharing opens Settings > Sharing: one place).

ConnectionHealth and ConnectorCards stop being separate cards: their per-connection content is on the institution card and in Connection details. Connections with no card (every account hidden, or an orphaned SimpleFIN or Lunch Flow connection) are listed in Settings > Connections.

## Activity

**Job:** what came in and went out, and is each transaction right?

A pinned bar at the top: the month (**‹ October 2026 ⌄ ›**, `MonthStepper`: its arrows, its name opening the list of months with transactions, and This month away from the month the tab opens on) and the segments **Transactions · Spending · Shared**. "Add a transaction" and "Import a file" sit in the bar's ⋯ when a manual account exists. The month's row is there on every segment, as tall, so the segments never move: on Shared, which isn't by month, and with no transactions to list, it holds only the ⋯, or nothing (since the screen review after step 5).

Under the bar, on Transactions and Spending, one **In / Out / Net strip** (`MonthFigures`), on the page rather than in a card, signed (In "+$1,000.00", Out "-$4,391.92", Net with its sign), with what it leaves out and may be missing under it: the month's on Transactions; on Spending the period's, under the period's switch, naming the span when it is longer than the bar's month. It is said once: the Cash flow card has no figures of its own and Spending has no In and out card (since the screen review). A cash-flow pick listed on Transactions lists the pick's rows; the strip there still sums the bar's month.

| Segment | Contents |
|---|---|
| **Transactions** (default) | The strip for the month (above, with its caveat lines); search; filter chips (Unsure category with its count while any listed row has one, To review while the queue is on, Tag, Receipt with its amount; since phase 5b); a cash-flow selection as a line over the list; the review bar with its count as a heading, Card Mode and Approve listed when the queue is on; the list grouped by day. |
| **Spending** | One period shared by every card here (since phase 5c): an underline switch for its length (`Segmented` as `.spending-period`: 1M, 3M, 12M, YTD, named in full; chips until the screen review), ending with the bar's month, which the bar's arrows and Net by month's columns move; each card names it. The strip for the period (above); Cash flow (Sankey, "Show as a table", no In / Out / Net of its own); Net by month (tapping a month sets the period); Income vs spend; Spending by group; Spending by tag; Online vs in-store; Where you spent; a **Reports** row (tax year, runway, year over year). Tapping a Sankey node switches to Transactions with that filter. |
| **Shared** | Shared expenses: people and balances, Paid back?, Add someone, Add an IOU, archived; its settings (counting, Venmo and Cash App) behind a gear. With no one yet (and nothing that couldn't be read), the card is an empty state: **No shared expenses yet**, one line, and **Add someone** as its one primary (since the screen review). |

**Transaction** sheet (tap a row; since phase 5e) replaces the inline editor: category (with **Looks right** beside a Check category chip, which keeps the category it has as the person's), tags and note, split or group, share the cost or "This paid back", receipt, include or exclude, the rules that matched and "Create a rule from this", and the bank's details (Plaid's finer category among them, as **Bank's category**, on a row from Plaid). Its actions (split or group, share the cost or "This paid back", exclude or include) are one list of rows (`ActionRows`, since the screen review), and "Create a rule from this" a row of its own after the rules that match it; a split's part has its one action as a row too. In the sheet's ⋯ (in its footer): rename vendor (a second level of the sheet), and Edit or delete for manual transactions. After a category change, the "Make a rule" offer shows in the sheet, under the category, and the sheet stays open. A split transaction's parts and a group's transactions are rows of their own and open the sheet on themselves: a part's category, whether it counts and Edit split; a group's transaction taken out of it. Each row is a button: its name, one line (category and account, the account's institution after its name only where two accounts share a name, cut with an ellipsis rather than wrapping; the bank and a connector's name are in the sheet) with its provenance as chips (Entered by hand or Imported, Pending, To review, Excluded or Hidden by a rule, Note, a receipt), and under it the notes that bear on what it counts as. A category Plaid was unsure of leads the line with a quiet neutral dot and words for a screen reader (Information, not caution: nothing is wrong with a figure), counted by the Unsure category chip; the sheet keeps its Check category badge and Looks right.

## Budgets

**Job:** am I on track this month, what is coming, and what am I saving toward?

| Segment | Contents |
|---|---|
| **Month** (default) | The month as the bar's heading, ‹ and › to the month either side, and a tap on its name to pick any month back to the first with transactions (ten years at most), or the month Activity was on; a past month says it is shown as it was; the "Categories that fit you" offer while it applies, one row that opens the starter sets with a × beside it that keeps yours (since the screen review); income pool and its build-up; total meter; groups and categories with meters, rollover and suggestions, edited in a sheet; **+ Add budget** (a sheet); "My income is irregular" as a row that opens its setting; one completeness notice for the month (built in 6a2: the notice at the top, then Available to allocate, then **Spent**, the month's total with what it counts, then the budgets as rows; a group opens in place to its categories, each budget opens its sheet). This month with no budget at all is one card in place of Spent, an empty state: **No budgets yet**, one line, what the Spent card would have said, and **Add budget** as its one primary (since the screen review). |
| **Upcoming** | One notice at the top for what the bills, income, planned items and payments may be missing; the cash forecast (30, 60 or 90 days, its lowest point, where it starts from with the notes on that, **Warns below** as a row that opens the low-balance warning's sheet, and "What if I buy..."); **List · Calendar** over the same entries (bills, income, planned items, card payments due): the list a bar per day over the forecast's range, the calendar a month a page with what posted on the days gone by; **Recurring** (bills and income as rows that open a sheet with Not recurring, and the marked list with Restore); **Planned** items as rows that open their sheet, with Add (built in 6a3). |
| **Goals** | Savings goals with outlook and Add goal (with no goal at all, an empty state: **No goals yet**, one line, **Add goal** as its one primary, since the screen review); archived goals; **Debt payoff** (moved from Accounts; shown when there is a card or loan). What several goals say of their months is said once at the top, each of them badged (6a2). |

Each segment has one time range, which removes today's three competing ranges on one page.

## Plan

**Job:** where am I, where am I heading, and what changes it?

A pinned **scenario bar**: "Your plan" with **Scenarios (3)**, which opens the Scenarios sheet (list, new, rename, duplicate, delete, Compare two to four), or, with a scenario open, a back arrow ("Back to your plan") and "Scenario: Sabbatical 2029"; under it the segments. With a scenario open, its card sits under the bar on every segment: what it changes, why it isn't worked out when it can't be, and **Scenarios (3)** again, so another can be opened or compared without going back first (decided 2026-10-25). Repair and load-error notices sit above it when present (built in 6b), and so does the currency card until it becomes the badge on Your path. When the spending or the invested assets the stress test uses may be incomplete (transactions missing from spending, assets short), Stress test opens with one amber notice saying so (built in 6c; decided 2026-10-26): Your path says it on the FI number and under each figure's row, and Portfolio's allocation reads holdings and says on its own card what it is short of.

| Segment | Contents |
|---|---|
| **Your path** (default; was FI and timeline) | The answer against your stop age ("Around age 39, 16 years before you stop at 55"), progress, and the caveats on the FI number; the path chart from today to the stop age (built in 8b, with the answer and Home's FI line); the figures it rests on (built in 6c as **Your figures**, under the FI card: annual spending, invested assets, annual savings with its savings rate, ages, assumptions; Ages and Assumptions two rows, Assumptions opening the one sheet of every rate and setting the plan uses, built in 6d), each one row that opens its edit sheet, where "Why?" explains its derivation (no control inside the row), with what qualifies it under the row, its lesser caveats on one line that says how many and what kind; plan currency as a badge once confirmed (a notice only while it needs a decision); the **What if…** card (built in 8c: templates as chips, and the scenarios as life choices with their FI age; with your plan shown, not inside a scenario); income and one-off expenses; "Will it last?" and "You could stop saving now" (Coast FI) as rows. |
| **Stress test** | One amber notice first when the spending or invested assets it uses may be low (6c), with a badge on each card it is about (6d); "Will it last?" with its method named, the success rate with its "Hypothetical, from US history" label and the fan chart, the worst starting years behind a disclosure, and what it takes from Your path; the withdrawal-rate grid, a card, with the same label; then one card of two rows: **Assumptions**, opening the sheet of every setting the plan uses (the FI number's rate, growth after inflation, tax and part-time income, and the test's method, rule, start, length, mix, rebalancing and fee), at the test's part, and **About these numbers**, the full statement and the data, said once, in a sheet (built in 6d). |
| **Portfolio** | Allocation by asset class or tax bucket, target and drift, "For your plan" mix (its **Use my allocation in the plan** opens the Assumptions sheet at the mix, filled in: the mix is set in one place, since 6d), mix over time. |

**Life events stay in scenarios** (decided 2026-10-25). The What if… card offers templates: buy a home, travel or a big expense, a child, a career break and part-time work from phase 8c (the kinds that exist), and buy a car, a raise, a windfall and pay off a loan from phase 8d (built). Social Security and pensions stay income on your plan. Picking one asks for your own figures, with nothing suggested, shows how it moves your FI age, and "Try it" creates a scenario named after it and opens it. The card lists the scenarios as life choices, each with its FI age; your plan stays what you have locked in. The path chart and the What if… card are new components, recorded in the table below (PlanPathChart, built in 8b; PlanWhatIf, built in 8c).

## Settings

A full screen with a list of sections; each opens its own view with a back button. The avatar menu (or the gear) shows a dot when a section needs attention, and the section row shows why.

| Section | Contents | From today |
|---|---|---|
| **Preferences** | Theme (System, Dark, Light); home currency and rates; weekly summary email | ThemeCard (new in phase 7), CurrencyCard, WeeklySummaryCard (Manage) |
| **Transactions** | Categories and groups (with starter sets); tags; rules; merchant defaults; review queue | CategoriesCard, CategoryManager, TagsCard, RulesCard, VendorDefaultsCard, ReviewSettingsCard (Manage) |
| **Connections** | Connections with no card (all accounts hidden, orphaned SimpleFIN or Lunch Flow) with Disconnect; reconnected accounts (link history, unlink, link by hand); earlier accounts and Forget; for the admin, unused connections and "Check all accounts now" | AccountLinks, AdminUnusedItems, the all-hidden filter (Manage) |
| **Sharing** | In place: invite, people and blocked, as cards; each person in a sheet of their own (what they see and for how long, both records, Remove and Block) with What they see as its second level (since the screen review) | SharingDrawer (avatar menu, Accounts button), now SharingSettings |
| **Your data and privacy** | Download my data; Your data (what Nya keeps); Bring back a download (a demo account: reset to a scenario instead); Receipts and documents; API tokens and their changes | DownloadMyData, InventoryEntry, RestoreCard (DemoDataCard on a demo account), ReceiptsCard, ApiTokens (Manage) |
| **Account** | Profile (Clerk), Forget this device, Delete my account, the admin's Storage across accounts; with Clerk, who is signed in (Clerk's picture, name and email, read from Clerk and drawn in place since the screen review: Clerk's own profile stays in its window, which it lays out by the window's width), then **Manage account**, opening Clerk's account window with its Data & privacy page as the avatar menu's does (look and feel step 2c), while Sign out is the avatar menu's alone and this section points to it; Sign out and Sign out everywhere in password mode | AccountSettings (ProfileWindow), ClerkAccount menu, DeleteAccount, ForgetDevice, password-mode header buttons |

Settings is a screen inside the app, not a sheet: thirteen-plus cards in a bottom sheet would mean long scrolling sheets and sheets opened from sheets. Whether it is an in-app view or a `/settings` route is an implementation choice for the rollout (a route gives real URLs; it also remounts the dashboard).

## Before anything is connected

The tab bar is hidden, so this state keeps its own entry points, as today: the Add account options, Add a manual account, Bring back a download, Sharing, Shared with me, and the importer for switching from another app.

## Needs attention

The only list on Home that asks the person to act (`components/NeedsAttention.tsx`, the rows from `components/attention.ts`, since rollout phase 4b). Each row takes the color its object already has and the words already said for it: the title and the line under it that the alert already builds, every word kept. Tapping it goes where it is fixed and moves focus there (to its heading where it has one; a sheet takes focus itself).

| Item | Severity | Goes to |
|---|---|---|
| A connection broken in a way only the person can fix, or missing money from the total (reconnect, connect again, pay or fix it at SimpleFIN or Lunch Flow, accounts couldn't be shown): what to do first where the person does it at Nya ("Reconnect Chase" over "Balances as of Oct 21"; "Connect SimpleFIN again"), else its name and its card's badge | Critical, its card's color; one row for a SimpleFIN or Lunch Flow connection failing as a whole | Its card on Accounts; its card in Settings > Connections when it has none there |
| A connection Plaid says ends within three days ("Reconnect Chase" / "Plaid says its connection ends in 2 days") | Caution | Its card |
| Accounts a SimpleFIN or Lunch Flow connection stopped sending ("Missing accounts") | Caution, as its card | Its card |
| An account stopped reporting or sat at zero: did it close? (its card's question) | Caution | Its card |
| A connection has accounts you haven't added | Information for Plaid's; Caution for a SimpleFIN or Lunch Flow connection with none chosen, as in Settings > Connections | Its card; Settings > Connections |
| A reconnected account may continue an earlier one: link its history ("Chase Checking ••4821 may continue an earlier account" over "Link its history"; "2 reconnected accounts may continue earlier ones"), each pair Settings suggests, until linked or declined there | Information | Settings > Connections, focus on the Reconnected accounts card's title |
| Transactions waiting for review ("12 transactions to review") | Information | Activity, focus on the review count |
| A payment overdue ("Amex is overdue" over "Minimum $35.00") | Critical | The account sheet, over Home |
| A payment due within 7 days ("Amex due tomorrow" over "Minimum $35.00"), every one | Caution | The account sheet, over Home |
| A budget over or close: the worst two, then "3 more budgets over or nearly over" | Caution | The Budgets tab, focus on its month |
| Your accounts use several currencies: choose a home currency ("Show your totals in one currency") | Caution while the total adds them unconverted (as its caveat); Information when only transactions are in several | The offer, in a sheet, with its choices and Not now |
| A bank a restore brought back isn't connected; what a restore brought back can't be read | Critical; Caution | Settings > Your data |
| Plaid's warnings (Caution), or your own sync's connections (Critical), couldn't be read on this load: one that needs you may be missing from the list | As the Accounts tab's notice | The Accounts tab, focus on its notice |
| The nightly backup or receipt clean-up failed (admin only): "Nightly backup failed" over "Last saved Oct 20 · timeout · Check the backup cron in Vercel." | Caution | The Admin card under Needs attention; each row goes to the Nightly jobs page (`/admin/jobs`) |

When a backup or clean-up fails, everyone sees it as an amber line on the Net worth card ("The nightly backup failed; the last one saved was Oct 20"); only the admin gets the instruction. A balance that couldn't refresh but needs nothing from you (it usually clears itself) is not listed here: it shows on its card and in the caveat under the total, and turns the Accounts pill amber. An unfinished restore keeps its banner on every tab, Home's too, rather than a row. What a budget row's month may be missing follows the budget rows, in the words Activity and Budgets use. A low balance is a row in This month (decided in 4c): it has no fix to go to and no way to set it aside.

## Deep links

| Today | After |
|---|---|
| `openCurrency(rateFor)` switches to Accounts and turns Manage on | Opens Settings > Preferences with that currency's rate field focused |
| `openRestore` and `#bring-back` switch to Accounts with Manage on | Open Settings > Your data with Bring back a download in view (the element keeps its id) |
| `?view=connections` opened Accounts with Connection health expanded | Opens Accounts with the first card that needs attention in view; Settings > Connections when that connection has no card |
| Hidden card text "use Close... (under Manage)" | "Open the account to close it" |
| Reports from Activity and from Manage | Activity > Spending > Reports; contextual links (runway from the forecast) stay |

## Feature to location

Every component on `origin/main` that renders on a tab or a sheet, with its new home. Pages that stand alone (`/reports`, `/your-data`, `/open-download`, `/security`, `/privacy`, `/developers`, `/connect`, `/unsubscribe`, `/admin-view`) are unchanged except for the shared look.

| Component | Today | New home |
|---|---|---|
| Dashboard (shell) | Header, five tabs, all sheets | Header, five tabs, Settings screen, sheets |
| Brand, HideAmounts | Header | Header |
| ClerkAccount | Avatar menu (Sharing, Manage account, Sign out) | Avatar menu: Settings, Sharing (opening Settings > Sharing), Sign out |
| Settings (SettingsScreen) | New in phase 1, replacing Manage | Full screen from the avatar menu or the gear: the six sections, each a view with a back button; kept in the address beside the tab (`?settings=`, lib/dashboard-tab.ts) since the screen review |
| RestoreBanner | Every tab while a restore is unfinished | Every tab (unchanged); "Go to it" opens Settings > Your data |
| TrustLinks | Foot of every tab | Foot of every tab and of Settings |
| NetWorthCard | New in phase 4a | Home: the one Net worth card, replacing the hero, Over time and notes cards; since the look and feel's step 5 the hero itself, on the page, not in a card (`.net-worth-hero`), with `components/hero-scrub.ts` carrying the day a finger is on from its chart to its figure |
| NeedsAttention (AdminAttention) | New in phase 4b | Home, under the Net worth card: a row per thing to do, worst first, each going where it is fixed; the admin's card under it, each row going to the Nightly jobs page |
| TotalCaveats | New in phase 4a | Under the Home total: each critical caveat in full, the lesser ones gathered in one line that opens in place; also the FI line (4c), Budgets > Month's notice and the notes under Spent, and the notice at the top of Goals (6a2); Budgets > Upcoming's notice and the forecast's notes on where it starts (6a3). Its `Notice` draws one notice with its level word, for the errors on the Month card and in the budgets' sheets, and the forecast's answer, Upcoming's load states and its sheets' errors (6a3) |
| NetWorthChart, ImportedHistoryNote, CurrencyNotes (chart and hero) | Home hero and Over time cards | Home > the hero (the hero's currency lines as caveats on the total); its chart drawn as the hero's (`hero`: edge to edge, `.hero-chart`) since the look and feel's step 5; since the screen review every net worth chart (an account's sheet, a shared net worth) is drawn at its width with no money ticks and has Show as a table |
| AccruedInterestNote | Under the Home total | Caveat line under the total |
| CurrencyOffer (CurrencyNotes) | Its own Home card | A Needs attention row that opens CurrencyOfferSheet (built in 4b) |
| TimelineNotes | Its own Home card | Chart notes sheet from the Net worth card's foot row (built in 4a) |
| Insights | Home card | Split: Needs attention (budgets, payments, reconnects; built in 4b), and the This month card it now draws (passive rows, a low balance among them; built in 4c) |
| FiProgressLoader, FiProgressCard | Home card with up to 12 caveat lines | One FI line, the last row of This month, its notes gathered under it; the Plan tab says each in full beside its figure (built in 4c) |
| ConnectButtons, CoverageNote | Top of Accounts | Add account sheet; the empty state keeps them |
| AddAccountSheet | New in phase 3 | + Add account on Accounts: every way in, coverage behind "Which should I use?" |
| MigrationSheet (Switching link) | Top of Accounts | Add account sheet |
| ConnectionHealth | Collapsible card on Accounts | Status pill, institution cards, Connection details in ⋯ |
| Connectors (ConnectorCards, ConnectorSheet) | Separate cards on Accounts | Institution card ⋯ menu; orphans in Settings > Connections |
| Institution cards (InstitutionCard) | Accounts, with Manage-only buttons | Accounts, ⋯ menu, no modes |
| AccountsStatus | New in phase 3c | The Accounts tab's header row, on its left (Add account, tonal, at its right): how many connections have a problem or something to check, in lib/accounts-status.ts's colors, jumping to the first |
| AccountsSummary | New in phase 3c | Under the Accounts tab's header row: the totals by type (components/account-groups.ts) as a stat strip in a card since the screen review, with what it can't count under the figures |
| ConnectionStatus | New in phase 3b | On each institution card (and Settings > Connections): what is wrong and what it does to the total, in one color from lib/accounts-status.ts, when it last synced and whose side, the account questions, and each button that fixes it once |
| ConnectionDetails | New in phase 3b | Institution ⋯ > Connection details: Plaid's own words, side and code; a SimpleFIN or Lunch Flow connection's card (where it reaches, requests left, history) |
| AccountSparkline, HoldingsRecorded, InvestmentActivity, LiabilityDetail | Inline expansion of a row | Account sheet |
| AccountSheet | New in phase 3 | Tap an account row on Accounts: balance and source, history, holdings, terms; Hide and Mark as closed… in its footer, Update balance and Add transaction on typed accounts; Import a file, Import history and Delete in its ⋯ |
| Manual account sheet, OwedFlipNote | Add manual, Update on a row | Add account sheet, Account sheet > Update balance |
| ManualTxnSheet, ImportSheet | Manual row buttons; Activity add card | Account sheet; Activity bar ⋯ |
| HistoryImportSheet | Expanded row; ended accounts | Account sheet; Accounts that ended |
| AccountLifecycle (questions, Close sheet, EndedAccounts) | Cards, Manage-only Close... | Questions on the card; Mark as closed… in the Account sheet; Accounts that ended section |
| Hidden accounts card | Bottom of Accounts | Bottom of Accounts |
| Disconnect sheet, DisconnectSplitsNote | Manage-only header button; ConnectionHealth | ⋯ > Disconnect...; Settings > Connections |
| ConnectRedirect ("already connected") | After Connect | Unchanged |
| AccountLinks | Manage | Settings > Connections; a notice on Accounts when a match is waiting |
| AdminUnusedItems | Manage (admin) | Settings > Connections (admin) |
| DebtPayoff | Accounts top card button | Budgets > Goals (6a1): a Debt payoff card holding a Payoff plan row, shown when a card or loan that isn't hidden is on screen; the sheet stays mounted once, outside the tabs |
| Sharing (SharingSettings with SharingListView and ConnectionView, SharedViews, ShareKinds, SharingDates) | Avatar menu, Accounts button | Settings > Sharing, in place, each person in a sheet; the avatar menu's Sharing opens it |
| Sharing (SharedWithMe) | Bottom of Accounts; empty state | Bottom of Accounts; empty state |
| AcceptInvite | Invite link page | Unchanged |
| DownloadMyData, DownloadOptions | Manage | Settings > Your data |
| InventoryEntry, DataInventory | Manage, `/your-data` | Settings > Your data, `/your-data` |
| RestoreCard, RestoreAnswers | Manage; empty state | Settings > Your data; empty state |
| DemoDataCard | New | Settings > Your data, for a demo account only, where Bring back a download would be: reset it to a scenario |
| ReceiptsCard | Manage (when files are on) | Settings > Your data |
| ApiTokens, ApiChanges | Manage | Settings > Your data |
| ReportsEntry | Activity foot; Manage | Activity > Spending |
| ReportsPage, ReportView, RunwayReport, RunwayChart, YearOverYearReport | `/reports` | Unchanged |
| WeeklySummaryCard | Manage | Settings > Preferences |
| ThemeCard | New (phase 7) | Settings > Preferences, first |
| CurrencyCard, CurrencyChoiceSheet | Manage; Home offer | Settings > Preferences; Needs attention |
| CategoriesCard, CategoryManager, CategoryTemplates | Manage | Settings > Transactions |
| TemplateOffer | Top of Budgets | Budgets > Month: one row that opens the starter sets, a × beside it that keeps yours (a card with two buttons until the screen review) |
| TagsCard | Manage | Settings > Transactions |
| RulesCard, RuleSheet | Manage; Activity row | Settings > Transactions; Transaction sheet (the "Make a rule" offer and "Create a rule from this", since 5e) |
| VendorDefaultsCard | Manage | Settings > Transactions |
| ReviewSettingsCard | Manage | Settings > Transactions |
| DeleteAccount, DeletionReceipt, ForgetDevice | Clerk profile window; header (password mode) | Settings > Account |
| AdminStorage | `/admin-view` | Settings > Account (admin link) and `/admin-view` |
| AdminJobs | New | `/admin-view/jobs` (asked for as `/admin/jobs`, the admin only): the nightly backup and clean-up, their last runs and **Run now**; linked from Settings > Your data and privacy (admin link) and from the Admin card's rows on Home |
| ActivityBar | New (phase 5a) | Activity's pinned bar: **‹ October 2026 ›** (on Shared and with no transactions, its row held, empty but for the ⋯), the ⋯ with Add a transaction and Import a file while there are transactions (buttons in the empty card while there are none), and the segments Transactions · Spending · Shared |
| BudgetsBar | New (phase 6a1) | Budgets' pinned bar: on Month the month as its heading (**‹ October 2026 ›**, a tap on the name picks any month), on the others the same row, empty, with the segment's name as a heading read alone (shown until the screen review); under it the segments Month · Upcoming · Goals. Each segment's panel stays mounted, the others hidden |
| PlanBar | New (phase 6b) | The Plan's pinned scenario bar: "Your plan" with **Scenarios (3)**, or a back arrow and "Scenario: Sabbatical 2029"; under it the segments Your path · Stress test · Portfolio. Its heading is where Home's FI line lands. Each segment's panel stays mounted, the others hidden |
| MonthBreakdown (list, filters, inline editor) | Activity, under the analysis cards | Activity > Transactions; the rows are list rows that open the Transaction sheet (5e) |
| TransactionSheet | New (phase 5e), replacing the inline editor | A row's sheet on Activity > Transactions: a transaction, a split's part or a group's transaction |
| MonthBreakdown (net by month, income vs spend, top spending, online vs in-store, places) | Activity, above the list | Activity > Spending |
| MonthFigures | The summary card on Transactions, Cash flow's own row and Spending's In and out card | Activity > Transactions and Spending: the one In / Out / Net strip under the bar, signed, on the page (the screen review after step 5) |
| CashFlowSankey | Activity, first card, own period picker | Activity > Spending, on the shared period (5c): no control of its own, and no In / Out / Net of its own since the screen review (the strip over the panel says them); on a phone, three columns, its categories in the table under it (5d) |
| MonthFlowChart, CategoryRollup, SpendByTag | Activity | Activity > Spending |
| TagFilter, TagChips, TxnTagsNote | Activity list and editor | Transactions filters (the Tag chip, since 5b); Transaction sheet (5e) |
| ChipSelect | New (phase 5b) | A filter chip that chooses one of a few options: Transactions' Tag and Receipt chips |
| ReviewBar, ReviewNote, CardMode | Activity list | Activity > Transactions: the count as a heading beside Card Mode, under the filter chips (5b); its filter is the To review chip |
| SplitSheet, GroupSheet, SplitRows, SplitChangedNote | Activity editor; Budgets note | Transaction sheet (5e), the parts and a group's transactions rows of their own; Budgets > Month, a note under Spent (6a2) |
| AttachmentSection, AttachmentViewer | Activity editor | Transaction sheet (5e) |
| SharedExpensesCard, SharedRows, ShareCostSheet, ConfirmPaymentSheet, SettleSheet, PersonSheet, IouSheet, HandoffSheet | Activity, below the list; row lines | Activity > Shared; row lines unchanged. The sheets (`SharedSheets`) stay mounted on every segment, since a row on Transactions opens Share the cost, This paid back and an IOU |
| BudgetsTab, BudgetsCard, BudgetSuggestion, IncomePool | Budgets | Budgets > Month |
| BudgetSheet (BudgetSheet, OrphanBudgetSheet, AddBudgetSheet) | Budgets editor and add form, open under the list | Budgets > Month (6a2): a budget's sheet from its row (its amount, then Rollover, Reset carryover and Remove as levels with Back), a deleted category's or group's from its row, and Add budget from + Add budget |
| GoalsCard, GoalSheet, GoalPlansRepair | Budgets | Budgets > Goals; what several goals say of their months, and what the card says once, in one notice at its top (6a2) |
| UpcomingPanel | New (phase 6a3) | Budgets > Upcoming: the segment, its one notice at the top, the forecast, the **List · Calendar** tabs (both views mounted, the other hidden), Recurring and Planned; it holds the range the forecast and the list share |
| ForecastCard, ForecastChart | Budgets | Budgets > Upcoming: the range as a radio group, its notes on where it starts under that line, **Warns below** as a row opening the low-balance warning's sheet, and What if I buy… (6a3) |
| UpcomingList | New (phase 6a3) | Budgets > Upcoming, under the List tab: the bills, income, planned items and payments due from today over the forecast's range, a bar per day, as plain rows |
| CalendarView, RecurringCard, PlannedCard | Budgets | Budgets > Upcoming: the calendar under the Calendar tab, its day's list as rows; Recurring's bills and income and Planned's items as rows that open their sheets (6a3) |
| PlanTabLoader, PlanTab (FiCard, InputsCard, EventsCard) | Plan | Plan > Your path (6b); InputsCard (Your figures), the figures the plan rests on as rows under FiCard, each opening its sheet (6c) |
| PlanTab (RepairCard), PlanCurrency | Plan | Plan, above the bar (6b); PlanCurrency to become a badge on Your path once confirmed, a notice only while it needs a decision |
| PlanTab (FiCard's answer), PlanPathChart | Plan | Plan > Your path: the answer against the stop age at the top of the FI card, the age ask while an age is missing, and the path chart under it (8b) |
| PlanTab (SimulationCard, GridCard, About), PlanFanChart, PlanGrid | Plan | Plan > Stress test (6b); About became a row and sheet in StressRows and AboutNumbers, and the fan chart is drawn at its width (6d) |
| PlanTab (StressRows, AboutNumbers) | New (phase 6d) | Plan > Stress test, its last card: Assumptions (opening the Assumptions sheet at the stress test's part) and About these numbers (opening AboutNumbers in a sheet) |
| PlanScenarios (ScenariosSheet, ScenarioCard), PlanCompare, ScenarioTag | Plan, below FiCard; bar at top | The Scenarios sheet (list, second level for new, rename, duplicate and delete, Compare), opened from the bar or the open scenario's card; ScenarioCard under the bar with a scenario open (6b) |
| PlanEvents | Plan, near the bottom | Plan > Your path, with a scenario open (under its card, above the segments, while its lasting changes are refused); its form is the What if… card's template sheet (8c) |
| PlanWhatIf | New (phase 8c) | Plan > Your path, under Your figures and above income and one-off expenses, with your plan shown: a chip per template opening the life event's form in a sheet, with the FI age it moves as it is typed and Try it; the scenarios as rows with their FI age, each opening it |
| PlanProgress | New (phase 8e) | Plan > Your path, its last card (**Progress**): **This is my plan** saves the Plan's assumptions (confirmed in a sheet, with the inflation rate the comparison uses); once saved, the invested assets recorded each day set against where that plan has them, with a **Save the Plan as it is now** when what the comparison rests on changed, and **Stop comparing** in its ⋯ menu, confirmed in a sheet. What was recorded, and where that plan had it, are drawn before today on the path chart (PlanPathChart), with the Plan shown |
| PlanForms | Plan sheet | The Plan's sheets; since 6d one Assumptions sheet (AssumptionsForm) holds what the Assumptions and Simulation forms did, opened from Your figures, Stress test, a scenario's Change it and Portfolio |
| AllocationCard | Plan, between FI and simulation | Plan > Portfolio (6b); its mix confirm gone, Use my allocation opening the Assumptions sheet (6d) |
| Sheet | Every form and confirmation | Unchanged, plus sticky footer and second-level back |
| CategoryPicker | Editors | Unchanged |
| InfoPage, OpenProtectedDownload, UnsubscribeForm, ServiceWorkerRegistration | Standalone pages and plumbing | Unchanged, except that the public pages (InfoPage) read as prose under headings rather than in cards, with a contents list of links to their parts when they have five or more, and a plain-language note first where they have one; a form on them (OpenProtectedDownload, UnsubscribeForm) keeps its card |
| LoadingSkeletons (HomeSkeleton, AccountsSkeleton, ActivitySkeleton, BudgetsSkeleton, PlanSkeleton, TabSkeleton, SettingsSkeleton, AppLoading, SignInSkeleton, and the parts the tabs draw themselves: ActivityListSkeleton, BudgetsMonthSkeleton, UpcomingSkeleton, PlanPanelSkeleton, SharedWithMeSkeleton, LinesSkeleton, RowsSkeleton) | New, replacing the loading spinners | The open tab in placeholders while the dashboard's first load is on its way, or Settings when the address has it open (Home's Net worth card; Accounts' bar and institution cards; Activity's, Budgets' and the Plan's bar, unavailable, over the segment's cards); the same under the dashboard's header as a whole page (AppLoading), which Home streams while the server reads the session (so a sign-in's move there shows it at once) and the sign-in page and the password login hand over to; inside the tabs, Activity's list and Budgets' Month and Upcoming while transactions load, each Plan segment while the saved plan loads and the Plan's code while it arrives, Progress's lines, and Shared with me while it is read on a device whose last read had shares; the place of Clerk's form on the sign-in page while it loads |
| SignInFlow (SignInPlaceholder) | New | The sign-in page's frame: the page from the top, Clerk's form in its placeholder (with a notice if it hasn't loaded in 15 seconds); the app loading in its place from a demo button's press until Clerk has moved to Home |
| DemoSignIn | Sign-in page, inline | The sign-in page's Try the demo card, under one line on what Nya is: each account a tonal button that says what it is set up to hold, so Clerk's Continue is the one filled button; each signs in as Alex or Sam in place, with the route's ticket, and says why when it can't; a plain form post before Clerk has loaded. Which banks connect is folded under the form, behind "Which banks work?" |

## Building blocks

Components that only serve other components (a picker, a chart, a row, a notice) are listed here in one line each, with what they serve, instead of a row in the table above. A new component goes in one or the other; `test/design-guard.test.ts` fails until it does.

- AccountSparkline, ForecastChart, RunwayChart, PlanFanChart, PlanGrid, MonthFlowChart: charts, inside their cards and sheets. `useDrawnWidth` (`components/drawn-width.ts`, phase 5d) draws a chart at its own width, so its text is 12px; MonthFlowChart and CashFlowSankey use it, and since 6a4 ForecastChart and the payoff plan's chart (in DebtPayoff); since 6d PlanFanChart, since 8b PlanPathChart, and NetWorthChart since step 5 (the hero) and the screen review (everywhere) (PlanGrid is a table: its text is 12px, it runs into its card's padding to 8px from the border, and its shade is neutral, `.plan-grid-cell.scored`); RunwayChart and the allocation chart are still on a fixed viewBox. ForecastChart and NetWorthChart carry no money on the plot, with Show as a table under them; the forecast names its zero and warning rules in words (`.chart-rule-label`). LegendLine (`components/LegendLine.tsx`, look and feel step 4) is a legend's sample of one line in its dash, for ForecastChart and RunwayChart, whose two lines differ by dash as well as color.
- CategoryPicker, TagChips, SplitRows, SharedRows, ScenarioTag, DownloadOptions: shared parts of the editors and sheets that use them.
- Sheet: every form, confirmation and detail view.
- ActionRows: an object's actions in its sheet, one to a row in one `.card.list-rows`, a chevron on those that open another sheet (since the screen review: the transaction sheet's Split, Group with others, Share the cost and Exclude from budgets and reports; its Create a rule from this; a split part's Leave this part out).
- ProfileWindow: Clerk's account window with Nya's Data & privacy page (DeleteAccount), for Settings > Account (AccountSettings, its card); the avatar menu's Manage account opens the same window and takes the page's name and icon from it.
- HeaderIcon: the icons of the header's buttons (Refresh, the Settings gear), for the dashboard's header and the app loading's copy of it.
- Menu: an object's ⋯ menu of rare actions (the account sheet's, the transaction sheet's, the institution card's, a report's). An item may be a link to a file to save (a report's Download as CSV).
- PageHeader: the one header of the pages outside the tabs (the public pages through InfoPage, Your data, Reports, the admin's pages): the logo and name as the link back into the app (Reports' back to Activity), and Reports' hide amounts at its other end.
- EmptyState: a card with nothing in it yet (the screen review after step 5): a heading, one line and one primary, what must still be said between the line and the action. Budgets > Month (BudgetsCard), Goals (GoalsCard) and Shared (SharedExpensesCard).
- MonthStepper: the one month control (step 2b1): Activity's bar, Budgets' bar on Month and the calendar, each with its own months; Activity and Budgets share the month (step 2b2), the calendar keeps its own.
- Segmented: the underline switch for a value (a radio group: the net worth chart's range, Runway's window, the Plan's choices, the kind of report) or a few views (tabs over one panel: Allocation's two views, which report). Activity's, Budgets' and the Plan's bars, Budgets > Upcoming's List or Calendar, the forecast, Planned and Theme draw `.segmented` themselves.
- Why: the "Why?" disclosure, wherever an explanation goes behind one line.
- Collapsible (CollapsibleHeader): the title of a card that opens and closes (Hidden, Accounts that ended, Shared with me).
- upcoming-notes (NoticeBadge): what Budgets > Upcoming says it may be missing (the notice at its top, through TotalCaveats, and the forecast's notes on where it starts), and the badge on each card the notice bears on (6a3).

## Vocabulary

One word for one thing, everywhere:

| Word | Means | Not |
|---|---|---|
| **Hide** | Keep syncing, stop counting | Remove, archive |
| **Close** | The account ended on a day (closed, no longer yours, or no longer followed); history before stays; its button reads "Mark as closed…", so it is never taken for a sheet's Close | Disconnect, delete |
| **Disconnect** | Remove a connection to an institution; its accounts' history is kept | Remove, unlink |
| **Delete** | Permanently remove something you made (a manual account, a transaction, a rule) | Forget |
| **Forget** | Permanently remove what Nya kept about a disconnected account | Delete |
| **Link** | Join a reconnected account's history to the account it replaces | Connect |
| **Connect** / **Reconnect** | Bring an institution in through a provider / fix its login | Link |
| **Financial independence** (FI) | Enough invested that work is optional: the Plan tab's subject and its label | Retire early |
| **Stop age** | The age you plan to stop working, which the Plan's answer is measured against | Retirement age |
| **What if** | A scenario, started from a life event's template or by hand | A life event on your plan |
