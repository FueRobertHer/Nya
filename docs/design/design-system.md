# Design system

How Nya should look and behave, screen to screen. The tokens are in [tokens.css](tokens.css); where things live is in [information-architecture.md](information-architecture.md); the order of work is in [rollout.md](rollout.md). The tokens (dark only) and the primitives are in `app/globals.css` since rollout phase 2; the rest arrives phase by phase.

- [Direction](#direction)
- [Color](#color)
- [Type](#type)
- [Space, shape and motion](#space-shape-and-motion)
- [Components](#components)
- [Status and honesty](#status-and-honesty)
- [Copy](#copy)
- [Accessibility](#accessibility)
- [What this replaces](#what-this-replaces)

## Direction

**A financial ledger.** Nya is a dense tool people open daily to check numbers they care about, so it should read like a well-set ledger: quiet surfaces, crisp hairlines between rows, money in tabular figures that line up, and color spent only where it means something.

- **Dark and light.** The theme follows the system: dark when the system is dark or states no preference (so most people see what they see today), light when it is light. Settings > Preferences can pin Dark or Light. Keeping everyone on dark until they opt in is the alternative; see [Decisions you can reverse](README.md#decisions-you-can-reverse).
- **Fewer boxes.** A screen is a few cards with grouped rows, not a column of cards each holding one fact. Rows share a card and are split by 1px dividers.
- **One hero number per screen.** Net worth on Home, a month's net on Activity, the FI number on Plan. Everything else is smaller.
- **Color is meaning.** Blue is for things you can act on and the current selection. Green and red are for money in and out, and for gain and loss. Amber is only for something that needs you. Red as a background means a number is wrong or short. One status uses green: the Accounts tab's "All synced", the good end of the status pill whose other ends are red and amber.
- **Considered and rejected:** an editorial "warm paper" style with a serif display face. It is pleasant for reading and worse for scanning columns of figures.

The mockups ([mockups/index.html](mockups/index.html)) show the refined current dark beside this direction on Home, so the choice can be made on a real screen.

## Color

Defined in `tokens.css` and copied into `app/globals.css`; Clerk's appearance and `themeColor` in `app/layout.tsx` read them from `lib/theme.ts`, and the web manifest restates two of them. The guard test keeps all of these equal to `tokens.css`.

| Role | Token | Dark | Light | Use |
|---|---|---|---|---|
| Page | `--canvas` | `#0d0f14` | `#f6f7f9` | Behind cards |
| Card | `--surface` | `#151821` | `#ffffff` | Cards, sheets |
| Raised | `--elevated` | `#1c202b` | `#f0f2f6` | Pressed rows, inputs on a card, segmented track |
| Chrome | `--glass` | 88% surface | 88% white | Header and tab bar over a blur |
| Divider | `--border-subtle` | `#232834` | `#e6e8ef` | Between rows |
| Edge | `--border-strong` | `#2b3140` | `#d5d9e2` | Card and sheet edges |
| Field | `--border-input` | `#707889` | `#757c8a` | Input outlines (3:1 on canvas, card and raised) |
| Text | `--text-1/2/3` | `#eceef2` / `#9499a6` / `#868c9b` | `#11141c` / `#525866` / `#636a77` | Primary, secondary, meta |
| Action | `--accent` | `#5b8def` | `#2563eb` | Links, selection, focus |
| Money in | `--pos` | `#34d399` | `#047857` | Inflows, gains |
| Money out | `--neg` | `#f87171` | `#b91c1c` | Outflows, losses, critical text |
| Needs you | `--warn` | `#fbbf24` | `#92400e` | Caution text |
| Tints | `--*-tint` | solid, about 12% | solid, about 8% | Notice and chip backgrounds |
| Buttons | `--accent-fill`, `--danger-fill` | `#2563eb`, `#dc2626` | same | Filled buttons with `--on-fill` white labels |

**Contrast.** Every text token passes WCAG AA (4.5:1) on canvas, surface and elevated in both themes, every meaning color passes on its own tint, white passes on both fills, and field borders pass 3:1 on every surface. The pairings are checked by `test/design-guard.test.ts` on every test run. The ones most likely to matter:

| Pair | Dark | Light |
|---|---|---|
| `--text-2` on `--surface` | 6.22 | 7.13 |
| `--text-3` on `--surface` | 5.27 | 5.44 |
| `--accent` on `--surface` | 5.49 | 5.17 |
| `--neg` on `--surface` | 6.41 | 6.47 |
| `--warn` on `--warn-tint` | 8.32 | 6.51 |
| `--neg` on `--neg-tint` | 5.42 | 5.73 |
| `--accent` on `--accent-tint` | 4.68 | 4.65 |
| white on `--accent-fill` | 5.17 | 5.17 |
| white on `--danger-fill` | 4.83 | 4.83 |
| `--border-input` on `--elevated` (3:1 for UI, its weakest surface) | 3.67 | 3.74 |

Today white on the accent button is 3.23:1 and white on the danger button 3.32:1; both fail. That is why the button fill is a deeper blue than the accent text in dark.

**Charts** use the same tokens: `--pos` and `--neg` for in and out, `--accent` for the selected series, `--text-3` for ticks, `--border-subtle` for gridlines. The hardcoded `#262a33`, `#3a4150`, `#8b8f98` and `#6b7080` in the chart components go. A chart **drawn at its own width** (`useDrawnWidth`, `components/drawn-width.ts`: Income vs spend and the cash flow since phase 5d, the other charts with phase 6) has a viewBox as wide as it is laid out, so a viewBox unit is a CSS pixel and its text is `--fs-1` (12px) at every width, never scaled down on a phone. A chart on a fixed viewBox draws its text at a fraction of its size on a phone (10px at 340 units is 7.3px on a 248px card).

**Print** keeps its own light palette (it already overrides tokens in `@media print`); it should be rebuilt on the light tokens so the two stay in step.

## Type

System UI font, as today: fast, native, and no font file to host or put in the Content-Security-Policy. (A self-hosted Inter with tabular figures is an option if the system font's figures disappoint on Windows; not proposed now.)

| Token | Size | Weight | Use |
|---|---|---|---|
| `--fs-hero` | 32 to 40px | 700 | The one hero number on a screen |
| `--fs-6` | 24px | 600 | Large figures in a stat strip |
| `--fs-5` | 20px | 600 | Screen titles |
| `--fs-4` | 17px | 600 | Sheet titles, settings section titles |
| `--fs-3` | 15px | 400 / 600 | Body, list rows; card titles (`<h2>`) and buttons at 600 |
| `--fs-2` | 13px | 400 | Secondary lines, notices, helper text |
| `--fs-1` | 12px | 500 | Meta: dates, chips, chart ticks |

- **Nothing on screen under 12px.** Today 38 declarations are 9 to 11px, including the tab bar labels; they move to `--fs-1`.
- **Money is tabular** everywhere it is in a column or can change in place: one rule on a `.money` class (and `.num` cells) instead of 27 separate `tabular-nums` declarations. The hero keeps proportional figures, as now.
- **No uppercase micro-labels.** Fourteen uppercase styles today (`th`, `.type-tag`, `.section-label`, `.health-badge` and more) become sentence-case `--fs-1` or `--fs-2` in `--text-2`. Uppercase at 10 to 11px is the hardest text in the app to read.
- **Headings are headings.** Card titles are `<h2>`, sections inside a card `<h3>`. Today 65 card titles are `<div class="inst-name">`.

## Space, shape and motion

- **Spacing**: `--sp-1` to `--sp-8` on a 4px grid. Card padding `--sp-4` on phones and `--sp-5` from 720px; gap between cards `--sp-3`; between rows 0 (dividers do the separating).
- **Margins belong to layout, not to text.** Notes and labels carry no built-in top margin; a stack container sets the gap. This is what removes the 245 inline `marginTop` patches (100 of them `marginTop: 0`, undoing a class's own margin).
- **Radii**: `--r-xs` 6 (chips), `--r-sm` 8 (inputs, segmented items), `--r-md` 12 (buttons, notices), `--r-lg` 16 (cards, sheets), `--r-pill`. Today there are 19 radii.
- **Motion**: `--dur-fast` 140ms for presses and toggles, `--dur-base` 220ms for sheets and segment changes, `--dur-pulse` 900ms for each way of a loading placeholder's pulse, one easing. One global reduced-motion rule zeroes them; today only the sheets and Card Mode respect it.
- **Layers**: header, tab bar, sheet backdrop, sheet, toast, as tokens.

## Components

One component per pattern. Each lists what it replaces so the migration can delete as it goes.

### Card

A surface with an optional header: `<h2>` title on the left, a meta value or one action on the right. Content below is rows, a chart, or a stat strip.

```html
<section class="card">
  <header class="card-header"><h2>Chime</h2><span class="money">$320.00</span><button class="icon-btn" aria-label="Chime options">⋯</button></header>
  …rows…
</section>
```

A card that opens and closes (Hidden, Accounts that ended) has a header whose `<h2>` holds one button, the whole title row (`components/Collapsible.tsx`, `.section-toggle`): the title, then a neutral count badge and at most one status badge, then a chevron that turns when it is open. It is 44px tall and says whether it is open (`aria-expanded`).

Replaces `.inst-header`, `.inst-name`, `.inst-total` used as a generic header (43 files), `.institution-name`, `.holdings-title`, `.plan-subhead`, `.plan-scenario-heading`, `.card-mode-header`, and `.report-page` (a copy of `.card`).

### List row

The workhorse. Leading logo or icon (optional), title, one subtitle line, trailing value with an optional second line, and a chevron when it opens something. At least `--row-min` (48px) tall; the whole row is the target.

- A row that opens a detail sheet is a `<button>` (or a link), never a `<tr>` with buttons inside it. Today account rows put Hide, Close..., Delete and Update inside a clickable `<tr>`.
- At most one subtitle line and one trailing secondary line. Anything more belongs in the detail sheet.
- Provenance (Updated, Last known, Estimated, Excluded, Rule, Split, Pending) is a chip on the subtitle line.
- Activity's transactions are list rows (since phase 5e): a logo, the name with its tags, one line (category, account, where it came from) with its provenance as `.badge` chips, and the amount. The notes that bear on what a transaction counts as (an exclusion that couldn't be read, a pair worked out, its split or group, how it is shared, a file's amount the bank changed) stay under that line in `--fs-1`, never only in its sheet. A split's parts and a group's transactions are rows of their own, set in past the logo.
- A row that reports a status (Home's Needs attention) leads with `.list-row-icon`, a 32px square in its level's tint holding a shape for each level (an alert, a clock, an info mark), and a word for a screen reader before its title: never color alone.

Replaces `.acct-row`, `.txn-main` with `.txn-text`, `.peer-row`, `.peer-item`, `.cat-manage-row`, `.timeline-note-row`, `.budget-summary`, and the table-based account and transaction lists.

### Stat strip

Two to four labelled figures in a row (In, Out, Net). Label `--fs-1` in `--text-2`, figure `--fs-6`. Replaces `.summary-row` and `.summary-value`.

### Buttons

| Variant | Look | Use |
|---|---|---|
| Primary | `--accent-fill`, white label | The one main action in a card or sheet |
| Secondary | Transparent, `--border-strong` edge | Other actions |
| Ghost | Text only in `--accent`, padded to 44px | Inline actions (Edit, See all) |
| Danger | `--danger-fill`, white label | Confirming something destructive, inside a confirm sheet only |
| Icon | 44px square, icon 20px | Header, card menus, sheet close |

- **Width is auto by default**; `.btn-block` makes one full width. Today `button { width: 100% }` forces about 25 one-off classes (`.logout-btn`, `.manage-toggle`, `.disconnect-btn`, `.plan-edit`, `.pool-toggle`, `.split-small`, `.rollup-toggle` and more) that each undo it.
- **One button group** (`.btn-row`): gap `--sp-2`, wraps on narrow screens, primary last. Replaces `.button-pair`, `.action-row`, `.card-actions`, `.button-stack`.
- **Danger is never a first-level button** on a working screen. Disconnect, Delete and Forget live in a menu or a detail sheet and confirm in a sheet. Replaces `.disconnect-btn` (red-bordered in a card header), `.danger-link`, `button.danger-outline`. The one exception: a connection that can't be repaired shows **Remove {name}** (or Disconnect, for a SimpleFIN or Lunch Flow connection that is gone) as a secondary button on its card, since removing it is the fix; it still confirms in a sheet.
- `.link-btn` (about 15px tall today) becomes Ghost.

### Segmented control

Two to four mutually exclusive views of the same thing (Transactions / Spending / Shared; History / Monte Carlo). A track in `--elevated`, the selected item on `--surface` with `--text-1`, each item 44px tall on touch. `role="tablist"` when it switches views, a radio group when it switches a setting.

A **range control** (1M ... All) looks the same but is a labelled radio group, and may hold up to six options; more than that become chips. Spending's period lengths (since phase 5c) are chips in a labelled radio group (`role="radio"`, `aria-checked`, arrows, Home and End), as the mockup draws them: four labels as long as "Year to date" don't fit one segmented row at 320px. Replaces `.chart-ranges` / `.chart-range` (a generic control named after the chart), `.manage-toggle`, and the `[aria-pressed]` chip toggles used as modes.

### Badge and chip

One family, `--r-xs`, `--fs-1`, weight 500, sentence case.

- **Badge**: a status or source label that isn't clickable (Manual, via SimpleFIN, Pending, Overdue). Tones: neutral, accent, pos, neg, warn, each on its tint.
- **Chip**: clickable (a filter, a tag, a selectable option), 32px tall inside a 44px hit area. Tones `neg` and `warn` (since phase 3c) for a status that jumps to what it counts, the Accounts status pill: its severity's tint, with the edge kept in the text's color and a trailing chevron, so it never reads as a badge.
- **Filter chips** (since phase 5b) sit in a `.chip-row`, which wraps with 12px between rows so each chip's 44px hit area ends where the next row's begins. A filter that is on or off is a `button.chip` with `aria-pressed` (To review). One that chooses among a few options is a **select chip** (`ChipSelect`, `.chip-select`): a native select laid unseen over the whole hit area, so a phone opens its own picker, with a trailing down chevron. It shows its word and the choice ("Tag", "Tag: Groceries"), so its state is never color alone, and takes the "on" look (`data-on`) while a choice is made. The select is named by the chip's word, which the shown text starts with.
- **Tag colors**: the nine tag colors (`.tag-gray` to `.tag-pink`) stay. Today they are dark-only (a pastel text on an 18 to 20% tint). They become tokens in phase 7, which gives them light values, and join the contrast check then; they are not in `tokens.css` yet.

Replaces `.pill`, `.manual-badge`, `.cash-chip`, `.health-badge`, `.tag-chip`, `button.tag-suggestion`, `.card-mode-category`, `.pending-tag`, `.low-conf-tag`, `.over-tag`, `.done-tag`.

### Notice

The only way to say something is wrong or worth knowing. See [Status and honesty](#status-and-honesty) for which level to use.

| Level | Look | Example |
|---|---|---|
| Critical | `--neg` text on `--neg-tint`, icon | "Chase needs reconnecting. Its balances are from Aug 7." / "This total is short by 2 accounts." |
| Caution | `--warn` text on `--warn-tint`, icon | "Couldn't refresh Ally; balances are from yesterday." / "History paused since Oct 3." |
| Information | `--text-2` on `--caveat-surface` | "Converted to USD at ECB rates." |
| Done | `--pos` text on `--pos-tint` | "Saved. 14 transactions now use this rule." |

- Two forms: **inline** (one line under the number it qualifies) and **block** (inside a card or sheet, with an optional action button).
- **Gathered** (since phase 4a, `components/TotalCaveats.tsx`): two or more caution or information notices on one figure become one `<details class="notice-summary">` whose summary is a notice in the worst one's color, "2 notes: old exchange rates and accrued interest left out" (the worst kinds first, so an amber line names what made it amber; past three kinds, "and 2 more"), opening in place to each in full in its own color. Critical ones are never gathered. The words stay on the page while it is closed.
- Never color alone: every notice has an icon and words, and starts with its level for a screen reader ("Critical:", "Caution:", "Note:", visually hidden), as Needs attention's rows do.

Replaces `.error`, `.stale-note`, `.as-of.stale`, `.status-note`, `.info-notice`, `.plan-warning`, `.forecast-warning`, `.api-access-warning`, `.restore-banner`, and the feature-scoped notes (`.lifecycle-note`, `.review-note`, `.split-note`, `.goal-note`, `.budget-note`, `.currency-note`, `.imported-history-note`, `.kind-warnings`, `.plan-save-error`, `.payoff-field-error`, `.card-mode-error`).

### Helper text and disclosure

- **Helper text**: one line, `--fs-2`, `--text-2`, under the thing it explains. Replaces seven muted-note styles that differ only in size (11 to 14px) and margin: `.panel-note`, `.empty-note`, `.as-of`, `.chart-note`, `.lifecycle-note`, `.rename-hint`, `.review-note`.
- **"Why?" / "How this works" disclosure**: a ghost button that expands an explanation in place. Every paragraph of prose that is on screen by default today (connect options, the download formats, the plan's derivations, About these numbers) moves behind one. Built as `components/Why.tsx`: a `<details class="why">` whose `<summary>` looks like a ghost button (44px, `--accent`), the explanation below it in `--fs-2`, `--text-2`. A `<details>` needs no script and is native to the keyboard and screen readers.

### Sheet

The existing sheet (`Sheet.tsx`, bottom on phones, side panel from 720px) is the one coherent family today and stays. Additions: a footer for its primary and secondary buttons, 44px close and back buttons, and a back button for a sheet that opens a second level (instead of stacking a sheet on a sheet, which loses focus).

The footer is `Sheet`'s `footer` prop, drawn as `.sheet-footer` after the scrolling body (the sheet is a flex column, so it stays in view without `position: sticky`): a hairline above, the buttons wrapping like a `.btn-row`. The close and back buttons are 44px with 20px icons.

### Menu

A small popover for an object's rare actions (the institution ⋯ menu, a transaction's overflow). Items are 44px rows; a destructive item is last, in `--neg`, and opens a confirm sheet.

Built as `components/Menu.tsx`: a 44px `.icon-btn` (⋯) with `aria-haspopup="menu"`, opening a `.menu` of `.menu-item` buttons on `--elevated` with a `--border-strong` edge, aligned to the button's right edge (moved in when that would take it past the screen's edge), below it or above it when there is no room below. Its ⋯ is outlined like a secondary button. It follows the WAI-ARIA menu button pattern: focus moves to the first item, the arrow keys, Home and End move between items, Escape closes it (and only it, inside a sheet), and focus returns to the button after Escape or a choice. A press outside closes it. It is drawn in place, so inside a sheet it belongs in the footer or the header, not in the scrolling body, which would clip it.

### Empty state

A title, one line of helper text, and one primary action. Replaces the empty-note paragraphs that explain at length ("No recurring charges detected yet; they show up once...").

### Skeleton

What a screen shows while what fills it is on its way: the screen itself, with placeholders where its data goes, so nothing moves when the data arrives. Not a spinner in an empty card, which the page then grows from.

- **The placeholder** (`.skeleton`): `--elevated` at `--r-xs`, pulsing between full and half opacity over `--dur-pulse`, held still under reduced motion. Inside text it is an inline block 0.8em tall, so its line keeps the height of the words it stands for; given a width near theirs. `.skeleton.block` is a box, for a field, a button or a plot, sized where it is used. Its sizes are named for the view (`.home-skeleton-total`), not as variants of the placeholder. One exception in look: the header's icon buttons are drawn as their outlines (`.app-loading-btn`, transparent with the `--border-strong` edge a secondary button has), which their icons then fill.
- **Drawn on the real component's classes.** The loading view is the card it stands for, its header, rows and chart on their own classes, with placeholders only where data goes, so it is as tall as what replaces it at every width. Words that are known (a card's title) show as words.
- **Said once.** Placeholders are hidden from a screen reader; the card is `aria-busy` and one `role="status"` in it says it is loading, also when the view is a whole page.
- **Never in place of a warning.** A skeleton stands for data on its way, never for a figure that couldn't be read: a load that fails says so in its notice, as before.
- **Never only a placeholder.** A wait that can end without its content says so after a while: the sign-in page's form placeholder gets a caution notice when Clerk's form hasn't come in 15 seconds, and a demo sign-in or a password login that hasn't opened the app in 12 shows its page again.
- **Where it is** (`components/LoadingSkeletons.tsx`): Home's Net worth card while the dashboard's first load is on its way, and the same under the dashboard's header as a whole page, which Home streams while the server reads the session and the sign-in page and the password login hand over to. A small wait inside a card (an account's history) keeps its spinner, in a box the chart's size.

**The sign-in page** is laid out from the top, not centered: Clerk's form arrives after the page and changes height from step to step, and centered, every change moved the name and the demo card above it. The pages that share its layout (an invite link's, Not allowed yet) are laid out from the top too, so the name stays put from one to the next. Until Clerk's form loads, a placeholder of its width and about its height holds its place, and the form fades in where it was. From a demo button's press the page shows the app loading in its place. Once Clerk signs someone in, it moves to Home, which streams the same view at once while the server reads the session, and the dashboard then draws it again while its first load is on its way: one view from the sign-in to the figures.

### Header and tab bar

- **Header**: brand, then hide amounts, refresh, and the avatar (or a gear in password mode). The avatar menu leads with Settings and carries a dot when something in Settings needs attention.
- **Tab bar**: five tabs, icons with `--fs-1` labels (12px, up from 11px), `--glass` with a blur.

## Status and honesty

Nya shows its gaps on purpose (see [features.md](../features.md)): a missing row usually means a missing debt, which makes net worth look better than it is. The reorganization must not soften any of that. It ranks and places it.

**Severity sets the color; it is never downgraded to save space.**

| Severity | When | Color |
|---|---|---|
| Critical | A number is wrong or short: an institution needs reconnecting, rows couldn't be shown, a total is incomplete. Also an overdue payment in Needs attention | Red |
| Caution | Numbers are real but dated, held or paused: stale but recovered balances, an account that stopped reporting (held at its last known balance until you answer), a connection that ends soon (Reconnect soon), history paused, a backup or clean-up failed, a month may be missing transactions. In Needs attention, also a payment due within a week and a budget over or nearly over | Amber |
| Information | Nothing is wrong: converted currency, imported history, rates used | Neutral |

**Placement follows three rules.**

1. **On the number.** A caveat sits directly under the figure it qualifies, as an inline notice. **Critical caveats are never collapsed**: each shows in full, naming the institution and what is wrong ("Chase needs reconnecting; its balances are from Oct 21", "This total is short by 1 account"). Caution and information caveats show in full when there is one; two or more become a summary line that states the count and kind in words, in the color of the worst of them ("2 notes: 1 balance from yesterday, accrued interest left out"), and expands in place to every note in its current full wording. Never an unlabeled icon, never only in a sheet.
2. **Counted on Home.** Anything that needs the person to act (reconnect, answer an account question, approve the review queue, a payment due, a bank a restore brought back or a restore that can't be read) is also an item in Home's **Needs attention**, linking to where it is fixed. An overdue payment is red there: nothing on screen is wrong, but it costs the person until it is paid.
3. **Once per tab, not once per card.** On Budgets and Plan, a month or input that may be incomplete gets one notice at the top of the segment and a small badge on each affected card, instead of the same paragraph in every card.

**A connection's problems have one color**, from two questions (`lib/accounts-status.ts`, since rollout phase 3b): is it broken in a way only the person can fix (sign in again, reconnect, connect again, pay or fix it at SimpleFIN or Lunch Flow, say which way a card goes, remove one that can't be repaired)? Is the total missing an account's money (nothing fetched or recovered, accounts not shown, too old, held with no balance)? Either makes it critical, and the card shows the button that fixes it or says what isn't counted. Anything else that is off is a caution, a new connection waiting for its first answer included. The card's notice, its badge, Settings > Connections and the Accounts status all use it, and the words never change with the color.

**Who an instruction is for.** The backup and receipt clean-up notices reach every user (the server sends them ungated), but only the deployment's admin can act on "check the backup cron in Vercel". When one fails, everyone sees it as an amber caution on the Net worth card ("The nightly backup failed; the last one saved was Oct 20"); the instruction and its action show only to the admin, in an Admin card under Needs attention. Each of its rows goes to the admin's Nightly jobs page (`/admin/jobs`), a page of its own where the job's runs are and **Run now** runs it, so Home carries no controls for it. When backups are fine, nothing is shown.

## Copy

- **One line of helper text** by default. A second paragraph goes behind "Why?".
- **Say what to do**, then why: "Reconnect Chase to update its balances", not "Chase's connection has expired. ITEM_LOGIN_REQUIRED".
- **Name things the same everywhere**: "Hide", "Close", "Disconnect", "Forget" each mean one thing (see [information-architecture.md](information-architecture.md#vocabulary)).
- **Sentence case** for titles, buttons and labels.
- **No em or en dashes.** Commas, colons, parentheses or separate sentences.
- **Amounts in the account's currency**, as today; hide amounts (`data-amounts="hidden"`) keeps masking every figure in every new component.

## Accessibility

- 44px minimum targets on touch (`--tap`). Today `.link-btn` is about 15px, `.disconnect-btn` about 26px, `.chart-range` about 28px; about 10 rules set a 44px minimum.
- Real headings (`<h1>` per screen, `<h2>` per card) so screen-reader users can jump by heading.
- No interactive element inside another (no buttons inside a clickable row; a "Why?" for a row lives in the sheet the row opens).
- A deep link or a jump (the Accounts status pill, `?view=connections`, a Needs attention item) moves keyboard focus to the target's heading, not just the scroll position.
- One global `:focus-visible` ring in `--focus`, 2px, offset 2px; no component removes it.
- Segmented controls and menus follow the WAI-ARIA tabs and menu patterns, with arrow keys.
- Sheets trap focus and return it to the control that opened them; a second level replaces the content with a back button instead of stacking.
- Reduced motion respected everywhere through the motion tokens.
- AA contrast for every token pair in both themes (see [Color](#color)).

## What this replaces

A summary of the current CSS, from an audit of `app/globals.css` (about 6,700 lines) on `origin/main`:

| Today | After |
|---|---|
| 11 color tokens, nothing else tokenized, no light theme | Color, type, space, radius, motion and layer tokens, light and dark |
| Palette restated by hand in `app/layout.tsx` | One source shared with Clerk and `themeColor` |
| 26 font sizes, 38 declarations under 12px | 7 steps, nothing under 12px |
| 19 border radii | 5 |
| About 50 note and alert classes | Notice (4 levels) and helper text |
| About 25 one-off button classes | 5 button variants plus a group |
| 296 inline `style={{}}`, 245 of them `marginTop` | Stack gaps; inline style only for data (bar widths, chart colors) |
| `.inst-*` as the generic header in 43 files, as `<div>` | `.card-header` with a real heading |
| 14 uppercase micro-label styles | Sentence case at 12 to 13px |
| Contrast fails on primary and danger buttons | All 76 checked pairs pass AA |
| Broken fallbacks (`var(--track)` undefined, `var(--card, #fff)`) | Removed |
| A spinner in an empty card while Home loads, a sign-in page that moved as Clerk's form arrived | Placeholders on the real card's classes; the sign-in page from the top, with a placeholder for the form |
