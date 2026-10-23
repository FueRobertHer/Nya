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
- **Segments** split a tab into two or three views of the same subject (Activity: Transactions, Spending, Shared). The tab opens on its first segment; the last segment chosen is remembered for the session.
- **Detail sheets** show one object (an account, a transaction) with everything about it and every action on it. Sheets are the existing `Sheet.tsx`: bottom on phones, side panel from 720px.
- **Menus** (⋯) hold an object's rare actions. Urgent actions stay visible.
- **Settings** is a full screen, opened from the avatar menu (or a gear in password mode). It is not a tab.
- **No modes.** Nothing toggles a screen into a different screen. Manage goes away.

Principles behind the choices: one job per screen; settings live in Settings; one home per thing (other places link to it, never copy it); act where the object is; explain on demand; honest, ranked status; same thing, same look.

## Home

**Job:** how am I doing, and does anything need me?

| Order | Block | Contents |
|---|---|---|
| 1 | **Net worth** (one card) | Total and change; one caveat line under the total (see [design-system.md](design-system.md#status-and-honesty)); range chips; the chart with its readout; a **Notes (N)** button in the chart header that opens the timeline notes sheet; a **History paused** badge on the chart header while history is paused. |
| 2 | **Needs attention** | Shown only when something does. Each item says what and links to where it is fixed (list [below](#needs-attention)). |
| 3 | **This month** | The passive insights (spending pace, biggest purchase, upcoming bills, idle cash) and one FI line ("FI in 11.4 years · 62% there"), with its caveats summarized in their severity color (for example an amber "Spending covers 11 of 12 months"), linking to Plan. |

Moves off Home: the timeline notes card (into a sheet from the chart), the backup instruction (into Needs attention, for the admin only; everyone keeps the amber "backup failed" line), the CurrencyOffer card (into Needs attention), the FI card's full caveat list (stays on Plan).

## Accounts

**Job:** what do I have and owe, and is each number current?

**Opens on:**

- A compact header row: **+ Add account** and a status pill (green "All synced", amber "1 couldn't refresh", or red "1 needs you"), which moves focus to the first affected card.
- One summary line by type: Cash, Credit, Investments, Loans, Other, with subtotals.
- **Institution cards**, grouped by institution as today. Header: name, source badge (Manual, via SimpleFIN, via Lunch Flow), subtotal, ⋯. A one-line "Synced 2h ago" (or the caveat, in its severity color). Rows: name and mask, one subtitle line (type, or the payment line on a card or loan, or a cash chip on a brokerage), balance, chevron.
- Problems stay on the card they concern: the reconnect notice and **Reconnect** button, Review accounts, account questions ("Did this close?"), missing-rows and stale-balance notices.
- Collapsible sections at the bottom: **Hidden (N)**, **Accounts that ended (N)**, **Shared with me**.

**Why grouped by institution, not by account type.** Balances fail per institution and all at once (an institution answers or it doesn't), and a missing row is announced as "this subtotal is short". Grouped by type, one bank's accounts would scatter across groups and that warning would have nowhere to sit. The type summary line answers "what do I have and owe" without that cost.

**One tap away:**

- **Add account** sheet: Connect a bank or card; Connect a brokerage or retirement account (where enabled); Connect with SimpleFIN (also for Redbark, which speaks the same protocol); Connect with Lunch Flow (where enabled); Add a manual account; Switching from another app. Each option has one line; the coverage explanation (which service reaches which countries) is a "Which should I use?" disclosure.
- **Account** sheet (tap a row): balance and its source line; balance history chart; holdings with gain or loss and the cash share; payment terms (statement balance, last payment, interest, escrow, payoff); investment activity; recent transactions with "See all in Activity". Actions in the sheet's footer: **Hide** and **Close...**, plus Update balance and Add transaction on manual accounts. In the sheet's ⋯: Import a file (manual), Import history from a file, Repair holdings history, Rename, and **Delete** (manual only, confirmed).
- **Institution ⋯ menu**: Connection details (health, last synced, whose side a problem is on, the provider's code), Add or remove accounts, Enable payment details, Allow transactions, and for SimpleFIN and Lunch Flow: Refresh, Choose accounts, Answer. Last: **Disconnect...**, confirmed by typing the name as today.
- **Payoff plan** moves to Budgets > Goals.
- **Sharing** moves to the avatar menu and Settings.

ConnectionHealth and ConnectorCards stop being separate cards: their per-connection content is on the institution card and in Connection details. Connections with no card (every account hidden, or an orphaned SimpleFIN or Lunch Flow connection) are listed in Settings > Connections.

## Activity

**Job:** what came in and went out, and is each transaction right?

A pinned bar at the top: **‹ October ›** month switcher and the segments **Transactions · Spending · Shared**. "Add a transaction" and "Import a file" sit in the bar's ⋯ when a manual account exists.

| Segment | Contents |
|---|---|
| **Transactions** (default) | One In / Out / Net strip for the month (with its single caveat line); search; filter chips (tag, has receipt, over an amount, needs review, a cash-flow selection); the review bar with Card Mode and Approve listed when the queue is on; the list grouped by day. |
| **Spending** | One period control shared by every card here (the month from the bar by default, plus the ranges the cash-flow chart offers today: last month, 3 or 12 months, year to date). Cash flow (Sankey, "Show as a table"); Net by month (tapping a month sets the period); Income vs spend; Spending by group; Spending by tag; Online vs in-store; Where you spent; a **Reports** row (tax year, runway, year over year). Tapping a Sankey node switches to Transactions with that filter. |
| **Shared** | Shared expenses: people and balances, Paid back?, Add someone, Add an IOU, archived; its settings (counting, Venmo and Cash App) behind a gear. |

**Transaction** sheet (tap a row) replaces the inline editor: category, tags and note, split or group, share the cost or "This paid back", receipt, include or exclude, the rules that matched and "Create a rule from this", and the bank's details. In the sheet's ⋯: rename vendor, and Edit or delete for manual transactions. After a category change, the "Make a rule" offer shows in the sheet.

## Budgets

**Job:** am I on track this month, what is coming, and what am I saving toward?

| Segment | Contents |
|---|---|
| **Month** (default) | Month picker; the "Categories that fit you" offer while it applies (dismissible); income pool and its build-up; total meter; groups and categories with meters, rollover and suggestions, edited in a sheet; **+ Add budget** (a sheet); "My income is irregular" as a row that opens its setting; one completeness notice for the month. |
| **Upcoming** | Cash forecast (30, 60, 90 days, lowest point, "What if I buy..."; the "Warns below" threshold in a sheet); a list or calendar toggle over the same data (bills, income, planned items, card payments due); Recurring (bills and income, Not recurring, the marked list); Planned items with Add. |
| **Goals** | Savings goals with outlook and Add goal; archived goals; **Debt payoff** (moved from Accounts; shown when there is a card or loan). |

Each segment has one time range, which removes today's three competing ranges on one page.

## Plan

**Job:** when can I stop working, and how sure is that?

A pinned **scenario bar**: "Your plan" or the open scenario, a switcher that opens the Scenarios sheet (list, new, rename, duplicate, delete, Compare two to four), and "Back to your plan". Repair and load-error notices sit above it when present. When an input may be incomplete (a month missing from spending, assets short), each segment opens with one amber notice saying so, since every figure on every segment rests on those inputs.

| Segment | Contents |
|---|---|
| **FI and timeline** (default) | FI number, years to FI, Coast and Barista FI, progress; the five inputs (spending, assets, savings, ages, assumptions), each one row that opens its edit sheet, where "Why?" explains its derivation (no control inside the row); plan currency as a badge once confirmed (a notice only while it needs a decision); income and one-off expenses; life events when a scenario is open. |
| **Stress test** | Method (History or Monte Carlo) and Change; success rate and fan chart; worst starting years; the withdrawal-rate grid; assumptions; About these numbers as a disclosure. |
| **Portfolio** | Allocation by asset class or tax bucket, target and drift, "For your plan" mix, mix over time. |

## Settings

A full screen with a list of sections; each opens its own view with a back button. The avatar menu (or the gear) shows a dot when a section needs attention, and the section row shows why.

| Section | Contents | From today |
|---|---|---|
| **Preferences** | Home currency and rates; theme (System, Dark, Light); weekly summary email | CurrencyCard, WeeklySummaryCard (Manage); theme is new |
| **Transactions** | Categories and groups (with starter sets); tags; rules; merchant defaults; review queue | CategoriesCard, CategoryManager, TagsCard, RulesCard, VendorDefaultsCard, ReviewSettingsCard (Manage) |
| **Connections** | Connections with no card (all accounts hidden, orphaned SimpleFIN or Lunch Flow) with Disconnect; reconnected accounts (link history, unlink, link by hand); earlier accounts and Forget; for the admin, unused connections and "Check all accounts now" | AccountLinks, AdminUnusedItems, the all-hidden filter (Manage) |
| **Sharing** | Invite, people, what each sees and for how long, blocked | SharingDrawer (avatar menu, Accounts button) |
| **Your data and privacy** | Download my data; Your data (what Nya keeps); Bring back a download; Receipts and documents; API tokens and their changes | DownloadMyData, InventoryEntry, RestoreCard, ReceiptsCard, ApiTokens (Manage) |
| **Account** | Profile (Clerk), Forget this device, Delete my account, Sign out, Sign out everywhere (password mode), the admin's Storage across accounts | ClerkAccount menu, DeleteAccount, ForgetDevice, password-mode header buttons |

Settings is a screen inside the app, not a sheet: thirteen-plus cards in a bottom sheet would mean long scrolling sheets and sheets opened from sheets. Whether it is an in-app view or a `/settings` route is an implementation choice for the rollout (a route gives real URLs; it also remounts the dashboard).

## Before anything is connected

The tab bar is hidden, so this state keeps its own entry points, as today: the Add account options, Add a manual account, Bring back a download, Sharing, Shared with me, and the importer for switching from another app.

## Needs attention

The only list on Home that asks the person to act. Each item has one line and a link.

| Item | Severity | Links to |
|---|---|---|
| An institution needs reconnecting (or will soon) | Critical / Caution | Its card on Accounts, Reconnect |
| Accounts couldn't be shown; a total is short | Critical | Its card |
| An account stopped reporting or sat at zero: did it close? | Caution | Its card's question |
| A connection has accounts you haven't added | Information | Review accounts |
| A reconnected account may continue an earlier one: link its history | Information | Settings > Connections |
| Transactions waiting for review (count) | Information | Activity > Transactions, needs review |
| A payment is overdue or due within 7 days | Critical / Caution | The account sheet |
| A budget is over or close | Caution | Budgets > Month |
| Your accounts use several currencies: choose a home currency | Information | Settings > Preferences |
| A restore is unfinished or held | Caution | Settings > Your data |
| The nightly backup or receipt clean-up failed (admin only) | Caution | The admin's instructions |

When a backup or clean-up fails, everyone sees it as an amber line on the Net worth card ("The nightly backup failed; the last one saved was Oct 20"); only the admin gets the instruction. A balance that couldn't refresh but needs nothing from you (it usually clears itself) is not listed here: it shows on its card and in the caveat under the total, and turns the Accounts pill amber.

## Deep links

| Today | After |
|---|---|
| `openCurrency(rateFor)` switches to Accounts and turns Manage on | Opens Settings > Preferences with that currency's rate field focused |
| `openRestore` and `#bring-back` switch to Accounts with Manage on | Open Settings > Your data with Bring back a download in view (the element keeps its id) |
| `?view=connections` opens Accounts with Connection health expanded | Opens Accounts with the first card that needs attention in view; Settings > Connections when that connection has no card |
| Hidden card text "use Close... (under Manage)" | "Open the account to close it" |
| Reports from Activity and from Manage | Activity > Spending > Reports; contextual links (runway from the forecast) stay |

## Feature to location

Every component on `origin/main` that renders on a tab or a sheet, with its new home. Pages that stand alone (`/reports`, `/your-data`, `/open-download`, `/security`, `/privacy`, `/developers`, `/connect`, `/unsubscribe`, `/admin-view`) are unchanged except for the shared look.

| Component | Today | New home |
|---|---|---|
| Dashboard (shell) | Header, five tabs, all sheets | Header, five tabs, Settings screen, sheets |
| Brand, HideAmounts | Header | Header |
| ClerkAccount | Avatar menu (Sharing, Manage account, Sign out) | Avatar menu: Settings, Sharing, Sign out |
| RestoreBanner | Every tab while a restore is unfinished | Every tab (unchanged); "Go to it" opens Settings > Your data |
| TrustLinks | Foot of every tab | Foot of every tab and of Settings |
| NetWorthChart, ImportedHistoryNote, CurrencyNotes (chart and hero) | Home hero and Over time cards | Home > Net worth card |
| AccruedInterestNote | Under the Home total | Caveat line under the total |
| CurrencyOffer (CurrencyNotes) | Its own Home card | Needs attention item |
| TimelineNotes | Its own Home card | Notes sheet from the chart header |
| Insights | Home card | Split: Needs attention (urgent items), This month (passive) |
| FiProgressLoader, FiProgressCard | Home card with up to 12 caveat lines | One FI line in This month; caveats stay on Plan |
| ConnectButtons, CoverageNote | Top of Accounts | Add account sheet |
| MigrationSheet (Switching link) | Top of Accounts | Add account sheet |
| ConnectionHealth | Collapsible card on Accounts | Status pill, institution cards, Connection details in ⋯ |
| Connectors (ConnectorCards, ConnectorSheet) | Separate cards on Accounts | Institution card ⋯ menu; orphans in Settings > Connections |
| Institution cards (in Dashboard) | Accounts, with Manage-only buttons | Accounts, ⋯ menu, no modes |
| AccountSparkline, HoldingsRecorded, InvestmentActivity, LiabilityDetail | Inline expansion of a row | Account sheet |
| Manual account sheet, OwedFlipNote | Add manual, Update on a row | Add account sheet, Account sheet > Update balance |
| ManualTxnSheet, ImportSheet | Manual row buttons; Activity add card | Account sheet; Activity bar ⋯ |
| HistoryImportSheet | Expanded row; ended accounts | Account sheet; Accounts that ended |
| AccountLifecycle (questions, Close sheet, EndedAccounts) | Cards, Manage-only Close... | Questions on the card; Close... in the Account sheet; Accounts that ended section |
| Hidden accounts card | Bottom of Accounts | Bottom of Accounts |
| Disconnect sheet, DisconnectSplitsNote | Manage-only header button; ConnectionHealth | ⋯ > Disconnect...; Settings > Connections |
| ConnectRedirect ("already connected") | After Connect | Unchanged |
| AccountLinks | Manage | Settings > Connections; a notice on Accounts when a match is waiting |
| AdminUnusedItems | Manage (admin) | Settings > Connections (admin) |
| DebtPayoff | Accounts top card button | Budgets > Goals |
| Sharing (SharingDrawer, SharedViews, ShareKinds, SharingDates) | Avatar menu, Accounts button | Avatar menu, Settings > Sharing |
| Sharing (SharedWithMe) | Bottom of Accounts; empty state | Bottom of Accounts; empty state |
| AcceptInvite | Invite link page | Unchanged |
| DownloadMyData, DownloadOptions | Manage | Settings > Your data |
| InventoryEntry, DataInventory | Manage, `/your-data` | Settings > Your data, `/your-data` |
| RestoreCard, RestoreAnswers | Manage; empty state | Settings > Your data; empty state |
| ReceiptsCard | Manage (when files are on) | Settings > Your data |
| ApiTokens, ApiChanges | Manage | Settings > Your data |
| ReportsEntry | Activity foot; Manage | Activity > Spending |
| ReportsPage, ReportView, RunwayReport, RunwayChart, YearOverYearReport | `/reports` | Unchanged |
| WeeklySummaryCard | Manage | Settings > Preferences |
| CurrencyCard, CurrencyChoiceSheet | Manage; Home offer | Settings > Preferences; Needs attention |
| CategoriesCard, CategoryManager, CategoryTemplates | Manage | Settings > Transactions |
| TemplateOffer | Top of Budgets | Budgets > Month (dismissible notice) |
| TagsCard | Manage | Settings > Transactions |
| RulesCard, RuleSheet | Manage; Activity row | Settings > Transactions; Transaction sheet |
| VendorDefaultsCard | Manage | Settings > Transactions |
| ReviewSettingsCard | Manage | Settings > Transactions |
| DeleteAccount, DeletionReceipt, ForgetDevice | Clerk profile window; header (password mode) | Settings > Account |
| AdminStorage | `/admin-view` | Settings > Account (admin link) and `/admin-view` |
| MonthBreakdown (list, filters, inline editor) | Activity, under the analysis cards | Activity > Transactions; editor becomes the Transaction sheet |
| MonthBreakdown (net by month, income vs spend, summary, top spending, online vs in-store, places) | Activity, above the list | Activity > Spending (summary strip also on Transactions) |
| CashFlowSankey | Activity, first card, own period picker | Activity > Spending, on the shared period control |
| MonthFlowChart, CategoryRollup, SpendByTag | Activity | Activity > Spending |
| TagFilter, TagChips, TxnTagsNote | Activity list and editor | Transactions filters; Transaction sheet |
| ReviewBar, ReviewNote, CardMode | Activity list | Activity > Transactions (unchanged behavior) |
| SplitSheet, GroupSheet, SplitRows, SplitChangedNote | Activity editor; Budgets note | Transaction sheet; Budgets > Month notice |
| AttachmentSection, AttachmentViewer | Activity editor | Transaction sheet |
| SharedExpensesCard, SharedRows, ShareCostSheet, ConfirmPaymentSheet, SettleSheet, PersonSheet, IouSheet, HandoffSheet | Activity, below the list; row lines | Activity > Shared; row lines unchanged |
| BudgetsTab, BudgetsCard, BudgetSuggestion, IncomePool | Budgets | Budgets > Month |
| GoalsCard, GoalSheet, GoalPlansRepair | Budgets | Budgets > Goals |
| ForecastCard, ForecastChart | Budgets | Budgets > Upcoming |
| CalendarView, RecurringCard, PlannedCard | Budgets | Budgets > Upcoming |
| PlanTabLoader, PlanTab (FiCard, RepairCard, EventsCard) | Plan | Plan > FI and timeline |
| PlanTab (SimulationCard, GridCard, About), PlanFanChart, PlanGrid | Plan | Plan > Stress test |
| PlanScenarios, PlanCompare, ScenarioTag | Plan, below FiCard; bar at top | Scenario bar and Scenarios sheet |
| PlanEvents | Plan, near the bottom | Plan > FI and timeline (with a scenario open) |
| PlanForms | Plan sheet | Unchanged |
| PlanCurrency | Plan card | Badge; notice only while it needs a decision |
| AllocationCard | Plan, between FI and simulation | Plan > Portfolio |
| Sheet | Every form and confirmation | Unchanged, plus sticky footer and second-level back |
| CategoryPicker | Editors | Unchanged |
| InfoPage, OpenProtectedDownload, UnsubscribeForm, ServiceWorkerRegistration | Standalone pages and plumbing | Unchanged |

## Vocabulary

One word for one thing, everywhere:

| Word | Means | Not |
|---|---|---|
| **Hide** | Keep syncing, stop counting | Remove, archive |
| **Close** | The account ended on a day (closed, no longer yours, or no longer followed); history before stays | Disconnect, delete |
| **Disconnect** | Remove a connection to an institution; its accounts' history is kept | Remove, unlink |
| **Delete** | Permanently remove something you made (a manual account, a transaction, a rule) | Forget |
| **Forget** | Permanently remove what Nya kept about a disconnected account | Delete |
| **Link** | Join a reconnected account's history to the account it replaces | Connect |
| **Connect** / **Reconnect** | Bring an institution in through a provider / fix its login | Link |
