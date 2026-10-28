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
- **One hero number per screen.** Net worth on Home, a month's net on Activity, the answer on Plan (when you reach FI, since phase 8b: words, at the hero's 32px end so "Around age 39" fits a phone's line). Everything else is smaller.
- **Color is meaning.** Brass is for things you can act on and the current selection (ink and brass, from the logo, since the look and feel's step 4). Green and red are for money in and out, and for gain and loss. Orange is only for something that needs you. Red as a background means a number is wrong or short. One status uses green: the Accounts tab's "All synced", the good end of the status pill whose other ends are red and orange. Brass sits close to orange, coral and body text in lightness, so it never carries a meaning alone: a link inside a sentence is underlined, a meter at caution is hatched, and two chart lines differ by dash.
- **Considered and rejected:** an editorial "warm paper" style with a serif display face. It is pleasant for reading and worse for scanning columns of figures.

The mockups ([mockups/index.html](mockups/index.html)) show the refined current dark beside this direction on Home, so the choice can be made on a real screen.

## Color

Defined in `tokens.css` and copied into `app/globals.css`; Clerk's appearance and `themeColor` in `app/layout.tsx` read them from `lib/theme.ts`, and the web manifest restates two of them. The guard test keeps all of these equal to `tokens.css`.

| Role | Token | Dark | Light | Use |
|---|---|---|---|---|
| Page | `--canvas` | `#0b1019` (ink) | `#f4f5f8` | Behind cards |
| Card | `--surface` | `#131a27` | `#ffffff` | Cards, sheets |
| Raised | `--elevated` | `#1b2333` | `#eef0f4` | Pressed rows, inputs on a card, a secondary button's fill |
| Chrome | `--glass` | 88% surface | 88% white | Header and tab bar over a blur |
| Divider | `--border-subtle` | `#222b3c` | `#e3e6ec` | Between rows |
| Edge | `--border-strong` | `#2e384c` | `#d3d8e1` | Card, sheet and menu edges. About 1.4:1, so it never marks a control on its own |
| Control | `--border-input` | `#6f7b91` | `#737c8c` | A control's edge: fields, chips, and a secondary button on a fill of its own (a notice, the rule offer) (3:1 on canvas, card and raised) |
| Text | `--text-1/2/3` | `#eeece7` / `#9ba4b5` / `#8b94a6` | `#111826` / `#4f5869` / `#5e6777` | Primary, secondary, meta |
| Action | `--accent` | `#d4b680` (brass) | `#846326` | Links (underlined inside a sentence), selection, focus |
| Money in | `--pos` | `#4ade9b` | `#047857` | Inflows, gains |
| Money out | `--neg` | `#f7857a` | `#b91c1c` | Outflows, losses, critical text |
| Needs you | `--warn` | `#fb9a4b` (orange) | `#a3410b` | Caution text |
| Tints | `--*-tint` | solid, about 12% | solid, about 8% | Notice and chip backgrounds |
| Primary | `--accent-fill`, `--on-accent-fill` | `#cdae74` (brass) under `#0b1019` (ink) | `#18243d` (the logo navy) under white | The primary button |
| Danger | `--danger-fill`, `--on-fill` | `#dc2626` under white | same | The danger button |
| Tags | `--tag-<color>`, `--tag-<color>-tint` | pastel on a solid ~19% tint | a deep step on a solid ~8% tint | A tag's chip (text on tint) and its swatch (the text step), for the nine colors in `lib/tags.ts` (since phase 7) |
| Shadow | `--shadow` | 45% black | 16% ink | Under a sheet |
| Logo tile | `--logo-tile` | white | white | Behind a merchant's logo, so a dark logo shows on a dark card |
| Logo mark | `--brand-mark` | `#bfa271` (the logo gold) | `#18243d` (the logo navy) | The header logo's one ink, and nothing else |

**Contrast.** Every text token passes WCAG AA (4.5:1) on canvas, surface and elevated in both themes, every meaning color passes on its own tint, each fill's label passes on it, field borders pass 3:1 on every surface, and each tag color passes 4.5:1 on its tint and 3:1 (its swatch) on a card. The pairings are checked by `test/design-guard.test.ts` on every test run. The ones most likely to matter:

| Pair | Dark | Light |
|---|---|---|
| `--text-2` on `--surface` | 6.95 | 7.16 |
| `--text-3` on `--surface` | 5.71 | 5.70 |
| `--accent` on `--surface` | 8.97 | 5.54 |
| `--neg` on `--surface` | 7.13 | 6.47 |
| `--warn` on `--warn-tint` | 6.67 | 5.61 |
| `--neg` on `--neg-tint` | 6.08 | 5.64 |
| `--accent` on `--accent-tint` | 7.42 | 4.88 |
| `--on-accent-fill` on `--accent-fill` | 8.98 | 15.46 |
| white on `--danger-fill` | 4.83 | 4.83 |
| `--border-input` on `--elevated` (3:1 for UI, its weakest surface) | 3.68 | 3.69 |
| `--brand-mark` on `--canvas` (3:1 for a graphic) | 7.82 | 14.18 |
| `--accent` from `--text-1` | 1.65 | 3.21 |

The primary's label is the ink in dark: white on its fill would be 2.12:1 (and 1.94:1 on `--accent`, where Clerk's primary states draw it). Brass is 1.65:1 from body text in dark and 3.21:1 in light, so a link inside a sentence is underlined (`a:not([class])`, and Clerk's "Sign up"), never told by its hue alone.

**Charts** use the same tokens: `--pos` and `--neg` for in and out, `--accent` for the selected series, `--text-3` for ticks, `--border-subtle` for gridlines. The column a readout is for is marked with a `--border-strong` rule, a line drawn for comparison is `--text-3`, and a heat map (the Plan's grid) is a neutral ramp from `--elevated` to `--border-strong`, through `color-mix`, never brass behind a figure (since the screen review after step 5): its ends are about 1.3:1 apart, low contrast end to end, a cue only, since the figures carry the value; text passes 4.5:1 on its strongest cell in both themes (`--text-2` 4.69 dark, 5.01 light), and the plan's own cell is the grid's only brass, a 2px outline (3:1 or more). Two lines told apart (the forecast and a what-if, Runway with and without income) differ by dash as well as color, since brass is about 1.1:1 from orange and 1.3:1 from coral: the second is round dots (`0 4`; with round caps a short dash looks solid), and the legend shows each line's sample (`LegendLine`). A what-if is `--text-2`, not `--warn`, which means caution. The calendar's planned dot is a brass ring and a payment due an orange square. **No money on a line chart's plot** (since the screen review): Home's hero is drawn edge to edge (see Hero, under Components), and every other net worth chart (an account's sheet, a link's preview, a shared net worth) takes the same rules in its card's shape (150 to 340): drawn at its width, no gridlines and no money ticks, months at 12px, every month that fits labelled (a whole step of the ladder in `lib/chart-range.ts`, 12px apart by their widths, so they stay evenly spaced), and its scale in the readout (the range's change, the day under the finger), the label (current, low and high) and **Show as a table**. The cash forecast too: no gridlines or ticks, its zero and warning rules named in words at their left end ("Zero", "Warning", 12px `--text-2`, never an amount), drawn over the lines with a `--surface` halo and never over each other, and every day's low and end behind **Show as a table**. **All estimate, drawn solid**: a net worth history with no recorded stretch in the range shown (no segment of the line, however long, joins two recorded points, as when it is estimated up to a recorded today) would be dashed end to end, setting nothing apart, so it is drawn solid and says once that it is estimated: "· estimated" after the range in the readout, and "Estimated, not recorded" (", except Oct 27" for a recorded day) in its label and its info: not "from transactions", since a day bridged between two others is a straight line across days with no data. The look can change with the range: one that reaches a recorded stretch is dashed and solid again. A line of recorded points that is dashed only for the days between them (a shared net worth, a point a week) stays dashed, whatever estimated weeks sit among them. This is for history charts alone: a forecast is all estimate and stays dashed. The allocation views' class colors are fixed (`components/allocation-text.ts`): tag tokens, never a meaning color, unclassified money in the neutral `--border-input`. Each passes 3:1 on a card in both themes, and neighbours in the bar differ in lightness, which the guard checks. The tag green and orange, close to `--pos` and `--warn`, go to Real estate and Crypto, the classes least read as money moving; the tag red isn't used. No chart color is written as a literal (since phase 7). A chart **drawn at its own width** (`useDrawnWidth`, `components/drawn-width.ts`: Income vs spend and the cash flow since phase 5d, the cash forecast and the payoff plan since 6a4, the Plan's charts with phase 6 and 8, Home's hero since step 5 and every other net worth chart since the screen review; Runway and the allocation chart are still on a fixed viewBox) has a viewBox as wide as it is laid out, so a viewBox unit is a CSS pixel and its text is `--fs-1` (12px) at every width, never scaled down on a phone. A chart on a fixed viewBox draws its text at a fraction of its size on a phone (10px at 340 units is 7.3px on a 248px card).

**A path against a target** (Your path's chart, `components/PlanPathChart.tsx`, phase 8b): one `--accent` line of one series over a 12% `--accent` wash, the target as a dashed `--text-3` line with its 12px name, a `--pos` marker where the line reaches it, and a `--text-3` rule at the age it runs to. A year with money in (a scenario's windfall, phase 8d) steps the line straight up at its age, to what is in hand then, so a windfall that reaches the target reaches it on the line, with the marker on the step; its table row says both figures. No amount is written on the plot (no money ticks), so the plot needs no masking; the ages along it are spaced by their widths (`labelWidth` and `MIN_LABEL_GAP` in `components/drawn-width.ts`, shared with the fan chart), and one that would crowd another is left out. What it shows is said in words through `spoken()` for a screen reader, and every point is in a table behind **Show as a table**, through `Masked`. Once a plan is saved as your plan (phase 8e), two lines run before today, where the path starts: what was recorded, a solid 2px `--text-1` line, and where that plan had it, a dotted (`2 4`) 2px `--text-2` line, with a `--border-subtle` rule at today; a line under the chart names both (never the line's look alone), the summary starts with them, and they have a table of their own behind **Show as a table**. The axis then starts at the start's age, with "today" marked when there is room.

**Print** is the light theme with black and white over it (`@media print`, since phase 7): text, surfaces, lines and orange (`--warn`) are black, white and grays, and the other meaning colors and tints are light's, whichever theme is on screen. The guard holds print's copy of the light theme to `tokens.css`.

## Type

Red Hat (since the look and feel's step 3), taken with the ink and brass direction: **Red Hat Text** (`--font-ui`) for reading, and **Red Hat Display** (`--font-display`) for titles and figures. `app/layout.tsx` loads both through `next/font/google`, which fetches the files when the app is built and serves them from the app itself, so no page asks Google for anything, and the Content-Security-Policy's `font-src 'self'` covers them. Latin is preloaded; other scripts come from their own files when a page uses them, and anything Red Hat lacks falls to the system stack after it. Each token names its family after next/font's variable, so a page that loads the font some other way (a static check page) still gets it rather than a serif.

**Display** goes to `h1`, card titles (`.card-header` `h2` and `h3`), sheet titles, the bars' headings and the month's name, and the figures that stand alone: Home's total, In / Out / Net (and Debt payoff's summary, which shares its class), the Plan's stat figures and its answer in words ("Around age 39"), Card Mode's amount, a transaction's amount in its sheet, an account's balance, and a merchant's letter tile. A heading drawn as a label (Home's "Net worth") keeps Text. Clerk takes `var(--font-ui)`.

| Token | Size | Weight | Use |
|---|---|---|---|
| `--fs-hero` | 32 to 40px | 700 | The one hero number on a screen |
| `--fs-6` | 24px | 600 | Large figures in a stat strip |
| `--fs-5` | 20px | 600 | Screen titles |
| `--fs-4` | 17px | 600 | Sheet titles, settings section titles |
| `--fs-3` | 15px | 400 / 600 | Body, list rows; card titles (`<h2>`) and buttons at 600 |
| `--fs-2` | 13px | 400 | Secondary lines, notices, helper text |
| `--fs-1` | 12px | 500 | Meta: dates, chips, chart ticks |

- **Nothing on screen under 12px.** Since the words pass after the screen review, the only declarations under it are the ticks of the charts still drawn on a fixed viewBox (`.chart-tick`, `.chart-xlabel`, 10px: Runway and the allocation views), which go when those charts are drawn at their own width.
- **Money is tabular** everywhere it is in a column or can change in place: one rule on a `.money` class (and `.num` cells) instead of 27 separate `tabular-nums` declarations. Both Red Hat families carry true tabular figures. The hero keeps proportional figures, as now.
- **The hero's cents** are half its size (`--fs-5` of its 40px) in `--text-2`, on Home's net worth alone (`moneyRuns` in `lib/format.ts` marks them, wherever the locale puts them; with amounts hidden there are none). It is drawn in runs a screen reader would pause between, so the whole figure is said apart, as `Masked` does.
- **No uppercase micro-labels.** None is left (since the words pass after the screen review; the guard holds it, with `capitalize`): a sheet's section heading (`.section-label`, `.plan-subhead`) is sentence case at `--fs-2`, weight 600, in `--text-2`, and a meta line (`.type-tag`, the reports' kicker) at `--fs-1`. Words are written in sentence case where they are made, never cased by CSS. Uppercase at 10 to 11px was the hardest text in the app to read.
- **Headings are headings.** Card titles are `<h2>`, sections inside a card `<h3>`. Today 65 card titles are `<div class="inst-name">`.

## Space, shape and motion

- **Spacing**: `--sp-1` to `--sp-8` on a 4px grid. Card padding `--sp-4` on phones and `--sp-5` from 720px; gap between cards `--sp-3`; between rows 0 (dividers do the separating).
- **Margins belong to layout, not to text.** Notes and labels carry no built-in top margin; a stack container sets the gap. This is what removes the 245 inline `marginTop` patches (100 of them `marginTop: 0`, undoing a class's own margin).
- **Radii**: `--r-xs` 6 (chips), `--r-sm` 8 (inputs), `--r-md` 12 (buttons, notices), `--r-lg` 16 (cards, sheets), `--r-pill`. Today there are 19 radii.
- **Motion**: `--dur-fast` 140ms for presses and toggles, `--dur-base` 220ms for sheets and segment changes, `--dur-pulse` 900ms for each way of a loading placeholder's pulse, one easing. One global reduced-motion rule zeroes them; today only the sheets and Card Mode respect it.
- **Layers**: header, tab bar, sheet backdrop, sheet, toast, as tokens.

## Components

One component per pattern. Each lists what it replaces so the migration can delete as it goes.

### Hero

Home's net worth (`components/NetWorthCard.tsx`, since the look and feel's step 5): the one figure on the page, never in a card, so the cards under it stay plain. In order: the label (a real `h2`, focus's landing place), the figure at `--fs-hero` (32px on a phone, 40px from about 445px, never wrapping) with its cents at half size in `--text-2`, the change line (green with ▲ or red with ▼ and how much; a change that rounds to nothing is "No change in 30 days" in `--text-2`, with no arrow, `.hero-delta.flat`), what qualifies the total (`TotalCaveats`), the chart, the chart's cautions, and the foot row. A notice there keeps a `--border-subtle` edge, since an information notice's fill is about 1.0:1 from the canvas in light; a critical one has its own. It keeps `--sp-6` under it, where a card's margin was.

- **The chart** (`NetWorthChart` with `hero`) runs to the screen's edges through the page's gutter, drawn at its own width: one 2px `--accent` line (dashed where estimated, as everywhere, and solid when all of it is, said in words; see Charts, under Color) over a 12% wash, every month that fits at 12px kept inside the gutter, the today dot ringed in `--canvas`, and no gridlines and no money on the plot. The readout over it keeps the range's change; the range switch, the notes list and **Show as a table** (every day in the range, newest first, rendered once opened) sit under it.
- **Scrubbing.** A mouse over the plot, or a finger or pen once it has gone sideways (6px, more than up or down: the start of a scroll moves nothing), moves the figure to that day's value (in the hero's currency, masked when amounts are hidden), and the change line's place says the day: "Jul 1 · estimated · Sold the car", one line cut to fit, so an estimate never reads as recorded. The change line keeps its height, so nothing under the finger moves; lifting it, or leaving the plot, brings back today. A measurement between two days stays in the readout, and a note chosen from the list reads there too, never moving the figure. The plot is `touch-action: pan-y`: across the whole screen there is no gutter to scroll from, so a vertical drag scrolls the page.
- **Never** a second hero on a screen, money ticks on its plot, or a card around it.

### Card

A surface with an optional header: `<h2>` title on the left, a meta value or one action on the right. Content below is rows, a chart, or a stat strip.

```html
<section class="card">
  <header class="card-header"><h2>Chime</h2><span class="money">$320.00</span><button class="icon-btn" aria-label="Chime options">⋯</button></header>
  …rows…
</section>
```

A card that opens and closes (Hidden, Accounts that ended) has a header whose `<h2>` holds one button, the whole title row (`components/Collapsible.tsx`, `.section-toggle`): the title, then a neutral count badge and at most one status badge, then a chevron that turns when it is open. It is 44px tall and says whether it is open (`aria-expanded`).

Replaces `.inst-header`, `.inst-name`, `.inst-total` used as a generic header (43 files), `.institution-name`, `.holdings-title`, `.plan-subhead`, `.plan-scenario-heading` (gone since phase 6b: the open scenario's name is the Plan bar's heading), `.card-mode-header`, and `.report-page` (a copy of `.card`).

### List row

The workhorse. Leading logo or icon (optional), title, one subtitle line, trailing value with an optional second line, and a chevron when it opens something. At least `--row-min` (48px) tall; the whole row is the target.

- A row that opens a detail sheet is a `<button>` (or a link), never a `<tr>` with buttons inside it. Today account rows put Hide, Close..., Delete and Update inside a clickable `<tr>`.
- At most one subtitle line and one trailing secondary line. Anything more belongs in the detail sheet.
- Provenance (Updated, Last known, Estimated, Excluded, Rule, Split, Pending) is a chip on the subtitle line.
- Activity's transactions are list rows (since phase 5e): a logo (on a 32px `--logo-tile` with a `--border-strong` hairline, so a dark logo shows in dark; a letter on `--elevated` without one), the name with its tags (the bank's own text in capitals shown readably, `lib/merchant-name.ts`), one line with its provenance as `.badge` chips, and the amount. The line (since the screen review, which found rows of three and four lines) is the category and the account: the account's own name, with its institution after it only where another account loaded has the same name ("Plaid Checking, Tartan Bank", `distinctAccountNames` name first), one line cut with an ellipsis (`.txn-row-line`) rather than wrapping, the chips beside it where it fits whole and under it where it doesn't. The bank, Plaid's finer category and a connector's name are in its sheet; a row typed in or from a file says so as a chip (Entered by hand, Imported). A category Plaid was unsure of is Information, not caution: the line leads with a neutral 8px dot (`.txn-check`, a border in `--text-2` so forced colors keep it) and "Unsure category" for a screen reader, the list's **Unsure category (N)** chip counts and filters them with the same dot, and the sheet keeps the Check category badge with Looks right. Neither a pending row nor a split's or group's row is marked, since the sheet can't answer it there. The notes that bear on what a transaction counts as (an exclusion that couldn't be read, a pair worked out, its split or group, how it is shared, a file's amount the bank changed) stay under that line in `--fs-1`, never only in its sheet. A split's parts and a group's transactions are rows of their own, set in past the logo.
- A budget is a list row (since phase 6a2): its name, with an **Over** badge past its limit, the meter under the name, one subtitle line (what rolled over, with a badge when the group's or its categories' budgets set the limit), and its figures as the trailing value ("$1,240.00 of $1,300.00", `--fs-2`, at most half the row), with "Began the month ... over" as their second line. A group's row opens and closes in place on its categories, which are rows of their own set in under it, each opening the budget's sheet.
- What is coming is a list of plain rows (since phase 6a3): Budgets > Upcoming's list and the calendar's day list share one row, under Activity's day bars (`.txn-day`, the day and what it is expected to come to): the name, one subtitle line in the calendar's words ("bill · Monthly", "planned · Once", why it isn't in the day's figure), with a **Due** badge leading a card's or loan's payment due, and the amount, quieter when it isn't in the day's figure. They open nothing; Recurring's and Planned's rows, at the foot, open their sheets.
- The calendar over those rows: its day cells (since phase 6a4) carry a figure at 12px with its sign and no currency, which the legend names once ("Day figures in USD, rounded"): whole units under a thousand, then two significant figures and K, M, B or T ("-143", "+3.5K", "-13K"), in the viewer's digits. Its grid runs to the card's edges, as a card's rows do, so a cell is 39px wide at 320px and 44px or more from a 360px phone, its focus ring drawn inside.
- The figures the Plan rests on are list rows (since phase 6c, Plan > Your path's Your figures): each figure's title, where it came from in a few words as its subtitle ("A year, from transactions", "2 accounts, as of Oct 6, 3:12 PM"), the figure as the trailing value (the savings rate as its second line), a chevron; the row opens the figure's sheet, where Why? says how it was worked out. What qualifies the figure sits under the row, outside the button, through `TotalCaveats`, as under Home's FI line. A row opens its sheet while editing is paused (the sheet says why it can't be saved yet), and is held (`aria-disabled`) only while the plan reloads.
- A row that reports a status (Home's Needs attention) leads with `.list-row-icon`, a 32px square in its level's tint holding a shape for each level (an alert, a clock, an info mark), and a word for a screen reader before its title: never color alone.

Replaces `.acct-row` and `.txn-main` (both gone since phase 6a3, with Recurring's and Planned's tables), `.txn-text`, `.peer-row`, `.peer-item`, `.cat-manage-row`, `.timeline-note-row`, `.budget-summary` (Budgets > Month since phase 6a2; Goals' rows keep it until they are redrawn), and the table-based account and transaction lists.

### Stat strip

Two to four labelled figures in a row (In, Out, Net). Label `--fs-1` in `--text-2`, figure `--fs-6`. Replaces `.summary-row` and `.summary-value`.

### Buttons

| Variant | Look | Use |
|---|---|---|
| Primary | `--accent-fill`, its `--on-accent-fill` label (ink on brass in dark, white on navy in light) | The one main action in a card or sheet |
| Secondary | Tonal: `--elevated` fill, `--text-1` label, no edge (a transparent one, for forced colors); `--border-subtle` on hover. On a fill of its own (a notice, the rule offer) transparent with a `--border-input` edge | Other actions |
| Ghost | Text only in `--accent`, padded to 44px, underlined on hover | Inline actions (Edit, See all) |
| Danger | `--danger-fill`, its white `--on-fill` label | Confirming something destructive, inside a confirm sheet only |
| Icon | 44px square, icon 20px in `--text-2`, bare (no edge or fill), `--elevated` on hover; its `aria-label` is its name. A sheet's close and back are filled circles (`.sheet-icon-btn`) | Header, card menus, the month's arrows, back |

- **Width is auto by default**; `.btn-block` makes one full width. Today `button { width: 100% }` forces about 25 one-off classes (`.logout-btn`, `.manage-toggle`, `.disconnect-btn`, `.plan-edit`, `.pool-toggle`, `.split-small`, `.rollup-toggle` and more) that each undo it.
- **One button group** (`.btn-row`): gap `--sp-2`, wraps on narrow screens, primary last. Replaces `.button-pair`, `.action-row`, `.card-actions`, `.button-stack`.
- **Danger is never a first-level button** on a working screen. Disconnect, Delete and Forget live in a menu or a detail sheet and confirm in a sheet. Replaces `.disconnect-btn` (red-bordered in a card header), `.danger-link`, `button.danger-outline`. The one exception: a connection that can't be repaired shows **Remove {name}** (or Disconnect, for a SimpleFIN or Lunch Flow connection that is gone) as a secondary button on its card, since removing it is the fix; it still confirms in a sheet.
- `.link-btn` (about 15px tall today) becomes Ghost, screen by screen (the screen review moved the payoff plan's choices on a debt and the admin's unused connections card).

### Segmented control

Two to four mutually exclusive views of the same thing (Transactions / Spending / Shared; History / Monte Carlo), drawn as an underline switch that matches the tab bar (since the look and feel's step 2): no track, a 1px `--border-strong` rule under it, each item 44px tall in `--text-2` at weight 500, the current one `--text-1` at weight 600 over a 3px `--accent` bar (a bottom border, so forced colors keep it; `--accent` is 4.6:1 or more on canvas, card and raised). `role="tablist"` when it switches views, a radio group when it switches a setting; `Segmented` (`components/Segmented.tsx`) draws either, with one tab stop and the arrow keys.

A **range control** (1M ... All) looks the same but is a labelled radio group. `.segmented.compact` (12px labels) holds up to eight, each 44px tall and narrower than 44px (24px or more) so the net worth chart's eight fit 320px; a set whose labels don't fit becomes chips, unless short labels say it. Spending's period lengths (chips since phase 5c, a fourth kind of switch that wrapped at 375px) are `.segmented` since the screen review: **1M · 3M · 12M · YTD**, a labelled radio group held to its items' width (`.spending-period`, so it reads as a control on the segment rather than a second row of tabs under Activity's), each item named for a screen reader with its words first ("YTD, year to date", WCAG 2.5.3), through `Segmented`'s third option element. The cash forecast's 30, 60 and 90 days (since phase 6a3) are the first range control drawn as `.segmented`. Budgets > Upcoming's **List · Calendar** is a tablist of two, held to the mockup's width (`.upcoming-views`). Replaces `.chart-ranges` / `.chart-range` (a generic control named after the chart), `.manage-toggle`, and the `[aria-pressed]` chip toggles used as modes.

### Month stepper

The one control that changes the month (since the look and feel's step 2b1), `components/MonthStepper.tsx`: Activity's bar, Budgets' bar on Month and Upcoming's calendar. Bare `.icon-btn` arrows labelled **Earlier month** and **Later month**, focusable at either end (`aria-disabled`); the month's name (`--fs-3`, weight 600, `aria-live="polite"`, `tabIndex={-1}` so a jump can land on it) with a 16px chevron and a native select laid unseen over the two alone, named for the month it lies over ("Month to show: October 2026"; the calendar's "Calendar month: ..."); and a `.btn.ghost` return button after the name while another month shows: **This month**, or **Latest month** on Activity while this month has no transactions yet. Pressing it moves focus to the list (or the name) before it goes. At 320px it doesn't fit beside the name and wraps under it; the arrows and Activity's ⋯ keep to the first line. Activity and Budgets share one month for the session (step 2b2, `components/view-month-state.ts`); the calendar keeps its own, since it runs a year ahead. Each tab shows the month it can: Activity the latest month with transactions at or before it, else its oldest, Budgets this month for a later one. Landing on a tab's own default (Activity's month it opens on, Budgets' this month) clears the shared month, as the return button does, and Home's links reset it. A past month on Budgets says, at the top of its panel, that it is shown as it was and budgets change in this month.

### Badge and chip

One family, `--r-xs`, `--fs-1`, weight 500, sentence case.

- **Badge**: a status or source label that isn't clickable (Manual, via SimpleFIN, Pending, Overdue). Tones: neutral, accent, pos, neg, warn, each on its tint.
- **Chip**: clickable (a filter, a tag, a selectable option), 32px tall inside a 44px hit area, edged in `--border-input` so it reads as a control. One that is on takes an `--accent` edge on `--accent-tint` and leads with a check, so its state is never color alone. Tones `neg` and `warn` (since phase 3c) for a status that jumps to what it counts, the Accounts status pill: its severity's tint, with the edge kept in the text's color and a trailing chevron, so it never reads as a badge.
- **Filter chips** (since phase 5b) sit in a `.chip-row`, which wraps with 12px between rows so each chip's 44px hit area ends where the next row's begins. A filter that is on or off is a `button.chip` with `aria-pressed` (To review). One that chooses among a few options is a **select chip** (`ChipSelect`, `.chip-select`): a native select laid unseen over the whole hit area, so a phone opens its own picker, with a trailing down chevron. It shows its word and the choice ("Tag", "Tag: Groceries"), so its state is never color alone, and takes the "on" look (`data-on`) while a choice is made. The select is named by the chip's word, which the shown text starts with.
- **Tag colors**: the nine tag colors (`.tag-gray` to `.tag-pink`) are tokens since phase 7 (`--tag-<color>` on `--tag-<color>-tint`): in dark a pastel on a solid tint, in light a deep step on a pale one, each in the contrast check. A color's swatch on the Tags screen is its text step, since a tint alone is too faint to tell apart.

Replaces `.pill`, `.manual-badge`, `.cash-chip`, `.health-badge`, `.tag-chip`, `button.tag-suggestion`, `.card-mode-category`, `.pending-tag`, `.low-conf-tag`, `.over-tag`, `.done-tag`.

### Notice

The only way to say something is wrong or worth knowing. See [Status and honesty](#status-and-honesty) for which level to use.

| Level | Look | Example |
|---|---|---|
| Critical | `--neg` text on `--neg-tint`, an edge in `--neg`, the alert triangle | "Chase needs reconnecting. Its balances are from Aug 7." / "This total is short by 2 accounts." |
| Caution | `--warn` text on `--warn-tint`, the clock | "Couldn't refresh Ally; balances are from yesterday." / "History paused since Oct 3." |
| Information | `--text-2` on `--caveat-surface` | "Converted to USD at ECB rates." |
| Done | `--pos` text on `--pos-tint` | "Saved. 14 transactions now use this rule." |

- Two forms: **inline** (one line under the number it qualifies) and **block** (inside a card or sheet, with an optional action button).
- **Gathered** (since phase 4a, `components/TotalCaveats.tsx`): two or more caution or information notices on one figure become one `<details class="notice-summary">` whose summary is a notice in the worst one's color, "2 notes: old exchange rates and accrued interest left out" (the worst kinds first, so an orange line names what made it orange; past three kinds, "and 2 more"), opening in place to each in full in its own color. Critical ones are never gathered. The words stay on the page while it is closed.
- Never color alone: every notice has an icon and words, and starts with its level for a screen reader ("Critical:", "Caution:", "Note:", visually hidden), as Needs attention's rows do. Critical and caution differ by shape as well as color (in light, `--neg` and `--warn` are about 1.1:1 apart): critical has the alert triangle and an edge, caution the clock, the same shapes as Needs attention's rows.

Replaces `.error`, `.stale-note`, `.as-of.stale`, `.status-note`, `.info-notice`, `.plan-warning`, `.forecast-warning`, `.api-access-warning`, `.restore-banner`, and the feature-scoped notes (`.lifecycle-note`, `.review-note`, `.split-note`, `.goal-note`, `.budget-note`, `.currency-note`, `.imported-history-note`, `.kind-warnings`, `.plan-save-error`, `.payoff-field-error`, `.card-mode-error`).

### Helper text and disclosure

- **Helper text**: one line, `--fs-2`, `--text-2`, under the thing it explains. Replaces seven muted-note styles that differ only in size (11 to 14px) and margin: `.panel-note`, `.empty-note`, `.as-of`, `.chart-note`, `.lifecycle-note`, `.rename-hint`, `.review-note`.
- **"Why?" / "How this works" disclosure**: a ghost button that expands an explanation in place. Every paragraph of prose that is on screen by default today (connect options, the download formats, the plan's derivations, About these numbers) moves behind one. Built as `components/Why.tsx`: a `<details class="why">` whose `<summary>` looks like a ghost button (44px, `--accent`), the explanation below it in `--fs-2`, `--text-2`. A `<details>` needs no script and is native to the keyboard and screen readers.

### Sheet

The existing sheet (`Sheet.tsx`, bottom on phones, side panel from 720px) is the one coherent family today and stays. Additions: a footer for its primary and secondary buttons, 44px close and back buttons, and a back button for a sheet that opens a second level (instead of stacking a sheet on a sheet, which loses focus).

Its motion is the tokens' (since the screen review): it slides on `--dur-base` with `--ease`, over the scrim with no blur, and comes off the page as the slide ends (`CLOSE_MS` in `Sheet.tsx`, which the guard holds to `--dur-base`).

An object's actions in its sheet are one list of rows (`ActionRows`, since the screen review): a `.card.list-rows` of `.list-row` buttons, one line each, a chevron on those that open another sheet; one that acts in place (Exclude) has none, and may carry a subtitle saying what it does. Why an action isn't offered yet is a `.helper` line after the list.

The footer is `Sheet`'s `footer` prop, drawn as `.sheet-footer` after the scrolling body (the sheet is a flex column, so it stays in view without `position: sticky`): a hairline above, the buttons wrapping like a `.btn-row`. The close and back buttons are 44px with 20px icons. The title wraps rather than being cut with an ellipsis (a scenario's name is up to 40 characters).

### Menu

A small popover for an object's rare actions (the institution ⋯ menu, a transaction's overflow). Items are 44px rows; a destructive item is last, in `--neg`, and opens a confirm sheet.

Built as `components/Menu.tsx`: a 44px `.icon-btn` (⋯) with `aria-haspopup="menu"`, opening a `.menu` of `.menu-item` buttons on `--elevated` with a `--border-strong` edge, aligned to the button's right edge (moved in when that would take it past the screen's edge), below it or above it when there is no room below. Its ⋯ is a bare icon button, as the header's are. It follows the WAI-ARIA menu button pattern: focus moves to the first item, the arrow keys, Home and End move between items, Escape closes it (and only it, inside a sheet), and focus returns to the button after Escape or a choice. A press outside closes it. It is drawn in place, so inside a sheet it belongs in the footer or the header, not in the scrolling body, which would clip it.

An item can be a link to a file to save (a report's **Download as CSV**): a real `<a download>` with `role="menuitem"`, drawn as the other items are, so it saves with no script and keeps the browser's own "save link as". As a link it is chosen with Enter, not Space.

Clerk's account menu (the avatar's) takes the same row metrics through `CLERK_APPEARANCE` in `lib/theme.ts` (look and feel step 2c), and Clerk's corners are `--r-sm`.

### Empty state

A title, one line of helper text, and one primary action. Replaces the empty-note paragraphs that explain at length ("No recurring charges detected yet; they show up once...").

### Skeleton

What a screen shows while what fills it is on its way: the screen itself, with placeholders where its data goes, so nothing moves when the data arrives. Not a spinner in an empty card, which the page then grows from.

- **The placeholder** (`.skeleton`): `--elevated` at `--r-xs`, pulsing between full and half opacity over `--dur-pulse`, held still under reduced motion. Inside text it is an inline block 0.8em tall, so its line keeps the height of the words it stands for; given a width near theirs. `.skeleton.block` is a box, for a field, a button or a plot, sized where it is used. Its sizes are named for the view (`.home-skeleton-total`), not as variants of the placeholder.
- **Drawn on the real component's classes.** The loading view is the card it stands for, its header, rows and chart on their own classes, with placeholders only where data goes, so it is as tall as what replaces it at every width. Words that are known (a card's title) show as words, and controls that are known are the controls themselves: the app loading's header has the dashboard's own buttons (hide amounts, Refresh turning and unavailable as the dashboard draws it while it loads), and the account menu's circle is the same placeholder the menu itself shows until Clerk draws the avatar.
- **One pulse.** A view drawn anew as it is handed on (the sign-in page's, Home's while it reads the session, the dashboard's own) keeps the pulse, and Refresh's turn, in step with the first this page showed, so a new copy never blinks.
- **Said once.** Placeholders are hidden from a screen reader; the card is `aria-busy` and one `role="status"` in it says it is loading, also when the view is a whole page.
- **Never in place of a warning.** A skeleton stands for data on its way, never for a figure that couldn't be read: a load that fails says so in its notice, as before.
- **Never only a placeholder.** A wait that can end without its content says so after a while: the sign-in page's form placeholder gets a caution notice when Clerk's form hasn't come in 15 seconds, and a demo sign-in or a password login that hasn't opened the app in 12 shows its page again.
- **Where it is** (`components/LoadingSkeletons.tsx`): the open tab while the dashboard's first load is on its way (Home's hero, Accounts' institution cards, and Activity's, Budgets' and the Plan's bar over the segment's cards), and the same under the dashboard's header as a whole page, which Home streams while the server reads the session and the sign-in page and the password login hand over to. Inside the tabs: Activity's list and Budgets' Month and Upcoming while transactions load (Month again until the budgets are read), each Plan segment while the saved plan loads, the Plan's bar and card while its code arrives, Progress's lines, and Shared with me while it is read. A small wait inside a card (an account's history) keeps its spinner, in a box the chart's size.
- **A tab's bar is the bar itself.** A tab with a bar (Activity, Budgets, Plan) draws its own while the dashboard loads, on the segment it will open on, `inert` until the tab is in; a month still to come is a placeholder in the month's place, so the row is there and nothing moves.
- **Only for what will come.** A placeholder holds the place of something that is coming, never of something that may not exist: Shared with me is held only on a device whose last read had shares, and Needs attention, which shows only when something does, has none.

**The sign-in page** is laid out from the top, not centered: Clerk's form arrives after the page and changes height from step to step, and centered, every change moved the name and the demo card above it. The pages that share its layout (an invite link's, Not allowed yet) are laid out from the top too, so the name stays put from one to the next. Until Clerk's form loads, a placeholder of its width and about its height holds its place, and the form fades in where it was. From a demo button's press the page shows the app loading in its place. Once Clerk signs someone in, it moves to Home, which streams the same view at once while the server reads the session, and the dashboard then draws it again while its first load is on its way: one view from the sign-in to the figures.

Under the name, one line says what Nya is (`lib/tagline.ts`, 60 characters at most), on the password login too. Clerk's Continue is the page's one filled button: the demo accounts are tonal `.btn.secondary` buttons of two lines, the name over what the account is set up to hold (from the seed's scenarios, `lib/demo-seed/scenarios.ts`), and they sit above the form, since the form changes height from step to step and nothing below it should hold a button. Which banks connect is folded under the form behind **Which banks work?** (`Why`), left-aligned.

### The pages outside the tabs

The public pages (Security, Privacy, Developers, Open a protected download, the weekly summary's Turn off) are documents, so they read as prose under headings, not in cards: each part an `<h2>` at `--fs-5`, 32px apart (`.info-body`), code on `--surface` with a hairline. A page of five parts or more opens with a contents list (**On this page**), a 44px link to each part, two columns from 600px wide; its parts and the list are drawn from one list in the page, so they can't drift. A plain-language note said first (Privacy's, the download's) is an information notice before the contents. A form on one of them is a control and keeps its card. Every page outside the tabs (these, Your data, Reports, the admin's pages) has the same header, `components/PageHeader.tsx`: the logo and name as a 44px link back into the app (Reports' back to Activity, named "Back to Nya"), and Reports' hide amounts at the other end.

### Header and tab bar

- **Header**: brand, then hide amounts, refresh, and the avatar (or a gear in password mode). The avatar menu leads with Settings and carries a dot when something in Settings needs attention. The brand's logo is a two-ink mark (since the look and feel's step 4): the app icon's ring and cat face in one ink, `--brand-mark` (the logo gold on dark, its navy on light and in print), with the disc and the cat's features cut away, so the page is its disc. `BrandLogo` (`components/Brand.tsx`) draws it as one inline SVG through a mask, so it follows the theme with no image to swap; in forced colors it takes the forced text color. The filled coin (`app/icon.svg`) stays the favicon and the installed icon.
- **Tab bar**: five tabs, icons with `--fs-1` labels (12px, up from 11px), `--glass` with a blur. The current tab (`aria-current="page"`) has a 3px `--accent` bar over it and a bold label, not only its color (`--accent` is about 1.1:1 from `--text-2` in dark). On a wide window the glass still spans it, but the tabs keep to the 760px content column, so they never sit far apart.

## Status and honesty

Nya shows its gaps on purpose (see [features.md](../features.md)): a missing row usually means a missing debt, which makes net worth look better than it is. The reorganization must not soften any of that. It ranks and places it.

**Severity sets the color; it is never downgraded to save space.**

| Severity | When | Color |
|---|---|---|
| Critical | A number is wrong or short: an institution needs reconnecting, rows couldn't be shown, a total is incomplete. Also an overdue payment in Needs attention | Red |
| Caution | Numbers are real but dated, held or paused: stale but recovered balances, an account that stopped reporting (held at its last known balance until you answer), a connection that ends soon (Reconnect soon), history paused, a backup or clean-up failed, a month may be missing transactions. In Needs attention, also a payment due within a week and a budget over or nearly over; on Budgets, a budget's meter from 85% (hatched, since the look and feel's step 4) and its **Over** badge (since phase 6a2) | Orange |
| Information | Nothing is wrong: converted currency, imported history, rates used | Neutral |

**Placement follows three rules.**

1. **On the number.** A caveat sits directly under the figure it qualifies, as an inline notice. **Critical caveats are never collapsed**: each shows in full, naming the institution and what is wrong ("Chase needs reconnecting; its balances are from Oct 21", "This total is short by 1 account"). Caution and information caveats show in full when there is one; two or more become a summary line that states the count and kind in words, in the color of the worst of them ("2 notes: 1 balance from yesterday, accrued interest left out"), and expands in place to every note in its current full wording. Never an unlabeled icon, never only in a sheet.
2. **Counted on Home.** Anything that needs the person to act (reconnect, answer an account question, approve the review queue, a payment due, a bank a restore brought back or a restore that can't be read) is also an item in Home's **Needs attention**, linking to where it is fixed. An overdue payment is red there: nothing on screen is wrong, but it costs the person until it is paid.
3. **Once per tab, not once per card.** On Budgets and Plan, a month or input that may be incomplete gets one notice at the top of the segment and a small badge on each affected card, instead of the same paragraph in every card. A note only one card rests on stays on that card, by rule 1: on Budgets > Upcoming (since phase 6a3) the notice holds what the bills, income and planned items may be missing, and the forecast's notes on the balance it starts from stay under its "Starts from" line. On Plan (since phase 6c) the notice opens Stress test, whose simulation uses the spending and invested assets that may be low; Your path says it on the FI number and under each figure's row, and Portfolio's allocation says its own gaps. A card's own empty state still says why it is empty, at its level.

**A connection's problems have one color**, from two questions (`lib/accounts-status.ts`, since rollout phase 3b): is it broken in a way only the person can fix (sign in again, reconnect, connect again, pay or fix it at SimpleFIN or Lunch Flow, say which way a card goes, remove one that can't be repaired)? Is the total missing an account's money (nothing fetched or recovered, accounts not shown, too old, held with no balance)? Either makes it critical, and the card shows the button that fixes it or says what isn't counted. Anything else that is off is a caution, a new connection waiting for its first answer included. The card's notice, its badge, Settings > Connections and the Accounts status all use it, and the words never change with the color.

**Who an instruction is for.** The backup and receipt clean-up notices reach every user (the server sends them ungated), but only the deployment's admin can act on "check the backup cron in Vercel". When one fails, everyone sees it as an orange caution on the Net worth card ("The nightly backup failed; the last one saved was Oct 20"); the instruction and its action show only to the admin, in an Admin card under Needs attention. Each of its rows goes to the admin's Nightly jobs page (`/admin/jobs`), a page of its own where the job's runs are and **Run now** runs it, so Home carries no controls for it. When backups are fine, nothing is shown.

## Copy

- **One line of helper text** by default. A second paragraph goes behind "Why?".
- **Say what to do**, then why: "Reconnect Chase to update its balances", not "Chase's connection has expired. ITEM_LOGIN_REQUIRED".
- **Name things the same everywhere**: "Hide", "Close", "Disconnect", "Forget" each mean one thing (see [information-architecture.md](information-architecture.md#vocabulary)).
- **Sentence case** for titles, buttons and labels.
- **No em or en dashes.** Commas, colons, parentheses or separate sentences.
- **Amounts in the account's currency**, as today, except in the calendar's day cells (since 6a4), too narrow at 12px for a symbol, which keep the sign while the legend under them names the currency once; hide amounts (`data-amounts="hidden"`) keeps masking every figure in every new component.

## Accessibility

- 44px minimum targets on touch (`--tap`). Every text field and select is 44px tall (since the screen review: the plain field rule and `.text-input` set the minimum). Today `.link-btn` (79 uses) is about 15px, `.disconnect-btn` about 26px.
- Real headings (`<h1>` per screen, `<h2>` per card) so screen-reader users can jump by heading.
- No interactive element inside another (no buttons inside a clickable row; a "Why?" for a row lives in the sheet the row opens).
- A deep link or a jump (the Accounts status pill, `?view=connections`, a Needs attention item) moves keyboard focus to the target's heading, not just the scroll position.
- One global `:focus-visible` ring in `--focus`, 2px, offset 2px; no component removes it.
- Segmented controls and menus follow the WAI-ARIA tabs and menu patterns, with arrow keys.
- Sheets trap focus and return it to the control that opened them; a second level replaces the content with a back button instead of stacking.
- Reduced motion respected everywhere through the motion tokens.
- AA contrast for every token pair in both themes (see [Color](#color)).
- Every control is edged in `--border-input` (3:1), and every selected or current state shows by an edge, a mark or weight as well as its color. The guard checks the rules that carry these.

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
