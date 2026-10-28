# Building UI in Nya

The rules every change that adds or changes UI follows, so the app keeps one design language as it grows. Read this before starting UI work; the [checklist](#checklist) at the end is what a pull request is reviewed against.

The target design is in [design-system.md](design-system.md) and [information-architecture.md](information-architecture.md); [rollout.md](rollout.md) is how the app gets there. Build with the **primitives** ([below](#which-class-to-use)) and the tokens in `app/globals.css`, following the target's rules; the classes they replace stay in older screens until each screen's rollout phase. `test/design-guard.test.ts` holds the parts a test can check.

- [Where it goes](#where-it-goes)
- [Color](#color)
- [Type](#type)
- [Spacing and layout](#spacing-and-layout)
- [Which class to use](#which-class-to-use)
- [Status and honesty](#status-and-honesty)
- [Amounts](#amounts)
- [Sheets, menus and forms](#sheets-menus-and-forms)
- [Copy](#copy)
- [Accessibility](#accessibility)
- [Changing the design itself](#changing-the-design-itself)
- [What the guard test checks](#what-the-guard-test-checks)
- [Checklist](#checklist)

## Where it goes

Decide this first. Most clutter in Nya came from good features placed in the first spot that was free.

1. **A setting** (it changes how Nya behaves, and nobody looks at it daily) goes in a Settings section: Preferences, Transactions, Connections, Sharing, Your data and privacy, or Account. Build it as one self-contained card component and add it to its section in `settingsSections` in `components/Dashboard.tsx`, so it can move as a unit. Never put a setting on a working screen.
2. **About one object** (an account, a transaction, a goal, a connection, a person) goes in that object's sheet or its ⋯ menu, not as a new card or a new row button on the tab.
3. **Asks the person to act** is shown on the object it concerns and is also an item in Home's Needs attention.
4. **Analysis of transactions** goes with Activity's analysis (Spending, after phase 5), never above the transaction list.
5. **This month's budget, what is coming, or something saved toward** goes in Budgets: Month, Upcoming or Goals.
6. **Long-term or FI** goes in Plan: Your path, Stress test or Portfolio.
7. **None of these**: say so in the pull request and propose a home. Don't add a card to Home.

Also:

- **No new tabs and no new modes.** Nothing toggles a screen into a different screen.
- **A tab's first screen is earned.** A new card goes below what is there unless it is the tab's main object.
- **Explanations go behind "Why?"**: one line of helper text by default.
- **Record the placement**: add every new component to the [feature-to-location table](information-architecture.md#feature-to-location), or to [Building blocks](information-architecture.md#building-blocks) if it only serves other components. The guard test fails until you do.

## Color

- Use only `var(--…)` colors: the tokens on `:root` in `app/globals.css` (`--canvas`, `--surface`, `--elevated`, `--border-subtle`, `--text-1`, `--accent`, `--neg-tint`, `--accent-fill`, ...; the table is in [design-system.md](design-system.md#color)).
- New rules use the token names. Today's names (`--bg`, `--card`, `--raised`, `--border`, `--line`, `--text`, `--muted`, `--up`, `--down`) are aliases kept so older rules keep working; don't add new uses of them.
- **No color literals** (`#hex`, `rgb()`, `hsl()`) in components or in new CSS rules. Charts pass `var(--…)` strings to `fill` and `stroke`.
- The app is light or dark (rollout phase 7), so a color that only reads in one of them is a bug. Code that can't read a CSS variable (`themeColor`, the web manifest) imports `lib/theme.ts`; Clerk takes the variables themselves.
- A token at an alpha is `color-mix(in srgb, var(--token) N%, transparent)`, never the token's color restated as `rgba()`.
- **Meaning, not decoration.** Brass (`--accent`) is for actions and the current selection. Green and red are for money in and out and for gain and loss (and green for the Accounts tab's "All synced"). Orange (`--warn`) is only for something that needs the person. Red is for a number that is wrong or short. Brass is close to orange, coral and body text in lightness, so it never carries a meaning alone: underline a link inside a sentence, and tell two chart lines apart by dash as well as color.
- **Never color alone**: a state shown in color also has a word or an icon.

## Type

- Sizes: 12, 13, 15, 17, 20, 24px, and one hero figure per screen. **Nothing on screen under 12px.**
- Sentence case. No new uppercase micro-labels.
- Card titles 15px at weight 600; sheet titles 17px; body and rows 15px; secondary lines 13px; meta 12px.
- Money in columns or that can change in place is tabular: the `.money` class (`td.num` and `.list-row-value` already are).

## Spacing and layout

- **The container spaces its children.** Put stacked siblings in `.stack` (12px), `.stack.tight` (8px) or `.stack.loose` (16px); children of a stack lose their own block margins.
- **No inline spacing or type.** `style={{}}` must not set margin, padding, gap, font size, weight, line height, letter spacing or text transform. Inline style is for data only: a bar's width, a marker's position, a chart color as `var(--…)`, a CSS custom property.
- Spacing comes from the 4px grid (4, 8, 12, 16, 20, 24, 32). Radii come from 6, 8, 12, 16 and pill.
- **Reuse before you add.** Before writing a CSS rule, look for the class in the table below. Name a new class for its feature (`.payoff-…`), unless it is a generic primitive agreed in design-system.md. Never add another note, alert or button variant.
- Phone first: it must work at 320 and 375px wide without the page scrolling sideways.

## Which class to use

The primitives in `app/globals.css` ([design-system.md](design-system.md#components)) for new and changed UI; the third column is what each replaces, which stays in older screens until their rollout phase moves them. Where a need has no primitive yet, the class in the middle column is today's. The guard test checks that every class in the middle column exists in `app/globals.css`.

<!-- design-guard:classes -->
| Need | Use | Replaces |
|---|---|---|
| A card | `.card` | |
| A card's title row | `.card-header` with an `<h2>` | `.inst-header` with `.inst-name` and `.inst-total` |
| Rows in a card, split by hairlines | `.card.list-rows` (a `<ul>`), each `<li>` holding a `.list-row` | `.acct-row`, `.peer-row`, `.cat-manage-row` |
| A row's parts | `.list-row-text` with `.list-row-title` and `.list-row-sub`, then `.list-row-value` or a chevron | |
| Stacked spacing | `.stack`, `.stack.tight`, `.stack.loose` | inline `marginTop` |
| Primary action | `.btn` | a plain `<button>` |
| Other actions | `.btn.secondary` | `button.secondary` |
| An inline action (Edit, See all) | `.btn.ghost` | `.link-btn` |
| One full-width button | `.btn.btn-block` | |
| Icon button | `.icon-btn` | |
| Confirming a destructive action, inside a sheet | `.btn.danger` | `button.danger` |
| A group of buttons | `.btn-row` | `.button-pair`, `.card-actions` |
| Helper text | `.helper` | `.panel-note` |
| Empty state: a card with nothing in it yet | `EmptyState` (`.empty-state`): a heading, one line, one filled primary | a `.empty-note` paragraph and a tonal button apart from it |
| A line saying a list or a figure is empty, inside a card that has more | `.empty-note` | |
| Content still loading | `.skeleton` (`.skeleton.block` for a box), on the real component's classes | `.spinner` in an empty card |
| Critical notice (a number is wrong or short) | `.notice.critical` | `.error` |
| Caution notice (real but dated, needs you) | `.notice.caution` | `.stale-note` |
| Information notice | `.notice.info` | `.info-notice` |
| Done, saved | `.notice.done` | `.status-note` |
| Badge (not clickable) | `.badge`, toned `.accent`, `.pos`, `.neg` or `.warn` | `.pill` |
| Chip (clickable, a filter or a tag) | `.chip`; toned `.neg` or `.warn` for a status that jumps to what it counts; a row of filters in `.chip-row`; one that chooses among options is `ChipSelect` (`.chip-select`) | `.tag-chip`, a filter `<select>` in a `.text-input` |
| Change the month | `.month-stepper`, drawn by `MonthStepper` | arrows and a name of your own; on Activity or Budgets, a month apart from the shared one |
| Range or view switch | `.segmented` (`.compact` for a chart's range), drawn by `Segmented` | a boxed track, buttons with `aria-pressed` |
| Money that lines up | `.money` | `font-variant-numeric` in a feature rule |
| A meter | `.meter-track` with `.meter-fill` | |
| Key and value details | `.txn-detail` with `.txn-detail-row` | |
| Labelled figures in a row (In, Out, Net; totals by kind) | `.stat-strip` of `.stat`, each a `.stat-label` over a `.stat-value` | `.summary-row` with `.summary-value` |
| A form field | `.field` around a plain `<input>` or `<select>` | |
| A form in a sheet | `.sheet-form` | |
| A sheet's buttons, kept in view | `Sheet`'s `footer` (`.sheet-footer`) | a `.button-pair` at the end of the body |
| An object's rare actions (⋯) | `Menu` (`.menu` of `.menu-item`) | an Options button that opens an action sheet |
| An object's actions in its sheet | `ActionRows` (`.card.list-rows` of `.list-row` buttons) | a `.btn-row` of secondaries in the body |
| An explanation behind "Why?" | `Why` (`.why`) | a second paragraph on screen |
| A card that opens and closes on its title | `CollapsibleHeader` (`.section-toggle` in an `<h2>`) | `.holdings-toggle` with `.holdings-title` |
<!-- /design-guard:classes -->

**Avoid in new code**: `.link-btn` (about 15px tall; use `.btn.ghost`); `.type-tag` (a meta line, sentence case since the words pass; use `.list-row-sub` or `.helper`); one-off button classes that undo `button { width: 100% }` (a `.btn` sizes itself). The global `button` rule still fills every bare `<button>` and makes it full width, so new buttons always take a `.btn` class (or `.icon-btn`, `.list-row`, `.chip`, or sit in a `.segmented`).

## Status and honesty

Nya shows its gaps on purpose ([features.md](../features.md)). A new feature that can be wrong, stale or incomplete must say so, in these terms:

- **Severity sets the color, and is never lowered to save space.** Critical (red): a number is wrong or short. Caution (orange): real but dated, held or paused, or it needs the person. Information (neutral): nothing is wrong.
- **On the number.** A caveat sits under the figure it qualifies. Critical caveats always show in full, naming what is wrong. Two or more lesser ones may collapse into a line that states how many and what kind.
- **Needs attention.** Anything that asks the person to act also appears in Home's Needs attention, linking to where it is fixed.
- **Who can act.** An instruction only the deployment's admin can follow is shown only to the admin; everyone else gets the fact.
- **Keep the words.** Moving or restyling a warning never changes its wording or drops it. A pull request that touches one says so.

## Amounts

- Write every amount through `lib/format.ts` (`formatMoney`, `signedMoney`, `compactMoney`), so hide amounts masks it. `test/hide-amounts.test.tsx` fails otherwise.
- Show an amount in its own currency. A total that mixes currencies says what it left out.
- The one exception to both is the calendar's day cells (since 6a4): too narrow at 12px for a symbol, they keep the sign and the legend under them names the currency once. Their figure is written in `components/CalendarView.tsx` (`cellFigure`) behind an `amountsHidden()` guard, which the source scan checks.
- A negative balance shows a minus sign, and a debt reads as a debt.

## Sheets, menus and forms

- Forms, confirmations and detail views open in `components/Sheet.tsx`. A sheet that needs a second level replaces its content and gets a back button, instead of opening a sheet on top of a sheet.
- Destructive actions live in a menu or a detail sheet and are confirmed in a sheet. An irreversible one says it can't be undone; disconnecting an institution asks for its name to be typed.
- Rare actions on an object go in its ⋯; urgent ones (Reconnect) stay as visible buttons.
- A number field keeps its value as a string while it is typed (see `ManualDraft` in `Dashboard.tsx`), so a minus sign survives.

## Copy

- One line of helper text; the rest behind "Why?".
- Say what to do, then why: "Reconnect Chase to update its balances".
- One word for one thing: Hide, Close, Disconnect, Delete, Forget, Link, Connect ([vocabulary](information-architecture.md#vocabulary)).
- Sentence case. No em or en dashes.

## Accessibility

- Touch targets at least 44px.
- No interactive element inside another, so no button inside a clickable row.
- Card titles are headings (`.card-header` with an `<h2>`), and real headings are used wherever new markup allows it.
- Focus is visible and never removed. Jumping to something moves focus to it.
- Reduced motion is respected.
- AA contrast. The token set is checked; a new color pairing goes through [Changing the design itself](#changing-the-design-itself).

## Changing the design itself

A new token, component pattern, color or size is a change to the design system, not to one feature:

1. Propose it in `design-system.md` (and `tokens.css` for a color or size), saying what it replaces or why nothing existing fits.
2. Run `bun test test/design-guard.test.ts`, which checks the token contrast.
3. Update the mockups in `docs/design/mockups/index.html` if a screen changes.

## What the guard test checks

`test/design-guard.test.ts`, against the per-file counts in `test/design-guard-baseline.json`:

- **Raw colors** in components, app pages and on-screen CSS rules, **inline spacing and type** in `style={{}}`, and **on-screen font sizes under 12px** may not rise in any file, and a new file has none.
- When a count falls, the test asks you to lower that file's number in the baseline. Do it in the same pull request; the baseline only ever goes down.
- Every component in `components/` is placed in the information architecture doc.
- Every class in the table above exists.
- Both themes, as `app/globals.css` has them, pass AA contrast (tag colors included); the app's copies of the tokens (the light theme's three, print's among them) match `docs/design/tokens.css`, and `lib/theme.ts` and the manifest match the app.

When it fails, fix the code. Don't raise a baseline number to make it pass.

## Checklist

For every pull request that adds or changes UI:

- [ ] Placement follows [Where it goes](#where-it-goes); new components are recorded in the information architecture doc.
- [ ] No new tab, mode, or card on a tab's first screen without a reason stated in the PR.
- [ ] Colors are `var(--…)`; no literals; meaning colors used for their meaning.
- [ ] Sizes from the scale, nothing under 12px; spacing through `.stack` or a button group, not inline.
- [ ] Classes come from the table above; no new note, alert or button variant.
- [ ] Warnings keep their words and severity; critical ones are on the number in full.
- [ ] Amounts go through `lib/format.ts`; hide amounts still masks them.
- [ ] Targets at least 44px; no nested controls; focus visible.
- [ ] Works at 320 and 375px and on desktop, in print where a report is involved.
- [ ] A view test (`test/*-view.test.tsx` pattern) covers the new UI's states, including its warnings.
- [ ] `bun test` and `bun run typecheck` pass.
